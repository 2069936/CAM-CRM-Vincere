using System;
using System.Collections.Generic;

namespace Vincere.AutoExport.Agent.Capture;

/// <summary>One strategy instance as the per strategy reading names it.</summary>
public readonly record struct StrategyInstanceKey(string AccountName, string StrategyId);

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
 * THE RULE. An instance that was live earlier today, then missing from at least
 * one later SUCCESSFUL reading, and is live again, restarted at the reading where
 * it reappeared. A restart time is never cleared within the local day (a later
 * return moves it to that later reset), and the CRM shows the row as counting
 * only since then and never compares it.
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
 * KNOWN LIMIT, SAID PLAINLY. A restart that happened while this service was not
 * running is not seen: the memory is in this process and starts empty. That row
 * then counts since its last enable without saying so. Persisting the memory would
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
    /// Records one successful reading and returns, for each key in it, when that
    /// instance restarted today, or null if it has not.
    /// </summary>
    /// <param name="sampledAt">The machine's clock when the strategies were read.</param>
    /// <param name="keys">Every instance the reading found live.</param>
    public IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> Observe(
        DateTimeOffset sampledAt,
        IEnumerable<StrategyInstanceKey> keys)
    {
        DateTime today = sampledAt.Date;
        if (day != today)
        {
            entries.Clear();
            day = today;
        }

        Dictionary<StrategyInstanceKey, DateTimeOffset?> result = new(KeyComparer.Instance);
        if (keys != null)
        {
            foreach (StrategyInstanceKey key in keys)
            {
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
                else if (entry.MissedSinceLive)
                {
                    // The latest return, not the first: a second re-enable resets
                    // the figure again, and "counts only since then" has to name
                    // the reset that actually applies.
                    entry.RestartedAt = sampledAt;
                }

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
