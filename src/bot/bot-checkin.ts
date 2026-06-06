import {
  BotEvent,
  MedplumClient,
  normalizeErrorString,
  createReference,
} from '@medplum/core';
import {
  Account,
  AuditEvent,
  Bundle,
  ChargeItem,
  Communication,
  Coverage,
  Patient,
  Task,
} from '@medplum/fhirtypes';

// ─── Tipos del payload ─────────────────────────────────────────────────────────

interface CheckInPayload {
  patientId: string;
  terapia: TerapiaCodigo;
  duracionMinutos: number;
  secretariaId: string;
  notaClinica?: string;
}

type TerapiaCodigo =
  | 'hbot'
  | 'luz-roja'
  | 'ihht'
  | 'crioterapia'
  | 'sauna-cold'
  | 'osteopatia'
  | 'masaje'
  | 'yoga';

interface CheckInResult {
  success: boolean;
  estado: 'ok' | 'ultima-sesion' | 'exceso-pendiente' | 'bloqueado' | 'error';
  chargeItemId?: string;
  sesionesDisponibles?: number;
  mensaje: string;
}

// ─── Catálogo de terapias ──────────────────────────────────────────────────────

const TERAPIAS: Record<TerapiaCodigo, {
  display: string;
  system: string;
  code: string;
  precioUnitarioARS: number;
}> = {
  'hbot':         { display: 'Oxigenoterapia Hiperbárica (HBOT)',    system: 'http://biowellness.ar/terapias', code: 'HBOT',      precioUnitarioARS: 18000 },
  'luz-roja':     { display: 'Fototerapia Luz Roja / PBMT',          system: 'http://biowellness.ar/terapias', code: 'LUZ-ROJA',  precioUnitarioARS: 8000  },
  'ihht':         { display: 'Hipoxia-Hiperoxia Intermitente (IHHT)', system: 'http://biowellness.ar/terapias', code: 'IHHT',      precioUnitarioARS: 14000 },
  'crioterapia':  { display: 'Crioterapia local / baño de hielo',     system: 'http://biowellness.ar/terapias', code: 'CRIO',      precioUnitarioARS: 6000  },
  'sauna-cold':   { display: 'Sauna + Cold plunge',                   system: 'http://biowellness.ar/terapias', code: 'SAUNA',     precioUnitarioARS: 7000  },
  'osteopatia':   { display: 'Osteopatía',                            system: 'http://biowellness.ar/terapias', code: 'OSTEO',     precioUnitarioARS: 10000 },
  'masaje':       { display: 'Masaje deportivo / terapéutico',        system: 'http://biowellness.ar/terapias', code: 'MASAJE',    precioUnitarioARS: 9000  },
  'yoga':         { display: 'Yoga / meditación',                     system: 'http://biowellness.ar/terapias', code: 'YOGA',      precioUnitarioARS: 5000  },
};

// ─── Handler principal ─────────────────────────────────────────────────────────

export async function handler(
  medplum: MedplumClient,
  event: BotEvent<CheckInPayload>
): Promise<CheckInResult> {
  const payload = event.input;

  try {
    // 1. Leer Patient y Account activo
    const patient = await medplum.readResource('Patient', payload.patientId);
    const account = await leerAccountActivo(medplum, payload.patientId);

    if (!account) {
      return await rechazarCheckIn(
        medplum, patient, payload,
        'bloqueado',
        'El paciente no tiene una membresía activa. Regularizar desde recepción.'
      );
    }

    // 2. Verificar estado del Account
    if (account.status === 'on-hold') {
      return await rechazarCheckIn(
        medplum, patient, payload,
        'bloqueado',
        'Membresía suspendida por pago vencido. No se puede registrar la sesión.'
      );
    }

    if (account.status === 'inactive') {
      return await rechazarCheckIn(
        medplum, patient, payload,
        'bloqueado',
        'Membresía cerrada. El paciente debe reactivarla antes de usar el servicio.'
      );
    }

    // 3. Leer saldo de sesiones desde las extensions del Account
    const { incluidas, consumidas, disponibles } = leerSaldo(account);

    // 4. Bifurcar según saldo
    if (disponibles <= 0) {
      return await gestionarExceso(medplum, patient, account, payload, consumidas);
    }

    // 5. Registrar sesión: crear ChargeItem y actualizar Account
    const terapia = TERAPIAS[payload.terapia];
    const chargeItem = await crearChargeItem(medplum, patient, account, payload, terapia);
    await actualizarSaldo(medplum, account, consumidas + 1, incluidas);

    const nuevasDisponibles = disponibles - 1;

    // 6. ¿Era la última sesión del ciclo?
    if (nuevasDisponibles === 0) {
      await notificarCuotaLlena(medplum, patient, account, payload.secretariaId);
      await registrarAuditoria(medplum, patient, payload, chargeItem.id ?? '', 'ultima-sesion');
      return {
        success: true,
        estado: 'ultima-sesion',
        chargeItemId: chargeItem.id,
        sesionesDisponibles: 0,
        mensaje: `Sesión de ${terapia.display} registrada. Era la última del ciclo — se notificó al paciente y a recepción.`,
      };
    }

    // 7. Sesión normal
    await enviarConfirmacion(medplum, patient, terapia.display, nuevasDisponibles);
    await registrarAuditoria(medplum, patient, payload, chargeItem.id ?? '', 'ok');

    return {
      success: true,
      estado: 'ok',
      chargeItemId: chargeItem.id,
      sesionesDisponibles: nuevasDisponibles,
      mensaje: `Sesión de ${terapia.display} registrada. Saldo restante: ${nuevasDisponibles} sesiones.`,
    };

  } catch (err) {
    const motivo = normalizeErrorString(err);
    console.error(`[bot-checkin] Error: ${motivo}`);
    return { success: false, estado: 'error', mensaje: motivo };
  }
}

// ─── 1. Leer Account activo del paciente ──────────────────────────────────────

async function leerAccountActivo(
  medplum: MedplumClient,
  patientId: string
): Promise<Account | undefined> {
  const bundle: Bundle = await medplum.search('Account', {
    subject: `Patient/${patientId}`,
    _sort: '-_lastUpdated',
    _count: '1',
  });
  return bundle.entry?.[0]?.resource as Account | undefined;
}

// ─── 2. Leer saldo desde extensions ───────────────────────────────────────────

function leerSaldo(account: Account): {
  incluidas: number;
  consumidas: number;
  disponibles: number;
} {
  const ext = account.extension ?? [];

  const get = (url: string): number =>
    ext.find(e => e.url === url)?.valueInteger ?? 0;

  const incluidas   = get('http://biowellness.ar/fhir/StructureDefinition/sesiones-incluidas');
  const consumidas  = get('http://biowellness.ar/fhir/StructureDefinition/sesiones-consumidas');
  const disponibles = get('http://biowellness.ar/fhir/StructureDefinition/sesiones-disponibles');

  return { incluidas, consumidas, disponibles };
}

// ─── 3. Crear ChargeItem ──────────────────────────────────────────────────────

async function crearChargeItem(
  medplum: MedplumClient,
  patient: Patient,
  account: Account,
  payload: CheckInPayload,
  terapia: typeof TERAPIAS['hbot']
): Promise<ChargeItem> {
  return medplum.createResource<ChargeItem>({
    resourceType: 'ChargeItem',
    status: 'billed',
    subject: createReference(patient),
    context: createReference(account),
    code: {
      coding: [{
        system: terapia.system,
        code: terapia.code,
        display: terapia.display,
      }],
      text: terapia.display,
    },
    occurrenceDateTime: new Date().toISOString(),
    enteredDate: new Date().toISOString(),
    quantity: { value: 1, unit: 'sesion' },
    priceOverride: {
      value: terapia.precioUnitarioARS,
      currency: 'ARS',
    },
    performer: [{
      function: {
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
          code: 'PART',
        }],
      },
      actor: { reference: `Practitioner/${payload.secretariaId}` },
    }],
    note: payload.notaClinica
      ? [{ text: payload.notaClinica }]
      : undefined,
    extension: [{
      url: 'http://biowellness.ar/fhir/StructureDefinition/duracion-minutos',
      valueInteger: payload.duracionMinutos,
    }],
  });
}

// ─── 4. Actualizar saldo en Account via PATCH ─────────────────────────────────

async function actualizarSaldo(
  medplum: MedplumClient,
  account: Account,
  nuevasConsumidas: number,
  incluidas: number
): Promise<void> {
  const nuevasDisponibles = Math.max(0, incluidas - nuevasConsumidas);

  await medplum.patchResource('Account', account.id ?? '', [
    {
      op: 'replace',
      path: '/extension/1/valueInteger',
      value: nuevasConsumidas,
    },
    {
      op: 'replace',
      path: '/extension/2/valueInteger',
      value: nuevasDisponibles,
    },
  ]);
}

// ─── 5. Gestionar exceso (cuota agotada) ──────────────────────────────────────

async function gestionarExceso(
  medplum: MedplumClient,
  patient: Patient,
  account: Account,
  payload: CheckInPayload,
  consumidas: number
): Promise<CheckInResult> {
  const terapia = TERAPIAS[payload.terapia];
  const nombre = patient.name?.[0]?.given?.[0] ?? 'el paciente';

  // Crear Task para aprobación manual de la secretaria
  const task = await medplum.createResource<Task>({
    resourceType: 'Task',
    status: 'requested',
    intent: 'proposal',
    priority: 'urgent',
    code: {
      coding: [{
        system: 'http://biowellness.ar/task-codes',
        code: 'aprobar-sesion-extra',
        display: 'Aprobar sesión fuera de cuota',
      }],
    },
    description: `${nombre} solicita ${terapia.display} — cuota agotada (${consumidas} sesiones usadas). Requiere aprobación manual para add-on.`,
    for: createReference(patient),
    focus: createReference(account),
    authoredOn: new Date().toISOString(),
    requester: { reference: `Practitioner/${payload.secretariaId}` },
    owner: { reference: `Practitioner/${payload.secretariaId}` },
    restriction: {
      period: {
        end: new Date(Date.now() + 30 * 60 * 1000).toISOString(), // 30 min para decidir
      },
    },
  });

  // Notificar a recepción
  await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    priority: 'urgent',
    category: [{
      coding: [{
        system: 'http://biowellness.ar/communication-category',
        code: 'exceso-cuota',
        display: 'Sesión fuera de cuota',
      }],
    }],
    subject: createReference(patient),
    sent: new Date().toISOString(),
    payload: [{
      contentString: `⚠ Check-in bloqueado: ${nombre} agotó su cuota mensual. ` +
        `Solicita ${terapia.display}. Task #${task.id} — aprobar o rechazar en 30 min.`,
    }],
  });

  return {
    success: false,
    estado: 'exceso-pendiente',
    sesionesDisponibles: 0,
    mensaje: `Cuota agotada. Se creó la Task #${task.id} para aprobación manual del add-on.`,
  };
}

// ─── 6. Notificar cuota llena ─────────────────────────────────────────────────

async function notificarCuotaLlena(
  medplum: MedplumClient,
  patient: Patient,
  account: Account,
  secretariaId: string
): Promise<void> {
  const nombre = patient.name?.[0]?.given?.[0] ?? 'paciente';
  const fin = account.servicePeriod?.end ?? '';
  const finFmt = fin
    ? new Date(fin).toLocaleDateString('es-AR', { day: '2-digit', month: 'long' })
    : 'fin de ciclo';

  // Al paciente
  await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    priority: 'routine',
    category: [{
      coding: [{
        system: 'http://biowellness.ar/communication-category',
        code: 'cuota-llena',
        display: 'Cuota mensual agotada',
      }],
    }],
    subject: createReference(patient),
    recipient: [createReference(patient)],
    sent: new Date().toISOString(),
    payload: [{
      contentString: [
        `Hola ${nombre}, usaste tu última sesión del ciclo.`,
        ``,
        `Tu membresía se renueva automáticamente el ${finFmt}.`,
        `Si necesitás una sesión extra antes, pedísela a recepción.`,
        ``,
        `Equipo BioWellness`,
      ].join('\n'),
    }],
  });

  // A recepción
  await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    priority: 'routine',
    category: [{
      coding: [{
        system: 'http://biowellness.ar/communication-category',
        code: 'info-cuota-llena',
      }],
    }],
    subject: createReference(patient),
    sent: new Date().toISOString(),
    payload: [{
      contentString: `${nombre} usó su última sesión del ciclo actual. ` +
        `Renovación automática el ${finFmt}.`,
    }],
  });
}

// ─── 7. Confirmación al paciente ──────────────────────────────────────────────

async function enviarConfirmacion(
  medplum: MedplumClient,
  patient: Patient,
  terapiaDisplay: string,
  disponibles: number
): Promise<void> {
  const nombre = patient.name?.[0]?.given?.[0] ?? 'paciente';

  await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    priority: 'routine',
    category: [{
      coding: [{
        system: 'http://biowellness.ar/communication-category',
        code: 'confirmacion-checkin',
        display: 'Confirmación de sesión',
      }],
    }],
    subject: createReference(patient),
    recipient: [createReference(patient)],
    sent: new Date().toISOString(),
    payload: [{
      contentString: `Hola ${nombre}, tu sesión de ${terapiaDisplay} fue registrada. ` +
        `Te quedan ${disponibles} sesión${disponibles !== 1 ? 'es' : ''} disponible${disponibles !== 1 ? 's' : ''} este ciclo.`,
    }],
  });
}

// ─── 8. Check-in bloqueado ────────────────────────────────────────────────────

async function rechazarCheckIn(
  medplum: MedplumClient,
  patient: Patient,
  payload: CheckInPayload,
  estado: CheckInResult['estado'],
  mensaje: string
): Promise<CheckInResult> {
  await registrarAuditoria(medplum, patient, payload, '', estado);

  await medplum.createResource<Communication>({
    resourceType: 'Communication',
    status: 'completed',
    priority: 'urgent',
    category: [{
      coding: [{
        system: 'http://biowellness.ar/communication-category',
        code: 'checkin-bloqueado',
      }],
    }],
    subject: createReference(patient),
    sent: new Date().toISOString(),
    payload: [{ contentString: `Check-in bloqueado para Patient/${patient.id}: ${mensaje}` }],
  });

  return { success: false, estado, mensaje };
}

// ─── 9. AuditEvent ────────────────────────────────────────────────────────────

async function registrarAuditoria(
  medplum: MedplumClient,
  patient: Patient,
  payload: CheckInPayload,
  chargeItemId: string,
  resultado: string
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
    outcome: resultado === 'bloqueado' || resultado === 'error' ? '4' : '0',
    outcomeDesc: resultado,
    agent: [{
      type: {
        coding: [{
          system: 'http://terminology.hl7.org/CodeSystem/v3-ParticipationType',
          code: 'AUT',
        }],
      },
      who: { reference: `Practitioner/${payload.secretariaId}` },
      requestor: true,
    }],
    source: { observer: { display: 'bot-checkin' } },
    entity: [
      { what: createReference(patient), name: 'Patient' },
      ...(chargeItemId ? [{ what: { reference: `ChargeItem/${chargeItemId}` }, name: 'ChargeItem' }] : []),
    ],
  } as AuditEvent);
}
