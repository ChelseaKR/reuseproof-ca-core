/** Duplicate-key and resource-boundary tests for untrusted JSON text. */

import { describe, expect, it } from 'vitest';

import { parseBoundedJson, parseEvaluationFixtureJson } from '../src/index.js';

const roomyLimits = {
  maxBytes: 1_000,
  maxDepth: 8,
  maxNodes: 100,
} as const;

describe('bounded JSON parsing', () => {
  it('accepts every JSON value kind and decodes escapes before returning data', () => {
    expect(
      parseBoundedJson(
        '{"array":[true,false,null,-12.5e+2,"line\\n\\u0061"],"emptyObject":{},"emptyArray":[]}',
      ),
    ).toEqual({
      array: [true, false, null, -1250, 'line\na'],
      emptyObject: {},
      emptyArray: [],
    });
    expect(parseBoundedJson(' 42\n')).toBe(42);
  });

  it.each([
    ['{"key":1,"key":2}', '"key"'],
    ['{"outer":{"key":1,"key":2}}', '"key"'],
    ['{"a":1,"\\u0061":2}', '"a"'],
  ])('rejects decoded duplicate keys %#', (text, key) => {
    expect(() => parseBoundedJson(text)).toThrow(`duplicate object key ${key}`);
  });

  it('enforces UTF-8 byte, structural-depth, and parsed-node boundaries exactly', () => {
    expect(parseBoundedJson('["😀"]', { ...roomyLimits, maxBytes: 8 })).toEqual(['😀']);
    expect(() => parseBoundedJson('["😀"]', { ...roomyLimits, maxBytes: 7 })).toThrow(
      '7-byte limit',
    );

    expect(parseBoundedJson('[[0]]', { ...roomyLimits, maxDepth: 2, maxNodes: 3 })).toEqual([[0]]);
    expect(() => parseBoundedJson('[[0]]', { ...roomyLimits, maxDepth: 1 })).toThrow(
      '1-level limit',
    );
    expect(() => parseBoundedJson('[[0]]', { ...roomyLimits, maxNodes: 2 })).toThrow(
      '2-node limit',
    );
  });

  it.each([
    ['', 'expected a JSON value'],
    ['{} true', 'unexpected trailing content'],
    ['{key:1}', 'object keys must be strings'],
    ['{"key" 1}', 'followed by a colon'],
    ['{"a":1 "b":2}', 'object entries must be separated'],
    ['[1 2]', 'array values must be separated'],
    ['treu', 'invalid JSON literal'],
    ['"\\x"', 'invalid string escape'],
    ['"\\u12xz"', 'invalid Unicode escape'],
    ['"line\nbreak"', 'unescaped control character'],
    ['"unterminated', 'unterminated string'],
    ['-', 'expected a JSON value'],
    ['01', 'unexpected trailing content'],
    ['[1,]', 'expected a JSON value'],
    ['{"a":1,}', 'object keys must be strings'],
  ])('rejects malformed JSON before domain parsing %#', (text, message) => {
    expect(() => parseBoundedJson(text)).toThrow(message);
  });

  it.each([
    [null, 'limits must be an object'],
    [{ maxBytes: 10, maxDepth: 2 }, 'require exactly'],
    [{ ...roomyLimits, extra: 1 }, 'require exactly'],
    [{ ...roomyLimits, maxBytes: 0 }, 'maxBytes'],
    [{ ...roomyLimits, maxDepth: 1.5 }, 'maxDepth'],
    [{ ...roomyLimits, maxNodes: Number.MAX_SAFE_INTEGER + 1 }, 'maxNodes'],
  ])('rejects malformed parser limits %#', (limits, message) => {
    expect(() => parseBoundedJson('null', limits as never)).toThrow(message);
  });

  it('rejects non-text input even when a caller bypasses TypeScript', () => {
    expect(() => parseBoundedJson({} as never)).toThrow('input must be text');
  });
});

describe('raw fixture boundary', () => {
  it('rejects duplicate fixture keys before ordinary JSON parsing can overwrite them', () => {
    expect(() => parseEvaluationFixtureJson('{"tenantId":"first","tenantId":"second"}')).toThrow(
      'duplicate object key',
    );
  });

  it('passes caller-supplied limits through to the fixture parser boundary', () => {
    expect(() =>
      parseEvaluationFixtureJson('{}', { maxBytes: 1, maxDepth: 1, maxNodes: 1 }),
    ).toThrow('1-byte limit');
  });
});
