/** Duplicate-key-safe and resource-bounded parsing for untrusted JSON bytes. */

import { Buffer } from 'node:buffer';

import { deepFreeze } from './model.js';

export interface JsonParseLimits {
  readonly maxBytes: number;
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export const DEFAULT_JSON_PARSE_LIMITS: JsonParseLimits = deepFreeze({
  maxBytes: 1_048_576,
  maxDepth: 32,
  maxNodes: 100_000,
});

class JsonStructureScanner {
  private offset = 0;
  private nodes = 0;

  public constructor(
    private readonly text: string,
    private readonly limits: JsonParseLimits,
  ) {}

  public scan(): void {
    this.skipWhitespace();
    this.scanValue(0);
    this.skipWhitespace();
    if (this.offset !== this.text.length) {
      this.fail('unexpected trailing content');
    }
  }

  private scanValue(depth: number): void {
    this.nodes += 1;
    if (this.nodes > this.limits.maxNodes) {
      throw new RangeError(`raw JSON exceeds the ${this.limits.maxNodes.toString()}-node limit`);
    }
    const token = this.text[this.offset];
    if (token === '{') {
      this.scanObject(depth + 1);
      return;
    }
    if (token === '[') {
      this.scanArray(depth + 1);
      return;
    }
    if (token === '"') {
      this.scanStringToken();
      return;
    }
    if (token === 't') {
      this.scanLiteral('true');
      return;
    }
    if (token === 'f') {
      this.scanLiteral('false');
      return;
    }
    if (token === 'n') {
      this.scanLiteral('null');
      return;
    }
    this.scanNumber();
  }

  private requireDepth(depth: number): void {
    if (depth > this.limits.maxDepth) {
      throw new RangeError(`raw JSON exceeds the ${this.limits.maxDepth.toString()}-level limit`);
    }
  }

  private scanObject(depth: number): void {
    this.requireDepth(depth);
    this.offset += 1;
    this.skipWhitespace();
    if (this.consume('}')) {
      return;
    }
    const keys = new Set<string>();
    for (;;) {
      if (this.text[this.offset] !== '"') {
        this.fail('object keys must be strings');
      }
      const rawKey = this.scanStringToken();
      const key = JSON.parse(rawKey) as string;
      if (keys.has(key)) {
        throw new SyntaxError(`raw JSON contains duplicate object key ${JSON.stringify(key)}`);
      }
      keys.add(key);
      this.skipWhitespace();
      if (!this.consume(':')) {
        this.fail('object key must be followed by a colon');
      }
      this.skipWhitespace();
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.consume('}')) {
        return;
      }
      if (!this.consume(',')) {
        this.fail('object entries must be separated by commas');
      }
      this.skipWhitespace();
    }
  }

  private scanArray(depth: number): void {
    this.requireDepth(depth);
    this.offset += 1;
    this.skipWhitespace();
    if (this.consume(']')) {
      return;
    }
    for (;;) {
      this.scanValue(depth);
      this.skipWhitespace();
      if (this.consume(']')) {
        return;
      }
      if (!this.consume(',')) {
        this.fail('array values must be separated by commas');
      }
      this.skipWhitespace();
    }
  }

  private scanStringToken(): string {
    const start = this.offset;
    this.offset += 1;
    while (this.offset < this.text.length) {
      const token = this.text.charAt(this.offset);
      if (token === '"') {
        this.offset += 1;
        return this.text.slice(start, this.offset);
      }
      if (token === '\\') {
        this.offset += 1;
        const escape = this.text[this.offset];
        if (escape === 'u') {
          const hex = this.text.slice(this.offset + 1, this.offset + 5);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
            this.fail('invalid Unicode escape');
          }
          this.offset += 5;
          continue;
        }
        if (escape === undefined || !'"\\/bfnrt'.includes(escape)) {
          this.fail('invalid string escape');
        }
        this.offset += 1;
        continue;
      }
      if (token.charCodeAt(0) < 0x20) {
        this.fail('unescaped control character in string');
      }
      this.offset += 1;
    }
    this.fail('unterminated string');
  }

  private scanLiteral(literal: string): void {
    if (this.text.slice(this.offset, this.offset + literal.length) !== literal) {
      this.fail('invalid JSON literal');
    }
    this.offset += literal.length;
  }

  private scanNumber(): void {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.offset));
    if (match === null) {
      this.fail('expected a JSON value');
    }
    this.offset += match[0].length;
  }

  private skipWhitespace(): void {
    while (' \t\r\n'.includes(this.text[this.offset] ?? 'x')) {
      this.offset += 1;
    }
  }

  private consume(expected: string): boolean {
    if (this.text[this.offset] !== expected) {
      return false;
    }
    this.offset += 1;
    return true;
  }

  private fail(message: string): never {
    throw new SyntaxError(`${message} at character ${this.offset.toString()}`);
  }
}

function validateLimits(value: unknown): JsonParseLimits {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('raw JSON limits must be an object');
  }
  const allowed = ['maxBytes', 'maxDepth', 'maxNodes'] as const;
  const keys = Object.keys(value);
  const extras = keys.filter((key) => !(allowed as readonly string[]).includes(key));
  if (keys.length !== allowed.length || extras.length > 0) {
    throw new TypeError('raw JSON limits require exactly maxBytes, maxDepth, and maxNodes');
  }
  const record = value as Record<string, unknown>;
  for (const name of allowed) {
    const limit = record[name];
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new TypeError(`raw JSON ${name} must be a positive safe integer`);
    }
  }
  return record as unknown as JsonParseLimits;
}

/** Parse JSON only after proving byte, nesting, node, and duplicate-key constraints. */
export function parseBoundedJson(
  text: string,
  limits: JsonParseLimits = DEFAULT_JSON_PARSE_LIMITS,
): unknown {
  if (typeof text !== 'string') {
    throw new TypeError('raw JSON input must be text');
  }
  const validated = validateLimits(limits);
  const byteLength = Buffer.byteLength(text, 'utf8');
  if (byteLength > validated.maxBytes) {
    throw new RangeError(`raw JSON exceeds the ${validated.maxBytes.toString()}-byte limit`);
  }
  new JsonStructureScanner(text, validated).scan();
  return JSON.parse(text) as unknown;
}
