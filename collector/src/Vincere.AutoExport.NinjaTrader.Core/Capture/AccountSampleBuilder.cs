using System;
using System.Collections.Generic;
using System.Linq;
using Vincere.AutoExport.Contracts;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{
    public sealed class AccountSampleBuildContext
    {
        /// <summary>The machine's clock when the accounts were read.</summary>
        public DateTimeOffset SampledAt { get; set; }
    }

    /// <summary>
    /// Builds the tracker reading. The counterpart of <see cref="SnapshotBuilder"/>
    /// and deliberately much less than it.
    ///
    /// WHAT IT DOES NOT DO, each one a line SnapshotBuilder has and this does not:
    /// no orders section, no executions section, no strategy rows, no attribution
    /// map, no capture id, no trading date, no time zone, no source metadata. A
    /// sample is not filed against a trading day and is never replayed, so it
    /// needs none of the bookkeeping a close is built out of.
    ///
    /// ONE SECTION, SO ONE FAILURE MODE. SnapshotBuilder wraps each of its four
    /// reads in its own SnapshotCaptureException so a close can name the section
    /// that broke. There is one read here, and a sample that cannot be taken
    /// degrades to nothing and waits for the next tick, so it lets the exception
    /// out unchanged for the pipe processor to turn into one error code.
    /// </summary>
    public sealed class AccountSampleBuilder
    {
        private readonly IAccountSampleFacade facade;

        public AccountSampleBuilder(IAccountSampleFacade facade)
        {
            this.facade = facade ?? throw new ArgumentNullException(nameof(facade));
        }

        public AccountSampleV1 Build(AccountSampleBuildContext context)
        {
            if (context == null) throw new ArgumentNullException(nameof(context));

            IEnumerable<AccountSampleCaptureSource> sources = facade.ReadAccountsForSample();
            return new AccountSampleV1
            {
                SchemaVersion = 1,
                SampledAt = context.SampledAt,
                Accounts = sources == null
                    ? new List<AccountSampleRowV1>()
                    : sources.Select(MapAccount).ToList(),
            };
        }

        private static AccountSampleRowV1 MapAccount(AccountSampleCaptureSource source)
        {
            StrategyLiveTally tally = StrategyLiveCount.Tally(source.StrategyStates);
            return new AccountSampleRowV1
            {
                AccountName = source.AccountName,
                ConnectionName = source.ConnectionName,
                Connected = source.Connected,
                Status = source.Status,
                RealizedPnl = source.RealizedPnl,
                UnrealizedPnl = source.UnrealizedPnl,
                TotalPnl = source.TotalPnl,
                StrategyCount = tally.Total,
                EnabledStrategyCount = tally.Live,
            };
        }
    }
}
