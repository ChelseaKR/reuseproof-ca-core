/** Immutable contracts and evidence inputs for required-series evaluation. */

import { canonicalJson, compareCodeUnits, sha256 } from './canonical.js';
import { requireIanaTimeZone, requireStrictArray, requireStrictRecord } from './validation.js';

export const lifecycleStates = [
  'permitted',
  'commissioning',
  'in_service',
  'suspended',
  'decommissioning',
] as const;

export type LifecycleState = (typeof lifecycleStates)[number];

export interface TimeRange {
  readonly start: string;
  readonly end: string;
}

export interface ActivationBasis {
  readonly permitVersionId: string;
  readonly profileVersionId: string;
  readonly lifecycleApprovalId: string;
  readonly treatmentBasisId: string;
}

export interface RequiredSeriesContract {
  readonly schemaVersion: 'required-series-contract/v1';
  readonly contractId: string;
  readonly version: string;
  readonly tenantId: string;
  readonly systemId: string;
  readonly processCode: string;
  readonly parameterCode: string;
  readonly statistic: string;
  readonly canonicalUnit: string;
  readonly activationBasis: ActivationBasis;
  readonly eligibleLifecycleStates: readonly LifecycleState[];
  readonly effectiveRange: TimeRange;
  readonly cadenceMinutes: number;
  readonly timezone: string;
  readonly criticality: 'required' | 'report_critical';
  readonly aggregateMembership: readonly string[];
}

export interface VendorMapping {
  readonly schemaVersion: 'vendor-mapping/v1';
  readonly mappingId: string;
  readonly version: string;
  readonly contractId: string;
  readonly vendorField: string;
  readonly sourceUnit: string;
}

export type QuarantineReason =
  | 'ambiguous_timestamp'
  | 'conflicting_duplicate'
  | 'impossible_unit'
  | 'malformed_value'
  | 'unmapped_value';

interface ObservationBase {
  readonly observationId: string;
  readonly contractId: string;
  readonly observedAt: string;
  readonly sourceFingerprint: string;
}

export type Observation =
  | (ObservationBase & {
      readonly qualityState: 'accepted';
      readonly quarantineReason?: never;
      readonly supersededBy?: string;
    })
  | (ObservationBase & {
      readonly qualityState: 'quarantined';
      readonly quarantineReason: QuarantineReason;
      readonly supersededBy?: never;
    });

export interface ScheduledNonoperation {
  readonly nonoperationId: string;
  readonly contractId: string;
  readonly range: TimeRange;
  readonly authorizedAt: string;
  readonly evidenceId: string;
}

export interface ContractMappingBinding {
  readonly contract: RequiredSeriesContract;
  readonly mapping: VendorMapping | null;
}

/** Content-address one complete immutable denominator contract. */
export function hashRequiredSeriesContract(contract: RequiredSeriesContract): string {
  const normalizedContract = createRequiredSeriesContract(contract);
  return sha256(
    canonicalJson({
      schemaVersion: 'required-series-contract-binding/v1',
      contract: normalizedContract,
    }),
  );
}

/** Content-address a contract set independently of caller ordering. */
export function hashRequiredSeriesContractSet(
  contracts: readonly RequiredSeriesContract[],
): string {
  const ordered = requireStrictArray(contracts, 'required-series contract set')
    .map(createRequiredSeriesContract)
    .sort(
      (left, right) =>
        compareCodeUnits(left.contractId, right.contractId) ||
        compareCodeUnits(left.version, right.version),
    );
  const keys = ordered.map(({ contractId, version }) => `${contractId}\u0000${version}`);
  if (new Set(keys).size !== keys.length) {
    throw new RangeError('required-series contract set ID/version pairs must be unique');
  }
  return sha256(
    canonicalJson({
      schemaVersion: 'required-series-contract-set-binding/v1',
      contracts: ordered,
    }),
  );
}

const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function requiredString(value: Record<string, unknown>, key: string, label: string): string {
  const result = value[key];
  if (typeof result !== 'string' || result.trim() === '') {
    throw new TypeError(`${label}.${key} must be a non-empty string`);
  }
  return result;
}

function requiredStringArray(
  value: Record<string, unknown>,
  key: string,
  label: string,
): readonly string[] {
  const result = value[key];
  const items = requireStrictArray(result, `${label}.${key}`);
  if (items.some((item) => typeof item !== 'string' || item === '')) {
    throw new TypeError(`${label}.${key} must be an array of non-empty strings`);
  }
  const strings = items as string[];
  if (new Set(strings).size !== strings.length) {
    throw new TypeError(`${label}.${key} cannot contain duplicates`);
  }
  return [...strings];
}

/** Parse and normalize a fixed-millisecond UTC instant. */
export function instantMilliseconds(value: string, label = 'instant'): number {
  if (!instantPattern.test(value)) {
    throw new TypeError(`${label} must use fixed-millisecond UTC RFC 3339 format`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new TypeError(`${label} is not a valid UTC instant`);
  }
  return milliseconds;
}

/** Parse a non-empty half-open time range. */
export function createTimeRange(value: unknown, label = 'range'): TimeRange {
  const record = requireStrictRecord(value, ['start', 'end'], [], label);
  const start = requiredString(record, 'start', label);
  const end = requiredString(record, 'end', label);
  if (instantMilliseconds(start, `${label}.start`) >= instantMilliseconds(end, `${label}.end`)) {
    throw new RangeError(`${label} must satisfy start < end`);
  }
  return deepFreeze({ start, end });
}

function parseActivationBasis(value: unknown): ActivationBasis {
  const label = 'contract.activationBasis';
  const keys = [
    'permitVersionId',
    'profileVersionId',
    'lifecycleApprovalId',
    'treatmentBasisId',
  ] as const;
  const record = requireStrictRecord(value, keys, [], label);
  return deepFreeze({
    permitVersionId: requiredString(record, 'permitVersionId', label),
    profileVersionId: requiredString(record, 'profileVersionId', label),
    lifecycleApprovalId: requiredString(record, 'lifecycleApprovalId', label),
    treatmentBasisId: requiredString(record, 'treatmentBasisId', label),
  });
}

function parseLifecycleStates(value: Record<string, unknown>): readonly LifecycleState[] {
  const states = requiredStringArray(value, 'eligibleLifecycleStates', 'contract');
  const invalid = states.filter(
    (state): state is string => !(lifecycleStates as readonly string[]).includes(state),
  );
  if (invalid.length > 0 || states.length === 0) {
    throw new TypeError('contract.eligibleLifecycleStates must contain only supported states');
  }
  return states as readonly LifecycleState[];
}

/** Create a deeply frozen, immutable, effective-dated denominator contract. */
export function createRequiredSeriesContract(value: unknown): RequiredSeriesContract {
  const label = 'contract';
  const record = requireStrictRecord(
    value,
    [
      'schemaVersion',
      'contractId',
      'version',
      'tenantId',
      'systemId',
      'processCode',
      'parameterCode',
      'statistic',
      'canonicalUnit',
      'activationBasis',
      'eligibleLifecycleStates',
      'effectiveRange',
      'cadenceMinutes',
      'timezone',
      'criticality',
      'aggregateMembership',
    ],
    [],
    label,
  );
  if (record.schemaVersion !== 'required-series-contract/v1') {
    throw new TypeError('contract.schemaVersion must be required-series-contract/v1');
  }
  const cadenceMinutes = record.cadenceMinutes;
  if (!Number.isSafeInteger(cadenceMinutes) || (cadenceMinutes as number) <= 0) {
    throw new TypeError('contract.cadenceMinutes must be a positive safe integer');
  }
  const timezone = requireIanaTimeZone(record.timezone, 'contract.timezone');
  if (record.criticality !== 'required' && record.criticality !== 'report_critical') {
    throw new TypeError('contract.criticality must be required or report_critical');
  }
  return deepFreeze({
    schemaVersion: 'required-series-contract/v1',
    contractId: requiredString(record, 'contractId', label),
    version: requiredString(record, 'version', label),
    tenantId: requiredString(record, 'tenantId', label),
    systemId: requiredString(record, 'systemId', label),
    processCode: requiredString(record, 'processCode', label),
    parameterCode: requiredString(record, 'parameterCode', label),
    statistic: requiredString(record, 'statistic', label),
    canonicalUnit: requiredString(record, 'canonicalUnit', label),
    activationBasis: parseActivationBasis(record.activationBasis),
    eligibleLifecycleStates: parseLifecycleStates(record),
    effectiveRange: createTimeRange(record.effectiveRange, 'contract.effectiveRange'),
    cadenceMinutes: cadenceMinutes as number,
    timezone,
    criticality: record.criticality,
    aggregateMembership: requiredStringArray(record, 'aggregateMembership', label),
  });
}

/** Parse a transport-only mapping, rejecting every denominator-shaped extra field. */
export function createVendorMapping(value: unknown): VendorMapping {
  const label = 'mapping';
  const record = requireStrictRecord(
    value,
    ['schemaVersion', 'mappingId', 'version', 'contractId', 'vendorField', 'sourceUnit'],
    [],
    label,
  );
  if (record.schemaVersion !== 'vendor-mapping/v1') {
    throw new TypeError('mapping.schemaVersion must be vendor-mapping/v1');
  }
  return deepFreeze({
    schemaVersion: 'vendor-mapping/v1',
    mappingId: requiredString(record, 'mappingId', label),
    version: requiredString(record, 'version', label),
    contractId: requiredString(record, 'contractId', label),
    vendorField: requiredString(record, 'vendorField', label),
    sourceUnit: requiredString(record, 'sourceUnit', label),
  });
}

/** Bind mappings without filtering or mutating the independently approved required set. */
export function bindVendorMappings(
  contracts: readonly RequiredSeriesContract[],
  mappings: readonly VendorMapping[],
): readonly ContractMappingBinding[] {
  const normalizedContracts = requireStrictArray(contracts, 'required contracts').map(
    createRequiredSeriesContract,
  );
  const normalizedMappings = requireStrictArray(mappings, 'vendor mappings').map(
    createVendorMapping,
  );
  const contractIds = new Set(normalizedContracts.map(({ contractId }) => contractId));
  if (contractIds.size !== normalizedContracts.length) {
    throw new RangeError('required contracts must have unique contract IDs');
  }
  const mappingByContract = new Map<string, VendorMapping>();
  for (const mapping of normalizedMappings) {
    if (!contractIds.has(mapping.contractId)) {
      throw new RangeError(`mapping ${mapping.mappingId} references an unknown required contract`);
    }
    if (mappingByContract.has(mapping.contractId)) {
      throw new RangeError(`more than one mapping targets required contract ${mapping.contractId}`);
    }
    mappingByContract.set(mapping.contractId, mapping);
  }
  return deepFreeze(
    normalizedContracts
      .sort((left, right) => compareCodeUnits(left.contractId, right.contractId))
      .map((contract) => ({
        contract,
        mapping: mappingByContract.get(contract.contractId) ?? null,
      })),
  );
}

/** Parse a normalized observation without inferring or repairing ambiguous evidence. */
export function createObservation(value: unknown): Observation {
  const label = 'observation';
  const record = requireStrictRecord(
    value,
    ['observationId', 'contractId', 'observedAt', 'sourceFingerprint', 'qualityState'],
    ['quarantineReason', 'supersededBy'],
    label,
  );
  if (record.qualityState !== 'accepted' && record.qualityState !== 'quarantined') {
    throw new TypeError('observation.qualityState must be accepted or quarantined');
  }
  const hasQuarantineReason = Object.hasOwn(record, 'quarantineReason');
  const hasSupersededBy = Object.hasOwn(record, 'supersededBy');
  const quarantineReasons: readonly QuarantineReason[] = [
    'ambiguous_timestamp',
    'conflicting_duplicate',
    'impossible_unit',
    'malformed_value',
    'unmapped_value',
  ];
  if (
    record.qualityState === 'quarantined' &&
    (!hasQuarantineReason ||
      typeof record.quarantineReason !== 'string' ||
      !quarantineReasons.includes(record.quarantineReason as QuarantineReason))
  ) {
    throw new TypeError('quarantined observations require a supported quarantineReason');
  }
  if (record.qualityState === 'accepted' && hasQuarantineReason) {
    throw new TypeError('accepted observations cannot have a quarantineReason');
  }
  if (hasSupersededBy && record.qualityState !== 'accepted') {
    throw new TypeError('only accepted observations can be superseded');
  }
  const observedAt = requiredString(record, 'observedAt', label);
  instantMilliseconds(observedAt, 'observation.observedAt');
  const base = {
    observationId: requiredString(record, 'observationId', label),
    contractId: requiredString(record, 'contractId', label),
    observedAt,
    sourceFingerprint: requiredString(record, 'sourceFingerprint', label),
  };
  const observation: Observation =
    record.qualityState === 'quarantined'
      ? {
          ...base,
          qualityState: 'quarantined',
          quarantineReason: record.quarantineReason as QuarantineReason,
        }
      : {
          ...base,
          qualityState: 'accepted',
          ...(hasSupersededBy
            ? { supersededBy: requiredString(record, 'supersededBy', label) }
            : {}),
        };
  return deepFreeze(observation);
}

/** Parse prior authorization for a scheduled nonoperation interval. */
export function createScheduledNonoperation(value: unknown): ScheduledNonoperation {
  const label = 'scheduledNonoperation';
  const record = requireStrictRecord(
    value,
    ['nonoperationId', 'contractId', 'range', 'authorizedAt', 'evidenceId'],
    [],
    label,
  );
  const authorizedAt = requiredString(record, 'authorizedAt', label);
  instantMilliseconds(authorizedAt, 'scheduledNonoperation.authorizedAt');
  return deepFreeze({
    nonoperationId: requiredString(record, 'nonoperationId', label),
    contractId: requiredString(record, 'contractId', label),
    range: createTimeRange(record.range, 'scheduledNonoperation.range'),
    authorizedAt,
    evidenceId: requiredString(record, 'evidenceId', label),
  });
}

/** Recursively freeze plain domain structures at their creation boundary. */
export function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}
