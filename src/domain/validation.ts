/** Shared fail-closed validation for JSON-shaped domain inputs. */

/** Require a plain or null-prototype object before inspecting any of its fields. */
export function requirePlainRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function snapshotRecordDataProperties(
  value: Record<string, unknown>,
  label: string,
): Record<string, unknown> {
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new TypeError(`${label} contains unsupported symbol keys`);
  }
  const stringKeys = ownKeys as string[];
  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of stringKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label}.${key} must be an enumerable data property`);
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}

/** Require exact own JSON-style fields, rejecting symbols, accessors, and inherited substitutes. */
export function assertStrictRecordKeys(
  value: Record<string, unknown>,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  const snapshot = snapshotRecordDataProperties(value, label);
  const stringKeys = Object.keys(snapshot);
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const extras = stringKeys.filter((key) => !allowed.has(key)).sort();
  if (extras.length > 0) {
    throw new TypeError(`${label} contains unsupported keys: ${extras.join(', ')}`);
  }
  const missing = requiredKeys.filter((key) => !Object.hasOwn(snapshot, key)).sort();
  if (missing.length > 0) {
    throw new TypeError(`${label} is missing required keys: ${missing.join(', ')}`);
  }
  return snapshot;
}

/** Validate one complete strict record in a single boundary operation. */
export function requireStrictRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  const record = requirePlainRecord(value, label);
  return assertStrictRecordKeys(record, requiredKeys, optionalKeys, label);
}

/** Require and snapshot one dense ordinary array with only own data-property indices. */
export function requireStrictArray(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new TypeError(`${label} must use Array.prototype`);
  }

  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === 'symbol')) {
    throw new TypeError(`${label} contains unsupported symbol keys`);
  }
  const stringKeys = ownKeys as string[];
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (
    lengthDescriptor === undefined ||
    !('value' in lengthDescriptor) ||
    typeof lengthDescriptor.value !== 'number' ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0 ||
    lengthDescriptor.enumerable ||
    lengthDescriptor.configurable
  ) {
    throw new TypeError(`${label}.length must be the ordinary array length data property`);
  }
  const length = lengthDescriptor.value;

  const indexKeys = stringKeys.filter((key) => key !== 'length');
  const descriptors: PropertyDescriptor[] = [];
  const entries = indexKeys.map((key): [number, unknown] => {
    const index = Number(key);
    if (!Number.isInteger(index) || index < 0 || index >= length || index.toString() !== key) {
      throw new TypeError(`${label} contains unsupported array keys: ${key}`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      throw new TypeError(`${label}[${key}] must be an enumerable data property`);
    }
    descriptors.push(descriptor);
    return [index, descriptor.value];
  });
  if (indexKeys.length !== length) {
    throw new TypeError(`${label} must be a dense array with every index present`);
  }

  const mutableShape =
    lengthDescriptor.writable === true &&
    descriptors.every(
      (descriptor) => descriptor.writable === true && descriptor.configurable === true,
    );
  const frozenShape =
    lengthDescriptor.writable === false &&
    descriptors.every(
      (descriptor) => descriptor.writable === false && descriptor.configurable === false,
    );
  if (!mutableShape && !frozenShape) {
    throw new TypeError(`${label} must use ordinary mutable or frozen array data properties`);
  }
  const snapshot = new Array<unknown>(length);
  for (const [index, item] of entries) {
    snapshot[index] = item;
  }
  return snapshot;
}

/** Accept named IANA zones and aliases, but never fixed-offset identifiers. */
export function requireIanaTimeZone(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label} must be a recognized IANA time zone`);
  }
  if (/^[+-]/.test(value)) {
    throw new TypeError(`${label} must be a recognized IANA time zone`);
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
  } catch (error) {
    throw new TypeError(`${label} must be a recognized IANA time zone`, { cause: error });
  }
  return value;
}
