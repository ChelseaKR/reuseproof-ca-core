/** Focused synthetic builders for the reconciled CSV evidence vertical slice. */

import type {
  ReconciledCsvEvidenceInput,
  ReconciledCsvSeriesInput,
  RequiredSeriesContract,
} from '../src/index.js';
import { contractInput } from './helpers.js';

export const CSV_HEADER = 'id,observed_at,value,unit';
export const REPORT_RANGE = {
  start: '2026-01-01T00:00:00.000Z',
  end: '2026-01-01T01:00:00.000Z',
} as const;

export interface TestSeriesParts {
  readonly contract: RequiredSeriesContract;
  readonly series: ReconciledCsvSeriesInput;
}

export interface TestSeriesOptions {
  readonly contractId?: string;
  readonly contractVersion?: string;
  readonly tenantId?: string;
  readonly systemId?: string;
  readonly csvContractId?: string;
  readonly mappingVersionId?: string;
  readonly parameterCode?: string;
  readonly canonicalUnit?: string;
  readonly sourceUnit?: string;
  readonly sourceObjects?: readonly Uint8Array[];
  readonly contractOverrides?: Readonly<Record<string, unknown>>;
  readonly csvContractOverrides?: Readonly<Record<string, unknown>>;
  readonly mappingOverrides?: Readonly<Record<string, unknown>>;
  readonly conversionRuleOverrides?: Readonly<Record<string, unknown>>;
  readonly aggregatePolicyOverrides?: Readonly<Record<string, unknown>>;
}

export function csvBytes(...rows: readonly string[]): Uint8Array {
  return new TextEncoder().encode([CSV_HEADER, ...rows].join('\n'));
}

export function defaultCsvBytes(): Uint8Array {
  return csvBytes(
    'a,2026-01-01T00:05:00.000Z,2,source-unit',
    'b,2026-01-01T00:35:00.000Z,4,source-unit',
  );
}

export function testSeriesParts(options: TestSeriesOptions = {}): TestSeriesParts {
  const contractId = options.contractId ?? 'contract-1';
  const contractVersion = options.contractVersion ?? '1';
  const tenantId = options.tenantId ?? 'tenant-1';
  const systemId = options.systemId ?? 'system-1';
  const csvContractId = options.csvContractId ?? `csv-${contractId}`;
  const mappingVersionId = options.mappingVersionId ?? `mapping-${contractId}`;
  const parameterCode = options.parameterCode ?? 'flow.treated.daily_avg';
  const canonicalUnit = options.canonicalUnit ?? 'canonical-unit';
  const sourceUnit = options.sourceUnit ?? 'source-unit';
  const mappingReviewId = `mapping-review-${contractId}`;
  const contract = contractInput({
    contractId,
    version: contractVersion,
    tenantId,
    systemId,
    parameterCode,
    canonicalUnit,
    cadenceMinutes: 30,
    timezone: 'UTC',
    effectiveRange: REPORT_RANGE,
    aggregateMembership: [`annual-${contractId}`],
    ...options.contractOverrides,
  }) as unknown as RequiredSeriesContract;
  const csvContract = {
    schemaVersion: 'csv-adapter-source-contract/v1',
    contractId: csvContractId,
    version: '1',
    adapterId: 'generic-csv',
    mappingVersionId,
    sourceSchemaVersion: 'synthetic-v1',
    tenantId,
    systemId,
    effectiveRange: REPORT_RANGE,
    transport: {
      kind: 'customer_pushed_csv',
      encoding: 'utf-8',
      delimiter: ',',
    },
    columns: [
      { sourceName: 'id', requiredInSourceRow: true },
      { sourceName: 'observed_at', requiredInSourceRow: true },
      { sourceName: 'value', requiredInSourceRow: true },
      { sourceName: 'unit', requiredInSourceRow: true },
    ],
    identityFields: ['id', 'observed_at'],
    informationalDeliveryCadence: 'nominally every 30 minutes',
    approvals: {
      vendorOperatorReviewId: `vendor-review-${contractId}`,
      jurisdictionMappingReviewId: mappingReviewId,
      securityReviewId: `security-review-${contractId}`,
    },
    limits: {
      maxBytes: 10_000,
      maxRecords: 100,
      maxFieldBytes: 100,
    },
    ...options.csvContractOverrides,
  };
  const mapping = {
    schemaVersion: 'csv-measurement-mapping/v1',
    mappingVersionId,
    csvContractId,
    csvContractVersion: '1',
    requiredSeriesContractId: contractId,
    requiredSeriesContractVersion: contractVersion,
    observedAtField: 'observed_at',
    valueField: 'value',
    unit: { kind: 'column', field: 'unit' },
    timestampFormat: 'fixed_millisecond_utc',
    authorizationId: mappingReviewId,
    ...options.mappingOverrides,
  };
  const conversionRule = {
    schemaVersion: 'unit-conversion-rule/v1',
    ruleId: `conversion-${contractId}`,
    version: '1',
    parameterCode,
    sourceUnit,
    canonicalUnit,
    sourceOffset: '0',
    multiplierNumerator: '1',
    multiplierDenominator: '2',
    effectiveRange: {
      start: '2025-01-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    },
    authorizationId: `unit-dictionary-${contractId}`,
    ...options.conversionRuleOverrides,
  };
  const aggregatePolicy = {
    schemaVersion: 'daily-aggregate-policy/v1',
    policyId: `daily-policy-${contractId}`,
    version: '1',
    contractId,
    method: 'mean',
    decimalPlaces: 2,
    roundingMode: 'half_away_from_zero',
    timeZone: 'UTC',
    authorizationId: `profile-${contractId}`,
    ...options.aggregatePolicyOverrides,
  };
  return {
    contract,
    series: {
      requiredSeriesContractId: contractId,
      requiredSeriesContractVersion: contractVersion,
      csvContract: csvContract as unknown as ReconciledCsvSeriesInput['csvContract'],
      mapping: mapping as unknown as ReconciledCsvSeriesInput['mapping'],
      conversionRules: [
        conversionRule as unknown as ReconciledCsvSeriesInput['conversionRules'][number],
      ],
      aggregatePolicy: aggregatePolicy as unknown as ReconciledCsvSeriesInput['aggregatePolicy'],
      sourceObjects: options.sourceObjects ?? [defaultCsvBytes()],
    },
  };
}

export function reconciledEvidenceInput(
  parts: readonly TestSeriesParts[] = [testSeriesParts()],
  overrides: Readonly<Record<string, unknown>> = {},
): ReconciledCsvEvidenceInput {
  return {
    contracts: parts.map(({ contract }) => contract),
    reportRange: REPORT_RANGE,
    reportTimeBasis: { kind: 'utc' },
    lifecycleState: 'in_service',
    scheduledNonoperations: [],
    series: parts.map(({ series }) => series),
    ...overrides,
  } as unknown as ReconciledCsvEvidenceInput;
}

export function lifecycleTimeline(
  tenantId = 'tenant-1',
  systemId = 'system-1',
): Record<string, unknown> {
  return {
    schemaVersion: 'lifecycle-timeline/v1',
    version: 'timeline-v1',
    tenantId,
    systemId,
    periods: [
      {
        lifecycleEventId: 'lifecycle-event-in-service',
        state: 'in_service',
        effectiveRange: {
          start: REPORT_RANGE.start,
          end: '2026-01-01T00:30:00.000Z',
        },
        evidenceId: 'lifecycle-evidence-in-service',
        recordedAt: '2025-12-01T00:00:00.000Z',
      },
      {
        lifecycleEventId: 'lifecycle-event-suspended',
        state: 'suspended',
        effectiveRange: {
          start: '2026-01-01T00:30:00.000Z',
          end: REPORT_RANGE.end,
        },
        evidenceId: 'lifecycle-evidence-suspended',
        recordedAt: '2025-12-15T00:00:00.000Z',
      },
    ],
  };
}
