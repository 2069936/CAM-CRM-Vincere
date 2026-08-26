import { describe, expect, it } from 'vitest';
import {
  RESIDUAL_REASONS,
  deriveStrategyPnl,
  deriveStrategyPnlByAccount,
  multiplierFor,
  orderExecutions,
  parsePosition,
} from './deriveStrategyPnl.js';

// Every fixture here is synthetic. public/local-snapshot.json cannot be used to
// test this module: its `time_text` and `entry_exit` columns are redacted, which
// is exactly what made an earlier measurement conclude — wrongly — that per-algo
// P&L is underivable. See the header of algoContribution.js.
//
// MNQ is worth $2 a point, NQ $20, MES $5. Every expected figure below is small
// enough to check by hand on purpose.

let seq = 0;
const nextId = () => `${(seq += 1)}_1`;

function fill({ id, action, qty = 1, price, position = '-', orderId, account = 'ACC1', instrument = 'MNQ SEP26', time = '' }) {
  return { id: id ?? nextId(), accountName: account, instrument, action, quantity: qty, price, position, orderId, time, entryExit: '' };
}
function order({ id, strategyName = '', name = '', account = 'ACC1' }) {
  return { id, strategyName, name, accountName: account };
}

describe('a clean intraday round trip', () => {
  it('credits the whole pair to the strategy that owned both legs', () => {
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'O1' }),
        fill({ action: 'Sell', price: 110, position: '-', orderId: 'O2' }),
      ],
      orders: [order({ id: 'O1', strategyName: 'Alpha-1.0' }), order({ id: 'O2', strategyName: 'Alpha-1.0' })],
      reportedGross: 20,
    });

    expect(result.byStrategy).toEqual([{ strategyName: 'Alpha-1.0', realized: 20, pairs: 1 }]);
    expect(result.residual.realized).toBe(0);
    expect(result.residual.pairs).toBe(0);
    expect(result.openContracts).toBe(0);
    expect(result.positionAgrees).toBe(true);
    expect(result.status).toBe('exact');
  });

  it('prices a short the other way round', () => {
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Sell', price: 200, position: '1 S', orderId: 'O1' }),
        fill({ action: 'Buy', price: 195, position: '-', orderId: 'O2' }),
      ],
      orders: [order({ id: 'O1', strategyName: 'Beta-1.0' }), order({ id: 'O2', strategyName: 'Beta-1.0' })],
      reportedGross: 10,
    });
    expect(result.byStrategy).toEqual([{ strategyName: 'Beta-1.0', realized: 10, pairs: 1 }]);
    expect(result.status).toBe('exact');
  });
});

describe('a multi-leg scale-out', () => {
  it('pairs FIFO against one entry and adds the legs up', () => {
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', qty: 3, price: 100, position: '3 L', orderId: 'O1' }),
        fill({ action: 'Sell', qty: 1, price: 105, position: '2 L', orderId: 'O2' }),
        fill({ action: 'Sell', qty: 2, price: 110, position: '-', orderId: 'O3' }),
      ],
      orders: ['O1', 'O2', 'O3'].map((id) => order({ id, strategyName: 'Alpha-1.0' })),
      reportedGross: 50,
    });
    // (105-100)*1*2 + (110-100)*2*2 = 10 + 40
    expect(result.byStrategy).toEqual([{ strategyName: 'Alpha-1.0', realized: 50, pairs: 2 }]);
    expect(result.pairs).toBe(2);
    expect(result.status).toBe('exact');
  });
});

describe('two strategies on one account', () => {
  it('keeps their money apart even on the same instrument', () => {
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'A1' }),
        fill({ action: 'Sell', price: 110, position: '-', orderId: 'A2' }),
        fill({ action: 'Sell', price: 200, position: '1 S', orderId: 'B1' }),
        fill({ action: 'Buy', price: 195, position: '-', orderId: 'B2' }),
      ],
      orders: [
        order({ id: 'A1', strategyName: 'Alpha-1.0' }), order({ id: 'A2', strategyName: 'Alpha-1.0' }),
        order({ id: 'B1', strategyName: 'Beta-1.0' }), order({ id: 'B2', strategyName: 'Beta-1.0' }),
      ],
      reportedGross: 30,
    });
    expect(result.byStrategy).toEqual([
      { strategyName: 'Alpha-1.0', realized: 20, pairs: 1 },
      { strategyName: 'Beta-1.0', realized: 10, pairs: 1 },
    ]);
    expect(result.status).toBe('exact');
  });
});

describe('a fill whose strategy cannot be determined', () => {
  it('sends a hand-placed pair to the residual instead of dropping it', () => {
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'M1' }),
        fill({ action: 'Sell', price: 110, position: '-', orderId: 'M2' }),
      ],
      orders: [order({ id: 'M1' }), order({ id: 'M2' })],
      reportedGross: 20,
    });
    expect(result.byStrategy).toEqual([]);
    expect(result.residual).toMatchObject({ realized: 20, pairs: 1, reasons: { [RESIDUAL_REASONS.NO_STRATEGY]: 1 } });
    // The money is still in the derived total — it is the SPLIT that is unknown,
    // not the P&L. The account still reconciles; it just cannot be broken down.
    expect(result.derivedTotal).toBe(20);
    expect(result.reconciles).toBe(true);
    expect(result.status).toBe('partial');
  });

  it('refuses a pair whose two legs belong to different owners', () => {
    // This is the real ARPD case: a manual entry closed by a strategy's order.
    // Crediting it to the strategy is what made an earlier attempt report -300
    // where NinjaTrader reported -228. The pair goes to the residual instead.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'M1' }),
        fill({ action: 'Sell', price: 110, position: '-', orderId: 'S1' }),
      ],
      orders: [order({ id: 'M1' }), order({ id: 'S1', strategyName: 'Alpha-1.0' })],
      reportedGross: 20,
    });
    expect(result.byStrategy).toEqual([]);
    expect(result.residual.reasons[RESIDUAL_REASONS.MANUAL_LEG]).toBe(1);
    expect(result.status).toBe('partial');
  });

  it('credits a detached EXIT to the one strategy the book names', () => {
    // NinjaTrader's session flatten: the order row exists, State=Filled, its
    // Name is "Close", and its Strategy cell is blank. This was refused as a
    // guess for one day, and 2026-08-19 settled it: four grid-reported values
    // that the strict rule got wrong by $311.50, $315.00, $400.00 and $201.00
    // come out to the cent once the detached leg is credited. See rule 4b.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'O1' }),
        fill({ action: 'Sell', price: 110, position: '-', orderId: 'X1' }),
      ],
      orders: [order({ id: 'O1', strategyName: 'Alpha-1.0' }), order({ id: 'X1', name: 'Close' })],
      reportedGross: 20,
    });
    expect(result.byStrategy).toEqual([{ strategyName: 'Alpha-1.0', realized: 20, pairs: 1 }]);
    expect(result.residual.pairs).toBe(0);
    expect(result.detachedPairs).toBe(1);
    expect(result.status).toBe('exact');
  });

  it('credits a detached ENTRY the same way — the rule is about a leg, not an exit', () => {
    // The mirror image, and it is not hypothetical: on 2026-08-19 one book was
    // opened by a blank-Strategy "Enter Short" and closed by two named exits.
    // The grid credited the whole +1550.00 to Bullet Bot-1.1. A rule written
    // about detached EXITS would have declined that row and reported nothing.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Sell', qty: 2, price: 200, position: '2 S', orderId: 'E1' }),
        fill({ action: 'Buy', price: 195, position: '1 S', orderId: 'X1' }),
        fill({ action: 'Buy', price: 195, position: '-', orderId: 'X2' }),
      ],
      orders: [
        order({ id: 'E1', name: 'Enter Short' }),
        order({ id: 'X1', strategyName: 'Beta-1.0', name: 'PT-Short' }),
        order({ id: 'X2', strategyName: 'Beta-1.0', name: 'PT-Short' }),
      ],
      reportedGross: 20,
    });
    expect(result.byStrategy).toEqual([{ strategyName: 'Beta-1.0', realized: 20, pairs: 2 }]);
    expect(result.detachedPairs).toBe(2);
    expect(result.status).toBe('exact');
  });

  it('will not credit a detached leg on a book two named strategies worked', () => {
    // Rule 4b's fence. With one named strategy on the book there is nothing to
    // choose between; with two, FIFO would pick an owner and nothing would check
    // it. No export has yet contained such a book, so the refusal stands and the
    // pair stays visible in the residual instead of being quietly assigned.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'A1' }),
        fill({ action: 'Sell', price: 110, position: '-', orderId: 'X1' }),
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'B1' }),
        fill({ action: 'Sell', price: 105, position: '-', orderId: 'B2' }),
      ],
      orders: [
        order({ id: 'A1', strategyName: 'Alpha-1.0' }), order({ id: 'X1', name: 'Close' }),
        order({ id: 'B1', strategyName: 'Beta-1.0' }), order({ id: 'B2', strategyName: 'Beta-1.0' }),
      ],
      reportedGross: 30,
    });
    expect(result.byStrategy).toEqual([{ strategyName: 'Beta-1.0', realized: 10, pairs: 1 }]);
    expect(result.residual.reasons).toEqual({ [RESIDUAL_REASONS.DETACHED_EXIT]: 1 });
    expect(result.detachedPairs).toBe(0);
    expect(result.status).toBe('partial');
  });

  it('will not credit a NAMELESS blank-Strategy leg, whatever else is on the book', () => {
    // The separation rule 4b lives or dies on. A hand-placed order has a blank
    // Strategy AND a blank Name; NinjaTrader's own detached orders always carry
    // one. This is the -72 case the strict rule was built for: crediting it
    // reported -300 where NinjaTrader reported -228.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'M1' }),
        fill({ action: 'Sell', price: 110, position: '-', orderId: 'S1' }),
      ],
      orders: [order({ id: 'M1', name: '' }), order({ id: 'S1', strategyName: 'Alpha-1.0', name: 'Stop Long' })],
      reportedGross: 20,
    });
    expect(result.byStrategy).toEqual([]);
    expect(result.residual.reasons).toEqual({ [RESIDUAL_REASONS.MANUAL_LEG]: 1 });
    expect(result.detachedPairs).toBe(0);
  });

  it('refuses a pair opened by one strategy and closed by another', () => {
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'A1' }),
        fill({ action: 'Sell', price: 110, position: '-', orderId: 'B1' }),
      ],
      orders: [order({ id: 'A1', strategyName: 'Alpha-1.0' }), order({ id: 'B1', strategyName: 'Beta-1.0' })],
      reportedGross: 20,
    });
    expect(result.residual.reasons).toEqual({ [RESIDUAL_REASONS.CROSS_STRATEGY]: 1 });
    expect(result.byStrategy).toEqual([]);
  });
});

describe('a day that cannot fully pair', () => {
  it('refuses the whole book when a carried-in lot has no cost basis and no history', () => {
    // The first fill sells 1 and leaves the account 1 long, so it started the
    // session 2 long. Those two contracts were bought in a session this caller
    // does not hold: they exist, their cost basis does not. With no `carryIn`
    // the book is refused whole — not priced at zero, and not half-priced from
    // its other pairs while the account's failure to reconcile is left as the
    // only thing keeping it off a screen.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Sell', price: 110, position: '1 L', orderId: 'O1' }),
      ],
      orders: [order({ id: 'O1', strategyName: 'Alpha-1.0' })],
      reportedGross: 400,
    });
    expect(result.carriedInContracts).toBe(2);
    expect(result.unpricedPairs).toBe(1);
    expect(result.residual.reasons[RESIDUAL_REASONS.CARRY_IN]).toBe(1);
    expect(result.refusedBooks).toEqual([
      { instrument: 'MNQ SEP26', reason: RESIDUAL_REASONS.CARRY_IN, carriedInContracts: 2, carryInReason: 'no-history' },
    ]);
    // Critically: NOT 0. A zero here would understate the day while looking like
    // a real answer, which is the failure mode this module exists to prevent.
    expect(result.derivedTotal).toBe(0);
    expect(result.byStrategy).toEqual([]);
    expect(result.openContracts).toBe(1);
    expect(result.status).toBe('refused');
  });

  it('refuses on the E/X column alone, when the Position column is unreadable', () => {
    // The second witness, and it has to be independent of the first. A Position
    // cell this parser cannot read ('n/a' here) makes the implied start UNKNOWN,
    // not zero — so the arithmetic witness abstains entirely. The E/X cell still
    // says this fill CLOSED something, which it could not have done from flat.
    // One witness is enough to refuse. Note this one cannot SIZE the carry-in,
    // so a book refused only by E/X can never be seeded from history either:
    // there is nothing to check the handed-over lots against.
    seq = 0;
    const unreadablePosition = { ...fill({ action: 'Sell', price: 110, orderId: 'O1' }), position: 'n/a', entryExit: 'Exit' };
    expect(parsePosition(unreadablePosition.position)).toBeNull();
    const result = deriveStrategyPnl({
      executions: [unreadablePosition],
      orders: [order({ id: 'O1', strategyName: 'Alpha-1.0' })],
      reportedGross: 400,
    });
    expect(result.refusedBooks).toEqual([
      { instrument: 'MNQ SEP26', reason: RESIDUAL_REASONS.CARRY_IN, carriedInContracts: 0, carryInReason: 'no-history' },
    ]);
    expect(result.status).toBe('refused');
  });

  it('prices the carried-in lot when the caller DOES hold the previous close', () => {
    // The CRM's case. Same fills as the refusal above, plus the two lots the
    // previous stored close left open — priced, and naming the strategy that
    // opened them. Nothing is guessed: the lots have to add up to the Position
    // column's implied start of 2 long or they are rejected.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Sell', qty: 2, price: 110, position: '-', orderId: 'O1' }),
      ],
      orders: [order({ id: 'O1', strategyName: 'Alpha-1.0' })],
      reportedGross: 40,
      carryIn: {
        available: true,
        reason: '',
        priorDate: '2026-08-18',
        lots: [{ instrument: 'MNQ SEP26', side: 1, qty: 2, price: 100, strategyName: 'Alpha-1.0' }],
      },
    });
    expect(result.refusedBooks).toEqual([]);
    expect(result.byStrategy).toEqual([{ strategyName: 'Alpha-1.0', realized: 40, pairs: 1 }]);
    expect(result.carryInBasis).toBe('prior-close');
    expect(result.status).toBe('exact');
  });

  it('refuses when the carried lots do not add up to the day\'s opening position', () => {
    // A client who skipped an upload. The lots we hold are from a stale close
    // and cannot explain what the fills say was open, so the basis is not ours
    // to state and the book is refused rather than priced off it.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Sell', qty: 2, price: 110, position: '-', orderId: 'O1' }),
      ],
      orders: [order({ id: 'O1', strategyName: 'Alpha-1.0' })],
      reportedGross: 40,
      carryIn: {
        available: true,
        reason: '',
        priorDate: '2026-08-15',
        lots: [{ instrument: 'MNQ SEP26', side: 1, qty: 1, price: 100, strategyName: 'Alpha-1.0' }],
      },
    });
    expect(result.refusedBooks).toEqual([
      { instrument: 'MNQ SEP26', reason: RESIDUAL_REASONS.CARRY_IN, carriedInContracts: 2, carryInReason: 'no-matching-lots' },
    ]);
    expect(result.status).toBe('refused');
  });

  it('refuses when the caller looked and found the chain broken', () => {
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Sell', qty: 2, price: 110, position: '-', orderId: 'O1' }),
      ],
      orders: [order({ id: 'O1', strategyName: 'Alpha-1.0' })],
      reportedGross: 40,
      carryIn: { available: false, reason: 'gap', priorDate: '2026-08-15', lots: [] },
    });
    expect(result.refusedBooks[0].carryInReason).toBe('gap');
    expect(result.carryInBasis).toBe('gap');
    expect(result.status).toBe('refused');
  });

  it('leaves a position still open at the close out of the split without complaint', () => {
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'O1' }),
        fill({ action: 'Buy', price: 102, position: '2 L', orderId: 'O2' }),
        fill({ action: 'Sell', price: 110, position: '1 L', orderId: 'O3' }),
      ],
      orders: ['O1', 'O2', 'O3'].map((id) => order({ id, strategyName: 'Alpha-1.0' })),
      reportedGross: 20,
    });
    expect(result.byStrategy).toEqual([{ strategyName: 'Alpha-1.0', realized: 20, pairs: 1 }]);
    expect(result.openContracts).toBe(1);
    expect(result.status).toBe('exact');
  });

  it('refuses an instrument it has no multiplier for rather than guessing one', () => {
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'O1', instrument: 'ZZZ SEP26' }),
        fill({ action: 'Sell', price: 110, position: '-', orderId: 'O2', instrument: 'ZZZ SEP26' }),
      ],
      orders: ['O1', 'O2'].map((id) => order({ id, strategyName: 'Alpha-1.0' })),
      reportedGross: 0,
    });
    expect(result.unknownInstruments).toEqual(['ZZZ']);
    expect(result.byStrategy).toEqual([]);
    expect(result.residual.reasons[RESIDUAL_REASONS.UNKNOWN_INSTRUMENT]).toBe(1);
    // Named as a refusal, not left to fall out of the arithmetic. The account
    // reconciling by coincidence must not be what keeps this off a screen — on
    // 2026-08-19 exactly one book was in this state (PL, platinum) and its
    // account reported no gross at all, so nothing would have checked it.
    expect(result.refusedBooks).toEqual([
      { instrument: 'ZZZ SEP26', reason: RESIDUAL_REASONS.UNKNOWN_INSTRUMENT, carriedInContracts: 0, carryInReason: '' },
    ]);
    expect(result.status).toBe('refused');
  });

  it('prices platinum, which one real export could not', () => {
    // PL was the only unknown root on 2026-08-19 and it cost a whole book. The
    // multiplier is checked against that book's own grid row rather than taken
    // on faith: 1 contract, 1787.4 -> 1781.0, reported by NinjaTrader as -320.00.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 1787.4, position: '1 L', orderId: 'O1', instrument: 'PL OCT26' }),
        fill({ action: 'Sell', price: 1781, position: '-', orderId: 'O2', instrument: 'PL OCT26' }),
      ],
      orders: ['O1', 'O2'].map((id) => order({ id, strategyName: 'PLPI-1.3' })),
      reportedGross: -320,
    });
    expect(result.unknownInstruments).toEqual([]);
    expect(result.byStrategy).toEqual([{ strategyName: 'PLPI-1.3', realized: -320, pairs: 1 }]);
    expect(result.status).toBe('exact');
  });
});

describe('a derived total that fails to reconcile', () => {
  it('never calls itself exact when the account gross disagrees', () => {
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'O1' }),
        fill({ action: 'Sell', price: 110, position: '-', orderId: 'O2' }),
      ],
      orders: ['O1', 'O2'].map((id) => order({ id, strategyName: 'Alpha-1.0' })),
      reportedGross: 999,
    });
    expect(result.derivedTotal).toBe(20);
    expect(result.difference).toBe(-979);
    expect(result.reconciles).toBe(false);
    expect(result.status).toBe('unreconciled');
  });

  it('refuses the account outright when the grid exported no gross column', () => {
    // One client on 2026-08-19 runs a terminal configured without 'Gross
    // realized PnL'. It exports 'Realized PnL', which is NET of commissions —
    // $27.92 away from the derived total on that very account. Reading it would
    // have failed a correct derivation and called it a pairing error; comparing
    // against undefined would have passed anything. Neither: the account is
    // refused, under its own status, and publishes nothing.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'O1' }),
        fill({ action: 'Sell', price: 110, position: '-', orderId: 'O2' }),
      ],
      orders: ['O1', 'O2'].map((id) => order({ id, strategyName: 'Alpha-1.0' })),
      reportedGross: null,
    });
    expect(result.status).toBe('no-reported-gross');
    expect(result.reconciles).toBe(false);
    expect(result.difference).toBeNull();
    // The derivation itself still ran and is still worth cross-checking; what it
    // may not do is publish.
    expect(result.byStrategy).toEqual([{ strategyName: 'Alpha-1.0', realized: 20, pairs: 1 }]);
  });

  it('will not call a day exact when the Position column contradicts the pairing', () => {
    // Position is the free integrity check on ordering: if the reconstructed
    // running position disagrees with what NinjaTrader stated, the fills are not
    // in the order we think they are and the split cannot be trusted.
    //
    // This used to end 'partial' with the pair priced and credited, kept off the
    // screen by `positionAgrees` alone. It is now a NAMED book refusal — see
    // rule 6 — so the money is countable instead of merely unpublished.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'O1' }),
        fill({ action: 'Sell', price: 110, position: '4 L', orderId: 'O2' }),
      ],
      orders: ['O1', 'O2'].map((id) => order({ id, strategyName: 'Alpha-1.0' })),
      reportedGross: 20,
    });
    expect(result.positionAgrees).toBe(false);
    expect(result.status).toBe('refused');
  });
});

describe('a book whose ordering the Position column contradicts', () => {
  it('refuses a book whose ordering cannot reproduce the Position column', () => {
    // The two fills are a clean round trip on the clock, but the Position column
    // says the account was 4 long after the sell. No ordering of these fills
    // produces that, so the sequence the pairing would run on is one the file
    // itself contradicts. On the 2026-08-20 book this shape reaches 9 books
    // across 6 account-days, 49 pairs.
    //
    // The old behaviour priced the pair, credited Alpha-1.0 with $20 and left
    // `positionAgrees: false` as the only thing between that figure and a
    // screen. A single boolean on the account said nothing about WHICH book was
    // unreadable or how much money sat on it.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'O1' }),
        fill({ action: 'Sell', price: 110, position: '4 L', orderId: 'O2' }),
      ],
      orders: ['O1', 'O2'].map((id) => order({ id, strategyName: 'Alpha-1.0' })),
      reportedGross: 20,
    });
    expect(result.refusedBooks).toEqual([
      { instrument: 'MNQ SEP26', reason: RESIDUAL_REASONS.POSITION_UNREPRODUCIBLE, carriedInContracts: 0, carryInReason: '' },
    ]);
    expect(result.residual.reasons[RESIDUAL_REASONS.POSITION_UNREPRODUCIBLE]).toBe(1);
    expect(result.unpricedPairs).toBe(1);
    // Counted, never valued. A zero would be a claim; this is the absence of one.
    expect(result.byStrategy).toEqual([]);
    expect(result.derivedTotal).toBe(0);
    expect(result.status).toBe('refused');
  });

  it('leaves a book alone when the Position column does reproduce', () => {
    // The guard must not fire on the ordinary case, and it must not fire on a
    // same-second tie that resolveTiesByPosition has already repaired. Both
    // fills here are stamped the same second and the file order is backwards;
    // the Position column puts them right, so the book is priced as normal.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ id: '2_1', action: 'Sell', price: 110, position: '-', orderId: 'O2', time: '8/18/2026 9:30:01 AM' }),
        fill({ id: '1_1', action: 'Buy', price: 100, position: '1 L', orderId: 'O1', time: '8/18/2026 9:30:01 AM' }),
      ],
      orders: ['O1', 'O2'].map((id) => order({ id, strategyName: 'Alpha-1.0' })),
      reportedGross: 20,
    });
    expect(result.refusedBooks).toEqual([]);
    expect(result.positionAgrees).toBe(true);
    expect(result.byStrategy).toEqual([{ strategyName: 'Alpha-1.0', realized: 20, pairs: 1 }]);
    expect(result.status).toBe('exact');
  });

  it('names an unknown instrument as unknown, never as a position failure', () => {
    // Refusal ORDER, pinned. A grid that exported no Position column reads as
    // flat after every fill and so contradicts the pairing — but on the
    // 2026-08-20 book all 13 books in that state are also missing their
    // instrument, and they already had the right name. The multiplier check runs
    // first so rule 6 cannot rename an existing refusal.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        { ...fill({ action: 'Buy', price: 100, orderId: 'O1', instrument: 'ZZZ SEP26' }), position: '' },
        { ...fill({ action: 'Sell', price: 110, orderId: 'O2', instrument: 'ZZZ SEP26' }), position: '' },
      ],
      orders: ['O1', 'O2'].map((id) => order({ id, strategyName: 'Alpha-1.0' })),
      reportedGross: 0,
    });
    // (A blank Position cell parses as FLAT, which is also why this book looks
    // as though it carried a contract in. Both readings are artefacts of the
    // missing column; the refusal names the one a reader can act on.)
    expect(result.refusedBooks).toEqual([
      { instrument: 'ZZZ SEP26', reason: RESIDUAL_REASONS.UNKNOWN_INSTRUMENT, carriedInContracts: 1, carryInReason: '' },
    ]);
  });

  it('refuses on the position column before it decides whether the book carried in', () => {
    // Both carry-in witnesses — the first fill's E/X and the position it implies
    // — are read off the ordering rule 6 has just rejected. An unreadable
    // sequence cannot be asked whether it carried a contract in, so the answer
    // must be the unreadable sequence and not a guess about yesterday.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Sell', price: 110, position: '1 L', orderId: 'O1', time: '8/18/2026 9:30:01 AM' }),
        fill({ action: 'Sell', price: 111, position: '9 S', orderId: 'O2', time: '8/18/2026 9:31:01 AM' }),
      ],
      orders: ['O1', 'O2'].map((id) => order({ id, strategyName: 'Alpha-1.0' })),
      reportedGross: 0,
    });
    expect(result.refusedBooks.map((book) => book.reason))
      .toEqual([RESIDUAL_REASONS.POSITION_UNREPRODUCIBLE]);
    expect(result.status).toBe('refused');
  });

  it('refuses only the book that is unreadable, and poisons its account', () => {
    // Books are independent, so one bad sequence must not silently re-price
    // another. It does, however, take the whole account off the screen: rule 5's
    // refusal is at book level and it poisons the account.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'O1' }),
        fill({ action: 'Sell', price: 110, position: '4 L', orderId: 'O2' }),
        fill({ action: 'Buy', price: 200, position: '1 L', orderId: 'O3', instrument: 'MES SEP26' }),
        fill({ action: 'Sell', price: 210, position: '-', orderId: 'O4', instrument: 'MES SEP26' }),
      ],
      orders: ['O1', 'O2', 'O3', 'O4'].map((id) => order({ id, strategyName: 'Alpha-1.0' })),
      reportedGross: 70,
    });
    expect(result.refusedBooks).toEqual([
      { instrument: 'MNQ SEP26', reason: RESIDUAL_REASONS.POSITION_UNREPRODUCIBLE, carriedInContracts: 0, carryInReason: '' },
    ]);
    // The MES book still priced — $50 — and the MNQ pair is counted, not valued.
    expect(result.derivedTotal).toBe(50);
    expect(result.unpricedPairs).toBe(1);
    expect(result.status).toBe('refused');
  });
});

describe('ordering, which no export agrees on', () => {
  const rows = [
    fill({ id: '1_1', action: 'Buy', price: 100, position: '1 L', orderId: 'O1' }),
    fill({ id: '2_1', action: 'Sell', price: 110, position: '-', orderId: 'O2' }),
    fill({ id: '3_1', action: 'Sell', price: 200, position: '1 S', orderId: 'O3' }),
    fill({ id: '4_1', action: 'Buy', price: 195, position: '-', orderId: 'O4' }),
  ];
  const orders = ['O1', 'O2', 'O3', 'O4'].map((id) => order({ id, strategyName: 'Alpha-1.0' }));
  const run = (executions) => deriveStrategyPnl({ executions, orders, reportedGross: 30 });

  it.each([
    ['time-ascending (as written)', rows],
    ['time-descending, the common export', [...rows].reverse()],
    ['grouped by E/X: entries then exits', [rows[0], rows[2], rows[1], rows[3]]],
  ])('reaches the same answer from %s', (_label, executions) => {
    const result = run(executions);
    expect(result.orderingBasis).toBe('executionId');
    expect(result.byStrategy).toEqual([{ strategyName: 'Alpha-1.0', realized: 30, pairs: 2 }]);
    expect(result.positionAgrees).toBe(true);
    expect(result.status).toBe('exact');
  });

  it('falls back to the timestamp when execution ids are not sequenced', () => {
    const timed = [
      fill({ id: 'x', action: 'Sell', price: 110, position: '-', orderId: 'O2', time: '8/18/2026 10:05:00 AM' }),
      fill({ id: 'y', action: 'Buy', price: 100, position: '1 L', orderId: 'O1', time: '8/18/2026 9:30:01 AM' }),
    ];
    const result = deriveStrategyPnl({ executions: timed, orders, reportedGross: 20 });
    expect(result.orderingBasis).toBe('time');
    expect(result.byStrategy).toEqual([{ strategyName: 'Alpha-1.0', realized: 20, pairs: 1 }]);
  });

  it('says so when it had nothing to order by', () => {
    const { basis } = orderExecutions([{ id: 'a' }, { id: 'b' }]);
    expect(basis).toBe('fileOrder');
  });
});

describe('one strategy name, two accounts', () => {
  it('never lets one account\'s money land on the other\'s row', () => {
    // The bug this feature was nearly shipped with. "Bullet Bot-1.1" runs on
    // four separate accounts inside a single client export; a map keyed on the
    // name alone smears them together. Keying by (account, strategy) is the fix,
    // and this fixture fails loudly against a name-only implementation.
    seq = 0;
    const executions = [
      fill({ account: 'ACC1', action: 'Buy', price: 100, position: '1 L', orderId: 'A1' }),
      fill({ account: 'ACC1', action: 'Sell', price: 110, position: '-', orderId: 'A2' }),
      fill({ account: 'ACC2', action: 'Buy', price: 100, position: '1 L', orderId: 'B1' }),
      fill({ account: 'ACC2', action: 'Sell', price: 400, position: '-', orderId: 'B2' }),
    ];
    const orders = [
      order({ id: 'A1', strategyName: 'Bullet Bot-1.1', account: 'ACC1' }),
      order({ id: 'A2', strategyName: 'Bullet Bot-1.1', account: 'ACC1' }),
      order({ id: 'B1', strategyName: 'Bullet Bot-1.1', account: 'ACC2' }),
      order({ id: 'B2', strategyName: 'Bullet Bot-1.1', account: 'ACC2' }),
    ];
    const byAccount = deriveStrategyPnlByAccount({
      executions,
      orders,
      accounts: [
        { accountName: 'ACC1', grossRealizedPnlReported: 20 },
        { accountName: 'ACC2', grossRealizedPnlReported: 600 },
      ],
    });

    expect(byAccount.get('ACC1').byStrategy).toEqual([{ strategyName: 'Bullet Bot-1.1', realized: 20, pairs: 1 }]);
    expect(byAccount.get('ACC2').byStrategy).toEqual([{ strategyName: 'Bullet Bot-1.1', realized: 600, pairs: 1 }]);
    expect(byAccount.get('ACC1').status).toBe('exact');
    expect(byAccount.get('ACC2').status).toBe('exact');
  });

  it('keeps an account that never traded distinguishable from one that broke even', () => {
    const byAccount = deriveStrategyPnlByAccount({
      executions: [],
      orders: [],
      accounts: [{ accountName: 'IDLE', grossRealizedPnlReported: 0 }],
    });
    expect(byAccount.get('IDLE').status).toBe('no-trades');
    expect(byAccount.get('IDLE').byStrategy).toEqual([]);
  });
});

describe('reading the grid\'s own dialects', () => {
  it.each([
    ['MNQ SEP26', 2], ['MNQ 09-26', 2], ['MNQU6', 2],
    ['NQ SEP26', 20], ['NQZ25', 20], ['MES SEP26', 5], ['M2K JUN26', 5], ['ZB 12-26', 1000],
  ])('reads %s as a $%s point', (instrument, expected) => {
    expect(multiplierFor(instrument)).toBe(expected);
  });

  it('returns null for an instrument it does not know', () => {
    expect(multiplierFor('ZZZ SEP26')).toBe(null);
  });

  it.each([['-', 0], ['', 0], ['2 S', -2], ['4 L', 4], ['1 L', 1]])('reads position %s as %s', (raw, expected) => {
    expect(parsePosition(raw)).toBe(expected);
  });
});

describe('two fills stamped the same second', () => {
  // Found against a real export, not imagined. One account had two MES fills at
  // 10:11:58 and the grid listed the larger one first. Ordered that way the leg
  // looked as though it had carried a contract in overnight: the derivation
  // invented an unpriced lot, dropped a real pair, and came out $13.75 under the
  // account's own gross — a plausible wrong number, which is the one outcome
  // this module must never produce. The Position column is the only witness in
  // the file to what order the fills really happened in.
  const tied = [
    // Listed in the order the grid gave them: this one cannot have come first,
    // because the account cannot be 4 short after selling 3 from flat.
    { id: 'x1', accountName: 'ACC1', instrument: 'MES SEP26', action: 'Sell', quantity: 3, price: 104, position: '4 S', orderId: 'O1', time: '8/18/2026 10:11:58 AM' },
    { id: 'x2', accountName: 'ACC1', instrument: 'MES SEP26', action: 'Sell', quantity: 1, price: 100, position: '1 S', orderId: 'O1', time: '8/18/2026 10:11:58 AM' },
    { id: 'x3', accountName: 'ACC1', instrument: 'MES SEP26', action: 'Buy', quantity: 4, price: 101, position: '-', orderId: 'O2', time: '8/18/2026 4:30:18 PM' },
  ];
  const orders = [order({ id: 'O1', strategyName: 'Alpha-1.0' }), order({ id: 'O2', strategyName: 'Alpha-1.0' })];

  it('puts them in the order the Position column implies', () => {
    // (101-100)*1*5*-1 + (101-104)*3*5*-1 = -5 + 45
    const result = deriveStrategyPnl({ executions: tied, orders, reportedGross: 40 });
    expect(result.byStrategy).toEqual([{ strategyName: 'Alpha-1.0', realized: 40, pairs: 2 }]);
    expect(result.carriedInContracts).toBe(0);
    expect(result.unpricedPairs).toBe(0);
    expect(result.openContracts).toBe(0);
    expect(result.positionAgrees).toBe(true);
    expect(result.status).toBe('exact');
  });

  it('reaches the same answer whichever way the grid listed them', () => {
    const result = deriveStrategyPnl({ executions: [tied[1], tied[0], tied[2]], orders, reportedGross: 40 });
    expect(result.derivedTotal).toBe(40);
    expect(result.status).toBe('exact');
  });
});

describe('execution ids come in two dialects', () => {
  const rows = (ids) => [
    { id: ids[0], accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Buy', quantity: 1, price: 100, position: '1 L', orderId: 'O1', time: '8/18/2026 9:30:01 AM' },
    { id: ids[1], accountName: 'ACC1', instrument: 'MNQ SEP26', action: 'Sell', quantity: 1, price: 110, position: '-', orderId: 'O2', time: '8/18/2026 9:35:01 AM' },
  ];

  it('orders by a bare monotonic integer id, as half a real export used', () => {
    const { basis, ordered } = orderExecutions([...rows(['192920792576', '192949439232'])].reverse());
    expect(basis).toBe('executionId');
    expect(ordered.map((r) => r.id)).toEqual(['192920792576', '192949439232']);
  });

  it('will not compare one dialect against the other', () => {
    // One client folder in a real export carried both forms. Sorting "12_1"
    // numerically against "192949439232" is meaningless, so a mixed set falls
    // back to the timestamp rather than producing a confident wrong order.
    const { basis } = orderExecutions(rows(['12_1', '192949439232']));
    expect(basis).toBe('time');
  });
});

describe('the invariant that keeps the residual honest', () => {
  it('accounts for every priced pair exactly once', () => {
    // attributed + residual == derived total. If this drifts, money is being
    // double-counted into a strategy or quietly lost between the two buckets —
    // and a per-strategy table whose parts do not add up to the account is the
    // thing this whole module exists to prevent.
    seq = 0;
    const result = deriveStrategyPnl({
      executions: [
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'A1' }),   // Alpha round trip
        fill({ action: 'Sell', price: 110, position: '-', orderId: 'A2' }),
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'A3' }),   // closed by a detached exit
        fill({ action: 'Sell', price: 90, position: '-', orderId: 'X1' }),
        fill({ action: 'Buy', price: 100, position: '1 L', orderId: 'M1' }),   // wholly manual
        fill({ action: 'Sell', price: 130, position: '-', orderId: 'M2' }),
      ],
      orders: [
        order({ id: 'A1', strategyName: 'Alpha-1.0' }), order({ id: 'A2', strategyName: 'Alpha-1.0' }),
        order({ id: 'A3', strategyName: 'Alpha-1.0' }), order({ id: 'X1', name: 'Close' }),
        order({ id: 'M1' }), order({ id: 'M2' }),
      ],
      reportedGross: 60,
    });
    // Alpha's own round trip (+20) plus the detached exit rule 4b now credits to
    // it (-20). The wholly manual pair is still nobody's and stays in the
    // residual, where the invariant has to find it.
    expect(result.attributedTotal).toBe(0);
    expect(result.residual.realized).toBe(60);
    expect(result.derivedTotal).toBe(60);
    expect(result.attributedTotal + result.residual.realized).toBe(result.derivedTotal);
    expect(result.residual.reasons).toEqual({ 'no-strategy': 1 });
    // It reconciles with the account, but the split is incomplete — so it is
    // 'partial', and reconcile.js will publish no per-strategy figure for it.
    expect(result.reconciles).toBe(true);
    expect(result.status).toBe('partial');
  });
});
