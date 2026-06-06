import {
  BotEvent,
  MedplumClient,
  normalizeErrorString,
  createReference,
} from '@medplum/core';
import {
  Account,
  AuditEvent,
  ChargeItem,
  Communication,
  Invoice,
  Patient,
  Task,
} from '@medplum/fhirtypes';

// ─── Tipos ─────────────────────────────────────────────────────────────────────

type Accion = 'aprobar' | 'rechazar';

interface AddonPayload {
  taskId: string;
  accion: Accion;
  secretariaId: string;
  notaResolucion?: string;
  precioOverrideARS?: number;
}

interface AddonResult {
  success: boolean;
  accion: Accion;
  taskId: string;
  chargeItemId?: string;
  invoiceId?: string;
  mensaje: string;
}

// ─── Handler principal ─────────────────────────────────────────────────────────

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<AddonPayload>
): Promise<AddonResult> {
  const { taskId, accion, secretariaId, notaResolucion, precioOverrideARS } = event.input;

  try {
    // 1. Leer la Task y validar que sigue pendiente
    const task = await medplum.readResource('Task', taskId);
    await validarTask(task);

    // 2. Marcar Task como in-progress (secretaria tomó acción)
    await medplum.patchResource('Task', taskId, [
      { op: 'replace', path: '/status', value: 'in-progress' },
    ]);

    // 3. Resolver según acción
    const patientRef = task.for?.reference ?? '';
    const patientId  = patientRef.split('/')[1] ?? '';
    const patient    = await medplum.readResource('Patient', patientId);

    if (accion === 'aprobar') {
      return await aprobar(medplum, task, patient, secretariaId, notaResolucion, precioOverrideARS);
    }

    return await rechazar(medplum, task, patient, secretariaId, notaResolucion);

  } catch (err) {
    const motivo = normalizeErrorString(err);
    console.error(`[bot-aprobar-addon] Error en Task/${taskId}: ${motivo}`);
    return { success: false, accion, taskId, mensaje: motivo };
  }
}

// ─── Validaciones ──────────────────────────────────────────────────────────────

async function validarTask(task: Task): Promise<void> {
  if (task.status !== 'requested' && task.status !== 'in-progress') {
    throw new Error(
      `Task/${task.id} ya fue resuelta (status: ${task.status}). No se puede procesar de nuevo.`
    );
  }

  const vencimiento = task.restriction?.period?.end;
  if (vencimiento && new Date(vencimiento) < new Date()) {
    throw new Error(
      `Task/${task.id} venció el ${vencimiento}. El paciente debe solicitar la sesión nuevamente.`
    );
  }

  if (task.code?.coding?.[0]?.code !== 'aprobar-sesion-extra') {
    throw new Error(`Task/${task.id} no es del tipo aprobar-sesion-extra.`);
  }
}

// ─── APROBAR ──────────────────────────────────────────────────────────────────

async function aprobar(
  medplum: MedplumClient,
  task: Task,
  patient: Patient,
  secretariaId: string,
  nota?: string,
  precioOverride?: number
): Promise<AddonResult> {
  const taskId     = task.id ?? '';
  const patientRef = task.for?.reference ?? '';
  const accountRef = task.focus?.reference ?? '';
  const accountId  = accountRef.split('/')[1] ?? '';

  // 3a. Leer Account para obtener terapia y precio del catálogo
  const account = await medplum.readResource('Account', accountId);
  const { terapiaCodigo, terapiaDisplay, precioUnitario } = extraerDatosTask(task, precioOverride);

  // 3b. Crear ChargeItem del add-on (precio puede ser diferente al del plan)
  const chargeItem = await crearChargeItemAddon(
    medplum, patient, account, terapiaCodigo, terapiaDisplay,
    precioUnitario, secretariaId, nota
  );

  // 3c. Crear Invoice puntual para el add-on
  const invoice = await crearInvoiceAddon(
    medplum, patient, account, terapiaDisplay, precioUnitario
  );

  // 3d. Cerrar Task como completed con nota de resolución
  await cerrarTask(medplum, taskId, 'completed', secretariaId, nota ?? 'Add-on aprobado.');

  // 3e. Notificar al paciente
  await notificarPaciente(medplum, patient, 'aprobado', terapiaDisplay, precioUnitario);

  // 3f. Auditoría
  await auditoria(medplum, patient, taskId, chargeItem.id ?? '', 'aprobado', secretariaId);

  console.log(`[bot-aprobar-addon] Aprobado: Task/${taskId} → ChargeItem/${chargeItem.id} → Invoice/${invoice.id}`);

  return {
    success: true,
    accion: 'aprobar',
    taskId,
    chargeItemId: chargeItem.id,
    invoiceId: invoice.id,
    mensaje: `Sesión de ${terapiaDisplay} aprobada. ChargeItem e Invoice generados.`,
  };
}

// ─── RECHAZAR ─────────────────────────────────────────────────────────────────

async function rechazar(
  medplum: MedplumClient,
  task: Task,
  patient: Patient,
  secretariaId: string,
  nota?: string
): Promise<AddonResult> {
  const taskId = task.id ?? '';
  const { terapiaDisplay } = extraerDatosTask(task);

  // Cerrar Task como rejected
  await cerrarTask(medplum, taskId, 'rejected', secretariaId, nota ?? 'Add-on rechazado por secretaria.');

  // Notificar al paciente
  await notificarPaciente(medplum, patient, 'rechazado', terapiaDisplay, 0);

  // Auditoría
  await auditoria(medplum, patient, taskId, '', 'rechazado', secretariaId);

  console.log(`[bot-aprobar-addon] Rechazado: Task/${taskId}`);

  return {
    success: true,
    accion: 'rechazar',
    taskId,
    mensaje: `Solicitud de ${terapiaDisplay} rechazada. Paciente notificado.`,
  };
}

// ─── Crear ChargeItem add-on ───────────────────────────────────────────────────

async function crearChargeItemAddon(
  medplum: MedplumClient,
  patient: Patient,
  account: Account,
  codigo: string,
  display: string,
  precio: number,
  secretariaId: string,
  nota?: string
): Promise<ChargeItem> {
  return medplum.createResource<ChargeItem>({
    resourceType: 'ChargeItem',
    status: 'billed',
    subject: createReference(patient),
    context: createReference(account),
    code: {
      coding: [{
        system: 'http://biowellness.ar/terapias',
        code: codigo,
        display,
      }],
      text: display,
    },
    occurrenceDateTime: new Date().toISOString(),
    enteredDate: new Date().toISOString(),
    quantity: { value: 1, unit: 'sesion' },
    priceOverride: { value: precio, currency: 'ARS' },
    overrideReason: 'Sesión extra fuera de cuota mensual — aprobada manualmente',
    performer: [{
      function: {
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
          code: 'AUT',
          display: 'Author',
        }],
      },
      actor: { reference: `Practitioner/${secretariaId}` },
    }],
    note: nota ? [{ text: nota }] : undefined,
    extension: [{
      url: 'http://biowellness.ar/fhir/StructureDefinition/tipo-cargo',
      valueCode: 'add-on',
    }],
  });
}

// ─── Crear Invoice add-on ─────────────────────────────────────────────────────

async function crearInvoiceAddon(
  medplum: MedplumClient,
  patient: Patient,
  account: Account,
  terapiaDisplay: string,
  precio: number
): Promise<Invoice> {
  const today = new Date().toISOString().slice(0, 10);
  const vencimiento = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10);

  return medplum.createResource<Invoice>({
    resourceType: 'Invoice',
    status: 'issued',
    subject: createReference(patient),
    account: createReference(account),
    date: today,
    identifier: [{
      system: 'http://biowellness.ar/invoice',
      value: `ADDON-${today.replace(/-/g, '')}-${(patient.id ?? '').slice(-4).toUpperCase()}`,
    }],
    lineItem: [{
      sequence: 1,
      chargeItemCodeableConcept: {
        text: `Add-on: ${terapiaDisplay} — ${today}`,
      },
      priceComponent: [{
        type: 'base',
        amount: { value: precio, currency: 'ARS' },
      }],
    }],
    totalNet: { value: precio, currency: 'ARS' },
    totalGross: { value: precio, currency: 'ARS' },
    note: [
      { text: `Sesión extra fuera de cuota. Vencimiento: ${vencimiento}.` },
    ],
  });
}

// ─── Cerrar Task ──────────────────────────────────────────────────────────────

async function cerrarTask(
  medplum: MedplumClient,
  taskId: string,
  status: 'completed' | 'rejected',
  secretariaId: string,
  nota: string
): Promise<void> {
  await medplum.patchResource('Task', taskId, [
    { op: 'replace', path: '/status', value: status },
    {
      op: 'add',
      path: '/note',
      value: [{
        authorReference: { reference: `Practitioner/${secretariaId}` },
        time: new Date().toISOString(),
        text: nota,
      }],
    },
    {
      op: 'replace',
      path: '/lastModified',
      value: new Date().toISOString(),
    },
  ]);
}

// ─── Notificar al paciente ─────────────────────────────────────────────────────

async function notificarPaciente(
  medplum: MedplumClient,
  patient: Patient,
  resultado: 'aprobado' | 'rechazado',
  terapiaDisplay: string,
  precio: number
): Promise<void> {
  const nombre = patient.name?.[0]?.given?.[0] ?? 'paciente';

  const contenido = resultado === 'aprobado'
    ? [
        `Hola ${nombre}, tu sesión extra de ${terapiaDisplay} fue aprobada.`,
        ``,
        `Monto adicional: $${precio.toLocaleString('es-AR')} ARS.`,
        `Te enviamos el comprobante por separado.`,
        ``,
        `Equipo BioWellness · Roque Sáenz Peña 530, San Isidro`,
      ].join('\n')
    : [
        `Hola ${nombre}, tu solicitud de ${terapiaDisplay} extra no pudo ser aprobada por el momento.`,
        ``,
        `Tu cuota mensual está agotada. Podés contactarnos para gestionar un add-on`,
        `o esperar la renovación automática de tu membresía.`,
        ``,
        `Equipo BioWellness · info@biowellness.ar`,
      ].join('\n');

  await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    priority: 'routine',
    category: [{
      coding: [{
        system: 'http://biowellness.ar/communication-category',
        code: resultado === 'aprobado' ? 'addon-aprobado' : 'addon-rechazado',
      }],
    }],
    subject: createReference(patient),
    recipient: [createReference(patient)],
    sent: new Date().toISOString(),
    payload: [{ contentString: contenido }],
  });
}

// ─── AuditEvent ───────────────────────────────────────────────────────────────

async function auditoria(
  medplum: MedplumClient,
  patient: Patient,
  taskId: string,
  chargeItemId: string,
  resultado: string,
  secretariaId: string
): Promise<void> {
  await medplum.createResource({
    resourceType: 'AuditEvent',
    type: {
      system: 'http://dicom.nema.org/resources/ontology/DCM',
      code: '110110',
      display: 'Patient Record',
    },
    action: 'U',
    recorded: new Date().toISOString(),
    outcome: resultado === 'aprobado' ? '0' : '4',
    outcomeDesc: `Add-on ${resultado}`,
    agent: [{
      type: {
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
          code: 'AUT',
        }],
      },
      who: { reference: `Practitioner/${secretariaId}` },
      requestor: true,
    }],
    source: { observer: { display: 'bot-aprobar-addon' } },
    entity: [
      { what: createReference(patient), name: 'Patient' },
      { what: { reference: `Task/${taskId}` }, name: 'Task' },
      ...(chargeItemId ? [{ what: { reference: `ChargeItem/${chargeItemId}` }, name: 'ChargeItem' }] : []),
    ],
  } as AuditEvent);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function extraerDatosTask(task: Task, precioOverride?: number): {
  terapiaCodigo: string;
  terapiaDisplay: string;
  precioUnitario: number;
} {
  const PRECIOS: Record<string, number> = {
    HBOT: 18000, 'LUZ-ROJA': 8000, IHHT: 14000,
    CRIO: 6000, SAUNA: 7000, OSTEO: 10000, MASAJE: 9000, YOGA: 5000,
  };

  const descripcion = task.description ?? '';
  const match = descripcion.match(/solicita ([\w\s/-]+) —/i);
  const terapiaDisplay = match?.[1]?.trim() ?? 'Terapia';

  const codigoMatch = descripcion.match(/\b(HBOT|LUZ-ROJA|IHHT|CRIO|SAUNA|OSTEO|MASAJE|YOGA)\b/);
  const terapiaCodigo = codigoMatch?.[1] ?? 'HBOT';

  return {
    terapiaCodigo,
    terapiaDisplay,
    precioUnitario: precioOverride ?? PRECIOS[terapiaCodigo] ?? 10000,
  };
}
