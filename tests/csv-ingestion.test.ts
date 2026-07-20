import { Buffer } from 'node:buffer';

import { describe, expect, it } from 'vitest';

import {
  CSV_HARD_LIMITS,
  createCsvAdapterSourceContract,
  hashCsvAdapterSourceContract,
  ingestCsvSource,
  type CsvAdapterSourceContract,
} from '../src/index.js';

function contractInput(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'csv-adapter-source-contract/v1',
    contractId: 'csv-contract-1',
    version: '1',
    adapterId: 'generic-csv',
    mappingVersionId: 'mapping-1',
    sourceSchemaVersion: 'vendor-export-1',
    tenantId: 'tenant-1',
    systemId: 'system-1',
    effectiveRange: {
      start: '2026-01-01T00:00:00.000Z',
      end: '2027-01-01T00:00:00.000Z',
    },
    transport: {
      kind: 'customer_pushed_csv',
      encoding: 'utf-8',
      delimiter: ',',
    },
    columns: [
      { sourceName: 'id', requiredInSourceRow: false },
      { sourceName: 'observed_at', requiredInSourceRow: true },
      { sourceName: 'value', requiredInSourceRow: true },
      { sourceName: 'unit', requiredInSourceRow: false },
    ],
    identityFields: ['id', 'observed_at'],
    informationalDeliveryCadence: 'nominally every 15 minutes',
    approvals: {
      vendorOperatorReviewId: 'vendor-review-1',
      jurisdictionMappingReviewId: 'jurisdiction-review-1',
      securityReviewId: 'security-review-1',
    },
    limits: {
      maxBytes: 10_000,
      maxRecords: 100,
      maxFieldBytes: 100,
    },
    ...overrides,
  };
}

function contract(overrides: Readonly<Record<string, unknown>> = {}): CsvAdapterSourceContract {
  return createCsvAdapterSourceContract(contractInput(overrides));
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('CSV adapter/source contract', () => {
  it('strictly reconstructs, deeply freezes, and content-addresses the contract', () => {
    const result = contract();
    const replay = contract({ columns: [...(contractInput().columns as object[])] });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.columns)).toBe(true);
    expect(Object.isFrozen(result.columns[0])).toBe(true);
    expect(Object.isFrozen(result.approvals)).toBe(true);
    expect(Object.isFrozen(result.limits)).toBe(true);
    expect(hashCsvAdapterSourceContract(replay)).toBe(hashCsvAdapterSourceContract(result));
  });

  it.each([
    [{ schemaVersion: 'csv-adapter-source-contract/v2' }, 'schemaVersion'],
    [{ contractId: '' }, 'non-empty string'],
    [{ transport: { kind: 'api', encoding: 'utf-8', delimiter: ',' } }, 'transport'],
    [
      { transport: { kind: 'customer_pushed_csv', encoding: 'latin1', delimiter: ',' } },
      'transport',
    ],
    [
      { transport: { kind: 'customer_pushed_csv', encoding: 'utf-8', delimiter: ';' } },
      'transport',
    ],
    [{ columns: [] }, '1 through'],
    [
      {
        columns: Array.from({ length: CSV_HARD_LIMITS.maxColumns + 1 }, (_, index) => ({
          sourceName: `column-${index.toString()}`,
          requiredInSourceRow: false,
        })),
      },
      '1 through',
    ],
    [
      {
        columns: [
          { sourceName: 'same', requiredInSourceRow: true },
          { sourceName: 'same', requiredInSourceRow: false },
        ],
        identityFields: ['same'],
      },
      'unique',
    ],
    [
      { columns: [{ sourceName: 'id', requiredInSourceRow: 'yes' }], identityFields: ['id'] },
      'must be boolean',
    ],
    [
      { columns: [{ sourceName: '', requiredInSourceRow: true }], identityFields: ['id'] },
      'non-empty string',
    ],
    [{ identityFields: [] }, 'non-empty and unique'],
    [{ identityFields: ['id', 'id'] }, 'non-empty and unique'],
    [{ identityFields: ['missing'] }, 'declared source columns'],
    [{ identityFields: [3] }, 'non-empty strings'],
    [
      {
        limits: { maxBytes: 0, maxRecords: 100, maxFieldBytes: 100 },
      },
      'maxBytes',
    ],
    [
      {
        limits: { maxBytes: 10_000, maxRecords: 1.5, maxFieldBytes: 100 },
      },
      'maxRecords',
    ],
    [
      {
        limits: {
          maxBytes: 10_000,
          maxRecords: 100,
          maxFieldBytes: CSV_HARD_LIMITS.maxFieldBytes + 1,
        },
      },
      'maxFieldBytes',
    ],
    [
      {
        approvals: {
          vendorOperatorReviewId: '',
          jurisdictionMappingReviewId: 'jurisdiction-review-1',
          securityReviewId: 'security-review-1',
        },
      },
      'non-empty string',
    ],
    [{ unexpected: true }, 'unsupported keys'],
  ])('rejects an unsafe contract %#', (overrides, message) => {
    expect(() => contract(overrides)).toThrow(message);
  });
});

describe('CSV source routing', () => {
  it('routes every safe row exactly once with stable locators and hashes', () => {
    const source = [
      'id,observed_at,value,unit',
      'a,2026-01-01T00:00:00.000Z,1.5,mg/L',
      'a,2026-01-01T00:00:00.000Z,9.9,mg/L',
      'b,2026-01-01T00:15:00.000Z,,mg/L',
      ',2026-01-01T00:30:00.000Z,2.0,mg/L',
      'c,2026-01-01T00:45:00.000Z',
    ].join('\n');
    const result = ingestCsvSource(contract(), bytes(source));

    expect(result.sourceDisposition).toBe('routed');
    if (result.sourceDisposition !== 'routed') {
      throw new Error('expected routed source');
    }
    expect(result).toMatchObject({
      receivedRecordCount: 5,
      acceptedCount: 1,
      duplicateCount: 1,
      quarantineCount: 3,
      rejectedSourceCount: 0,
    });
    expect(result.outcomes.map(({ kind }) => kind)).toEqual([
      'accepted',
      'duplicate',
      'quarantine',
      'quarantine',
      'quarantine',
    ]);
    expect(result.outcomes[0]).toMatchObject({ recordNumber: 2, startLine: 2, endLine: 2 });
    expect(result.outcomes[1]).toMatchObject({
      kind: 'duplicate',
      duplicateOfRecordNumber: 2,
    });
    expect(
      result.outcomes
        .slice(2)
        .map((outcome) => (outcome.kind === 'quarantine' ? outcome.reason : null)),
    ).toEqual(['missing_required_field', 'missing_identity_field', 'column_count_mismatch']);
    expect(result.routingHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceObjectHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.outcomes)).toBe(true);
    expect(Object.isFrozen(result.outcomes[0])).toBe(true);
  });

  it('parses quoted commas, escaped quotes, CRLF, BOM, and embedded newlines', () => {
    const source =
      '\uFEFFid,observed_at,value,unit\r\n' +
      '"a,1",2026-01-01T00:00:00.000Z,"line 1\r\nline 2","mg/""L"""\r\n' +
      'b,2026-01-01T00:15:00.000Z,"",\r\n';
    const result = ingestCsvSource(
      contract({
        columns: [
          { sourceName: 'id', requiredInSourceRow: true },
          { sourceName: 'observed_at', requiredInSourceRow: true },
          { sourceName: 'value', requiredInSourceRow: false },
          { sourceName: 'unit', requiredInSourceRow: false },
        ],
      }),
      Buffer.from(source, 'utf8'),
    );

    expect(result.sourceDisposition).toBe('routed');
    if (result.sourceDisposition !== 'routed') {
      throw new Error('expected routed source');
    }
    expect(result.acceptedCount).toBe(2);
    expect(result.outcomes[0]).toMatchObject({ startLine: 2, endLine: 3 });
    expect(result.outcomes[1]).toMatchObject({ startLine: 4, endLine: 4 });
    expect(result.outcomes[0]?.kind === 'accepted' && result.outcomes[0].values).toEqual({
      id: 'a,1',
      observed_at: '2026-01-01T00:00:00.000Z',
      value: 'line 1\nline 2',
      unit: 'mg/"L"',
    });

    const lfQuoted = ingestCsvSource(
      contract(),
      bytes('id,observed_at,value,unit\na,t,"line 1\nline 2",u'),
    );
    expect(lfQuoted.outcomes[0]).toMatchObject({ startLine: 2, endLine: 3 });
  });

  it('quarantines a field whose UTF-8 bytes exceed the contract field bound', () => {
    const result = ingestCsvSource(
      contract({ limits: { maxBytes: 10_000, maxRecords: 100, maxFieldBytes: 12 } }),
      bytes('id,observed_at,value,unit\na,t,💧💧💧💧,u'),
    );
    expect(result.sourceDisposition).toBe('routed');
    expect(result.outcomes[0]).toMatchObject({
      kind: 'quarantine',
      reason: 'field_size_limit_exceeded',
    });
  });

  it('reproduces routing independent of caller byte-buffer mutation after the call', () => {
    const source = bytes('id,observed_at,value,unit\na,t,1,u');
    const first = ingestCsvSource(contract(), source);
    const replay = ingestCsvSource(contract(), Uint8Array.from(source));
    source.fill(0);

    expect(replay).toEqual(first);
  });

  it('changes source and routing hashes when exact source bytes change', () => {
    const lf = ingestCsvSource(contract(), bytes('id,observed_at,value,unit\na,t,1,u\n'));
    const crlf = ingestCsvSource(contract(), bytes('id,observed_at,value,unit\r\na,t,1,u\r\n'));

    expect(lf.sourceDisposition).toBe('routed');
    expect(crlf.sourceDisposition).toBe('routed');
    expect(crlf.sourceObjectHash).not.toBe(lf.sourceObjectHash);
    expect(crlf.routingHash).not.toBe(lf.routingHash);
  });

  it('routes a header-only source with zero reconciled data records', () => {
    const result = ingestCsvSource(contract(), bytes('id,observed_at,value,unit'));
    expect(result).toMatchObject({
      sourceDisposition: 'routed',
      receivedRecordCount: 0,
      acceptedCount: 0,
      duplicateCount: 0,
      quarantineCount: 0,
    });
  });

  it.each([
    [
      contract({ limits: { maxBytes: 3, maxRecords: 100, maxFieldBytes: 100 } }),
      bytes('four'),
      'byte_limit_exceeded',
    ],
    [contract(), Uint8Array.from([0xff]), 'invalid_utf8'],
    [contract(), bytes('id,observed_at,value,unit\n"unterminated'), 'malformed_csv'],
    [contract(), bytes('id,observed_at,value,unit\na"bad,t,1,u'), 'malformed_csv'],
    [contract(), bytes('id,observed_at,value,unit\n"a"bad,t,1,u'), 'malformed_csv'],
    [contract(), bytes('id,observed_at,value,unit\ra,t,1,u'), 'malformed_csv'],
    [contract(), bytes('id,observed_at,value,unit\n"a\rb",t,1,u'), 'malformed_csv'],
    [
      contract({ limits: { maxBytes: 10_000, maxRecords: 1, maxFieldBytes: 100 } }),
      bytes('id,observed_at,value,unit\na,t,1,u\nb,t,2,u'),
      'record_limit_exceeded',
    ],
    [contract(), bytes(''), 'header_mismatch'],
    [contract(), bytes('observed_at,id,value,unit\na,t,1,u'), 'header_mismatch'],
    [
      contract({ limits: { maxBytes: 10_000, maxRecords: 100, maxFieldBytes: 3 } }),
      bytes('identifier,observed_at,value,unit'),
      'header_mismatch',
    ],
  ])('rejects an unsafe source before persistence %#', (sourceContract, source, reason) => {
    const result = ingestCsvSource(sourceContract, source);
    expect(result).toMatchObject({
      sourceDisposition: 'rejected_before_persistence',
      reason,
      receivedRecordCount: null,
      acceptedCount: 0,
      duplicateCount: 0,
      quarantineCount: 0,
      rejectedSourceCount: 1,
      outcomes: [],
    });
    expect(result.routingHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('requires source bytes rather than accepting a text or array substitute', () => {
    expect(() => ingestCsvSource(contract(), 'csv' as never)).toThrow('Uint8Array');
    expect(() => ingestCsvSource(contract(), [1, 2, 3] as never)).toThrow('Uint8Array');
  });
});
