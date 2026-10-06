using System;
using System.Collections.Generic;
using System.Linq;

namespace Vincere.AutoExport.Agent.Capture;

/// <summary>One strategy instance as the per strategy reading names it.</summary>
public readonly record struct StrategyInstanceKey(string AccountName, string StrategyId);

/// <summary>
/// One instance in one successful reading, with the real time trade count the
/// add-on read for its current run, or null when it could not be read.
/// </summary>
public readonly record struct StrategyRunReading(StrategyInstanceKey Key, int? RealtimeTradeCount);

/* WHICH STRATEGY INSTANCES WERE SWITCHED OFF AND ON AGAIN TODAY.
 *
 * The Strategies tab figure counts since the instance was enabled, and on this
 * desk that is since today's enable: every measured enable and disable pair opens
 * and closes on the same date, and every account, instrument and day ends flat.
 * So the figure needs no start of day baseline. What it does need is to know about
 * a mid day re-enable, because that resets it to zero: on the one machine measured,
 * 24% of instance days had more than one enable, and 49 closes had every enabled
 * row reading 0 while the account still held realized P&L. A reset row compared
 * against the desk would read as a client that differs for no reason at all.
 *
 * TWO SIGNS OF A NEW RUN, EITHER ONE IS ENOUGH.
 * (1) Absence: an instance that was live earlier today, then missing from at least
 * one later SUCCESSFUL reading, and is live again, restarted at the reading where
 * it reappeared.
 * (2) The run's own count: the add-on reads how many real time trades the current
 * run has completed. That count only grows within a run and starts again at zero
 * on a re-enable, so a count LOWER than the last one read for the instance today
 * is a restart at the reading that shows it. This is the sign that matters most:
 * on the one machine with NinjaTrader logs, 64 of 77 same day re-enables were a
 * disable and enable inside one minute, which no ten minute reading sees as an
 * absence. The count also sees a re-enable that happened while the strategy part
 * was not reading (a silence, an account reading that failed), because the drop
 * is still there when readings resume.
 * A restart time is never cleared within the local day (a later reset moves it to
 * that later reading), and the CRM shows the row as counting only since then and
 * never compares it. After a restart the count is remembered afresh from the
 * reading that showed it, so the new run's own trades are not a second restart.
 *
 * AN UNREAD COUNT SAYS NOTHING. A null count (an add-on older than this rule, a
 * member this platform does not have, a reading past its P&L budget) neither
 * makes a restart nor erases the last count read, because within a run the count
 * cannot have gone down while nobody was looking.
 *
 * ONLY SUCCESSFUL READINGS ARE OBSERVED. A reading that failed says nothing about
 * which instances exist, and treating it as "all of them vanished" would flag the
 * whole desk as restarted the next time the pipe was busy with the close. The
 * caller passes nothing here for a failed reading, so there is no code path on
 * which a failure is an absence.
 *
 * THE DAY IS THE MACHINE'S OWN CALENDAR DATE, taken from the reading's own offset,
 * not from UTC: the desk's day turns over at local midnight, and a UTC date would
 * turn it over at 20:00 in New York, in the middle of the evening session. A new
 * date clears everything, because yesterday's enables say nothing about today's.
 *
 * KNOWN LIMITS, SAID PLAINLY. A disable and enable between two readings is still
 * not seen when the old run had completed no real time trade (its count was 0, so
 * a new 0 is no drop), or when the new run has already completed as many trades
 * as the old one by the next reading, or when the count is not read at all (then
 * only absence is left). A restart that happened while this service was not
 * running is not seen: the memory is in this process and starts empty. Those rows
 * then count since their last enable without saying so. Persisting the memory would
 * close that gap at the cost of a file that asserts things about instances on
 * evidence from before a restart, which is how a filter becomes a fiction (the
 * same reasoning LiveAccountMemory gives).
 *
 * BOUNDED. At most MaximumKeys instances are tracked; a reading beyond that is
 * reported without a restart time rather than growing the memory. A real machine
 * holds 10 to 14 live instances. */
public sealed class StrategyRunMemory
{
    public const int MaximumKeys = 2000;

    private readonly Dictionary<StrategyInstanceKey, Entry> entries = new(KeyComparer.Instance);
    private DateTime? day;

    /// <summary>How many instances are remembered.</summary>
    public int Count => entries.Count;

    /// <summary>
    /// Records one successful reading in which no run count was read, so only
    /// absence can show a restart.
    /// </summary>
    public IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> Observe(
        DateTimeOffset sampledAt,
        IEnumerable<StrategyInstanceKey> keys) =>
        Observe(sampledAt, keys?.Select(key => new StrategyRunReading(key, null)));

    /// <summary>
    /// Records one successful reading and returns, for each key in it, when that
    /// instance restarted today, or null if it has not.
    /// </summary>
    /// <param name="sampledAt">The machine's clock when the strategies were read.</param>
    /// <param name="readings">Every instance the reading found live, with its run count.</param>
    public IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> Observe(
        DateTimeOffset sampledAt,
        IEnumerable<StrategyRunReading> readings)
    {
        DateTime today = sampledAt.Date;
        if (day != today)
        {
            entries.Clear();
            day = today;
        }

        Dictionary<StrategyInstanceKey, DateTimeOffset?> result = new(KeyComparer.Instance);
        if (readings != null)
        {
            foreach (StrategyRunReading reading in readings)
            {
                StrategyInstanceKey key = reading.Key;
                int? count = reading.RealtimeTradeCount < 0 ? null : reading.RealtimeTradeCount;
                if (string.IsNullOrWhiteSpace(key.AccountName) || string.IsNullOrWhiteSpace(key.StrategyId)) continue;
                if (result.ContainsKey(key)) continue;

                if (!entries.TryGetValue(key, out Entry entry))
                {
                    if (entries.Count >= MaximumKeys)
                    {
                        result[key] = null;
                        continue;
                    }
                    entry = new Entry();
                    entries[key] = entry;
                }
                else if (entry.MissedSinceLive
                    || (count.HasValue && entry.LastTradeCount.HasValue && count.Value < entry.LastTradeCount.Value))
                {
                    // The latest reset, not the first: a second re-enable resets
                    // the figure again, and "counts only since then" has to name
                    // the reset that actually applies. The count starts afresh
                    // from this reading, unread or not, so the old run's count is
                    // never held against the new one.
                    entry.RestartedAt = sampledAt;
                    entry.LastTradeCount = count;
                }

                if (count.HasValue) entry.LastTradeCount = count;
                entry.MissedSinceLive = false;
                result[key] = entry.RestartedAt;
            }
        }

        // Everything remembered that this reading did not find has gone away, for
        // now. If it comes back today, it came back from zero.
        foreach (KeyValuePair<StrategyInstanceKey, Entry> remembered in entries)
        {
            if (!result.ContainsKey(remembered.Key)) remembered.Value.MissedSinceLive = true;
        }
        return result;
    }

    private sealed class Entry
    {
        public bool MissedSinceLive { get; set; }
        public DateTimeOffset? RestartedAt { get; set; }
        public int? LastTradeCount { get; set; }
    }

    // Account names compare ignoring case, as every account comparison in this
    // codebase does; instance ids compare exactly.
    private sealed class KeyComparer : IEqualityComparer<StrategyInstanceKey>
    {
        public static readonly KeyComparer Instance = new();

        public bool Equals(StrategyInstanceKey x, StrategyInstanceKey y) =>
            string.Equals(x.AccountName?.Trim(), y.AccountName?.Trim(), StringComparison.OrdinalIgnoreCase)
            && string.Equals(x.StrategyId?.Trim(), y.StrategyId?.Trim(), StringComparison.Ordinal);

        public int GetHashCode(StrategyInstanceKey key) => HashCode.Combine(
            StringComparer.OrdinalIgnoreCase.GetHashCode(key.AccountName?.Trim() ?? string.Empty),
            StringComparer.Ordinal.GetHashCode(key.StrategyId?.Trim() ?? string.Empty));
    }
}
