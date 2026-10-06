using System;
using System.Collections.Generic;
using System.Linq;
using Vincere.AutoExport.Agent.Capture;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class StrategyRunMemoryTests
{
    private static readonly TimeSpan NewYork = TimeSpan.FromHours(-4);
    private static readonly StrategyInstanceKey Ogx = new("SIM-1", "123456789");
    private static readonly StrategyInstanceKey Alpha = new("SIM-1", "123456790");

    [Fact]
    public void An_instance_seen_all_day_never_restarted()
    {
        StrategyRunMemory memory = new();

        memory.Observe(At(9, 30), new[] { Ogx });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> later = memory.Observe(At(11, 40), new[] { Ogx });

        Assert.Null(later[Ogx]);
    }

    /* THE RULE: live, then missing from a later successful reading, then live again
     * the same day. The figure has gone back to zero, so the row says since when. */
    [Fact]
    public void Gone_and_back_the_same_day_is_a_restart_at_the_reading_it_came_back_in()
    {
        StrategyRunMemory memory = new();

        memory.Observe(At(9, 30), new[] { Ogx, Alpha });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> gone = memory.Observe(At(11, 30), new[] { Alpha });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> back = memory.Observe(At(11, 40), new[] { Ogx, Alpha });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> after = memory.Observe(At(14, 0), new[] { Ogx, Alpha });

        Assert.False(gone.ContainsKey(Ogx));
        Assert.Equal(At(11, 40), back[Ogx]);
        Assert.Null(back[Alpha]);
        // It stays on the row for the rest of the day: the figure still counts only
        // since 11:40.
        Assert.Equal(At(11, 40), after[Ogx]);
    }

    // A second re-enable resets the figure again, so the time moves to it.
    [Fact]
    public void A_second_return_moves_the_restart_to_the_reset_that_applies()
    {
        StrategyRunMemory memory = new();

        memory.Observe(At(9, 30), new[] { Ogx });
        memory.Observe(At(10, 0), Array.Empty<StrategyInstanceKey>());
        memory.Observe(At(10, 10), new[] { Ogx });
        memory.Observe(At(12, 0), Array.Empty<StrategyInstanceKey>());
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> second = memory.Observe(At(12, 10), new[] { Ogx });

        Assert.Equal(At(12, 10), second[Ogx]);
    }

    /* A FAILED READING IS NOT AN ABSENCE. The caller does not observe a failed
     * reading at all, so between two successful readings that both hold the
     * instance, nothing happened to it, however many readings failed in between. */
    [Fact]
    public void Readings_that_failed_in_between_leave_no_trace()
    {
        StrategyRunMemory memory = new();

        memory.Observe(At(9, 30), new[] { Ogx });
        // 09:40 to 11:20: the pipe was busy, NinjaTrader restarting, the add-on timing out.
        // None of those is observed.
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> next = memory.Observe(At(11, 30), new[] { Ogx });

        Assert.Null(next[Ogx]);
    }

    /* A NEW DAY FORGETS YESTERDAY. The desk's day turns over at local midnight on
     * the machine's own clock, so an instance enabled yesterday and absent overnight
     * is not a restart this morning. */
    [Fact]
    public void A_new_local_date_resets_every_entry()
    {
        StrategyRunMemory memory = new();

        memory.Observe(At(16, 20), new[] { Ogx });
        memory.Observe(At(16, 50), Array.Empty<StrategyInstanceKey>());
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> morning = memory.Observe(
            new DateTimeOffset(2026, 10, 7, 9, 30, 0, NewYork),
            new[] { Ogx });

        Assert.Null(morning[Ogx]);
        Assert.Equal(1, memory.Count);
    }

    // The machine's date and not UTC's: 20:30 in New York is already tomorrow in
    // UTC, and the evening must not wipe the day.
    [Fact]
    public void The_day_is_the_readings_own_calendar_date_and_not_utcs()
    {
        StrategyRunMemory memory = new();

        memory.Observe(At(19, 50), new[] { Ogx });
        memory.Observe(At(20, 0), Array.Empty<StrategyInstanceKey>());
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> back = memory.Observe(At(20, 10), new[] { Ogx });

        Assert.Equal(At(20, 10), back[Ogx]);
    }

    [Fact]
    public void Account_names_compare_ignoring_case_and_ids_compare_exactly()
    {
        StrategyRunMemory memory = new();

        memory.Observe(At(9, 30), new[] { new StrategyInstanceKey("SIM-1", "A1") });
        memory.Observe(At(10, 0), new[] { new StrategyInstanceKey("sim-1", "A1") });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> third = memory.Observe(
            At(10, 10),
            new[] { new StrategyInstanceKey("SIM-1", "A1"), new StrategyInstanceKey("SIM-1", "a1") });

        Assert.Null(third[new StrategyInstanceKey("SIM-1", "A1")]);
        Assert.Null(third[new StrategyInstanceKey("SIM-1", "a1")]);
        Assert.Equal(2, memory.Count);
    }

    /* BOUNDED. Past the cap, a new instance is reported with no restart time and
     * not remembered; the instances already remembered keep working. */
    [Fact]
    public void The_memory_holds_at_most_its_cap()
    {
        StrategyRunMemory memory = new();
        StrategyInstanceKey[] many = Enumerable.Range(0, StrategyRunMemory.MaximumKeys + 50)
            .Select(i => new StrategyInstanceKey("SIM-" + i, "1"))
            .ToArray();

        memory.Observe(At(9, 30), many);
        memory.Observe(At(9, 40), many.Skip(1));
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> back = memory.Observe(At(9, 50), many);

        Assert.Equal(StrategyRunMemory.MaximumKeys, memory.Count);
        Assert.Equal(At(9, 50), back[many[0]]);
        Assert.Null(back[many[^1]]);
    }

    [Fact]
    public void Nothing_in_is_nothing_out_and_blank_keys_are_ignored()
    {
        StrategyRunMemory memory = new();

        Assert.Empty(memory.Observe(At(9, 30), (IEnumerable<StrategyInstanceKey>)null));
        Assert.Empty(memory.Observe(At(9, 30), (IEnumerable<StrategyRunReading>)null));
        Assert.Empty(memory.Observe(At(9, 30), new[] { new StrategyInstanceKey(" ", "1"), new StrategyInstanceKey("SIM-1", null) }));
        Assert.Equal(0, memory.Count);
    }

    /* THE TOGGLE BETWEEN TWO READINGS. Most measured re-enables are a disable and
     * enable inside one minute, so the instance is live in both readings and
     * absence never shows it. The run's own trade count does: it went from 4 to 0.
     * The restart is the reading that shows the drop, and it stays for the day. */
    [Fact]
    public void A_toggle_between_two_readings_is_seen_from_the_run_count_going_down()
    {
        StrategyRunMemory memory = new();

        memory.Observe(At(9, 30), new[] { Run(Ogx, 0), Run(Alpha, 1) });
        memory.Observe(At(11, 30), new[] { Run(Ogx, 4), Run(Alpha, 1) });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> toggled = memory.Observe(
            At(11, 40),
            new[] { Run(Ogx, 0), Run(Alpha, 1) });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> later = memory.Observe(
            At(14, 0),
            new[] { Run(Ogx, 3), Run(Alpha, 2) });

        Assert.Equal(At(11, 40), toggled[Ogx]);
        Assert.Null(toggled[Alpha]);
        // The new run's own trades are not another restart; the time stays.
        Assert.Equal(At(11, 40), later[Ogx]);
        Assert.Null(later[Alpha]);
    }

    // Trades only add up within a run, and an equal count is no evidence of anything.
    [Fact]
    public void A_count_that_holds_or_grows_is_one_run()
    {
        StrategyRunMemory memory = new();

        memory.Observe(At(9, 30), new[] { Run(Ogx, 0) });
        memory.Observe(At(9, 40), new[] { Run(Ogx, 2) });
        memory.Observe(At(9, 50), new[] { Run(Ogx, 2) });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> last = memory.Observe(At(10, 0), new[] { Run(Ogx, 7) });

        Assert.Null(last[Ogx]);
    }

    /* AN UNREAD COUNT SAYS NOTHING EITHER WAY. It neither makes a restart nor
     * wipes the last count read, so a drop across it is still seen. */
    [Fact]
    public void An_unread_count_neither_restarts_nor_forgets_the_last_one()
    {
        StrategyRunMemory memory = new();

        memory.Observe(At(9, 30), new[] { Run(Ogx, 4), Run(Alpha, 4) });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> unread = memory.Observe(
            At(9, 40),
            new[] { Run(Ogx, null), Run(Alpha, null) });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> next = memory.Observe(
            At(9, 50),
            new[] { Run(Ogx, 4), Run(Alpha, 1) });

        Assert.Null(unread[Ogx]);
        Assert.Null(unread[Alpha]);
        Assert.Null(next[Ogx]);
        Assert.Equal(At(9, 50), next[Alpha]);
    }

    /* AFTER A RETURN, THE OLD RUN'S COUNT IS NOT HELD AGAINST THE NEW ONE. The
     * instance had 5 trades, went away, came back at zero: one restart, at the
     * return. Its next trade must not read as a drop from 5. */
    [Fact]
    public void After_a_return_the_count_starts_again_from_the_returning_reading()
    {
        StrategyRunMemory memory = new();

        memory.Observe(At(9, 30), new[] { Run(Ogx, 5) });
        memory.Observe(At(9, 40), Array.Empty<StrategyRunReading>());
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> back = memory.Observe(At(9, 50), new[] { Run(Ogx, 0) });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> next = memory.Observe(At(10, 0), new[] { Run(Ogx, 1) });

        Assert.Equal(At(9, 50), back[Ogx]);
        Assert.Equal(At(9, 50), next[Ogx]);
    }

    // The same for a return whose count could not be read: the next count read is
    // the new run's first, not a drop from the old run's last.
    [Fact]
    public void After_a_return_with_an_unread_count_the_old_count_is_gone()
    {
        StrategyRunMemory memory = new();

        memory.Observe(At(9, 30), new[] { Run(Ogx, 5) });
        memory.Observe(At(9, 40), Array.Empty<StrategyRunReading>());
        memory.Observe(At(9, 50), new[] { Run(Ogx, null) });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> next = memory.Observe(At(10, 0), new[] { Run(Ogx, 1) });

        Assert.Equal(At(9, 50), next[Ogx]);
    }

    // A new day forgets yesterday's counts as it forgets yesterday's presence.
    [Fact]
    public void A_new_local_date_forgets_the_counts()
    {
        StrategyRunMemory memory = new();

        memory.Observe(At(16, 20), new[] { Run(Ogx, 9) });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> morning = memory.Observe(
            new DateTimeOffset(2026, 10, 7, 9, 30, 0, NewYork),
            new[] { Run(Ogx, 0) });

        Assert.Null(morning[Ogx]);
    }

    /* WHAT IS STILL NOT SEEN, PINNED SO IT CANNOT BE CLAIMED AWAY. A toggle between
     * two readings when the old run had no completed trade (0 then 0), when the new
     * run has already caught up (2 then 3), or when no count is read at all. The
     * runbook and the screen say this limit out loud. */
    [Fact]
    public void A_toggle_the_count_cannot_show_is_still_not_seen()
    {
        StrategyRunMemory memory = new();
        StrategyInstanceKey caughtUp = new("SIM-1", "123456791");
        StrategyInstanceKey unread = new("SIM-1", "123456792");

        memory.Observe(At(9, 30), new[] { Run(Ogx, 0), Run(caughtUp, 2), Run(unread, null) });
        IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> next = memory.Observe(
            At(9, 40),
            new[] { Run(Ogx, 0), Run(caughtUp, 3), Run(unread, null) });

        Assert.Null(next[Ogx]);
        Assert.Null(next[caughtUp]);
        Assert.Null(next[unread]);
    }

    private static StrategyRunReading Run(StrategyInstanceKey key, int? count) => new(key, count);

    private static DateTimeOffset At(int hour, int minute) => new(2026, 10, 6, hour, minute, 2, NewYork);
}
