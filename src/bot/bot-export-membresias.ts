import {
  BotEvent,
  MedplumClient,
  getDisplayString,
  normalizeErrorString,
} from '@medplum/core';
import {
  Account,
  Bundle,
  BundleEntry,
  ChargeItem,
  Communication,
  Coverage,
  Invoice,
  Patient,
} from '@medplum/fhirtypes';

// ─── Tipos internos ────────────────────────────────────────────────────────────

interface MemberRow {
  apellido: string;
  nombre: string;
  dni: string;
  email: string;
  telefono: string;
  plan: string;
  precio: string;
  sesiones_incluidas: number;
  sesiones_consumidas: number;
  sesiones_disponibles: number;
  estado_pago: string;
  proxima_renovacion: string;
  legajo: string;
  account_id: string;
}

// ─── Handler principal del Bot ────────────────────────────────────────────────

export async function handler(medplum: MedplumClient, event: BotEvent): Promise<void> {
  try {
    const rows = await buildMemberRows(medplum);
    const csv = toCsv(rows);
    await deliverCsv(medplum, csv, rows.length);
    console.log(`Exportación completada: ${rows.length} membresías activas`);
  } catch (err) {
    console.error('Error en bot-export-membresias:', normalizeErrorString(err));
    throw err;
  }
}

// ─── 1. Construir filas ───────────────────────────────────────────────────────

async function buildMemberRows(medplum: MedplumClient): Promise<MemberRow[]> {
  // Query principal: todos los Account activos con Patient y Coverage incluidos
  const bundle: Bundle = await medplum.search('Account', {
    status: 'active',
    _include: 'Account:subject',          // trae los Patient
    _revinclude: 'Coverage:payor',        // trae los Coverage del paciente
    _count: '500',
  });

  const entries = bundle.entry ?? [];

  // Indexar recursos del Bundle por resourceType + id
  const patients = indexResources<Patient>(entries, 'Patient');
  const coverages = indexResources<Coverage>(entries, 'Coverage');
  const accounts = entries
    .filter(e => e.resource?.resourceType === 'Account')
    .map(e => e.resource as Account);

  const rows: MemberRow[] = [];

  for (const account of accounts) {
    const patientRef = account.subject?.[0]?.reference ?? '';
    const patientId = patientRef.split('/')[1] ?? '';
    const patient = patients[patientId];
    if (!patient) continue;

    // Coverage del paciente (buscar por referencia al mismo Account o Patient)
    const coverage = findCoverageForPatient(coverages, patientRef);

    // Sesiones consumidas este ciclo (ChargeItems del mes actual)
    const consumed = await countSessionsThisCycle(medplum, patientRef);

    // Última Invoice del Account
    const invoiceStatus = await getLatestInvoiceStatus(medplum, account.id ?? '');

    // Fecha de próxima renovación desde Account.coverage[0].period.end
    const renewalDate = account.coverage?.[0]?.coverage?.display
      ?? account.meta?.lastUpdated?.slice(0, 10)
      ?? '';

    const sesionesIncluidas = extractSesionesIncluidas(coverage);

    rows.push({
      apellido: patient.name?.[0]?.family ?? '',
      nombre: patient.name?.[0]?.given?.join(' ') ?? '',
      dni: extractDni(patient),
      email: extractTelecom(patient, 'email'),
      telefono: extractTelecom(patient, 'phone'),
      plan: coverage?.subscriberId ?? extractPlanName(coverage),
      precio: extractPrecio(coverage),
      sesiones_incluidas: sesionesIncluidas,
      sesiones_consumidas: consumed,
      sesiones_disponibles: Math.max(0, sesionesIncluidas - consumed),
      estado_pago: invoiceStatus,
      proxima_renovacion: renewalDate,
      legajo: extractLegajo(patient),
      account_id: account.id ?? '',
    });
  }

  // Ordenar por apellido
  return rows.sort((a, b) => a.apellido.localeCompare(b.apellido, 'es'));
}

// ─── 2. Sesiones consumidas este ciclo ────────────────────────────────────────

async function countSessionsThisCycle(
  medplum: MedplumClient,
  patientRef: string
): Promise<number> {
  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1)
    .toISOString()
    .slice(0, 10);

  const bundle: Bundle = await medplum.search('ChargeItem', {
    subject: patientRef,
    'entered-date': `ge${firstOfMonth}`,
    status: 'billed',
    _count: '100',
    _summary: 'count',
  });

  return bundle.total ?? 0;
}

// ─── 3. Estado de última Invoice ──────────────────────────────────────────────

async function getLatestInvoiceStatus(
  medplum: MedplumClient,
  accountId: string
): Promise<string> {
  const bundle: Bundle = await medplum.search('Invoice', {
    account: accountId,
    _sort: '-date',
    _count: '1',
  });

  const invoice = bundle.entry?.[0]?.resource as Invoice | undefined;
  if (!invoice) return 'sin-factura';

  const statusMap: Record<string, string> = {
    balanced: 'pagado',
    issued: 'pendiente',
    cancelled: 'cancelado',
    draft: 'borrador',
  };
  return statusMap[invoice.status ?? ''] ?? invoice.status ?? 'desconocido';
}

// ─── 4. Generar CSV ───────────────────────────────────────────────────────────

function toCsv(rows: MemberRow[]): string {
  const headers = [
    'apellido',
    'nombre',
    'DNI',
    'email',
    'telefono',
    'plan',
    'precio_mensual',
    'sesiones_incluidas',
    'sesiones_consumidas',
    'sesiones_disponibles',
    'estado_pago',
    'proxima_renovacion',
    'legajo',
    'account_id',
  ];

  const escape = (v: string | number): string => {
    const s = String(v);
    // Escapar comas, comillas y saltos de línea según RFC 4180
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };

  const lines = [
    headers.join(','),
    ...rows.map(r =>
      [
        r.apellido,
        r.nombre,
        r.dni,
        r.email,
        r.telefono,
        r.plan,
        r.precio,
        r.sesiones_incluidas,
        r.sesiones_consumidas,
        r.sesiones_disponibles,
        r.estado_pago,
        r.proxima_renovacion,
        r.legajo,
        r.account_id,
      ]
        .map(escape)
        .join(',')
    ),
  ];

  // BOM UTF-8 para que Excel lo abra correctamente con acentos
  return '\uFEFF' + lines.join('\r\n');
}

// ─── 5. Entregar CSV por Communication ───────────────────────────────────────

async function deliverCsv(
  medplum: MedplumClient,
  csv: string,
  count: number
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10);
  const filename = `biowellness-membresias-${today}.csv`;

  // Subir como Binary en Medplum
  const binary = await medplum.createBinary(
    Buffer.from(csv, 'utf-8'),
    filename,
    'text/csv'
  );

  // Crear Communication con el archivo adjunto
  const comm: Communication = {
    resourceType: 'Communication',
    status: 'completed',
    category: [
      {
        coding: [
          {
            system: 'http://biowellness.ar/communication-category',
            code: 'export-report',
            display: 'Reporte de exportación',
          },
        ],
      },
    ],
    subject: { display: 'BioWellness — Reporte de membresías' },
    sent: new Date().toISOString(),
    payload: [
      {
        contentString: `Exportación de membresías activas al ${today}. Total: ${count} registros.`,
      },
      {
        contentAttachment: {
          contentType: 'text/csv',
          url: medplum.storageBaseUrl + binary.id,
          title: filename,
        },
      },
    ],
    note: [
      {
        text: `Generado automáticamente por bot-export-membresias. Ciclo: ${today}.`,
      },
    ],
  };

  await medplum.createResource(comm);
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function indexResources<T extends { id?: string }>(
  entries: BundleEntry[],
  resourceType: string
): Record<string, T> {
  return Object.fromEntries(
    entries
      .filter(e => e.resource?.resourceType === resourceType)
      .map(e => [(e.resource as T).id ?? '', e.resource as T])
  );
}

function findCoverageForPatient(
  coverages: Record<string, Coverage>,
  patientRef: string
): Coverage | undefined {
  return Object.values(coverages).find(c =>
    c.beneficiary?.reference === patientRef ||
    c.subscriber?.reference === patientRef
  );
}

function extractDni(patient: Patient): string {
  return (
    patient.identifier?.find(
      i => i.system === 'http://biowellness.ar/dni' ||
           i.type?.coding?.[0]?.code === 'NI'
    )?.value ?? ''
  );
}

function extractTelecom(patient: Patient, system: 'email' | 'phone'): string {
  return patient.telecom?.find(t => t.system === system)?.value ?? '';
}

function extractPlanName(coverage: Coverage | undefined): string {
  return (
    coverage?.class_?.[0]?.name ??
    coverage?.type?.coding?.[0]?.display ??
    'Sin plan'
  );
}

function extractPrecio(coverage: Coverage | undefined): string {
  // El precio mensual se guarda en coverage.costToBeneficiary[0].valueQuantity
  const val = coverage?.costToBeneficiary?.[0]?.valueQuantity;
  if (!val) return '';
  return `${val.value ?? ''} ${val.unit ?? 'ARS'}`.trim();
}

function extractSesionesIncluidas(coverage: Coverage | undefined): number {
  // Sesiones del plan en coverage.class_[0].value (ej: "6")
  const raw = coverage?.class_?.[0]?.value ?? '0';
  return parseInt(raw, 10) || 0;
}

function extractLegajo(patient: Patient): string {
  return (
    patient.identifier?.find(
      i => i.system === 'http://biowellness.ar/legajo'
    )?.value ?? ''
  );
}
