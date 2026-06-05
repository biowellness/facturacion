import {
  BotEvent,
  MedplumClient,
  normalizeErrorString,
  createReference,
} from '@medplum/core';
import {
  Account,
  Communication,
  Coverage,
  Invoice,
  Patient,
  Consent,
  Reference,
} from '@medplum/fhirtypes';

// ─── Tipos del payload ────────────────────────────────────────────────────────

interface AltaPayload {
  patientId: string;
  plan: 'esencial' | 'plus' | 'premium';
  inicioCiclo: 'hoy' | 'proximo-mes';
  secretariaId: string;
}

interface AltaResult {
  success: boolean;
  accountId?: string;
  coverageId?: string;
  invoiceId?: string;
  error?: string;
}

// ─── Configuración de planes ──────────────────────────────────────────────────

const PLANES: Record<AltaPayload['plan'], {
  nombre: string;
  sesiones: number;
  precioARS: number;
  coverageCode: string;
}> = {
  esencial: {
    nombre: 'Plan Esencial',
    sesiones: 2,
    precioARS: 28000,
    coverageCode: 'BW-ESENCIAL',
  },
  plus: {
    nombre: 'Plan Plus',
    sesiones: 6,
    precioARS: 45000,
    coverageCode: 'BW-PLUS',
  },
  premium: {
    nombre: 'Plan Premium',
    sesiones: 10,
    precioARS: 85000,
    coverageCode: 'BW-PREMIUM',
  },
};

// ─── Handler principal ────────────────────────────────────────────────────────

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<AltaPayload>
): Promise<AltaResult> {
  const payload = event.input;

  try {
    // 1. Leer Patient
    const patient = await medplum.readResource('Patient', payload.patientId);
    const plan = PLANES[payload.plan];

    // 2. Verificar Consent activo
    await verificarConsent(medplum, payload.patientId, patient);

    // 3. Verificar que no tenga Account activo ya
    await verificarSinAccountActivo(medplum, payload.patientId);

    // 4. Calcular fechas del ciclo
    const { inicio, fin } = calcularCiclo(payload.inicioCiclo);

    // 5. Crear Coverage
    const coverage = await crearCoverage(medplum, patient, payload.plan, inicio, fin);

    // 6. Crear Account
    const account = await crearAccount(medplum, patient, coverage, plan.sesiones, inicio, fin);

    // 7. Crear Invoice (con prorrateo si inicia hoy a mitad de mes)
    const invoice = await crearInvoice(
      medplum, patient, account, coverage, plan, inicio, fin, payload.inicioCiclo
    );

    // 8. Enviar email de bienvenida
    await enviarBienvenida(medplum, patient, plan.nombre, plan.sesiones, fin, invoice.id ?? '');

    // 9. Registrar auditoría
    await registrarAuditoria(medplum, patient, payload, account.id ?? '', invoice.id ?? '');

    console.log(`Alta completada: Patient/${payload.patientId} → Account/${account.id}`);

    return {
      success: true,
      accountId: account.id,
      coverageId: coverage.id,
      invoiceId: invoice.id,
    };

  } catch (err) {
    const msg = normalizeErrorString(err);
    console.error(`Error en bot-alta-paciente: ${msg}`);

    await notificarError(medplum, payload.patientId, msg);

    return { success: false, error: msg };
  }
}

// ─── 1. Verificar Consent activo ──────────────────────────────────────────────

async function verificarConsent(
  medplum: MedplumClient,
  patientId: string,
  patient: Patient
): Promise<void> {
  const bundle = await medplum.search('Consent', {
    patient: `Patient/${patientId}`,
    status: 'active',
    _sort: '-date',
    _count: '1',
  });

  const consent = bundle.entry?.[0]?.resource as Consent | undefined;

  if (!consent) {
    throw new Error(
      `El paciente ${patientId} no tiene un Consent activo. ` +
      `Debe completar el consentimiento digital antes del alta.`
    );
  }

  // Verificar que no tenga flags bloqueantes (contraindicaciones absolutas)
  const flagBundle = await medplum.search('Flag', {
    subject: `Patient/${patientId}`,
    status: 'active',
    code: 'awaiting-review',
  });

  if ((flagBundle.total ?? 0) > 0) {
    throw new Error(
      `El paciente ${patientId} tiene contraindicaciones pendientes de revisión médica. ` +
      `El Director Médico debe resolver el caso antes del alta.`
    );
  }
}

// ─── 2. Verificar sin Account activo ─────────────────────────────────────────

async function verificarSinAccountActivo(
  medplum: MedplumClient,
  patientId: string
): Promise<void> {
  const bundle = await medplum.search('Account', {
    subject: `Patient/${patientId}`,
    status: 'active',
    _count: '1',
    _summary: 'count',
  });

  if ((bundle.total ?? 0) > 0) {
    throw new Error(
      `El paciente ${patientId} ya tiene una membresía activa. ` +
      `Use el flujo de cambio de plan para modificarla.`
    );
  }
}

// ─── 3. Calcular ciclo ────────────────────────────────────────────────────────

function calcularCiclo(inicioCiclo: AltaPayload['inicioCiclo']): {
  inicio: Date;
  fin: Date;
} {
  const hoy = new Date();

  if (inicioCiclo === 'proximo-mes') {
    const inicio = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 1);
    const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 2, 0, 23, 59, 59);
    return { inicio, fin };
  }

  // Inicia hoy, vence el último día del mes actual
  const fin = new Date(hoy.getFullYear(), hoy.getMonth() + 1, 0, 23, 59, 59);
  return { inicio: hoy, fin };
}

// ─── 4. Crear Coverage ────────────────────────────────────────────────────────

async function crearCoverage(
  medplum: MedplumClient,
  patient: Patient,
  planKey: AltaPayload['plan'],
  inicio: Date,
  fin: Date
): Promise<Coverage> {
  const plan = PLANES[planKey];

  const coverage: Coverage = {
    resourceType: 'Coverage',
    status: 'active',
    beneficiary: createReference(patient),
    subscriber: createReference(patient),
    subscriberId: plan.coverageCode,
    type: {
      coding: [
        {
          system: 'http://biowellness.ar/plan-codes',
          code: planKey,
          display: plan.nombre,
        },
      ],
    },
    class: [
      {
        type: {
          coding: [
            {
              system: 'http://biowellness.ar/coverage-class',
              code: 'sesiones-mensuales',
            },
          ],
        },
        value: String(plan.sesiones),
        name: `${plan.sesiones} sesiones por ciclo`,
      },
    ],
    costToBeneficiary: [
      {
        type: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/coverage-copay-type',
              code: 'monthly',
            },
          ],
        },
        valueQuantity: {
          value: plan.precioARS,
          unit: 'ARS',
          system: 'urn:iso:std:iso:4217',
          code: 'ARS',
        },
      },
    ],
    period: {
      start: inicio.toISOString().slice(0, 10),
      end: fin.toISOString().slice(0, 10),
    },
  };

  return medplum.createResource(coverage);
}

// ─── 5. Crear Account ─────────────────────────────────────────────────────────

async function crearAccount(
  medplum: MedplumClient,
  patient: Patient,
  coverage: Coverage,
  sesionesIncluidas: number,
  inicio: Date,
  fin: Date
): Promise<Account> {
  const legajo = generarLegajo(patient.id ?? '');

  const account: Account = {
    resourceType: 'Account',
    status: 'active',
    name: `Membresía BioWellness — ${patient.name?.[0]?.family ?? ''}`,
    subject: [createReference(patient)],
    coverage: [
      {
        coverage: createReference(coverage),
        priority: 1,
      },
    ],
    servicePeriod: {
      start: inicio.toISOString().slice(0, 10),
      end: fin.toISOString().slice(0, 10),
    },
    description: `Ciclo: ${formatFecha(inicio)} → ${formatFecha(fin)}`,
    identifier: [
      {
        system: 'http://biowellness.ar/legajo',
        value: legajo,
      },
    ],
    extension: [
      {
        url: 'http://biowellness.ar/fhir/StructureDefinition/sesiones-incluidas',
        valueInteger: sesionesIncluidas,
      },
      {
        url: 'http://biowellness.ar/fhir/StructureDefinition/sesiones-consumidas',
        valueInteger: 0,
      },
      {
        url: 'http://biowellness.ar/fhir/StructureDefinition/sesiones-disponibles',
        valueInteger: sesionesIncluidas,
      },
    ],
  };

  return medplum.createResource(account);
}

// ─── 6. Crear Invoice con prorrateo ──────────────────────────────────────────

async function crearInvoice(
  medplum: MedplumClient,
  patient: Patient,
  account: Account,
  coverage: Coverage,
  plan: typeof PLANES['plus'],
  inicio: Date,
  fin: Date,
  inicioCiclo: AltaPayload['inicioCiclo']
): Promise<Invoice> {
  // Calcular monto: prorrateo si inicia hoy a mitad de mes
  const monto = calcularMontoProrrateo(plan.precioARS, inicio, fin, inicioCiclo);
  const today = new Date().toISOString().slice(0, 10);
  const vencimiento = new Date(inicio.getFullYear(), inicio.getMonth() + 1, 5)
    .toISOString()
    .slice(0, 10); // vence el día 5 del mes siguiente

  const invoice: Invoice = {
    resourceType: 'Invoice',
    status: 'issued',
    subject: createReference(patient),
    account: createReference(account),
    date: today,
    identifier: [
      {
        system: 'http://biowellness.ar/invoice',
        value: `INV-${today.replace(/-/g, '').slice(0, 6)}-${(patient.id ?? '').slice(-4).toUpperCase()}`,
      },
    ],
    lineItem: [
      {
        sequence: 1,
        chargeItemCodeableConcept: {
          coding: [
            {
              system: 'http://biowellness.ar/plan-codes',
              code: coverage.subscriberId ?? '',
              display: plan.nombre,
            },
          ],
          text: `${plan.nombre} — ${formatFecha(inicio)} a ${formatFecha(fin)}`,
        },
        priceComponent: [
          {
            type: 'base',
            amount: {
              value: monto,
              currency: 'ARS',
            },
          },
        ],
      },
    ],
    totalNet: { value: monto, currency: 'ARS' },
    totalGross: { value: monto, currency: 'ARS' },
    note: [
      {
        text: inicioCiclo === 'hoy' && monto < plan.precioARS
          ? `Monto prorrateado: ${diasRestantes(inicio, fin)} días de ${diasEnMes(inicio)} del mes.`
          : `Ciclo completo: ${formatFecha(inicio)} → ${formatFecha(fin)}.`,
      },
      { text: `Vencimiento de pago: ${vencimiento}.` },
    ],
  };

  return medplum.createResource(invoice);
}

// ─── 7. Email de bienvenida ───────────────────────────────────────────────────

async function enviarBienvenida(
  medplum: MedplumClient,
  patient: Patient,
  planNombre: string,
  sesiones: number,
  finCiclo: Date,
  invoiceId: string
): Promise<void> {
  const nombre = patient.name?.[0]?.given?.[0] ?? 'paciente';
  const email = patient.telecom?.find(t => t.system === 'email')?.value ?? '';

  const comm: Communication = {
    resourceType: 'Communication',
    status: 'completed',
    category: [
      {
        coding: [
          {
            system: 'http://biowellness.ar/communication-category',
            code: 'alta-bienvenida',
            display: 'Bienvenida nuevo socio',
          },
        ],
      },
    ],
    subject: createReference(patient),
    sent: new Date().toISOString(),
    recipient: [createReference(patient)],
    payload: [
      {
        contentString: [
          `¡Bienvenido/a a BioWellness, ${nombre}!`,
          ``,
          `Tu membresía ${planNombre} está activa.`,
          `Tenés ${sesiones} sesiones disponibles hasta el ${formatFecha(finCiclo)}.`,
          ``,
          `Podés reservar tu primera sesión respondiendo este mensaje o llamando a recepción.`,
          ``,
          `Tu comprobante de pago (Invoice #${invoiceId}) fue enviado a ${email}.`,
          ``,
          `Equipo BioWellness`,
          `Roque Sáenz Peña 530, San Isidro · info@biowellness.ar`,
        ].join('\n'),
      },
    ],
  };

  await medplum.createResource(comm);
}

// ─── 8. Auditoría ─────────────────────────────────────────────────────────────

async function registrarAuditoria(
  medplum: MedplumClient,
  patient: Patient,
  payload: AltaPayload,
  accountId: string,
  invoiceId: string
): Promise<void> {
  await medplum.createResource({
    resourceType: 'AuditEvent',
    type: {
      system: 'http://dicom.nema.org/resources/ontology/DCM',
      code: '110110',
      display: 'Patient Record',
    },
    action: 'C',
    recorded: new Date().toISOString(),
    outcome: '0',
    agent: [
      {
        type: {
          coding: [
            {
              system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
              code: 'AUT',
            },
          ],
        },
        who: { reference: `Practitioner/${payload.secretariaId}` },
        requestor: true,
      },
    ],
    source: {
      observer: {
        display: 'bot-alta-paciente',
      },
    },
    entity: [
      { what: createReference(patient), name: 'Patient' },
      { what: { reference: `Account/${accountId}` }, name: 'Account' },
      { what: { reference: `Invoice/${invoiceId}` }, name: 'Invoice' },
    ],
  } as any);
}

// ─── 9. Notificar error ───────────────────────────────────────────────────────

async function notificarError(
  medplum: MedplumClient,
  patientId: string,
  mensaje: string
): Promise<void> {
  await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    category: [
      {
        coding: [
          {
            system: 'http://biowellness.ar/communication-category',
            code: 'bot-error',
            display: 'Error de Bot',
          },
        ],
      },
    ],
    priority: 'urgent',
    subject: { reference: `Patient/${patientId}` },
    sent: new Date().toISOString(),
    payload: [
      {
        contentString:
          `Error en bot-alta-paciente para Patient/${patientId}:\n${mensaje}`,
      },
    ],
    note: [{ text: 'Revisar manualmente desde el dashboard de secretaria.' }],
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function generarLegajo(patientId: string): string {
  const hoy = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  return `${hoy}-${patientId.slice(-4).toUpperCase()}`;
}

function formatFecha(d: Date): string {
  return d.toLocaleDateString('es-AR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function diasEnMes(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
}

function diasRestantes(inicio: Date, fin: Date): number {
  return Math.ceil((fin.getTime() - inicio.getTime()) / (1000 * 60 * 60 * 24)) + 1;
}

function calcularMontoProrrateo(
  precioMensual: number,
  inicio: Date,
  fin: Date,
  inicioCiclo: AltaPayload['inicioCiclo']
): number {
  if (inicioCiclo === 'proximo-mes') return precioMensual;

  const totalDias = diasEnMes(inicio);
  const diasRestantesVal = diasRestantes(inicio, fin);

  if (diasRestantesVal >= totalDias) return precioMensual;

  const proporcional = Math.round((precioMensual * diasRestantesVal) / totalDias);
  return proporcional;
}
