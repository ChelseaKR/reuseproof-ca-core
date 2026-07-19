/** Contract and evidence-constructor tests. */

import { describe, expect, it } from 'vitest';

import {
  bindVendorMappings,
  canonicalJson,
  createObservation,
  createRequiredSeriesContract,
  createScheduledNonoperation,
  createTimeRange,
  createVendorMapping,
  deepFreeze,
  hashRequiredSeriesContract,
  hashRequiredSeriesContractSet,
  instantMilliseconds,
} from '../src/index.js';
import { contractInput, nonoperationInput, observationInput } from './helpers.js';

function mappingInput(overrides: Readonly<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    schemaVersion: 'vendor-mapping/v1',
    mappingId: 'mapping-1',
    version: '1',
    contractId: 'contract-1',
    vendorField: 'flow_gpd',
    sourceUnit: 'gal/day',
    ...overrides,
  };
}

function unreadProxy<T extends object>(value: T, counter: { reads: number }): T {
  return new Proxy(value, {
    get: () => {
      counter.reads += 1;
      throw new Error('deterministic boundary must not read caller Proxy properties');
    },
  });
}

describe('required-series contract', () => {
  it('creates a deeply immutable effective-dated contract', () => {
    const contract = createRequiredSeriesContract(contractInput());

    expect(Object.isFrozen(contract)).toBe(true);
    expect(Object.isFrozen(contract.activationBasis)).toBe(true);
    expect(Object.isFrozen(contract.effectiveRange)).toBe(true);
    expect(Object.isFrozen(contract.aggregateMembership)).toBe(true);
    expect(() => {
      (contract as { cadenceMinutes: number }).cadenceMinutes = 30;
    }).toThrow(TypeError);
  });

  it('replays legacy v1 caller-ordered arrays without changing their preimages or hashes', () => {
    const contract = createRequiredSeriesContract(
      contractInput({
        contractId: 'legacy-contract',
        version: '7',
        parameterCode: 'flow.daily',
        criticality: 'report_critical',
        eligibleLifecycleStates: ['suspended', 'permitted', 'in_service'],
        aggregateMembership: ['z-total', 'a-total'],
      }),
    );
    const bindingPreimage = canonicalJson({
      schemaVersion: 'required-series-contract-binding/v1',
      contract,
    });

    expect(contract.eligibleLifecycleStates).toEqual(['suspended', 'permitted', 'in_service']);
    expect(contract.aggregateMembership).toEqual(['z-total', 'a-total']);
    expect(bindingPreimage).toBe(
      '{"contract":{"activationBasis":{"lifecycleApprovalId":"lifecycle-v1","permitVersionId":"permit-v1","profileVersionId":"profile-v1","treatmentBasisId":"train-v1"},"aggregateMembership":["z-total","a-total"],"cadenceMinutes":15,"canonicalUnit":"gal/day","contractId":"legacy-contract","criticality":"report_critical","effectiveRange":{"end":"2026-01-01T01:00:00.000Z","start":"2026-01-01T00:00:00.000Z"},"eligibleLifecycleStates":["suspended","permitted","in_service"],"parameterCode":"flow.daily","processCode":"treatment","schemaVersion":"required-series-contract/v1","statistic":"interval_observation","systemId":"system-1","tenantId":"tenant-1","timezone":"America/Los_Angeles","version":"7"},"schemaVersion":"required-series-contract-binding/v1"}',
    );
    expect(hashRequiredSeriesContract(contract)).toBe(
      '4a67c62d3b9b02903f193fce90e98e91ebd942c4a5ed86d06aff8fd3b1bf4f10',
    );
    expect(hashRequiredSeriesContractSet([contract])).toBe(
      '49d5aca8b301ce3d93cd9ae81fa90a1e068cd40c4e2b687c1ff6c963699bdd03',
    );
  });

  it('strictly reconstructs contract hash inputs without invoking accessors or Proxy gets', () => {
    const valid = contractInput();
    const normalized = createRequiredSeriesContract(valid);
    const expected = hashRequiredSeriesContract(normalized);
    expect(() => hashRequiredSeriesContract({ ...valid, unsupported: true } as never)).toThrow(
      'unsupported keys',
    );

    let getterReads = 0;
    const accessor = { ...valid };
    Object.defineProperty(accessor, 'contractId', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterReads += 1;
        return 'contract-1';
      },
    });
    expect(() => hashRequiredSeriesContract(accessor as never)).toThrow('enumerable data property');
    expect(getterReads).toBe(0);

    const counter = { reads: 0 };
    const proxiedContract = unreadProxy(structuredClone(valid), counter);
    const proxiedSet = unreadProxy([proxiedContract], counter);
    expect(hashRequiredSeriesContract(proxiedContract as never)).toBe(expected);
    expect(hashRequiredSeriesContractSet(proxiedSet as never)).toBe(
      hashRequiredSeriesContractSet([normalized]),
    );
    expect(counter.reads).toBe(0);

    const accessorSet = [normalized];
    Object.defineProperty(accessorSet, '0', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterReads += 1;
        return normalized;
      },
    });
    expect(() => hashRequiredSeriesContractSet(accessorSet)).toThrow('enumerable data property');
    expect(getterReads).toBe(0);
  });

  it.each([
    [null, 'must be an object'],
    [{ ...contractInput(), relaxRequiredness: true }, 'unsupported keys'],
    [{ ...contractInput(), schemaVersion: 'v2' }, 'schemaVersion'],
    [{ ...contractInput(), contractId: '' }, 'contractId'],
    [{ ...contractInput(), cadenceMinutes: 0 }, 'cadenceMinutes'],
    [{ ...contractInput(), cadenceMinutes: 1.5 }, 'cadenceMinutes'],
    [{ ...contractInput(), timezone: 'Mars/Olympus' }, 'timezone'],
    [{ ...contractInput(), timezone: '-08:00' }, 'recognized IANA'],
    [{ ...contractInput(), timezone: '+01' }, 'recognized IANA'],
    [{ ...contractInput(), timezone: '+0100' }, 'recognized IANA'],
    [{ ...contractInput(), timezone: '+01:00' }, 'recognized IANA'],
    [{ ...contractInput(), criticality: 'optional' }, 'criticality'],
    [{ ...contractInput(), eligibleLifecycleStates: [] }, 'eligibleLifecycleStates'],
    [{ ...contractInput(), eligibleLifecycleStates: ['unknown'] }, 'eligibleLifecycleStates'],
    [{ ...contractInput(), aggregateMembership: 'annual-flow' }, 'array'],
    [{ ...contractInput(), aggregateMembership: [''] }, 'non-empty strings'],
    [{ ...contractInput(), aggregateMembership: ['a', 'a'] }, 'duplicates'],
    [{ ...contractInput(), activationBasis: { permitVersionId: 'permit-v1' } }, 'profileVersionId'],
  ])('rejects invalid contract input %#', (input, message) => {
    expect(() => createRequiredSeriesContract(input)).toThrow(message);
  });
});

describe('time and evidence inputs', () => {
  it('accepts fixed UTC instants and non-empty ranges', () => {
    expect(instantMilliseconds('2026-01-01T00:00:00.000Z')).toBe(1_767_225_600_000);
    expect(
      createTimeRange({
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-01T00:01:00.000Z',
      }),
    ).toEqual({
      start: '2026-01-01T00:00:00.000Z',
      end: '2026-01-01T00:01:00.000Z',
    });
  });

  it.each([
    ['2026-01-01T00:00:00Z', 'fixed-millisecond'],
    ['2026-02-30T00:00:00.000Z', 'valid UTC'],
  ])('rejects a noncanonical instant', (instant, message) => {
    expect(() => instantMilliseconds(instant)).toThrow(message);
  });

  it('rejects empty, malformed, and extended ranges', () => {
    expect(() => createTimeRange('not-an-object')).toThrow('must be an object');
    expect(() =>
      createTimeRange({
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow('start < end');
    expect(() =>
      createTimeRange({
        start: '2026-01-01T00:00:00.000Z',
        end: '2026-01-01T00:01:00.000Z',
        inclusive: true,
      }),
    ).toThrow('unsupported keys');
  });

  it('parses accepted, quarantined, and superseded observations', () => {
    expect(
      createObservation(observationInput('accepted', '2026-01-01T00:00:00.000Z')),
    ).toMatchObject({ qualityState: 'accepted' });
    expect(
      createObservation(
        observationInput('quarantined', '2026-01-01T00:00:00.000Z', {
          qualityState: 'quarantined',
          quarantineReason: 'impossible_unit',
        }),
      ),
    ).toMatchObject({ qualityState: 'quarantined', quarantineReason: 'impossible_unit' });
    expect(
      createObservation(
        observationInput('old', '2026-01-01T00:00:00.000Z', { supersededBy: 'new' }),
      ),
    ).toMatchObject({ supersededBy: 'new' });
  });

  it.each([undefined, null])(
    'rejects explicitly present nullish optional observation fields (%s)',
    (nullish) => {
      expect(() =>
        createObservation(
          observationInput('accepted-reason', '2026-01-01T00:00:00.000Z', {
            quarantineReason: nullish,
          }),
        ),
      ).toThrow('cannot have a quarantineReason');
      expect(() =>
        createObservation(
          observationInput('accepted-supersession', '2026-01-01T00:00:00.000Z', {
            supersededBy: nullish,
          }),
        ),
      ).toThrow('non-empty string');
      expect(() =>
        createObservation(
          observationInput('quarantined-reason', '2026-01-01T00:00:00.000Z', {
            qualityState: 'quarantined',
            quarantineReason: nullish,
          }),
        ),
      ).toThrow('supported quarantineReason');
      expect(() =>
        createObservation(
          observationInput('quarantined-supersession', '2026-01-01T00:00:00.000Z', {
            qualityState: 'quarantined',
            quarantineReason: 'malformed_value',
            supersededBy: nullish,
          }),
        ),
      ).toThrow('only accepted');
    },
  );

  it.each([
    [{ ...observationInput('bad', '2026-01-01T00:00:00.000Z'), extra: true }, 'unsupported'],
    [observationInput('bad', '2026-01-01T00:00:00.000Z', { qualityState: 'bad' }), 'qualityState'],
    [
      observationInput('bad', '2026-01-01T00:00:00.000Z', {
        qualityState: 'quarantined',
      }),
      'quarantineReason',
    ],
    [
      observationInput('bad', '2026-01-01T00:00:00.000Z', {
        quarantineReason: 'impossible_unit',
      }),
      'cannot have',
    ],
    [
      observationInput('bad', '2026-01-01T00:00:00.000Z', {
        qualityState: 'quarantined',
        quarantineReason: 'impossible_unit',
        supersededBy: 'new',
      }),
      'only accepted',
    ],
  ])('rejects inconsistent observations %#', (input, message) => {
    expect(() => createObservation(input)).toThrow(message);
  });

  it('parses and validates scheduled nonoperation evidence', () => {
    expect(createScheduledNonoperation(nonoperationInput())).toMatchObject({
      nonoperationId: 'stop-1',
      evidenceId: 'evidence-1',
    });
    expect(() =>
      createScheduledNonoperation(nonoperationInput({ authorizedAt: 'yesterday' })),
    ).toThrow('fixed-millisecond');
  });
});

describe('vendor mapping boundary', () => {
  it('retains every required contract when mappings are absent', () => {
    const contract1 = createRequiredSeriesContract(contractInput());
    const contract2 = createRequiredSeriesContract(
      contractInput({ contractId: 'contract-2', parameterCode: 'volume.produced.daily' }),
    );
    const bindings = bindVendorMappings(
      [contract2, contract1],
      [createVendorMapping(mappingInput())],
    );

    expect(bindings.map(({ contract }) => contract.contractId)).toEqual([
      'contract-1',
      'contract-2',
    ]);
    expect(bindings.map(({ mapping }) => mapping?.mappingId ?? null)).toEqual(['mapping-1', null]);
  });

  it('rejects denominator mutation fields, unknown contracts, and duplicate mappings', () => {
    const contract = createRequiredSeriesContract(contractInput());
    expect(() => createVendorMapping(mappingInput({ cadenceMinutes: 30 }))).toThrow(
      'unsupported keys',
    );
    expect(() => createVendorMapping(mappingInput({ schemaVersion: 'v2' }))).toThrow(
      'schemaVersion',
    );
    expect(() =>
      bindVendorMappings(
        [contract],
        [createVendorMapping(mappingInput({ contractId: 'invented-contract' }))],
      ),
    ).toThrow('unknown required contract');
    expect(() =>
      bindVendorMappings(
        [contract],
        [
          createVendorMapping(mappingInput()),
          createVendorMapping(mappingInput({ mappingId: 'mapping-2' })),
        ],
      ),
    ).toThrow('more than one mapping');
    expect(() => bindVendorMappings([contract, contract], [])).toThrow('unique contract IDs');
  });

  it('normalizes binding inputs once and never freezes or reads caller-owned objects', () => {
    const rawContract = contractInput();
    const rawMapping = mappingInput();
    const bindings = bindVendorMappings([rawContract as never], [rawMapping as never]);
    expect(bindings[0]?.contract).toEqual(createRequiredSeriesContract(rawContract));
    expect(bindings[0]?.mapping).toEqual(createVendorMapping(rawMapping));
    expect(Object.isFrozen(rawContract)).toBe(false);
    expect(Object.isFrozen(rawMapping)).toBe(false);
    expect(() => bindVendorMappings([{ ...rawContract, extra: true } as never], [])).toThrow(
      'unsupported keys',
    );
    expect(() =>
      bindVendorMappings([rawContract as never], [{ ...rawMapping, extra: true } as never]),
    ).toThrow('unsupported keys');

    let getterReads = 0;
    const accessorContracts = [rawContract];
    Object.defineProperty(accessorContracts, '0', {
      enumerable: true,
      configurable: true,
      get: () => {
        getterReads += 1;
        return rawContract;
      },
    });
    expect(() => bindVendorMappings(accessorContracts as never, [])).toThrow(
      'enumerable data property',
    );
    expect(getterReads).toBe(0);

    const counter = { reads: 0 };
    const proxiedContracts = unreadProxy(
      [unreadProxy(structuredClone(rawContract), counter)],
      counter,
    );
    const proxiedMappings = unreadProxy(
      [unreadProxy(structuredClone(rawMapping), counter)],
      counter,
    );
    expect(bindVendorMappings(proxiedContracts as never, proxiedMappings as never)).toHaveLength(1);
    expect(counter.reads).toBe(0);
  });

  it('deep-freezes nested arrays and tolerates primitive values', () => {
    const value = deepFreeze({ nested: [{ value: 1 }], text: 'stable' });
    expect(Object.isFrozen(value.nested)).toBe(true);
    expect(Object.isFrozen(value.nested[0])).toBe(true);
    expect(deepFreeze('stable')).toBe('stable');
  });
});
