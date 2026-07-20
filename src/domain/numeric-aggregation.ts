/** Governed exact-decimal conversion and deterministic civil-day aggregation. */

import { Temporal } from '@js-temporal/polyfill';

import { canonicalJson, compareCodeUnits, sha256 } from './canonical.js';
import {
  evaluateCoverage,
  type CoverageEvaluationInput,
  type CoverageSummary,
} from './coverage.js';
import {
  createObservation,
  createRequiredSeriesContract,
  createTimeRange,
  deepFreeze,
  hashRequiredSeriesContract,
  instantMilliseconds,
  type Observation,
  type RequiredSeriesContract,
  type TimeRange,
} from './model.js';
import { requireIanaTimeZone, requireStrictArray, requireStrictRecord } from './validation.js';

export type DailyAggregateMethod = 'sum' | 'mean' | 'minimum' | 'maximum';

export interface UnitConversionRule {
  readonly schemaVersion: 'unit-conversion-rule/v1';
  readonly ruleId: string;
  readonly version: string;
  readonly parameterCode: string;
  readonly sourceUnit: string;
  readonly canonicalUnit: string;
  readonly sourceOffset: string;
  readonly multiplierNumerator: string;
  readonly multiplierDenominator: string;
  readonly effectiveRange: TimeRange;
  readonly authorizationId: string;
}

export interface DailyAggregatePolicy {
  readonly schemaVersion: 'daily-aggregate-policy/v1';
  readonly policyId: string;
  readonly version: string;
  readonly contractId: string;
  readonly method: DailyAggregateMethod;
  readonly decimalPlaces: number;
  readonly roundingMode: 'half_away_from_zero';
  readonly timeZone: string;
  readonly authorizationId: string;
}

export interface NumericObservationValue {
  readonly observationId: string;
  readonly contractId: string;
  readonly observedAt: string;
  readonly sourceFingerprint: string;
  readonly sourceValue: string;
  readonly sourceUnit: string;
  readonly conversionRuleId: string;
  readonly conversionRuleVersion: string;
}

export interface DailyAggregateValue {
  readonly civilDate: string;
  readonly value: string;
  readonly canonicalUnit: string;
  readonly acceptedObservationCount: number;
  readonly observationIds: readonly string[];
}

export interface DailyNumericAggregate {
  readonly schemaVersion: 'daily-numeric-aggregate/v1';
  readonly contractId: string;
  readonly contractVersion: string;
  readonly tenantId: string;
  readonly systemId: string;
  readonly parameterCode: string;
  readonly canonicalUnit: string;
  readonly governingContractHash: string;
  readonly coverageEvaluationInputHash: string;
  readonly coverageSummaryHash: string;
  readonly conversionRuleSetHash: string;
  readonly aggregatePolicyHash: string;
  readonly numericSourceSetHash: string;
  readonly method: DailyAggregateMethod;
  readonly decimalPlaces: number;
  readonly roundingMode: 'half_away_from_zero';
  readonly timeZone: string;
  readonly values: readonly DailyAggregateValue[];
}

export interface DailyNumericAggregateInput {
  readonly coverageEvaluation: CoverageEvaluationInput;
  readonly numericObservations: readonly NumericObservationValue[];
  readonly conversionRules: readonly UnitConversionRule[];
  readonly policy: DailyAggregatePolicy;
}

interface Decimal {
  readonly coefficient: bigint;
  readonly scale: number;
}

interface Rational {
  readonly numerator: bigint;
  readonly denominator: bigint;
}

const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const unsignedIntegerPattern = /^(?:0|[1-9]\d*)$/;
export const MAX_NUMERIC_DIGITS = 64;
export const MAX_CONVERSION_RULES = 256;

function requiredString(record: Record<string, unknown>, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${label}.${key} must be a non-empty string`);
  }
  return value;
}

function parseDecimal(value: string, label: string): Decimal {
  if (!decimalPattern.test(value)) {
    throw new TypeError(`${label} must be a plain base-10 decimal string`);
  }
  if (value.replaceAll(/[-.]/g, '').length > MAX_NUMERIC_DIGITS) {
    throw new RangeError(`${label} exceeds the ${MAX_NUMERIC_DIGITS.toString()}-digit limit`);
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const coefficient = BigInt(`${negative ? '-' : ''}${integer}${fraction}`);
  if (coefficient === 0n && negative) {
    throw new TypeError(`${label} cannot be negative zero`);
  }
  return { coefficient, scale: fraction.length };
}

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

function decimalToRational(decimal: Decimal): Rational {
  return { numerator: decimal.coefficient, denominator: powerOfTen(decimal.scale) };
}

function greatestCommonDivisor(left: bigint, right: bigint): bigint {
  let a = left < 0n ? -left : left;
  let b = right;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

function normalizeRational(value: Rational): Rational {
  const divisor = greatestCommonDivisor(value.numerator, value.denominator);
  return {
    numerator: value.numerator / divisor,
    denominator: value.denominator / divisor,
  };
}

function add(left: Rational, right: Rational): Rational {
  return normalizeRational({
    numerator: left.numerator * right.denominator + right.numerator * left.denominator,
    denominator: left.denominator * right.denominator,
  });
}

function compareRational(left: Rational, right: Rational): number {
  const difference = left.numerator * right.denominator - right.numerator * left.denominator;
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function roundRational(value: Rational, decimalPlaces: number): string {
  const scale = powerOfTen(decimalPlaces);
  const scaledNumerator = value.numerator * scale;
  const negative = scaledNumerator < 0n;
  const absolute = negative ? -scaledNumerator : scaledNumerator;
  let quotient = absolute / value.denominator;
  const remainder = absolute % value.denominator;
  if (remainder * 2n >= value.denominator) {
    quotient += 1n;
  }
  if (quotient === 0n) {
    return decimalPlaces === 0 ? '0' : `0.${'0'.repeat(decimalPlaces)}`;
  }
  const digits = quotient.toString().padStart(decimalPlaces + 1, '0');
  const prefix = negative ? '-' : '';
  if (decimalPlaces === 0) {
    return `${prefix}${digits}`;
  }
  return `${prefix}${digits.slice(0, -decimalPlaces)}.${digits.slice(-decimalPlaces)}`;
}

/** Strictly reconstruct an authorized, effective-dated affine conversion rule. */
export function createUnitConversionRule(value: unknown): UnitConversionRule {
  const label = 'conversionRule';
  const record = requireStrictRecord(
    value,
    [
      'schemaVersion',
      'ruleId',
      'version',
      'parameterCode',
      'sourceUnit',
      'canonicalUnit',
      'sourceOffset',
      'multiplierNumerator',
      'multiplierDenominator',
      'effectiveRange',
      'authorizationId',
    ],
    [],
    label,
  );
  if (record.schemaVersion !== 'unit-conversion-rule/v1') {
    throw new TypeError(`${label}.schemaVersion must be unit-conversion-rule/v1`);
  }
  const sourceOffset = requiredString(record, 'sourceOffset', label);
  parseDecimal(sourceOffset, `${label}.sourceOffset`);
  const multiplierNumerator = requiredString(record, 'multiplierNumerator', label);
  const multiplierDenominator = requiredString(record, 'multiplierDenominator', label);
  if (
    multiplierNumerator.length > MAX_NUMERIC_DIGITS ||
    multiplierDenominator.length > MAX_NUMERIC_DIGITS
  ) {
    throw new RangeError(
      `${label} multiplier exceeds the ${MAX_NUMERIC_DIGITS.toString()}-digit limit`,
    );
  }
  if (!unsignedIntegerPattern.test(multiplierNumerator) || BigInt(multiplierNumerator) === 0n) {
    throw new TypeError(`${label}.multiplierNumerator must be a positive integer string`);
  }
  if (!unsignedIntegerPattern.test(multiplierDenominator) || BigInt(multiplierDenominator) === 0n) {
    throw new TypeError(`${label}.multiplierDenominator must be a positive integer string`);
  }
  return deepFreeze({
    schemaVersion: 'unit-conversion-rule/v1',
    ruleId: requiredString(record, 'ruleId', label),
    version: requiredString(record, 'version', label),
    parameterCode: requiredString(record, 'parameterCode', label),
    sourceUnit: requiredString(record, 'sourceUnit', label),
    canonicalUnit: requiredString(record, 'canonicalUnit', label),
    sourceOffset,
    multiplierNumerator,
    multiplierDenominator,
    effectiveRange: createTimeRange(record.effectiveRange, `${label}.effectiveRange`),
    authorizationId: requiredString(record, 'authorizationId', label),
  });
}

/** Strictly reconstruct a jurisdiction-authorized daily aggregation policy. */
export function createDailyAggregatePolicy(value: unknown): DailyAggregatePolicy {
  const label = 'aggregatePolicy';
  const record = requireStrictRecord(
    value,
    [
      'schemaVersion',
      'policyId',
      'version',
      'contractId',
      'method',
      'decimalPlaces',
      'roundingMode',
      'timeZone',
      'authorizationId',
    ],
    [],
    label,
  );
  if (record.schemaVersion !== 'daily-aggregate-policy/v1') {
    throw new TypeError(`${label}.schemaVersion must be daily-aggregate-policy/v1`);
  }
  const methods: readonly DailyAggregateMethod[] = ['sum', 'mean', 'minimum', 'maximum'];
  if (
    typeof record.method !== 'string' ||
    !methods.includes(record.method as DailyAggregateMethod)
  ) {
    throw new TypeError(`${label}.method must be sum, mean, minimum, or maximum`);
  }
  if (
    !Number.isSafeInteger(record.decimalPlaces) ||
    (record.decimalPlaces as number) > 12 ||
    (record.decimalPlaces as number) < 0
  ) {
    throw new TypeError(`${label}.decimalPlaces must be a safe integer from 0 through 12`);
  }
  if (record.roundingMode !== 'half_away_from_zero') {
    throw new TypeError(`${label}.roundingMode must be half_away_from_zero`);
  }
  return deepFreeze({
    schemaVersion: 'daily-aggregate-policy/v1',
    policyId: requiredString(record, 'policyId', label),
    version: requiredString(record, 'version', label),
    contractId: requiredString(record, 'contractId', label),
    method: record.method as DailyAggregateMethod,
    decimalPlaces: record.decimalPlaces as number,
    roundingMode: 'half_away_from_zero',
    timeZone: requireIanaTimeZone(record.timeZone, `${label}.timeZone`),
    authorizationId: requiredString(record, 'authorizationId', label),
  });
}

/** Strictly reconstruct the numeric preimage associated with one accepted observation. */
export function createNumericObservationValue(value: unknown): NumericObservationValue {
  const label = 'numericObservation';
  const record = requireStrictRecord(
    value,
    [
      'observationId',
      'contractId',
      'observedAt',
      'sourceFingerprint',
      'sourceValue',
      'sourceUnit',
      'conversionRuleId',
      'conversionRuleVersion',
    ],
    [],
    label,
  );
  const observedAt = requiredString(record, 'observedAt', label);
  instantMilliseconds(observedAt, `${label}.observedAt`);
  const sourceValue = requiredString(record, 'sourceValue', label);
  parseDecimal(sourceValue, `${label}.sourceValue`);
  return deepFreeze({
    observationId: requiredString(record, 'observationId', label),
    contractId: requiredString(record, 'contractId', label),
    observedAt,
    sourceFingerprint: requiredString(record, 'sourceFingerprint', label),
    sourceValue,
    sourceUnit: requiredString(record, 'sourceUnit', label),
    conversionRuleId: requiredString(record, 'conversionRuleId', label),
    conversionRuleVersion: requiredString(record, 'conversionRuleVersion', label),
  });
}

function normalizeCoveragePreimages(value: unknown): {
  readonly evaluation: CoverageEvaluationInput;
  readonly contract: RequiredSeriesContract;
  readonly observations: readonly Observation[];
  readonly summary: CoverageSummary;
} {
  const record = requireStrictRecord(
    value,
    ['contract', 'reportRange', 'observations', 'scheduledNonoperations'],
    ['reportTimeBasis', 'lifecycleState', 'lifecycleTimeline'],
    'coverageEvaluation',
  );
  const contract = createRequiredSeriesContract(record.contract);
  const observations = requireStrictArray(
    record.observations,
    'coverageEvaluation.observations',
  ).map(createObservation);
  const evaluation = value as CoverageEvaluationInput;
  return { evaluation, contract, observations, summary: evaluateCoverage(evaluation) };
}

function convert(value: NumericObservationValue, rule: UnitConversionRule): Rational {
  const source = decimalToRational(
    parseDecimal(value.sourceValue, 'numericObservation.sourceValue'),
  );
  const offset = decimalToRational(parseDecimal(rule.sourceOffset, 'conversionRule.sourceOffset'));
  const shifted = add(source, offset);
  return normalizeRational({
    numerator: shifted.numerator * BigInt(rule.multiplierNumerator),
    denominator: shifted.denominator * BigInt(rule.multiplierDenominator),
  });
}

function aggregate(values: readonly Rational[], method: DailyAggregateMethod): Rational {
  const first = values[0];
  /* v8 ignore next -- callers construct each bucket from at least one accepted observation. */
  if (first === undefined) {
    throw new RangeError('daily aggregate requires at least one accepted numeric observation');
  }
  if (method === 'minimum' || method === 'maximum') {
    return values.slice(1).reduce((selected, candidate) => {
      const comparison = compareRational(candidate, selected);
      return method === 'minimum'
        ? comparison < 0
          ? candidate
          : selected
        : comparison > 0
          ? candidate
          : selected;
    }, first);
  }
  const total = values.reduce(add, { numerator: 0n, denominator: 1n });
  return method === 'mean'
    ? normalizeRational({
        numerator: total.numerator,
        denominator: total.denominator * BigInt(values.length),
      })
    : total;
}

function hashRuleSet(rules: readonly UnitConversionRule[]): string {
  return sha256(canonicalJson({ schemaVersion: 'unit-conversion-rule-set-binding/v1', rules }));
}

/**
 * Aggregate only the exact accepted winners selected by coverage evaluation.
 * Missing/extra numeric preimages and ungoverned conversions fail closed.
 */
export function evaluateDailyNumericAggregate(
  input: DailyNumericAggregateInput,
): DailyNumericAggregate {
  const outer = requireStrictRecord(
    input,
    ['coverageEvaluation', 'numericObservations', 'conversionRules', 'policy'],
    [],
    'dailyNumericAggregateInput',
  );
  const { contract, observations, summary } = normalizeCoveragePreimages(outer.coverageEvaluation);
  const numericObservations = requireStrictArray(
    outer.numericObservations,
    'dailyNumericAggregateInput.numericObservations',
  ).map(createNumericObservationValue);
  const conversionRules = requireStrictArray(
    outer.conversionRules,
    'dailyNumericAggregateInput.conversionRules',
  )
    .map(createUnitConversionRule)
    .sort(
      (left, right) =>
        compareCodeUnits(left.ruleId, right.ruleId) ||
        compareCodeUnits(left.version, right.version),
    );
  if (conversionRules.length > MAX_CONVERSION_RULES) {
    throw new RangeError(
      `daily numeric aggregate exceeds the ${MAX_CONVERSION_RULES.toString()}-rule safety limit`,
    );
  }
  const policy = createDailyAggregatePolicy(outer.policy);
  if (policy.contractId !== contract.contractId) {
    throw new RangeError('aggregate policy contract does not match coverage contract');
  }
  if (policy.timeZone !== contract.timezone) {
    throw new RangeError('aggregate policy time zone does not match required-series contract');
  }

  const ruleKeys = conversionRules.map(({ ruleId, version }) => `${ruleId}\u0000${version}`);
  if (new Set(ruleKeys).size !== ruleKeys.length) {
    throw new RangeError('conversion rule ID/version pairs must be unique');
  }
  const numericIds = numericObservations.map(({ observationId }) => observationId);
  if (new Set(numericIds).size !== numericIds.length) {
    throw new RangeError('numeric observation IDs must be unique');
  }
  const acceptedIds = summary.outcomes
    .filter((outcome) => outcome.kind === 'accepted')
    .map(({ observationId }) => observationId)
    .sort(compareCodeUnits);
  const sortedNumericIds = [...numericIds].sort(compareCodeUnits);
  if (canonicalJson(sortedNumericIds) !== canonicalJson(acceptedIds)) {
    throw new RangeError('numeric observation set must exactly match accepted coverage winners');
  }
  const referencedRuleKeys = [
    ...new Set(
      numericObservations.map(
        ({ conversionRuleId, conversionRuleVersion }) =>
          `${conversionRuleId}\u0000${conversionRuleVersion}`,
      ),
    ),
  ].sort(compareCodeUnits);
  if (canonicalJson(ruleKeys) !== canonicalJson(referencedRuleKeys)) {
    throw new RangeError(
      'conversion rule set must exactly match rules pinned by numeric observations',
    );
  }

  const observationsById = new Map(
    observations.map((observation) => [observation.observationId, observation]),
  );
  const rulesByKey = new Map(
    conversionRules.map((rule) => [`${rule.ruleId}\u0000${rule.version}`, rule]),
  );
  const grouped = new Map<string, { value: Rational; observationId: string }[]>();
  for (const numeric of numericObservations) {
    const observation = observationsById.get(numeric.observationId);
    if (
      observation?.qualityState !== 'accepted' ||
      observation.contractId !== numeric.contractId ||
      observation.observedAt !== numeric.observedAt ||
      observation.sourceFingerprint !== numeric.sourceFingerprint
    ) {
      throw new RangeError(
        `numeric preimage identity does not match observation ${numeric.observationId}`,
      );
    }
    const rule = rulesByKey.get(
      `${numeric.conversionRuleId}\u0000${numeric.conversionRuleVersion}`,
    );
    if (rule === undefined) {
      throw new RangeError(
        `numeric observation ${numeric.observationId} has no pinned conversion rule`,
      );
    }
    const observedMilliseconds = instantMilliseconds(numeric.observedAt);
    if (
      rule.parameterCode !== contract.parameterCode ||
      rule.sourceUnit !== numeric.sourceUnit ||
      rule.canonicalUnit !== contract.canonicalUnit ||
      observedMilliseconds < instantMilliseconds(rule.effectiveRange.start) ||
      observedMilliseconds >= instantMilliseconds(rule.effectiveRange.end)
    ) {
      throw new RangeError(
        `conversion rule is not applicable to observation ${numeric.observationId}`,
      );
    }
    const civilDate = Temporal.Instant.from(numeric.observedAt)
      .toZonedDateTimeISO(policy.timeZone)
      .toPlainDate()
      .toString();
    const entries = grouped.get(civilDate) ?? [];
    entries.push({ value: convert(numeric, rule), observationId: numeric.observationId });
    grouped.set(civilDate, entries);
  }

  const values = [...grouped.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .map(([civilDate, entries]) => {
      const ordered = entries.sort((left, right) =>
        compareCodeUnits(left.observationId, right.observationId),
      );
      return deepFreeze({
        civilDate,
        value: roundRational(
          aggregate(
            ordered.map((entry) => entry.value),
            policy.method,
          ),
          policy.decimalPlaces,
        ),
        canonicalUnit: contract.canonicalUnit,
        acceptedObservationCount: ordered.length,
        observationIds: ordered.map(({ observationId }) => observationId),
      });
    });

  const coverageSummaryHash = sha256(canonicalJson(summary));
  const conversionRuleSetHash = hashRuleSet(conversionRules);
  const aggregatePolicyHash = sha256(
    canonicalJson({ schemaVersion: 'daily-aggregate-policy-binding/v1', policy }),
  );
  const orderedNumeric = [...numericObservations].sort((left, right) =>
    compareCodeUnits(left.observationId, right.observationId),
  );
  const numericSourceSetHash = sha256(
    canonicalJson({
      schemaVersion: 'numeric-source-set-binding/v1',
      coverageSummaryHash,
      conversionRuleSetHash,
      aggregatePolicyHash,
      observations: orderedNumeric,
    }),
  );
  return deepFreeze({
    schemaVersion: 'daily-numeric-aggregate/v1',
    contractId: contract.contractId,
    contractVersion: contract.version,
    tenantId: contract.tenantId,
    systemId: contract.systemId,
    parameterCode: contract.parameterCode,
    canonicalUnit: contract.canonicalUnit,
    governingContractHash: hashRequiredSeriesContract(contract),
    coverageEvaluationInputHash: summary.evaluationInputHash,
    coverageSummaryHash,
    conversionRuleSetHash,
    aggregatePolicyHash,
    numericSourceSetHash,
    method: policy.method,
    decimalPlaces: policy.decimalPlaces,
    roundingMode: policy.roundingMode,
    timeZone: policy.timeZone,
    values,
  });
}
