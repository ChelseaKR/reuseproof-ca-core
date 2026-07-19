import {
  createObservation,
  createRequiredSeriesContract,
  createTimeRange,
  createUnsignedReceipt,
  evaluateCoverage,
  type ReceiptInput,
  type UnsignedReceipt,
} from '../src/index.js';
import { contractInput, observationInput } from './helpers.js';

export interface TestReceiptOptions {
  readonly tenantId?: string;
  readonly systemId?: string;
  readonly contractId?: string;
  readonly contractOverrides?: Readonly<Record<string, unknown>>;
  readonly receiptOverrides?: Partial<ReceiptInput>;
}

export function createTestReceipt(options: TestReceiptOptions = {}): UnsignedReceipt {
  const tenantId = options.tenantId ?? 'tenant-1';
  const systemId = options.systemId ?? 'system-1';
  const contractId = options.contractId ?? 'contract-1';
  const reportPeriod = createTimeRange({
    start: '2026-01-01T00:00:00.000Z',
    end: '2026-01-01T01:00:00.000Z',
  });
  const contract = createRequiredSeriesContract(
    contractInput({
      tenantId,
      systemId,
      contractId,
      ...options.contractOverrides,
    }),
  );
  const evaluation = {
    contract,
    reportRange: reportPeriod,
    lifecycleState: 'in_service' as const,
    observations: [
      createObservation(
        observationInput(`observation-${contractId}`, '2026-01-01T00:00:00.000Z', {
          contractId,
        }),
      ),
    ],
    scheduledNonoperations: [],
  };
  const coverageSummary = evaluateCoverage(evaluation);
  return createUnsignedReceipt({
    tenantId,
    systemId,
    reportPeriod,
    contracts: [contract],
    coverageEvaluationInputs: [evaluation],
    coverageSummaries: [coverageSummary],
    sourceHashes: [{ logicalName: 'synthetic.csv', sha256: 'a'.repeat(64) }],
    pinnedVersions: [{ name: 'algorithm', value: 'coverage-v1' }],
    ...options.receiptOverrides,
  });
}
