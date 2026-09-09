/* ------------------------------------------------------------------------- *
 * A close taken while the trades were still open is not a close.
 *
 * WHAT HAPPENED. On 2026-09-08 the scheduled capture fired at 16:30:00 and
 * reported -$2,064 for the day. The real number was -$1,319. The difference,
 * $745, was sitting in unrealized PnL on three accounts whose positions had not
 * been flattened yet: the closing fills landed at 16:32, two minutes after the
 * snapshot. A capture from the same machine at 18:28 agreed with the manual
 * export to the dollar.
 *
 * MOVING THE CLOCK IS THE CURE, AND IT IS NOT A GUARANTEE. The desk flattens
 * around 16:30, by hand when the strategies have not done it, and that day the
 * fills landed at 16:32. A capture at 16:35 clears it. But three minutes of
 * margin over a close that has to happen by hand is a thin promise, and when it
 * is missed the failure is silent: the number looks like a number.
 *
 * (The strategies also carry CloseAllOpenTradeTime of 16:45 and 16:50. Those
 * are the last-resort automatic close rather than when the desk actually
 * flattens, and reading them as the normal close time is what first led to the
 * wrong conclusion about this.)
 *
 * So the snapshot is asked the question directly. An account still carrying
 * unrealized PnL had a position open when the picture was taken, which means
 * the day's realized total is not final yet, and an import built from it must
 * say so instead of being closed as if it were.
 * ------------------------------------------------------------------------- */

function numeric(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Accounts that still had something open when the snapshot was taken.
 *
 * Unrealized PnL is the signal because it is the one every account carries and
 * the one that moves into realized when the position closes. A position at
 * exactly break even is invisible here, and that is acceptable: it moves no
 * money into the realized total, which is the number being protected.
 */
export function accountsWithOpenPositions(accounts) {
  return (accounts || [])
    .filter((account) => numeric(account?.unrealizedPnl) !== 0)
    .map((account) => ({
      accountName: account.accountName,
      unrealizedPnl: numeric(account.unrealizedPnl),
    }));
}

/**
 * Was this snapshot taken before the day had finished closing?
 *
 * @returns {{ open: boolean, accounts: Array, unrealizedTotal: number }}
 */
export function openPositionsAt(snapshot) {
  const accounts = accountsWithOpenPositions(snapshot?.accounts);
  return {
    open: accounts.length > 0,
    accounts,
    // How far off the realized total is likely to be once the positions close.
    // Reported so a reader can judge whether it matters, rather than being told
    // only that something is wrong.
    unrealizedTotal: Number(accounts.reduce((sum, a) => sum + a.unrealizedPnl, 0).toFixed(2)),
  };
}

/** One sentence for a CAM looking at an import that is not final. */
export function describeOpenPositions(result) {
  if (!result?.open) return null;
  const count = result.accounts.length;
  const amount = Math.abs(result.unrealizedTotal).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `Captured while ${count} account${count === 1 ? ' was' : 's were'} still in a position.`
    + ` $${amount} was unrealized and has not landed in the daily total yet.`
    + ' Re-capture after the strategies have closed before treating this as the day\'s close.';
}
