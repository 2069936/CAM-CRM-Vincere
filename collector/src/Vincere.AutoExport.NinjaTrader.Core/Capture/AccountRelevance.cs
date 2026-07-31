using System;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{
    /// <summary>
    /// Decides whether an account NinjaTrader knows about is one of the client's.
    ///
    /// NinjaTrader's account collection holds every account ever configured on the
    /// machine, while the Accounts grid shows only those under a live connection.
    /// On a real machine that was 44 against 3: the rest were the platform's own
    /// Backtest and Playback accounts plus DEMO and APEX accounts left over from
    /// connections that no longer exist. Sending those on would have the CRM raise
    /// forty "new account needs classification" flags for accounts nobody trades.
    ///
    /// Kept deliberately cautious: an account is only dropped when it is
    /// disconnected AND holds nothing. Anything with money in it survives, because
    /// a real account that is merely offline right now must not disappear from a
    /// close.
    /// </summary>
    public static class AccountRelevance
    {
        // NinjaTrader's own fixtures. These names are reserved by the platform and
        // exist on every install whether or not anyone trades.
        private static readonly string[] PlatformAccounts = { "Backtest", "Playback" };

        public static bool IsPlatformAccount(string accountName)
        {
            string name = (accountName ?? String.Empty).Trim();
            if (name.Length == 0) return false;
            foreach (string platform in PlatformAccounts)
            {
                if (name.StartsWith(platform, StringComparison.OrdinalIgnoreCase))
                    return true;
            }
            return false;
        }

        /// <summary>
        /// A disconnected account is not part of today's close.
        ///
        /// Its balance is whatever it was when the connection last dropped, so
        /// sending it asserts a measurement that did not happen today. The
        /// earlier rule kept any disconnected account that still showed money,
        /// which is exactly the shape of an old prop-firm account left
        /// configured after the client moved on: disconnected for months,
        /// holding a frozen balance, and indistinguishable from a live one once
        /// it reaches the CRM.
        ///
        /// The cost is a real account that happened to be offline at capture
        /// time, which disappears for that day. That is the better failure: a
        /// missing account raises a flag the CAM can see, while a stale one
        /// contributes a wrong number to the day's totals in silence. Present
        /// and wrong is worse than absent and flagged.
        /// </summary>
        /// <param name="isConnected">Whether the account's connection is live.</param>
        /// <param name="cashValue">Cash the account holds, if reported.</param>
        /// <param name="netLiquidation">Net liquidation value, if reported.</param>
        public static bool IsRelevant(string accountName, bool isConnected, decimal? cashValue, decimal? netLiquidation)
        {
            if (IsPlatformAccount(accountName)) return false;
            return isConnected;
        }

    }
}
