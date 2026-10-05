using System;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{
    /// <summary>
    /// Which accounts belong in a tracker sample.
    ///
    /// ITS OWN RULE, AND NOT <see cref="AccountRelevance"/>. Reusing that one
    /// looked obviously right and would have destroyed the feature at the source,
    /// inside NinjaTrader, before anything reached the CRM.
    ///
    /// <see cref="AccountRelevance.IsRelevant"/> ends in `return isConnected`, so
    /// a disconnected account is dropped from the close entirely. For a money
    /// number that is the better failure and its own summary says why: a balance
    /// frozen at whatever it was when the connection dropped asserts a
    /// measurement that did not happen, and present-and-wrong is worse than
    /// absent-and-flagged.
    ///
    /// FOR A TRAFFIC LIGHT THE INEQUALITY REVERSES. The desk's question is which
    /// accounts are alive, so "this account has gone dark" is not noise to be
    /// filtered - it is the single most important thing the sample can say. Drop
    /// it here and a dark account becomes an ABSENT ROW, which is byte for byte
    /// what an unreachable machine and a collector too old to sample also
    /// produce. Three different situations, one observable, and no amount of
    /// cleverness in the CRM can separate them afterwards.
    ///
    /// So this keeps disconnected accounts and lets the row say `connected:
    /// false` for itself. The platform's own fixtures are still dropped, for the
    /// reason <see cref="AccountRelevance"/> gives: on a real machine that was 44
    /// accounts against 3, and Backtest and Playback exist on every install
    /// whether or not anyone trades.
    ///
    /// NOTHING HERE READS MONEY. The close's filter takes cash value and net
    /// liquidation and ignores both; this one does not ask for them, so there is
    /// no parameter that has to be explained as unused, and the sample never
    /// decides whether to mention an account based on what is in it.
    /// </summary>
    public static class AccountSampleRelevance
    {
        /// <param name="accountName">The account NinjaTrader is offering.</param>
        public static bool IsRelevant(string accountName)
        {
            return !AccountRelevance.IsPlatformAccount(accountName);
        }
    }
}
