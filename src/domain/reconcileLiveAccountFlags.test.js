import { describe, expect, it } from 'vitest';
import {
  LIVE_ACCOUNT_FLAG_TYPES,
  accountIsPastLiveFlags,
  closeReadingBreach,
  observedStateInClose,
  recalculateDailyImport,
  reconcileDailyImport,
} from './reconcile';

/* THE FIVE FLAGS THAT ONLY MEAN SOMETHING ON A LIVE ACCOUNT.
 *
 * Production on 2026-10-09: 6,808 Open flags, 2,758 of them on an account whose
 * status is Failed, and one close alone raised 160 Missing account flags. A
 * dead account cannot be missing, cannot have a strategy switched off, cannot
 * be expected to run one and cannot be approaching a limit it already went
 * through. These are the generator's half of step 67: the database refuses the
 * same five at insert (supabase/step_67_flag_hygiene.sql) and resolves the ones
 * already open, so the two have to agree on the five and on what "dead" means.
 *
 * The fixtures are fictional; the shapes are the registry's.
 */

const DAY = '2026-10-08';

const DEAD = [
  ['status Failed', { status: 'Failed' }],
  ['status Inactive', { status: 'Inactive' }],
  ['status Reserve', { status: 'Reserve' }],
  ['type Inactive / Ignore', { accountType: 'Inactive / Ignore' }],
  ['observed breached', { observedState: 'breached' }],
  ['observed absent', { observedState: 'absent' }],
];

// For an account IN the close the stored observation is read as of that close
// (observedStateInClose): 'absent' is already wrong there, and a measured
// reading decides 'breached'. These are dead in the close whatever it reports;
// 'observed breached' only while the close measures nothing, which is the shape
// account() below has (no trailing column).
const DEAD_IN_CLOSE = DEAD.filter(([label]) => label !== 'observed absent');
// Dead whatever the close reads: the registry says so.
const DEAD_BY_REGISTRY = DEAD.filter(([label]) => !label.startsWith('observed'));

const LIVE = [
  ['Active and seen', { observedState: 'seen' }],
  ['Active and never seen', { observedState: 'never_seen' }],
  ['Active with no observation yet', { observedState: null }],
  ['Payout Hold', { status: 'Payout Hold', observedState: 'seen' }],
];

function registryOf(over = {}, name = 'ACC 01') {
  return {
    [name]: {
      accountName: name,
      alias: name,
      accountType: 'Funded',
      status: 'Active',
      ...over,
    },
  };
}

function close(accounts = [], strategies = []) {
  return { accounts, strategies, orders: [], executions: [] };
}

function account(over = {}) {
  return {
    accountName: 'ACC 01', connection: 'Lucid', grossRealizedPnl: 0, accountBalance: 50000, weeklyPnl: 0, ...over,
  };
}

function typesOf(result) {
  return result.flags.map((flag) => flag.type);
}

function run(registry, parsed) {
  return reconcileDailyImport({ clientId: 'fictional', date: DAY, registry, parsed });
}

describe('the five and the rule', () => {
  it('are exactly the five types the step 67 note names, in one exported list', () => {
    expect([...LIVE_ACCOUNT_FLAG_TYPES].sort()).toEqual([
      'Drawdown approaching limit',
      'Drawdown near limit',
      'Expected strategy missing',
      'Missing account',
      'Strategy disabled',
    ]);
    expect(Object.isFrozen(LIVE_ACCOUNT_FLAG_TYPES)).toBe(true);
  });

  it.each(DEAD)('an account with %s is past the five', (_, over) => {
    expect(accountIsPastLiveFlags({ accountType: 'Funded', status: 'Active', ...over })).toBe(true);
  });

  it.each(LIVE)('an account %s is not', (_, over) => {
    expect(accountIsPastLiveFlags({ accountType: 'Funded', status: 'Active', ...over })).toBe(false);
  });

  it('nothing known is not dead: no record, an empty one, and a brand new one', () => {
    expect(accountIsPastLiveFlags(null)).toBe(false);
    expect(accountIsPastLiveFlags(undefined)).toBe(false);
    expect(accountIsPastLiveFlags({})).toBe(false);
  });
});

describe('Missing account is not raised for a dead account', () => {
  it.each(DEAD)('%s, registered and absent from the close: no Missing account', (_, over) => {
    const result = run(registryOf(over), close());
    expect(typesOf(result)).not.toContain('Missing account');
  });

  it.each(LIVE)('%s, registered and absent from the close: still raised', (_, over) => {
    const result = run(registryOf(over), close());
    expect(result.flags.filter((flag) => flag.type === 'Missing account')).toHaveLength(1);
  });

  it('the dead account is still carried in the import accounts, untouched', () => {
    const result = run(registryOf({ status: 'Failed', observedState: 'breached' }), close());
    expect(result.accounts['ACC 01']).toMatchObject({ status: 'Failed', observedState: 'breached' });
  });
});

describe('Strategy disabled is not raised for a dead account', () => {
  const switchedOff = [{ accountName: 'ACC 01', strategyName: '1 - IFSP-2.0', strategyFamily: 'IFSP', enabled: false }];

  it.each(DEAD_IN_CLOSE)('%s, in the close with a strategy that did not run: no Strategy disabled', (_, over) => {
    const result = run(registryOf(over), close([account()], switchedOff));
    expect(typesOf(result)).not.toContain('Strategy disabled');
  });

  it.each(LIVE)('%s: still raised', (_, over) => {
    const result = run(registryOf(over), close([account()], switchedOff));
    expect(result.flags.filter((flag) => flag.type === 'Strategy disabled')).toHaveLength(1);
  });
});

describe('Expected strategy missing is not raised for a dead account', () => {
  const idle = [{ accountName: 'ACC 01', strategyName: '0 - RBO-1.8', strategyFamily: 'RBO', enabled: false }];

  it.each(DEAD_IN_CLOSE)('%s, nothing ran: no Expected strategy missing', (_, over) => {
    const result = run(registryOf(over), close([account()], idle));
    expect(typesOf(result)).not.toContain('Expected strategy missing');
  });

  it('a live Active Funded account where nothing ran: still raised, Critical', () => {
    const result = run(registryOf({ observedState: 'seen' }), close([account()], idle));
    expect(result.flags.filter((flag) => flag.type === 'Expected strategy missing'))
      .toEqual([expect.objectContaining({ severity: 'Critical' })]);
  });
});

describe('the drawdown ladder: breached stays, near and approaching go', () => {
  const running = [{ accountName: 'ACC 01', strategyName: '0 - RBO', enabled: true }];
  // Model 1: a 2,000 limit and a cumulative loss. 1,600 leaves 400 (near),
  // 1,100 leaves 900 (approaching), 2,100 is through it (breached).
  const model1 = (loss) => close([account({ trailingMaxDrawdown: -loss, grossRealizedPnl: -loss })], running);
  // Model 2: no limit, the reading is the buffer. 300 is near, 900 approaching,
  // -50 breached.
  const model2 = (buffer) => close([account({ trailingMaxDrawdown: buffer })], running);

  it.each(DEAD_BY_REGISTRY.filter(([label]) => label !== 'type Inactive / Ignore'))(
    '%s, model 1: no near or approaching, and Drawdown breached is still raised',
    (_, over) => {
      const registry = registryOf({ maxDrawdownLimit: 2000, ...over });
      expect(typesOf(run(registry, model1(1600)))).not.toContain('Drawdown near limit');
      expect(typesOf(run(registry, model1(1100)))).not.toContain('Drawdown approaching limit');
      expect(typesOf(run(registry, model1(2100)))).toContain('Drawdown breached');
    },
  );

  it.each(DEAD_BY_REGISTRY.filter(([label]) => label !== 'type Inactive / Ignore'))(
    '%s, model 2: no near or approaching, and Drawdown breached is still raised',
    (_, over) => {
      const registry = registryOf(over);
      expect(typesOf(run(registry, model2(300)))).not.toContain('Drawdown near limit');
      expect(typesOf(run(registry, model2(900)))).not.toContain('Drawdown approaching limit');
      expect(typesOf(run(registry, model2(-50)))).toContain('Drawdown breached');
    },
  );

  it('a live account keeps the whole ladder, both models', () => {
    const one = registryOf({ maxDrawdownLimit: 2000, observedState: 'seen' });
    expect(typesOf(run(one, model1(1600)))).toContain('Drawdown near limit');
    expect(typesOf(run(one, model1(1100)))).toContain('Drawdown approaching limit');
    expect(typesOf(run(one, model1(2100)))).toContain('Drawdown breached');
    const two = registryOf({ observedState: 'seen' });
    expect(typesOf(run(two, model2(300)))).toContain('Drawdown near limit');
    expect(typesOf(run(two, model2(900)))).toContain('Drawdown approaching limit');
    expect(typesOf(run(two, model2(-50)))).toContain('Drawdown breached');
  });
});

describe('everything else a dead account raises is unchanged', () => {
  it('a Failed account that ran a strategy still raises Unexpected strategy active', () => {
    const result = run(
      registryOf({ status: 'Failed' }),
      close([account()], [{ accountName: 'ACC 01', strategyName: '0 - RBO', enabled: true, ran: true, ranBasis: 'fills' }]),
    );
    expect(typesOf(result)).toContain('Unexpected strategy active');
  });

  it('an unknown account in the close is still New account, whatever the registry holds for others', () => {
    const result = run(
      registryOf({ status: 'Failed' }),
      close([account(), account({ accountName: 'ACC 99' })]),
    );
    expect(result.flags.filter((flag) => flag.type === 'New account').map((flag) => flag.accountName)).toEqual(['ACC 99']);
  });
});

describe('the registry is matched as reconcile always matched it', () => {
  it('a registry keyed in another case still finds the observation', () => {
    const registry = { 'acc 01': { accountName: 'acc 01', alias: 'acc 01', accountType: 'Funded', status: 'Active', observedState: 'breached' } };
    const result = run(registry, close([account()], [{ accountName: 'ACC 01', strategyName: 'X', enabled: false }]));
    expect(typesOf(result)).not.toContain('Strategy disabled');
    expect(typesOf(result)).not.toContain('Expected strategy missing');
  });
});

/* READ AS OF THE CLOSE.
 *
 * observed_state is rewritten by step 65's refresh at the commit of a close, so
 * the registry reconcile reads holds what the closes BEFORE this one said. An
 * Active account absent for five closes that reports today is alive today (the
 * refresh writes 'seen' at this very commit), and before step 67 it got these
 * flags on the close it came back in. The same for an Active account still
 * reading 'breached' (auto fail off, or revived by a CAM) whose new reading is
 * clear: the latest measured reading is the refresh's word, and it is this one.
 */
describe('an account in the close is read as of that close', () => {
  const idleIfsp = [{ accountName: 'ACC 01', strategyName: '1 - IFSP', strategyFamily: 'IFSP', enabled: false }];
  const nearBuffer = close([account({ trailingMaxDrawdown: 300 })], idleIfsp);
  const inClose = (result) => result.flags
    .filter((flag) => flag.accountName === 'ACC 01' && LIVE_ACCOUNT_FLAG_TYPES.includes(flag.type))
    .map((flag) => `${flag.type}|${flag.severity}`)
    .sort();
  const THREE = ['Drawdown near limit|Critical', 'Expected strategy missing|Critical', 'Strategy disabled|Warning'];

  it('an Active account absent for five closes that comes back near its limit keeps the three, like one never absent', () => {
    const returning = run(registryOf({ observedState: 'absent', closesMissed: 5 }), nearBuffer);
    const steady = run(registryOf({ observedState: 'seen', closesMissed: 0 }), nearBuffer);
    expect(inClose(steady)).toEqual(THREE);
    expect(inClose(returning)).toEqual(THREE);
  });

  it('the same account, still absent from the close, still gets no Missing account', () => {
    const result = run(registryOf({ observedState: 'absent', closesMissed: 5 }), close());
    expect(typesOf(result)).not.toContain('Missing account');
  });

  it('an Active account still reading breached whose new reading is clear but near: the ladder and the strategy flags, both models', () => {
    const stale = { observedState: 'breached' };
    expect(inClose(run(registryOf(stale), nearBuffer))).toEqual(THREE);
    const one = registryOf({ ...stale, maxDrawdownLimit: 2000 });
    const nearOne = close([account({ trailingMaxDrawdown: -1600 })], idleIfsp);
    const approachingOne = close([account({ trailingMaxDrawdown: -1100 })], idleIfsp);
    expect(typesOf(run(one, nearOne))).toContain('Drawdown near limit');
    expect(typesOf(run(one, approachingOne))).toContain('Drawdown approaching limit');
    expect(typesOf(run(registryOf(stale), close([account({ trailingMaxDrawdown: 900 })], idleIfsp))))
      .toContain('Drawdown approaching limit');
  });

  it('a stored breach with nothing measured in this close stands: an unmeasured reading changes nothing, as in the refresh', () => {
    for (const trailing of [undefined, 0]) {
      const result = run(registryOf({ observedState: 'breached' }), close([account({ trailingMaxDrawdown: trailing })], idleIfsp));
      expect(inClose(result), String(trailing)).toEqual([]);
    }
  });

  it('a seen account whose reading in this close is a breach: Drawdown breached, and none of the five', () => {
    const result = run(registryOf({ observedState: 'seen' }), close([account({ trailingMaxDrawdown: -50 })], idleIfsp));
    expect(typesOf(result)).toContain('Drawdown breached');
    expect(inClose(result)).toEqual([]);
    const one = run(
      registryOf({ observedState: 'seen', maxDrawdownLimit: 2000 }),
      close([account({ trailingMaxDrawdown: -2100 })], idleIfsp),
    );
    expect(typesOf(one)).toContain('Drawdown breached');
    expect(inClose(one)).toEqual([]);
  });

  it('a registry death is not overruled by a clear reading: Failed, Inactive, Reserve, Inactive / Ignore', () => {
    for (const [label, over] of DEAD_BY_REGISTRY) {
      expect(inClose(run(registryOf({ ...over, observedState: 'seen' }), nearBuffer)), label).toEqual([]);
    }
  });
});

describe('the reading and the observation as of a close, at their edges', () => {
  it('closeReadingBreach is step 65\'s account_observation_breach: unmeasured, cash and simulation are null', () => {
    expect(closeReadingBreach(null, 'Funded', null)).toBe(null);
    expect(closeReadingBreach(undefined, 'Funded', null)).toBe(null);
    expect(closeReadingBreach(0, 'Funded', null)).toBe(null);
    expect(closeReadingBreach(Number.NaN, 'Funded', null)).toBe(null);
    expect(closeReadingBreach(Number.POSITIVE_INFINITY, 'Funded', null)).toBe(null);
    expect(closeReadingBreach(-5, 'Cash - IRA', null)).toBe(null);
    expect(closeReadingBreach(-5, 'Cash', null)).toBe(null);
    expect(closeReadingBreach(-5, ' Simulation ', null)).toBe(null);
    // Model 2: the reading is the buffer.
    expect(closeReadingBreach(-0.01, 'Funded', null)).toBe(true);
    expect(closeReadingBreach(300, 'Funded', 0)).toBe(false);
    // Model 1: the reading is cumulative loss against the limit.
    expect(closeReadingBreach(-2000, 'Funded', 2000)).toBe(true);
    expect(closeReadingBreach(-1999, 'Funded', '2000')).toBe(false);
  });

  it('observedStateInClose: out of the close the stored word stands; in it, a measured reading decides', () => {
    for (const stored of ['seen', 'breached', 'absent', 'never_seen', null]) {
      expect(observedStateInClose(stored, { inClose: false, closeBreach: true }), String(stored)).toBe(stored);
      expect(observedStateInClose(stored, { inClose: true, closeBreach: true }), String(stored)).toBe('breached');
      expect(observedStateInClose(stored, { inClose: true, closeBreach: false }), String(stored)).toBe('seen');
    }
    expect(observedStateInClose('breached', { inClose: true, closeBreach: null })).toBe('breached');
    expect(observedStateInClose('absent', { inClose: true, closeBreach: null })).toBe('seen');
    expect(observedStateInClose('never_seen', { inClose: true })).toBe('seen');
    expect(observedStateInClose(undefined)).toBe(null);
  });
});

describe('Recalculate regenerates none of the five for a dead account', () => {
  it('a close holding a near limit reading and a switched off strategy, recalculated after the account failed', () => {
    const before = registryOf({ maxDrawdownLimit: 2000, observedState: 'seen' });
    const original = run(before, close(
      [account({ trailingMaxDrawdown: -1600 })],
      [{ accountName: 'ACC 01', strategyName: '1 - IFSP', enabled: false }],
    ));
    expect(typesOf(original)).toEqual(expect.arrayContaining(['Drawdown near limit', 'Strategy disabled']));
    const after = recalculateDailyImport({
      dailyImport: { ...original, clientId: 'fictional', date: DAY },
      registry: registryOf({ maxDrawdownLimit: 2000, status: 'Failed', observedState: 'breached' }),
    });
    const five = after.flags.filter((flag) => LIVE_ACCOUNT_FLAG_TYPES.includes(flag.type));
    expect(five).toEqual([]);
  });
});
