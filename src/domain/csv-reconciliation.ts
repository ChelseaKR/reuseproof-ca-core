/** Deterministic cross-source reconciliation for governed CSV measurement normalization. */

import { canonicalJson, compareCodeUnits, sha256 } from './canonical.js';
import {
  createCsvMeasurementMapping,
  normalizeCsvMeasurements,
  type CsvMeasurementNormalizationInput,
  type CsvMeasurementNormalizationOutcome,
  type CsvMeasurementNormalizationResult,
} from './csv-normalization.js';
import { createObservation, deepFreeze, type Observation, type QuarantineReason } from './model.js';
import { type NumericObservationValue } from './numeric-aggregation.js';
import { requireStrictArray, requireStrictRecord } from './validation.js';

export const MAX_CSV_RECONCILIATION_SOURCES = 64;

export interface CsvMeasurementReconciliationInput {
  readonly sources: readonly CsvMeasurementNormalizationInput[];
}

export interface CsvMeasurementReconciledSource {
  readonly sourceObjectHash: string;
  readonly sourceByteLength: number;
  readonly sourceDisposition: CsvMeasurementNormalizationResult['sourceDisposition'];
  readonly sourceRejectionReason: CsvMeasurementNormalizationResult['sourceRejectionReason'];
  readonly normalizationCandidateCount: number;
  readonly normalizationHash: string;
  readonly submissionCount: number;
}

export interface CsvMeasurementReconciliationCandidate {
  readonly sourceObjectHash: string;
  readonly recordNumber: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly rowFingerprint: string;
  readonly normalizationKind: CsvMeasurementNormalizationOutcome['kind'];
  readonly normalizationReason: QuarantineReason | null;
  readonly observationId: string | null;
  readonly semanticHash: string;
}

export type CsvMeasurementReconciliationOutcome =
  | {
      readonly kind: 'accepted';
      readonly identityHash: string;
      readonly observationId: string;
      readonly canonicalCandidate: CsvMeasurementReconciliationCandidate;
      readonly replayCandidates: readonly CsvMeasurementReconciliationCandidate[];
    }
  | {
      readonly kind: 'quarantine';
      readonly identityHash: string;
      readonly reason: QuarantineReason;
      readonly observationId: string | null;
      readonly canonicalCandidate: CsvMeasurementReconciliationCandidate;
      readonly replayCandidates: readonly CsvMeasurementReconciliationCandidate[];
    }
  | {
      readonly kind: 'conflict';
      readonly identityHash: string;
      readonly reason: 'conflicting_duplicate';
      readonly observationId: string | null;
      readonly conflictHash: string;
      readonly candidates: readonly CsvMeasurementReconciliationCandidate[];
    };

export interface CsvMeasurementReconciliationResult {
  readonly schemaVersion: 'csv-measurement-reconciliation-result/v1';
  readonly requiredSeriesContractId: string;
  readonly requiredSeriesContractVersion: string;
  readonly requiredSeriesContractHash: string;
  readonly csvContractHash: string;
  readonly mappingHash: string;
  readonly conversionRuleSetHash: string;
  readonly submittedSourceCount: number;
  readonly uniqueSourceCount: number;
  readonly duplicateSourceSubmissionCount: number;
  readonly rejectedSourceCount: number;
  readonly submittedCandidateCount: number;
  readonly uniqueSourceCandidateCount: number;
  readonly acceptedIdentityCount: number;
  readonly quarantinedIdentityCount: number;
  readonly conflictingIdentityCount: number;
  readonly semanticReplayCandidateCount: number;
  readonly sources: readonly CsvMeasurementReconciledSource[];
  readonly outcomes: readonly CsvMeasurementReconciliationOutcome[];
  readonly observations: readonly Observation[];
  readonly numericObservations: readonly NumericObservationValue[];
  readonly reconciliationHash: string;
}

interface NormalizedSubmission {
  readonly input: CsvMeasurementNormalizationInput;
  readonly result: CsvMeasurementNormalizationResult;
}

type InternalCandidate =
  | {
      readonly kind: 'accepted';
      readonly identityHash: string;
      readonly public: CsvMeasurementReconciliationCandidate;
      readonly observation: Observation;
      readonly numeric: NumericObservationValue;
    }
  | {
      readonly kind: 'quarantine';
      readonly identityHash: string;
      readonly public: CsvMeasurementReconciliationCandidate;
      readonly reason: QuarantineReason;
      readonly observation: Observation | null;
      readonly numeric: null;
    };

function invariant<T>(value: T | undefined, message: string): T {
  /* v8 ignore next -- normalization constructs the joined routing/observation preimages. */
  if (value === undefined) {
    throw new RangeError(message);
  }
  return value;
}

function compareCandidates(
  left: CsvMeasurementReconciliationCandidate,
  right: CsvMeasurementReconciliationCandidate,
): number {
  return compareCodeUnits(left.sourceObjectHash, right.sourceObjectHash);
}

function validateGovernance(submissions: readonly NormalizedSubmission[]): void {
  const baseline = invariant(submissions[0], 'CSV reconciliation requires at least one source');
  const baselineResult = baseline.result;
  for (const submission of submissions) {
    const mapping = createCsvMeasurementMapping(submission.input.mapping);
    if (!submission.input.csvContract.identityFields.includes(mapping.observedAtField)) {
      throw new RangeError(
        'CSV reconciliation requires the mapped observed-at field in source identityFields',
      );
    }
    const result = submission.result;
    if (
      result.requiredSeriesContractHash !== baselineResult.requiredSeriesContractHash ||
      result.routing.contractHash !== baselineResult.routing.contractHash ||
      result.mappingHash !== baselineResult.mappingHash ||
      result.conversionRuleSetHash !== baselineResult.conversionRuleSetHash
    ) {
      throw new RangeError('CSV reconciliation sources must share identical governed contracts');
    }
  }
}

function candidateFromOutcome(
  submission: NormalizedSubmission,
  outcome: CsvMeasurementNormalizationOutcome,
): InternalCandidate {
  const { result } = submission;
  const routingRow = invariant(
    result.routing.outcomes.find(
      (row) => row.kind === 'accepted' && row.rowFingerprint === outcome.rowFingerprint,
    ),
    'CSV reconciliation could not join a normalization outcome to its routed row',
  );
  /* v8 ignore next -- the predicate above narrows this normalized routing outcome. */
  if (routingRow.kind !== 'accepted') {
    throw new RangeError('CSV reconciliation routing invariant failed');
  }
  const mapping = createCsvMeasurementMapping(submission.input.mapping);
  const observation =
    outcome.observationId === null
      ? null
      : invariant(
          result.observations.find(({ observationId }) => observationId === outcome.observationId),
          'CSV reconciliation could not join a normalization observation',
        );
  const numeric =
    outcome.kind === 'accepted'
      ? invariant(
          result.numericObservations.find(
            ({ observationId }) => observationId === outcome.observationId,
          ),
          'CSV reconciliation could not join an accepted numeric preimage',
        )
      : null;
  const sourceUnit =
    mapping.unit.kind === 'constant'
      ? mapping.unit.value
      : invariant(routingRow.values[mapping.unit.field], 'CSV reconciliation unit field is absent');
  const semanticHash = sha256(
    canonicalJson({
      schemaVersion: 'csv-measurement-reconciliation-semantic-candidate/v1',
      normalizationKind: outcome.kind,
      normalizationReason: outcome.kind === 'quarantine' ? outcome.reason : null,
      observedAt: invariant(
        routingRow.values[mapping.observedAtField],
        'CSV reconciliation observed-at field is absent',
      ),
      sourceValue: invariant(
        routingRow.values[mapping.valueField],
        'CSV reconciliation value field is absent',
      ),
      sourceUnit,
      conversionRuleId: numeric?.conversionRuleId ?? null,
      conversionRuleVersion: numeric?.conversionRuleVersion ?? null,
    }),
  );
  const publicCandidate = deepFreeze({
    sourceObjectHash: result.routing.sourceObjectHash,
    recordNumber: outcome.recordNumber,
    startLine: outcome.startLine,
    endLine: outcome.endLine,
    rowFingerprint: outcome.rowFingerprint,
    normalizationKind: outcome.kind,
    normalizationReason: outcome.kind === 'quarantine' ? outcome.reason : null,
    observationId: outcome.observationId,
    semanticHash,
  });
  if (outcome.kind === 'accepted') {
    return {
      kind: 'accepted',
      identityHash: outcome.identityHash,
      public: publicCandidate,
      observation: invariant(
        result.observations.find(({ observationId }) => observationId === outcome.observationId),
        'CSV reconciliation observation is absent',
      ),
      numeric: invariant(
        result.numericObservations.find(
          ({ observationId }) => observationId === outcome.observationId,
        ),
        'CSV reconciliation numeric preimage is absent',
      ),
    };
  }
  return {
    kind: 'quarantine',
    identityHash: outcome.identityHash,
    public: publicCandidate,
    reason: outcome.reason,
    observation,
    numeric: null,
  };
}

function conflictObservation(
  candidates: readonly InternalCandidate[],
  identityHash: string,
  contractId: string,
  governanceHash: string,
): { readonly conflictHash: string; readonly observation: Observation | null } {
  const conflictHash = sha256(
    canonicalJson({
      schemaVersion: 'csv-measurement-conflict-binding/v1',
      identityHash,
      governanceHash,
      candidates: candidates.map(({ public: candidate }) => candidate),
    }),
  );
  const observedTimes = [
    ...new Set(
      candidates.flatMap(({ observation }) =>
        observation === null ? [] : [observation.observedAt],
      ),
    ),
  ];
  /* v8 ignore next -- observed-at participates in governed identity for every candidate. */
  if (observedTimes.length > 1) {
    throw new RangeError('CSV reconciliation identity resolved to multiple observed times');
  }
  const observedAt = observedTimes[0];
  if (observedAt === undefined) {
    return { conflictHash, observation: null };
  }
  return {
    conflictHash,
    observation: createObservation({
      observationId: sha256(
        canonicalJson({
          schemaVersion: 'csv-measurement-conflict-observation-identity/v1',
          identityHash,
          governanceHash,
          conflictHash,
        }),
      ),
      contractId,
      observedAt,
      sourceFingerprint: conflictHash,
      qualityState: 'quarantined',
      quarantineReason: 'conflicting_duplicate',
    }),
  };
}

function withReconciliationHash(
  result: Omit<CsvMeasurementReconciliationResult, 'reconciliationHash'>,
): CsvMeasurementReconciliationResult {
  return deepFreeze({
    ...result,
    reconciliationHash: sha256(
      canonicalJson({ schemaVersion: 'csv-measurement-reconciliation-binding/v1', result }),
    ),
  });
}

/**
 * Rerun exact normalization inputs, collapse semantic replays, and quarantine conflicts.
 * No caller-selected normalized winner crosses this boundary.
 */
export function reconcileCsvMeasurementSources(
  input: CsvMeasurementReconciliationInput,
): CsvMeasurementReconciliationResult {
  const outer = requireStrictRecord(input, ['sources'], [], 'csvMeasurementReconciliation');
  const sourceInputs = requireStrictArray(
    outer.sources,
    'csvMeasurementReconciliation.sources',
  ) as unknown as readonly CsvMeasurementNormalizationInput[];
  if (sourceInputs.length === 0 || sourceInputs.length > MAX_CSV_RECONCILIATION_SOURCES) {
    throw new RangeError(
      `CSV reconciliation requires 1 through ${MAX_CSV_RECONCILIATION_SOURCES.toString()} sources`,
    );
  }
  const submissions = sourceInputs.map((source) => ({
    input: source,
    result: normalizeCsvMeasurements(source),
  }));
  validateGovernance(submissions);
  const baseline = invariant(submissions[0], 'CSV reconciliation requires at least one source');

  const bySourceHash = new Map<string, NormalizedSubmission[]>();
  for (const submission of submissions) {
    const hash = submission.result.routing.sourceObjectHash;
    bySourceHash.set(hash, [...(bySourceHash.get(hash) ?? []), submission]);
  }
  const uniqueSubmissions = [...bySourceHash.values()]
    .map((matches) => invariant(matches[0], 'CSV reconciliation source group cannot be empty'))
    .sort((left, right) =>
      compareCodeUnits(left.result.routing.sourceObjectHash, right.result.routing.sourceObjectHash),
    );
  const sources = uniqueSubmissions.map((submission) => {
    const result = submission.result;
    return {
      sourceObjectHash: result.routing.sourceObjectHash,
      sourceByteLength: result.routing.sourceByteLength,
      sourceDisposition: result.sourceDisposition,
      sourceRejectionReason: result.sourceRejectionReason,
      normalizationCandidateCount: result.normalizationCandidateCount,
      normalizationHash: result.normalizationHash,
      submissionCount: invariant(
        bySourceHash.get(result.routing.sourceObjectHash),
        'CSV reconciliation source multiplicity is absent',
      ).length,
    };
  });

  const groups = new Map<string, InternalCandidate[]>();
  for (const submission of uniqueSubmissions) {
    for (const outcome of submission.result.outcomes) {
      const candidate = candidateFromOutcome(submission, outcome);
      groups.set(candidate.identityHash, [
        ...(groups.get(candidate.identityHash) ?? []),
        candidate,
      ]);
    }
  }

  const outcomes: CsvMeasurementReconciliationOutcome[] = [];
  const observations: Observation[] = [];
  const numericObservations: NumericObservationValue[] = [];
  let semanticReplayCandidateCount = 0;
  let acceptedIdentityCount = 0;
  let quarantinedIdentityCount = 0;
  let conflictingIdentityCount = 0;
  const governanceHash = sha256(
    canonicalJson({
      schemaVersion: 'csv-measurement-reconciliation-governance-binding/v1',
      requiredSeriesContractHash: baseline.result.requiredSeriesContractHash,
      csvContractHash: baseline.result.routing.contractHash,
      mappingHash: baseline.result.mappingHash,
      conversionRuleSetHash: baseline.result.conversionRuleSetHash,
    }),
  );

  for (const identityHash of [...groups.keys()].sort(compareCodeUnits)) {
    const candidates = invariant(groups.get(identityHash), 'CSV reconciliation identity is absent')
      .slice()
      .sort((left, right) => compareCandidates(left.public, right.public));
    const semanticHashes = new Set(
      candidates.map(({ public: candidate }) => candidate.semanticHash),
    );
    if (semanticHashes.size === 1) {
      const canonical = invariant(candidates[0], 'CSV reconciliation candidate group is empty');
      const replays = candidates.slice(1).map(({ public: candidate }) => candidate);
      semanticReplayCandidateCount += replays.length;
      if (canonical.kind === 'accepted') {
        observations.push(canonical.observation);
        numericObservations.push(canonical.numeric);
        acceptedIdentityCount += 1;
        outcomes.push({
          kind: 'accepted',
          identityHash,
          observationId: canonical.observation.observationId,
          canonicalCandidate: canonical.public,
          replayCandidates: replays,
        });
      } else {
        if (canonical.observation !== null) {
          observations.push(canonical.observation);
        }
        quarantinedIdentityCount += 1;
        outcomes.push({
          kind: 'quarantine',
          identityHash,
          reason: canonical.reason,
          observationId: canonical.observation?.observationId ?? null,
          canonicalCandidate: canonical.public,
          replayCandidates: replays,
        });
      }
      continue;
    }

    const conflict = conflictObservation(
      candidates,
      identityHash,
      baseline.result.requiredSeriesContractId,
      governanceHash,
    );
    if (conflict.observation !== null) {
      observations.push(conflict.observation);
    }
    quarantinedIdentityCount += 1;
    conflictingIdentityCount += 1;
    outcomes.push({
      kind: 'conflict',
      identityHash,
      reason: 'conflicting_duplicate',
      observationId: conflict.observation?.observationId ?? null,
      conflictHash: conflict.conflictHash,
      candidates: candidates.map(({ public: candidate }) => candidate),
    });
  }

  observations.sort((left, right) => compareCodeUnits(canonicalJson(left), canonicalJson(right)));
  numericObservations.sort((left, right) =>
    compareCodeUnits(left.observationId, right.observationId),
  );
  return withReconciliationHash({
    schemaVersion: 'csv-measurement-reconciliation-result/v1',
    requiredSeriesContractId: baseline.result.requiredSeriesContractId,
    requiredSeriesContractVersion: baseline.result.requiredSeriesContractVersion,
    requiredSeriesContractHash: baseline.result.requiredSeriesContractHash,
    csvContractHash: baseline.result.routing.contractHash,
    mappingHash: baseline.result.mappingHash,
    conversionRuleSetHash: baseline.result.conversionRuleSetHash,
    submittedSourceCount: submissions.length,
    uniqueSourceCount: uniqueSubmissions.length,
    duplicateSourceSubmissionCount: submissions.length - uniqueSubmissions.length,
    rejectedSourceCount: uniqueSubmissions.filter(
      ({ result }) => result.sourceDisposition === 'rejected_before_persistence',
    ).length,
    submittedCandidateCount: submissions.reduce(
      (count, { result }) => count + result.normalizationCandidateCount,
      0,
    ),
    uniqueSourceCandidateCount: uniqueSubmissions.reduce(
      (count, { result }) => count + result.normalizationCandidateCount,
      0,
    ),
    acceptedIdentityCount,
    quarantinedIdentityCount,
    conflictingIdentityCount,
    semanticReplayCandidateCount,
    sources,
    outcomes,
    observations,
    numericObservations,
  });
}
