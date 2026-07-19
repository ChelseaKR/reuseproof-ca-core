/** Shared synthetic inputs for domain tests. */

export function contractInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 'required-series-contract/v1',
    contractId: 'contract-1',
    version: '1',
    tenantId: 'tenant-1',
    systemId: 'system-1',
    processCode: 'treatment',
    parameterCode: 'flow.treated.daily_avg',
    statistic: 'interval_observation',
    canonicalUnit: 'gal/day',
    activationBasis: {
      permitVersionId: 'permit-v1',
      profileVersionId: 'profile-v1',
      lifecycleApprovalId: 'lifecycle-v1',
      treatmentBasisId: 'train-v1',
    },
    eligibleLifecycleStates: ['in_service'],
    effectiveRange: {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-01T01:00:00.000Z',
    },
    cadenceMinutes: 15,
    timezone: 'America/Los_Angeles',
    criticality: 'required',
    aggregateMembership: ['annual-flow'],
    ...overrides,
  };
}

export function observationInput(
  observationId: string,
  observedAt: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    observationId,
    contractId: 'contract-1',
    observedAt,
    sourceFingerprint: `fingerprint-${observationId}`,
    qualityState: 'accepted',
    ...overrides,
  };
}

export function nonoperationInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    nonoperationId: 'stop-1',
    contractId: 'contract-1',
    range: {
      start: '2026-01-01T00:15:00.000Z',
      end: '2026-01-01T00:30:00.000Z',
    },
    authorizedAt: '2025-12-31T00:00:00.000Z',
    evidenceId: 'evidence-1',
    ...overrides,
  };
}

export function lifecyclePeriodInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    lifecycleEventId: 'lifecycle-event-1',
    state: 'in_service',
    effectiveRange: {
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-01T01:00:00.000Z',
    },
    evidenceId: 'synthetic-lifecycle-evidence-1',
    recordedAt: '2025-12-31T00:00:00.000Z',
    ...overrides,
  };
}

export function lifecycleTimelineInput(
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 'lifecycle-timeline/v1',
    version: 'synthetic-v1',
    tenantId: 'tenant-1',
    systemId: 'system-1',
    periods: [lifecyclePeriodInput()],
    ...overrides,
  };
}
