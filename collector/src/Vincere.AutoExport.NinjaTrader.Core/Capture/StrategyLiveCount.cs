using System;
using System.Collections.Generic;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{
    /// <summary>How many of an account's strategies are live, and how sure we are.</summary>
    public struct StrategyLiveTally
    {
        public StrategyLiveTally(int? total, int? live)
        {
            Total = total;
            Live = live;
        }

        /// <summary>Strategies seen, or null when the question was not answerable.</summary>
        public int? Total { get; private set; }

        /// <summary>Of those, how many were live. Null exactly when Total is null.</summary>
        public int? Live { get; private set; }

        public static StrategyLiveTally Unmeasured()
        {
            return new StrategyLiveTally(null, null);
        }
    }

    /// <summary>
    /// Counts the live strategies on one account, from NinjaTrader's own State
    /// word and NOT from `enabled`.
    ///
    /// WHY NOT `enabled`. Because it is not a reading. NinjaTraderFacade.MapAccount's
    /// sibling MapStrategy sets `Enabled = true` as a literal, for every strategy,
    /// on every capture. Counting it would make the live count equal the total on
    /// every account forever, and the tracker's "running" light would be welded on
    /// - the same permanently-green failure as a status field that can only ever
    /// hold one value, one level further in and much harder to notice, because the
    /// number would look plausible and would even be RIGHT most of the time.
    ///
    /// WHY `State` IS THE RIGHT READING, in this repo's own words. The agent has
    /// already measured what disabling does: "A capture taken after NinjaTrader
    /// disables the strategies finds none, because disabling removes them from the
    /// account rather than marking them off. Measured on one machine in one day:
    /// 14 at 09:21, 9 at 16:30, 0 at 18:28, every one Realtime and not one
    /// stopped" (CaptureAndQueueWorkflow and StrategyObservationStore both say
    /// it). And two screens already decide that a strategy ran by asking for
    /// exactly this word - dailyEmailPackage.js and renderOfflineReport.js, both
    /// "enabled and in Realtime ran, whether or not it happened to trade".
    ///
    /// SO THIS RULE IS CORRECT UNDER BOTH POSSIBLE PLATFORM BEHAVIOURS, which is
    /// the actual reason to prefer it and is worth being explicit about, because
    /// it is the thing that makes the choice safe rather than lucky:
    ///
    ///   * If disabling REMOVES the strategy (what the measurement above shows),
    ///     everything in the collection is Realtime, Total == Live, and the
    ///     account reads `running`. Identical to what counting `enabled` would
    ///     have produced - so nothing is lost on the machines we have measured.
    ///   * If some NinjaTrader version instead LEAVES it behind in a stopped
    ///     state, Live drops below Total and the account correctly reads `idle`.
    ///     Counting `enabled` would have said `running` about a flat desk.
    ///
    /// AN UNRECOGNISED WORD MAKES THE WHOLE ACCOUNT UNMEASURED, not zero. If a
    /// future platform renames a state, "none of these are live" would be a claim
    /// that the desk had switched everything off - and `idle` and `unmeasured`
    /// lead to opposite actions, which is why liveAccounts.js keeps them apart in
    /// the first place. One word we cannot place and the honest answer for that
    /// account is that nobody looked. All-or-nothing per account rather than per
    /// strategy, because a count that silently omits the rows it did not
    /// understand is a wrong number rather than a missing one.
    /// </summary>
    public static class StrategyLiveCount
    {
        // NinjaTrader's State enum, split by whether the strategy is working the
        // market. Transition is live: it is the step between the historical fill
        // and real time on a strategy the desk has switched ON, and it is about to
        // trade. Everything else is a strategy that is loading, stopped, or not
        // yet started. Ordinal and case-insensitive because these arrive as a
        // ToString() from an assembly we do not compile against.
        private static readonly string[] LiveStates = { "Realtime", "Transition" };

        private static readonly string[] NotLiveStates =
        {
            "SetDefaults",
            "Configure",
            "Active",
            "DataLoaded",
            "Historical",
            "Terminated",
            "Finalized",
        };

        /// <param name="states">
        /// Each strategy's State word, in the order NinjaTrader listed them. Null
        /// means the collection could not be read at all, which is not the same as
        /// an account holding none.
        /// </param>
        public static StrategyLiveTally Tally(IEnumerable<string> states)
        {
            if (states == null) return StrategyLiveTally.Unmeasured();

            int total = 0;
            int live = 0;
            foreach (string state in states)
            {
                total++;
                if (Contains(LiveStates, state))
                {
                    live++;
                    continue;
                }
                // A state we cannot place, including a strategy that reported no
                // state at all. Nothing this account says about running is
                // trustworthy any more.
                if (!Contains(NotLiveStates, state)) return StrategyLiveTally.Unmeasured();
            }
            // Zero strategies, read successfully: nothing is live right now, and
            // that is a measurement. Carried as (0, 0) rather than as nulls so the
            // wire says which of the two happened, even though the CRM's own
            // run_state rule renders both as "unmeasured" today.
            return new StrategyLiveTally(total, live);
        }

        private static bool Contains(string[] known, string state)
        {
            if (String.IsNullOrWhiteSpace(state)) return false;
            string trimmed = state.Trim();
            foreach (string candidate in known)
            {
                if (String.Equals(candidate, trimmed, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }
    }
}
