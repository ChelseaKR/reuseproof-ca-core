/** Bounded CSV source-contract validation and deterministic row routing. */

import { createHash } from 'node:crypto';

import { canonicalJson, sha256 } from './canonical.js';
import { createTimeRange, deepFreeze, type TimeRange } from './model.js';
import { requireStrictArray, requireStrictRecord } from './validation.js';

export const CSV_HARD_LIMITS = deepFreeze({
  maxBytes: 10_485_760,
  maxRecords: 100_000,
  maxColumns: 256,
  maxFieldBytes: 65_536,
});

export interface CsvSourceLimits {
  readonly maxBytes: number;
  readonly maxRecords: number;
  readonly maxFieldBytes: number;
}

export interface CsvSourceColumn {
  readonly sourceName: string;
  readonly requiredInSourceRow: boolean;
}

export interface CsvAdapterApprovals {
  readonly vendorOperatorReviewId: string;
  readonly jurisdictionMappingReviewId: string;
  readonly securityReviewId: string;
}

export interface CsvAdapterSourceContract {
  readonly schemaVersion: 'csv-adapter-source-contract/v1';
  readonly contractId: string;
  readonly version: string;
  readonly adapterId: string;
  readonly mappingVersionId: string;
  readonly sourceSchemaVersion: string;
  readonly tenantId: string;
  readonly systemId: string;
  readonly effectiveRange: TimeRange;
  readonly transport: {
    readonly kind: 'customer_pushed_csv';
    readonly encoding: 'utf-8';
    readonly delimiter: ',';
  };
  readonly columns: readonly CsvSourceColumn[];
  readonly identityFields: readonly string[];
  readonly informationalDeliveryCadence: string;
  readonly approvals: CsvAdapterApprovals;
  readonly limits: CsvSourceLimits;
}

export type CsvSourceRejectionReason =
  | 'byte_limit_exceeded'
  | 'invalid_utf8'
  | 'malformed_csv'
  | 'record_limit_exceeded'
  | 'header_mismatch';

export type CsvRowQuarantineReason =
  | 'column_count_mismatch'
  | 'field_size_limit_exceeded'
  | 'missing_required_field'
  | 'missing_identity_field';

export interface CsvSourceBinding {
  readonly sourceObjectHash: string;
  readonly sourceByteLength: number;
  readonly contractId: string;
  readonly contractVersion: string;
  readonly contractHash: string;
  readonly adapterId: string;
  readonly mappingVersionId: string;
  readonly tenantId: string;
  readonly systemId: string;
}

interface CsvRowLocator {
  readonly recordNumber: number;
  readonly startLine: number;
  readonly endLine: number;
}

export type CsvRowOutcome =
  | (CsvRowLocator & {
      readonly kind: 'accepted';
      readonly rowFingerprint: string;
      readonly identityHash: string;
      readonly values: Readonly<Record<string, string>>;
    })
  | (CsvRowLocator & {
      readonly kind: 'duplicate';
      readonly rowFingerprint: string;
      readonly identityHash: string;
      readonly duplicateOfRecordNumber: number;
    })
  | (CsvRowLocator & {
      readonly kind: 'quarantine';
      readonly rowFingerprint: string;
      readonly reason: CsvRowQuarantineReason;
    });

export interface RejectedCsvSource extends CsvSourceBinding {
  readonly schemaVersion: 'csv-ingestion-result/v1';
  readonly sourceDisposition: 'rejected_before_persistence';
  readonly reason: CsvSourceRejectionReason;
  readonly receivedRecordCount: null;
  readonly acceptedCount: 0;
  readonly duplicateCount: 0;
  readonly quarantineCount: 0;
  readonly rejectedSourceCount: 1;
  readonly outcomes: readonly [];
  readonly routingHash: string;
}

export interface RoutedCsvSource extends CsvSourceBinding {
  readonly schemaVersion: 'csv-ingestion-result/v1';
  readonly sourceDisposition: 'routed';
  readonly reason: null;
  readonly receivedRecordCount: number;
  readonly acceptedCount: number;
  readonly duplicateCount: number;
  readonly quarantineCount: number;
  readonly rejectedSourceCount: 0;
  readonly outcomes: readonly CsvRowOutcome[];
  readonly routingHash: string;
}

export type CsvIngestionResult = RejectedCsvSource | RoutedCsvSource;

interface ParsedCsvRecord extends CsvRowLocator {
  readonly fields: readonly string[];
}

class CsvSourceError extends Error {
  public constructor(public readonly reason: CsvSourceRejectionReason) {
    super(reason);
  }
}

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function requiredInvariantValue<T>(value: T | undefined): T {
  /* v8 ignore next -- callers establish exact column and identity lengths before indexing. */
  if (value === undefined) {
    throw new RangeError('CSV routing internal value invariant failed');
  }
  return value;
}

function positiveLimit(
  record: Record<string, unknown>,
  key: keyof CsvSourceLimits,
  hardMaximum: number,
): number {
  const value = record[key];
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > hardMaximum) {
    throw new TypeError(
      `contract.limits.${key} must be a positive safe integer no greater than ${hardMaximum.toString()}`,
    );
  }
  return value as number;
}

function createLimits(value: unknown): CsvSourceLimits {
  const record = requireStrictRecord(
    value,
    ['maxBytes', 'maxRecords', 'maxFieldBytes'],
    [],
    'contract.limits',
  );
  return deepFreeze({
    maxBytes: positiveLimit(record, 'maxBytes', CSV_HARD_LIMITS.maxBytes),
    maxRecords: positiveLimit(record, 'maxRecords', CSV_HARD_LIMITS.maxRecords),
    maxFieldBytes: positiveLimit(record, 'maxFieldBytes', CSV_HARD_LIMITS.maxFieldBytes),
  });
}

function createTransport(value: unknown): CsvAdapterSourceContract['transport'] {
  const record = requireStrictRecord(
    value,
    ['kind', 'encoding', 'delimiter'],
    [],
    'contract.transport',
  );
  if (
    record.kind !== 'customer_pushed_csv' ||
    record.encoding !== 'utf-8' ||
    record.delimiter !== ','
  ) {
    throw new TypeError(
      'contract.transport must be customer_pushed_csv with utf-8 encoding and comma delimiter',
    );
  }
  return deepFreeze({ kind: 'customer_pushed_csv', encoding: 'utf-8', delimiter: ',' });
}

function createColumns(value: unknown): readonly CsvSourceColumn[] {
  const columns = requireStrictArray(value, 'contract.columns').map((candidate, index) => {
    const label = `contract.columns[${index.toString()}]`;
    const record = requireStrictRecord(candidate, ['sourceName', 'requiredInSourceRow'], [], label);
    if (typeof record.requiredInSourceRow !== 'boolean') {
      throw new TypeError(`${label}.requiredInSourceRow must be boolean`);
    }
    return deepFreeze({
      sourceName: requiredString(record, 'sourceName', label),
      requiredInSourceRow: record.requiredInSourceRow,
    });
  });
  if (columns.length === 0 || columns.length > CSV_HARD_LIMITS.maxColumns) {
    throw new RangeError(
      `contract.columns must contain 1 through ${CSV_HARD_LIMITS.maxColumns.toString()} columns`,
    );
  }
  const names = columns.map(({ sourceName }) => sourceName);
  if (new Set(names).size !== names.length) {
    throw new RangeError('contract column names must be unique');
  }
  return deepFreeze(columns);
}

function createIdentityFields(value: unknown, columnNames: ReadonlySet<string>): readonly string[] {
  const fields = requireStrictArray(value, 'contract.identityFields').map((candidate) => {
    if (typeof candidate !== 'string' || candidate.trim() === '') {
      throw new TypeError('contract.identityFields must contain non-empty strings');
    }
    return candidate;
  });
  if (fields.length === 0 || new Set(fields).size !== fields.length) {
    throw new RangeError('contract.identityFields must be non-empty and unique');
  }
  if (fields.some((field) => !columnNames.has(field))) {
    throw new RangeError('contract.identityFields must reference declared source columns');
  }
  return deepFreeze(fields);
}

function createApprovals(value: unknown): CsvAdapterApprovals {
  const label = 'contract.approvals';
  const record = requireStrictRecord(
    value,
    ['vendorOperatorReviewId', 'jurisdictionMappingReviewId', 'securityReviewId'],
    [],
    label,
  );
  return deepFreeze({
    vendorOperatorReviewId: requiredString(record, 'vendorOperatorReviewId', label),
    jurisdictionMappingReviewId: requiredString(record, 'jurisdictionMappingReviewId', label),
    securityReviewId: requiredString(record, 'securityReviewId', label),
  });
}

/** Strictly reconstruct a transport-only CSV source contract. */
export function createCsvAdapterSourceContract(value: unknown): CsvAdapterSourceContract {
  const label = 'contract';
  const record = requireStrictRecord(
    value,
    [
      'schemaVersion',
      'contractId',
      'version',
      'adapterId',
      'mappingVersionId',
      'sourceSchemaVersion',
      'tenantId',
      'systemId',
      'effectiveRange',
      'transport',
      'columns',
      'identityFields',
      'informationalDeliveryCadence',
      'approvals',
      'limits',
    ],
    [],
    label,
  );
  if (record.schemaVersion !== 'csv-adapter-source-contract/v1') {
    throw new TypeError('contract.schemaVersion must be csv-adapter-source-contract/v1');
  }
  const columns = createColumns(record.columns);
  return deepFreeze({
    schemaVersion: 'csv-adapter-source-contract/v1',
    contractId: requiredString(record, 'contractId', label),
    version: requiredString(record, 'version', label),
    adapterId: requiredString(record, 'adapterId', label),
    mappingVersionId: requiredString(record, 'mappingVersionId', label),
    sourceSchemaVersion: requiredString(record, 'sourceSchemaVersion', label),
    tenantId: requiredString(record, 'tenantId', label),
    systemId: requiredString(record, 'systemId', label),
    effectiveRange: createTimeRange(record.effectiveRange, 'contract.effectiveRange'),
    transport: createTransport(record.transport),
    columns,
    identityFields: createIdentityFields(
      record.identityFields,
      new Set(columns.map(({ sourceName }) => sourceName)),
    ),
    informationalDeliveryCadence: requiredString(record, 'informationalDeliveryCadence', label),
    approvals: createApprovals(record.approvals),
    limits: createLimits(record.limits),
  });
}

/** Content-address the complete normalized adapter/source contract. */
export function hashCsvAdapterSourceContract(contract: CsvAdapterSourceContract): string {
  return sha256(
    canonicalJson({
      schemaVersion: 'csv-adapter-source-contract-binding/v1',
      contract: createCsvAdapterSourceContract(contract),
    }),
  );
}

function sourceHash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function binding(contract: CsvAdapterSourceContract, bytes: Uint8Array): CsvSourceBinding {
  return {
    sourceObjectHash: sourceHash(bytes),
    sourceByteLength: bytes.byteLength,
    contractId: contract.contractId,
    contractVersion: contract.version,
    contractHash: hashCsvAdapterSourceContract(contract),
    adapterId: contract.adapterId,
    mappingVersionId: contract.mappingVersionId,
    tenantId: contract.tenantId,
    systemId: contract.systemId,
  };
}

function withRoutingHash<T extends Omit<CsvIngestionResult, 'routingHash'>>(
  result: T,
): T & { readonly routingHash: string } {
  return deepFreeze({
    ...result,
    routingHash: sha256(
      canonicalJson({ schemaVersion: 'csv-ingestion-routing-binding/v1', result }),
    ),
  });
}

function rejectSource(
  contract: CsvAdapterSourceContract,
  bytes: Uint8Array,
  reason: CsvSourceRejectionReason,
): RejectedCsvSource {
  return withRoutingHash({
    schemaVersion: 'csv-ingestion-result/v1',
    sourceDisposition: 'rejected_before_persistence',
    reason,
    ...binding(contract, bytes),
    receivedRecordCount: null,
    acceptedCount: 0,
    duplicateCount: 0,
    quarantineCount: 0,
    rejectedSourceCount: 1,
    outcomes: [],
  });
}

function parseCsv(text: string, maxRecords: number): readonly ParsedCsvRecord[] {
  const records: ParsedCsvRecord[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let recordStarted = false;
  let line = 1;
  let recordStartLine = 1;

  const finishField = (): void => {
    fields.push(field);
    field = '';
    afterQuote = false;
  };
  const finishRecord = (endLine: number): void => {
    finishField();
    records.push({
      recordNumber: records.length + 1,
      startLine: recordStartLine,
      endLine,
      fields,
    });
    if (records.length > maxRecords + 1) {
      throw new CsvSourceError('record_limit_exceeded');
    }
    fields = [];
    field = '';
    recordStarted = false;
  };

  for (let offset = 0; offset < text.length; offset += 1) {
    const token = text.charAt(offset);
    if (inQuotes) {
      if (token === '"') {
        if (text.charAt(offset + 1) === '"') {
          field += '"';
          offset += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else if (token === '\r') {
        if (text.charAt(offset + 1) !== '\n') {
          throw new CsvSourceError('malformed_csv');
        }
        field += '\n';
        offset += 1;
        line += 1;
      } else {
        field += token;
        if (token === '\n') {
          line += 1;
        }
      }
      continue;
    }
    if (afterQuote) {
      if (token === ',') {
        finishField();
        recordStarted = true;
        continue;
      }
      if (token !== '\r' && token !== '\n') {
        throw new CsvSourceError('malformed_csv');
      }
    } else if (token === '"') {
      if (field !== '') {
        throw new CsvSourceError('malformed_csv');
      }
      inQuotes = true;
      recordStarted = true;
      continue;
    } else if (token === ',') {
      finishField();
      recordStarted = true;
      continue;
    } else if (token !== '\r' && token !== '\n') {
      field += token;
      recordStarted = true;
      continue;
    }

    if (token === '\r') {
      if (text.charAt(offset + 1) !== '\n') {
        throw new CsvSourceError('malformed_csv');
      }
      offset += 1;
    }
    finishRecord(line);
    line += 1;
    recordStartLine = line;
  }
  if (inQuotes) {
    throw new CsvSourceError('malformed_csv');
  }
  if (recordStarted || fields.length > 0 || field !== '') {
    finishRecord(line);
  }
  return records;
}

function rowFingerprint(
  sourceObjectHash: string,
  contractHash: string,
  record: ParsedCsvRecord,
): string {
  return sha256(
    canonicalJson({
      schemaVersion: 'csv-source-row-binding/v1',
      sourceObjectHash,
      contractHash,
      recordNumber: record.recordNumber,
      fields: record.fields,
    }),
  );
}

function routeRows(
  contract: CsvAdapterSourceContract,
  source: CsvSourceBinding,
  records: readonly ParsedCsvRecord[],
): readonly CsvRowOutcome[] {
  const outcomes: CsvRowOutcome[] = [];
  const firstRecordByIdentity = new Map<string, number>();
  const columnNames = contract.columns.map(({ sourceName }) => sourceName);
  for (const record of records.slice(1)) {
    const fingerprint = rowFingerprint(source.sourceObjectHash, source.contractHash, record);
    const locator = {
      recordNumber: record.recordNumber,
      startLine: record.startLine,
      endLine: record.endLine,
    };
    if (record.fields.length !== contract.columns.length) {
      outcomes.push({
        kind: 'quarantine',
        ...locator,
        rowFingerprint: fingerprint,
        reason: 'column_count_mismatch',
      });
      continue;
    }
    if (
      record.fields.some(
        (value) => new TextEncoder().encode(value).byteLength > contract.limits.maxFieldBytes,
      )
    ) {
      outcomes.push({
        kind: 'quarantine',
        ...locator,
        rowFingerprint: fingerprint,
        reason: 'field_size_limit_exceeded',
      });
      continue;
    }
    const values = Object.fromEntries(
      columnNames.map((columnName, index) => [
        columnName,
        requiredInvariantValue(record.fields[index]),
      ]),
    );
    if (
      contract.columns.some(
        ({ sourceName, requiredInSourceRow }) =>
          requiredInSourceRow && values[sourceName]?.trim() === '',
      )
    ) {
      outcomes.push({
        kind: 'quarantine',
        ...locator,
        rowFingerprint: fingerprint,
        reason: 'missing_required_field',
      });
      continue;
    }
    const identity = contract.identityFields.map((fieldName) =>
      requiredInvariantValue(values[fieldName]),
    );
    if (identity.some((value) => value.trim() === '')) {
      outcomes.push({
        kind: 'quarantine',
        ...locator,
        rowFingerprint: fingerprint,
        reason: 'missing_identity_field',
      });
      continue;
    }
    const identityHash = sha256(
      canonicalJson({
        schemaVersion: 'csv-row-identity-binding/v1',
        contractId: contract.contractId,
        contractVersion: contract.version,
        fields: contract.identityFields.map((fieldName, index) => ({
          fieldName,
          value: requiredInvariantValue(identity[index]),
        })),
      }),
    );
    const duplicateOfRecordNumber = firstRecordByIdentity.get(identityHash);
    if (duplicateOfRecordNumber !== undefined) {
      outcomes.push({
        kind: 'duplicate',
        ...locator,
        rowFingerprint: fingerprint,
        identityHash,
        duplicateOfRecordNumber,
      });
      continue;
    }
    firstRecordByIdentity.set(identityHash, record.recordNumber);
    outcomes.push({
      kind: 'accepted',
      ...locator,
      rowFingerprint: fingerprint,
      identityHash,
      values: deepFreeze(values),
    });
  }
  return deepFreeze(outcomes);
}

/**
 * Reject an unsafe source as one source object, or route every syntactically safe data record.
 * This boundary retains no raw quarantine copy; row locators point back to the hashed source.
 */
export function ingestCsvSource(
  contractInput: CsvAdapterSourceContract,
  sourceBytes: Uint8Array,
): CsvIngestionResult {
  const contract = createCsvAdapterSourceContract(contractInput);
  if (!(sourceBytes instanceof Uint8Array)) {
    throw new TypeError('CSV source must be a Uint8Array');
  }
  const bytes = Uint8Array.from(sourceBytes);
  if (bytes.byteLength > contract.limits.maxBytes) {
    return rejectSource(contract, bytes, 'byte_limit_exceeded');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return rejectSource(contract, bytes, 'invalid_utf8');
  }
  if (text.startsWith('\uFEFF')) {
    text = text.slice(1);
  }
  let records: readonly ParsedCsvRecord[];
  try {
    records = parseCsv(text, contract.limits.maxRecords);
  } catch (error) {
    if (error instanceof CsvSourceError) {
      return rejectSource(contract, bytes, error.reason);
    }
    /* v8 ignore next -- parseCsv throws only CsvSourceError for input failures. */
    throw error;
  }
  const expectedHeader = contract.columns.map(({ sourceName }) => sourceName);
  const actualHeader = records[0]?.fields;
  if (
    actualHeader === undefined ||
    actualHeader.some(
      (value) => new TextEncoder().encode(value).byteLength > contract.limits.maxFieldBytes,
    ) ||
    canonicalJson(actualHeader) !== canonicalJson(expectedHeader)
  ) {
    return rejectSource(contract, bytes, 'header_mismatch');
  }
  const source = binding(contract, bytes);
  const outcomes = routeRows(contract, source, records);
  const receivedRecordCount = records.length - 1;
  const acceptedCount = outcomes.filter(({ kind }) => kind === 'accepted').length;
  const duplicateCount = outcomes.filter(({ kind }) => kind === 'duplicate').length;
  const quarantineCount = outcomes.filter(({ kind }) => kind === 'quarantine').length;
  /* v8 ignore next -- routeRows emits exactly one outcome for every sliced data record. */
  if (acceptedCount + duplicateCount + quarantineCount !== receivedRecordCount) {
    throw new RangeError('CSV routing accounting invariant failed');
  }
  return withRoutingHash({
    schemaVersion: 'csv-ingestion-result/v1',
    sourceDisposition: 'routed',
    reason: null,
    ...source,
    receivedRecordCount,
    acceptedCount,
    duplicateCount,
    quarantineCount,
    rejectedSourceCount: 0,
    outcomes,
  });
}
