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

        /// <param name="isConnected">Whether the account's connection is live.</param>
        /// <param name="cashValue">Cash the account holds, if reported.</param>
        /// <param name="netLiquidation">Net liquidation value, if reported.</param>
        public static bool IsRelevant(string accountName, bool isConnected, decimal? cashValue, decimal? netLiquidation)
        {
            if (IsPlatformAccount(accountName)) return false;
            if (isConnected) return true;
            return HasValue(cashValue) || HasValue(netLiquidation);
        }

        private static bool HasValue(decimal? amount)
        {
            return amount.HasValue && amount.Value != 0m;
        }
    }
}
