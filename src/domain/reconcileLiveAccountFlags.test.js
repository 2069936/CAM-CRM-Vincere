import { describe, expect, it } from 'vitest';
import {
  LIVE_ACCOUNT_FLAG_TYPES,
  accountIsPastLiveFlags,
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

  it.each(DEAD)('%s, in the close with a strategy that did not run: no Strategy disabled', (_, over) => {
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

  it.each(DEAD)('%s, nothing ran: no Expected strategy missing', (_, over) => {
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

  it.each(DEAD.filter(([label]) => label !== 'type Inactive / Ignore'))(
    '%s, model 1: no near or approaching, and Drawdown breached is still raised',
    (_, over) => {
      const registry = registryOf({ maxDrawdownLimit: 2000, ...over });
      expect(typesOf(run(registry, model1(1600)))).not.toContain('Drawdown near limit');
      expect(typesOf(run(registry, model1(1100)))).not.toContain('Drawdown approaching limit');
      expect(typesOf(run(registry, model1(2100)))).toContain('Drawdown breached');
    },
  );

  it.each(DEAD.filter(([label]) => label !== 'type Inactive / Ignore'))(
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
