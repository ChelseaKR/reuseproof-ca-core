/** Restricted RFC 8785-compatible JSON canonicalization for receipt inputs. */

import { createHash } from 'node:crypto';

/** Compare strings by UTF-16 code units, independent of process locale or ICU data. */
export function compareCodeUnits(left: string, right: string): number {
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

function canonicalNumber(value: number): string {
  if (!Number.isFinite(value) || Object.is(value, -0)) {
    throw new TypeError('canonical JSON forbids non-finite numbers and negative zero');
  }
  return JSON.stringify(value);
}

function canonicalString(value: string): string {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError('canonical JSON forbids unpaired Unicode surrogates');
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      throw new TypeError('canonical JSON forbids unpaired Unicode surrogates');
    }
  }
  return JSON.stringify(value);
}

/** Canonicalize JSON-safe domain data with UTF-16 property ordering. */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'string') {
    return canonicalString(value);
  }
  if (typeof value === 'number') {
    return canonicalNumber(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (Array.isArray(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
      if (!Object.hasOwn(value, index)) {
        throw new TypeError('canonical JSON forbids sparse arrays');
      }
      items.push(canonicalJson(value[index]));
    }
    return `[${items.join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('canonical JSON accepts only plain objects');
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => {
        if (record[key] === undefined) {
          throw new TypeError(`canonical JSON input contains undefined at ${key}`);
        }
        return `${canonicalString(key)}:${canonicalJson(record[key])}`;
      })
      .join(',')}}`;
  }
  throw new TypeError(`canonical JSON cannot encode ${typeof value}`);
}

/** Compute a lowercase SHA-256 hexadecimal digest over UTF-8 text. */
export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
