/** Synthetic-fixture parser and end-to-end domain entrypoint. */

import {
  bindVendorMappings,
  createObservation,
  createRequiredSeriesContract,
  createScheduledNonoperation,
  createTimeRange,
  createVendorMapping,
  deepFreeze,
  hashRequiredSeriesContract,
  lifecycleStates,
  type LifecycleState,
  type Observation,
  type RequiredSeriesContract,
  type ScheduledNonoperation,
  type TimeRange,
  type VendorMapping,
} from './domain/model.js';
import { canonicalJson, sha256 } from './domain/canonical.js';
import {
  evaluateCoverage,
  type CoverageEvaluationInput,
  type CoverageSummary,
} from './domain/coverage.js';
import { parseBoundedJson, type JsonParseLimits } from './domain/json.js';
import { createLifecycleTimeline, type LifecycleTimeline } from './domain/lifecycle.js';
import { evaluateCoverageReadiness, type CoverageReadinessReport } from './domain/readiness.js';
import {
  createUnsignedReceipt,
  type NamedHash,
  type PinnedVersion,
  type UnsignedReceipt,
} from './domain/receipt.js';
import {
  createReportTimeBasis,
  resolveCivilTimeRange,
  type ReportTimeBasis,
} from './domain/time.js';
import { requireStrictArray, requireStrictRecord } from './domain/validation.js';
import { freezeReport, type FrozenReport } from './report-lifecycle.js';

interface EvaluationFixtureBase {
  readonly tenantId: string;
  readonly systemId: string;
  readonly reportRange: TimeRange;
  readonly reportTimeBasis: ReportTimeBasis;
  readonly contracts: readonly RequiredSeriesContract[];
  readonly mappings: readonly VendorMapping[];
  readonly observations: readonly Observation[];
  readonly scheduledNonoperations: readonly ScheduledNonoperation[];
  readonly sourceHashes: readonly NamedHash[];
  readonly pinnedVersions: readonly PinnedVersion[];
}

export type EvaluationFixture = EvaluationFixtureBase &
  (
    | {
        readonly lifecycleState: LifecycleState;
        readonly lifecycleTimeline?: never;
      }
    | {
        readonly lifecycleTimeline: LifecycleTimeline;
        readonly lifecycleState?: never;
      }
  );

export interface EvaluationResult {
  readonly requiredSet: readonly {
    readonly contractId: string;
    readonly mappingId: string | null;
  }[];
  readonly coverageSummaries: readonly CoverageSummary[];
  readonly coverageReadiness: CoverageReadinessReport;
  readonly receipt: UnsignedReceipt;
  readonly frozenReport: FrozenReport;
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const result = value[key];
  if (typeof result !== 'string' || result === '') {
    throw new TypeError(`${label}.${key} must be a non-empty string`);
  }
  return result;
}

function arrayField(
  value: Record<string, unknown>,
  key: string,
  label: string,
): readonly unknown[] {
  return requireStrictArray(value[key], `${label}.${key}`);
}

function parseNamedHash(value: unknown): NamedHash {
  const item = requireStrictRecord(value, ['logicalName', 'sha256'], [], 'sourceHash');
  return {
    logicalName: stringField(item, 'logicalName', 'sourceHash'),
    sha256: stringField(item, 'sha256', 'sourceHash'),
  };
}

function parsePinnedVersion(value: unknown): PinnedVersion {
  const item = requireStrictRecord(value, ['name', 'value'], [], 'pinnedVersion');
  return {
    name: stringField(item, 'name', 'pinnedVersion'),
    value: stringField(item, 'value', 'pinnedVersion'),
  };
}

type FixtureLifecycleChoice =
  { readonly lifecycleState: LifecycleState } | { readonly lifecycleTimeline: LifecycleTimeline };

function parseFixtureLifecycleChoice(
  value: Record<string, unknown>,
  label: string,
): FixtureLifecycleChoice {
  const hasLifecycleState = Object.hasOwn(value, 'lifecycleState');
  const hasLifecycleTimeline = Object.hasOwn(value, 'lifecycleTimeline');
  if (hasLifecycleState === hasLifecycleTimeline) {
    throw new TypeError(`${label} requires exactly one of lifecycleState or lifecycleTimeline`);
  }
  if (hasLifecycleTimeline) {
    return { lifecycleTimeline: createLifecycleTimeline(value.lifecycleTimeline) };
  }
  const lifecycleState = value.lifecycleState;
  if (
    typeof lifecycleState !== 'string' ||
    !(lifecycleStates as readonly string[]).includes(lifecycleState)
  ) {
    throw new TypeError(`${label}.lifecycleState must be supported`);
  }
  return { lifecycleState: lifecycleState as LifecycleState };
}

function requireUniqueContracts(
  contracts: readonly RequiredSeriesContract[],
): readonly RequiredSeriesContract[] {
  if (
    contracts.length === 0 ||
    new Set(contracts.map(({ contractId }) => contractId)).size !== contracts.length
  ) {
    throw new TypeError('fixture.contracts must contain unique required contracts');
  }
  return contracts;
}

/** Parse an untrusted synthetic fixture through the same constructors as domain inputs. */
export function parseEvaluationFixture(value: unknown): EvaluationFixture {
  const fixture = requireStrictRecord(
    value,
    [
      'tenantId',
      'systemId',
      'contracts',
      'mappings',
      'observations',
      'scheduledNonoperations',
      'sourceHashes',
      'pinnedVersions',
    ],
    ['reportRange', 'civilReportRange', 'lifecycleState', 'lifecycleTimeline'],
    'fixture',
  );
  const hasReportRange = Object.hasOwn(fixture, 'reportRange');
  const hasCivilReportRange = Object.hasOwn(fixture, 'civilReportRange');
  if (hasReportRange === hasCivilReportRange) {
    throw new TypeError('fixture requires exactly one of reportRange or civilReportRange');
  }
  const resolvedReport = hasReportRange
    ? {
        reportRange: createTimeRange(fixture.reportRange, 'fixture.reportRange'),
        timeBasis: { kind: 'utc' as const },
      }
    : resolveCivilTimeRange(fixture.civilReportRange);
  const lifecycle = parseFixtureLifecycleChoice(fixture, 'fixture');
  const contracts = requireUniqueContracts(
    arrayField(fixture, 'contracts', 'fixture').map(createRequiredSeriesContract),
  );
  const base: EvaluationFixtureBase = {
    tenantId: stringField(fixture, 'tenantId', 'fixture'),
    systemId: stringField(fixture, 'systemId', 'fixture'),
    reportRange: resolvedReport.reportRange,
    reportTimeBasis: resolvedReport.timeBasis,
    contracts,
    mappings: arrayField(fixture, 'mappings', 'fixture').map(createVendorMapping),
    observations: arrayField(fixture, 'observations', 'fixture').map(createObservation),
    scheduledNonoperations: arrayField(fixture, 'scheduledNonoperations', 'fixture').map(
      createScheduledNonoperation,
    ),
    sourceHashes: arrayField(fixture, 'sourceHashes', 'fixture').map(parseNamedHash),
    pinnedVersions: arrayField(fixture, 'pinnedVersions', 'fixture').map(parsePinnedVersion),
  };
  return deepFreeze({ ...base, ...lifecycle });
}

/** Reconstruct the already-resolved evaluator shape before any deterministic domain work. */
function normalizeEvaluationFixture(value: unknown): EvaluationFixture {
  const fixture = requireStrictRecord(
    value,
    [
      'tenantId',
      'systemId',
      'reportRange',
      'reportTimeBasis',
      'contracts',
      'mappings',
      'observations',
      'scheduledNonoperations',
      'sourceHashes',
      'pinnedVersions',
    ],
    ['lifecycleState', 'lifecycleTimeline'],
    'evaluation fixture',
  );
  const base: EvaluationFixtureBase = {
    tenantId: stringField(fixture, 'tenantId', 'evaluation fixture'),
    systemId: stringField(fixture, 'systemId', 'evaluation fixture'),
    reportRange: createTimeRange(fixture.reportRange, 'evaluation fixture.reportRange'),
    reportTimeBasis: createReportTimeBasis(fixture.reportTimeBasis),
    contracts: requireUniqueContracts(
      arrayField(fixture, 'contracts', 'evaluation fixture').map(createRequiredSeriesContract),
    ),
    mappings: arrayField(fixture, 'mappings', 'evaluation fixture').map(createVendorMapping),
    observations: arrayField(fixture, 'observations', 'evaluation fixture').map(createObservation),
    scheduledNonoperations: arrayField(fixture, 'scheduledNonoperations', 'evaluation fixture').map(
      createScheduledNonoperation,
    ),
    sourceHashes: arrayField(fixture, 'sourceHashes', 'evaluation fixture').map(parseNamedHash),
    pinnedVersions: arrayField(fixture, 'pinnedVersions', 'evaluation fixture').map(
      parsePinnedVersion,
    ),
  };
  const lifecycle = parseFixtureLifecycleChoice(fixture, 'evaluation fixture');
  return deepFreeze({ ...base, ...lifecycle });
}

/** Parse raw fixture bytes without allowing duplicate keys or unbounded structures. */
export function parseEvaluationFixtureJson(
  text: string,
  limits?: JsonParseLimits,
): EvaluationFixture {
  return parseEvaluationFixture(
    limits === undefined ? parseBoundedJson(text) : parseBoundedJson(text, limits),
  );
}

/** Run the deterministic contract-to-coverage-to-receipt slice. */
export function evaluateFixture(fixture: EvaluationFixture): EvaluationResult {
  const evaluatedFixture = normalizeEvaluationFixture(fixture);
  const lifecycle: FixtureLifecycleChoice =
    'lifecycleTimeline' in evaluatedFixture
      ? { lifecycleTimeline: evaluatedFixture.lifecycleTimeline }
      : { lifecycleState: evaluatedFixture.lifecycleState };
  const requiredIds = new Set(evaluatedFixture.contracts.map(({ contractId }) => contractId));
  const unknownObservation = evaluatedFixture.observations.find(
    ({ contractId }) => !requiredIds.has(contractId),
  );
  if (unknownObservation !== undefined) {
    throw new RangeError(
      `observation ${unknownObservation.observationId} references an unknown required contract`,
    );
  }
  const unknownNonoperation = evaluatedFixture.scheduledNonoperations.find(
    ({ contractId }) => !requiredIds.has(contractId),
  );
  if (unknownNonoperation !== undefined) {
    throw new RangeError(
      `scheduled nonoperation ${unknownNonoperation.nonoperationId} references an unknown required contract`,
    );
  }
  const bindings = bindVendorMappings(evaluatedFixture.contracts, evaluatedFixture.mappings);
  const coverageEvaluationInputs: readonly CoverageEvaluationInput[] = bindings.map(
    ({ contract }) => {
      const base = {
        contract,
        reportRange: evaluatedFixture.reportRange,
        reportTimeBasis: evaluatedFixture.reportTimeBasis,
        observations: evaluatedFixture.observations.filter(
          ({ contractId }) => contractId === contract.contractId,
        ),
        scheduledNonoperations: evaluatedFixture.scheduledNonoperations,
      };
      return 'lifecycleTimeline' in lifecycle
        ? { ...base, lifecycleTimeline: lifecycle.lifecycleTimeline }
        : { ...base, lifecycleState: lifecycle.lifecycleState };
    },
  );
  const coverageSummaries = coverageEvaluationInputs.map(evaluateCoverage);
  const coverageReadiness = evaluateCoverageReadiness({
    contracts: bindings.map(({ contract }) => contract),
    coverageEvaluationInputs,
    coverageSummaries,
  });
  const lifecyclePin =
    'lifecycleTimeline' in lifecycle
      ? {
          name: `lifecycle-timeline:${lifecycle.lifecycleTimeline.version}`,
          value: sha256(canonicalJson(lifecycle.lifecycleTimeline)),
        }
      : {
          name: 'lifecycle-basis',
          value: `resolved-state:${lifecycle.lifecycleState}`,
        };
  const receipt = createUnsignedReceipt({
    tenantId: evaluatedFixture.tenantId,
    systemId: evaluatedFixture.systemId,
    reportPeriod: evaluatedFixture.reportRange,
    contracts: bindings.map(({ contract }) => contract),
    coverageEvaluationInputs,
    coverageSummaries,
    coverageReadiness,
    sourceHashes: evaluatedFixture.sourceHashes,
    pinnedVersions: [
      ...evaluatedFixture.pinnedVersions,
      lifecyclePin,
      {
        name: 'report-time-basis',
        value: sha256(canonicalJson(evaluatedFixture.reportTimeBasis)),
      },
      ...bindings.map(({ contract }) => ({
        name: `required-series-contract:${contract.contractId}@${contract.version}`,
        value: hashRequiredSeriesContract(contract),
      })),
      ...bindings.map(({ contract, mapping }) => ({
        name: `vendor-mapping:${contract.contractId}`,
        value: mapping === null ? 'unmapped' : sha256(canonicalJson(mapping)),
      })),
    ],
  });
  const frozenReport = freezeReport({ receipt, reportVersion: 1 });
  return deepFreeze({
    requiredSet: bindings.map(({ contract, mapping }) => ({
      contractId: contract.contractId,
      mappingId: mapping?.mappingId ?? null,
    })),
    coverageSummaries,
    coverageReadiness,
    receipt,
    frozenReport,
  });
}
