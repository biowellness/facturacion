import {
  BotEvent,
  MedplumClient,
  normalizeErrorString,
  createReference,
} from '@medplum/core';
import {
  Account,
  Bundle,
  Communication,
  Coverage,
  Invoice,
  Patient,
} from '@medplum/fhirtypes';

// ─── Tipos internos ────────────────────────────────────────────────────────────

type EstadoRenovacion = 'renovada' | 'suspendida' | 'cerrada' | 'error';

interface ResultadoRenovacion {
  accountId: string;
  patientId: string;
  estado: EstadoRenovacion;
  invoiceId?: string;
  motivo?: string;
}

interface ResumenBot {
  total: number;
  renovadas: number;
  suspendidas: number;
  cerradas: number;
  errores: number;
  detalle: ResultadoRenovacion[];
}

// ─── Handler principal ────────────────────────────────────────────────────────

export async function handler(
  medplum: MedplumClient,
  _event: BotEvent
): Promise<ResumenBot> {
  console.log(`[bot-renovacion] Iniciando ciclo: ${new Date().toISOString()}`);

  const accounts = await leerAccountsAVencer(medplum);
  console.log(`[bot-renovacion] Accounts a procesar: ${accounts.length}`);

  const resultados: ResultadoRenovacion[] = [];

  for (const account of accounts) {
    const r = await procesarAccount(medplum, account);
    resultados.push(r);
    console.log(`[bot-renovacion] ${r.accountId} → ${r.estado}${r.motivo ? ': ' + r.motivo : ''}`);
  }

  const resumen = calcularResumen(resultados);
  await enviarResumenDashboard(medplum, resumen);

  console.log(`[bot-renovacion] Completado: ${JSON.stringify(resumen)}`);
  return resumen;
}

// ─── 1. Leer Accounts a vencer hoy ───────────────────────────────────────────

async function leerAccountsAVencer(medplum: MedplumClient): Promise<Account[]> {
  const hoy = new Date().toISOString().slice(0, 10);

  const bundle: Bundle = await medplum.search('Account', {
    status: 'active',
    'period-end': hoy,
    _include: 'Account:subject',
    _count: '500',
  });

  return (bundle.entry ?? [])
    .filter(e => e.resource?.resourceType === 'Account')
    .map(e => e.resource as Account);
}

// ─── 2. Procesar cada Account ─────────────────────────────────────────────────

async function procesarAccount(
  medplum: MedplumClient,
  account: Account
): Promise<ResultadoRenovacion> {
  const accountId = account.id ?? '';
  const patientRef = account.subject?.[0]?.reference ?? '';
  const patientId = patientRef.split('/')[1] ?? '';

  try {
    const [patient, invoice, coverage] = await Promise.all([
      medplum.readReference<Patient>({ reference: patientRef }),
      leerUltimaInvoice(medplum, accountId),
      leerCoverage(medplum, patientRef),
    ]);

    const estadoInvoice = invoice?.status ?? 'sin-invoice';

    if (estadoInvoice === 'balanced') {
      return await renovar(medplum, account, patient, coverage, accountId, patientId);
    }

    if (estadoInvoice === 'issued' || estadoInvoice === 'draft') {
      return await suspender(medplum, account, patient, accountId, patientId, estadoInvoice);
    }

    if (estadoInvoice === 'cancelled') {
      return await cerrar(medplum, account, patient, accountId, patientId);
    }

    return { accountId, patientId, estado: 'error', motivo: `Estado Invoice desconocido: ${estadoInvoice}` };

  } catch (err) {
    const motivo = normalizeErrorString(err);
    await notificarError(medplum, accountId, patientId, motivo);
    return { accountId, patientId, estado: 'error', motivo };
  }
}

// ─── 3a. RENOVAR: pago OK ─────────────────────────────────────────────────────

async function renovar(
  medplum: MedplumClient,
  account: Account,
  patient: Patient,
  coverage: Coverage | undefined,
  accountId: string,
  patientId: string
): Promise<ResultadoRenovacion> {
  const { inicio, fin } = calcularNuevoCiclo();
  const sesiones = extraerSesionesDelPlan(coverage);
  const precioARS = extraerPrecioDelPlan(coverage);
  const planNombre = extraerNombrePlan(coverage);

  // 3a.1 Actualizar Account: reset saldo + nuevo período
  await medplum.patchResource('Account', accountId, [
    { op: 'replace', path: '/status', value: 'active' },
    { op: 'replace', path: '/servicePeriod/start', value: inicio },
    { op: 'replace', path: '/servicePeriod/end', value: fin },
    { op: 'replace', path: '/extension/0/valueInteger', value: sesiones },
    { op: 'replace', path: '/extension/1/valueInteger', value: 0 },
    { op: 'replace', path: '/extension/2/valueInteger', value: sesiones },
  ]);

  // 3a.2 Crear nueva Invoice para el nuevo ciclo
  const invoice = await crearNuevaInvoice(
    medplum, patient, account, precioARS, planNombre, inicio, fin
  );

  // 3a.3 Actualizar período en Coverage
  if (coverage?.id) {
    await medplum.patchResource('Coverage', coverage.id, [
      { op: 'replace', path: '/period/start', value: inicio },
      { op: 'replace', path: '/period/end', value: fin },
    ]);
  }

  // 3a.4 Notificar al paciente
  await enviarEmailRenovacion(medplum, patient, planNombre, sesiones, fin, invoice.id ?? '');

  return { accountId, patientId, estado: 'renovada', invoiceId: invoice.id };
}

// ─── 3b. SUSPENDER: pago vencido ──────────────────────────────────────────────

async function suspender(
  medplum: MedplumClient,
  account: Account,
  patient: Patient,
  accountId: string,
  patientId: string,
  estadoInvoice: string
): Promise<ResultadoRenovacion> {
  // Cambiar Account a on-hold — bloquea nuevos ChargeItems
  await medplum.patchResource('Account', accountId, [
    { op: 'replace', path: '/status', value: 'on-hold' },
  ]);

  // Crear Flag de deuda pendiente
  await medplum.createResource({
    resourceType: 'Flag',
    status: 'active',
    code: {
      coding: [{ system: 'http://biowellness.ar/flag-codes', code: 'pago-vencido' }],
      text: 'Pago de membresía vencido',
    },
    subject: { reference: `Patient/${patientId}` },
    period: { start: new Date().toISOString() },
  } as any);

  // Notificar al paciente
  const nombre = patient.name?.[0]?.given?.[0] ?? 'paciente';
  await crearCommunication(medplum, patient, 'suspension-pago', 'urgent', [
    {
      contentString: [
        `Hola ${nombre}, tu membresía BioWellness fue suspendida temporalmente.`,
        ``,
        `Motivo: pago pendiente (Invoice estado: ${estadoInvoice}).`,
        `Para reactivarla, regularizá el pago y avisanos.`,
        ``,
        `Equipo BioWellness · info@biowellness.ar`,
      ].join('\n'),
    },
  ]);

  // Alerta a secretaria
  await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    priority: 'urgent',
    category: [{ coding: [{ code: 'alerta-pago-vencido', system: 'http://biowellness.ar/communication-category' }] }],
    subject: { reference: `Patient/${patientId}` },
    sent: new Date().toISOString(),
    payload: [{ contentString: `Account/${accountId} suspendido por pago vencido. Paciente: ${patientId}. Gestionar cobro manualmente.` }],
  });

  return { accountId, patientId, estado: 'suspendida', motivo: `Invoice ${estadoInvoice}` };
}

// ─── 3c. CERRAR: membresía cancelada ─────────────────────────────────────────

async function cerrar(
  medplum: MedplumClient,
  account: Account,
  patient: Patient,
  accountId: string,
  patientId: string
): Promise<ResultadoRenovacion> {
  await medplum.patchResource('Account', accountId, [
    { op: 'replace', path: '/status', value: 'inactive' },
  ]);

  const nombre = patient.name?.[0]?.given?.[0] ?? 'paciente';
  await crearCommunication(medplum, patient, 'cierre-membresia', 'routine', [
    {
      contentString: [
        `Hola ${nombre}, tu membresía BioWellness ha sido cerrada.`,
        `Gracias por ser parte de nuestra comunidad.`,
        `Podés reactivarla cuando quieras contactándonos.`,
        ``,
        `Equipo BioWellness · info@biowellness.ar`,
      ].join('\n'),
    },
  ]);

  return { accountId, patientId, estado: 'cerrada' };
}

// ─── 4. Crear nueva Invoice ───────────────────────────────────────────────────

async function crearNuevaInvoice(
  medplum: MedplumClient,
  patient: Patient,
  account: Account,
  precioARS: number,
  planNombre: string,
  inicio: string,
  fin: string
): Promise<Invoice> {
  const today = new Date().toISOString().slice(0, 10);
  const mesAnio = inicio.slice(0, 7).replace('-', '');
  const vencimiento = new Date(
    new Date(inicio).getFullYear(),
    new Date(inicio).getMonth() + 1,
    5
  ).toISOString().slice(0, 10);

  return medplum.createResource<Invoice>({
    resourceType: 'Invoice',
    status: 'issued',
    subject: createReference(patient),
    account: createReference(account),
    date: today,
    identifier: [{
      system: 'http://biowellness.ar/invoice',
      value: `INV-${mesAnio}-${(patient.id ?? '').slice(-4).toUpperCase()}`,
    }],
    lineItem: [{
      sequence: 1,
      chargeItemCodeableConcept: {
        text: `${planNombre} — ${inicio} a ${fin}`,
      },
      priceComponent: [{
        type: 'base',
        amount: { value: precioARS, currency: 'ARS' },
      }],
    }],
    totalNet: { value: precioARS, currency: 'ARS' },
    totalGross: { value: precioARS, currency: 'ARS' },
    note: [{ text: `Ciclo: ${inicio} → ${fin}. Vencimiento: ${vencimiento}.` }],
  });
}

// ─── 5. Email renovación ──────────────────────────────────────────────────────

async function enviarEmailRenovacion(
  medplum: MedplumClient,
  patient: Patient,
  planNombre: string,
  sesiones: number,
  fin: string,
  invoiceId: string
): Promise<void> {
  const nombre = patient.name?.[0]?.given?.[0] ?? 'paciente';
  const finFmt = new Date(fin).toLocaleDateString('es-AR', { day: '2-digit', month: 'long', year: 'numeric' });

  await crearCommunication(medplum, patient, 'renovacion-exitosa', 'routine', [
    {
      contentString: [
        `Hola ${nombre}, tu membresía ${planNombre} fue renovada.`,
        ``,
        `Tenés ${sesiones} sesiones disponibles hasta el ${finFmt}.`,
        ``,
        `Tu comprobante: Invoice #${invoiceId}`,
        ``,
        `Equipo BioWellness · Roque Sáenz Peña 530, San Isidro`,
      ].join('\n'),
    },
  ]);
}

// ─── 6. Resumen al dashboard ──────────────────────────────────────────────────

async function enviarResumenDashboard(
  medplum: MedplumClient,
  resumen: ResumenBot
): Promise<void> {
  const hoy = new Date().toISOString().slice(0, 10);

  await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    category: [{ coding: [{ code: 'bot-resumen', system: 'http://biowellness.ar/communication-category' }] }],
    sent: new Date().toISOString(),
    payload: [{
      contentString: [
        `[bot-renovacion-mensual] Ciclo ${hoy}`,
        `Total procesados: ${resumen.total}`,
        `  ✓ Renovadas:   ${resumen.renovadas}`,
        `  ⚠ Suspendidas: ${resumen.suspendidas}`,
        `  ✗ Cerradas:    ${resumen.cerradas}`,
        `  ! Errores:     ${resumen.errores}`,
      ].join('\n'),
    }],
  });

  await medplum.createResource({
    resourceType: 'AuditEvent',
    type: { system: 'http://dicom.nema.org/resources/ontology/DCM', code: '110110' },
    action: 'E',
    recorded: new Date().toISOString(),
    outcome: resumen.errores > 0 ? '4' : '0',
    agent: [{ who: { display: 'bot-renovacion-mensual' }, requestor: false }],
    source: { observer: { display: 'bot-renovacion-mensual' } },
    entity: [{ name: 'resumen', description: JSON.stringify(resumen) }],
  } as any);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function calcularNuevoCiclo(): { inicio: string; fin: string } {
  const hoy = new Date();
  const inicio = new Date(hoy.getFullYear(), hoy.getMonth(), 1);
  const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0, 23, 59, 59);
  return {
    inicio: inicio.toISOString().slice(0, 10),
    fin: fin.toISOString().slice(0, 10),
  };
}

async function leerUltimaInvoice(
  medplum: MedplumClient,
  accountId: string
): Promise<Invoice | undefined> {
  const bundle: Bundle = await medplum.search('Invoice', {
    account: accountId,
    _sort: '-date',
    _count: '1',
  });
  return bundle.entry?.[0]?.resource as Invoice | undefined;
}

async function leerCoverage(
  medplum: MedplumClient,
  patientRef: string
): Promise<Coverage | undefined> {
  const bundle: Bundle = await medplum.search('Coverage', {
    beneficiary: patientRef,
    status: 'active',
    _count: '1',
  });
  return bundle.entry?.[0]?.resource as Coverage | undefined;
}

function extraerSesionesDelPlan(coverage: Coverage | undefined): number {
  return parseInt(coverage?.class_?.[0]?.value ?? '6', 10) || 6;
}

function extraerPrecioDelPlan(coverage: Coverage | undefined): number {
  return coverage?.costToBeneficiary?.[0]?.valueQuantity?.value ?? 45000;
}

function extraerNombrePlan(coverage: Coverage | undefined): string {
  return coverage?.type?.coding?.[0]?.display ?? 'Plan Plus';
}

async function crearCommunication(
  medplum: MedplumClient,
  patient: Patient,
  categoryCodigo: string,
  priority: 'routine' | 'urgent',
  payload: Communication['payload']
): Promise<void> {
  await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    priority,
    category: [{ coding: [{ code: categoryCodigo, system: 'http://biowellness.ar/communication-category' }] }],
    subject: createReference(patient),
    recipient: [createReference(patient)],
    sent: new Date().toISOString(),
    payload,
  });
}

async function notificarError(
  medplum: MedplumClient,
  accountId: string,
  patientId: string,
  motivo: string
): Promise<void> {
  await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    priority: 'urgent',
    category: [{ coding: [{ code: 'bot-error', system: 'http://biowellness.ar/communication-category' }] }],
    subject: { reference: `Patient/${patientId}` },
    sent: new Date().toISOString(),
    payload: [{ contentString: `Error renovando Account/${accountId}: ${motivo}` }],
  });
}

function calcularResumen(resultados: ResultadoRenovacion[]): ResumenBot {
  return {
    total: resultados.length,
    renovadas: resultados.filter(r => r.estado === 'renovada').length,
    suspendidas: resultados.filter(r => r.estado === 'suspendida').length,
    cerradas: resultados.filter(r => r.estado === 'cerrada').length,
    errores: resultados.filter(r => r.estado === 'error').length,
    detalle: resultados,
  };
}
