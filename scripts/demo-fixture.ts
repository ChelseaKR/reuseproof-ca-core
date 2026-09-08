/**
 * The one place the shipped synthetic fixture is turned into an evaluation input.
 *
 * `scripts/demo.ts` owned this privately until a second command needed the same input:
 * `scripts/demo-case.ts` writes that input as an `evidence-case/v1` directory and replays it
 * through the published binary. Two parsers for one fixture would be two chances for the gate
 * to exercise something the demo does not, so there is one.
 *
 * The fixture carries source objects as UTF-8 text because it is a committed synthetic file
 * and a reviewer has to be able to read it. Real source objects are bytes; the case format
 * stores them as bytes, and this boundary is where the fixture's text becomes them.
 */

import type { ReconciledCsvEvidenceInput } from '../src/index.js';
import { requireStrictArray, requireStrictRecord } from '../src/domain/validation.js';

/** Reconstruct one reconciled evaluation input from the shipped synthetic fixture shape. */
export function reconciledFixtureInput(value: unknown): ReconciledCsvEvidenceInput {
  const record = requireStrictRecord(
    value,
    ['contracts', 'reportRange', 'reportTimeBasis', 'scheduledNonoperations', 'series'],
    ['lifecycleState', 'lifecycleTimeline'],
    'reconciled demo fixture',
  );
  const series = requireStrictArray(record.series, 'reconciled demo fixture.series').map(
    (item, index) => {
      const label = `reconciled demo fixture.series[${index.toString()}]`;
      const source = requireStrictRecord(
        item,
        [
          'requiredSeriesContractId',
          'requiredSeriesContractVersion',
          'csvContract',
          'mapping',
          'conversionRules',
          'aggregatePolicy',
          'sourceObjectsUtf8',
        ],
        ['plausibilityPolicy'],
        label,
      );
      const sourceObjects = requireStrictArray(
        source.sourceObjectsUtf8,
        `${label}.sourceObjectsUtf8`,
      ).map((text, sourceIndex) => {
        if (typeof text !== 'string') {
          throw new TypeError(`${label}.sourceObjectsUtf8[${sourceIndex.toString()}] must be text`);
        }
        return new TextEncoder().encode(text);
      });
      const { sourceObjectsUtf8: _sourceObjectsUtf8, ...governance } = source;
      return { ...governance, sourceObjects };
    },
  );
  return {
    contracts: record.contracts,
    reportRange: record.reportRange,
    reportTimeBasis: record.reportTimeBasis,
    scheduledNonoperations: record.scheduledNonoperations,
    series,
    ...(Object.hasOwn(record, 'lifecycleTimeline')
      ? { lifecycleTimeline: record.lifecycleTimeline }
      : { lifecycleState: record.lifecycleState }),
  } as unknown as ReconciledCsvEvidenceInput;
}
