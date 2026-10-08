using System;
using System.Collections.Generic;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{
    public interface INinjaTraderFacade
    {
        IEnumerable<AccountCaptureSource> ReadAccounts();
        IEnumerable<StrategyCaptureSource> ReadStrategies();
        IEnumerable<OrderCaptureSource> ReadOrders();
        IEnumerable<ExecutionCaptureSource> ReadExecutions();
    }

    /// <summary>
    /// The tracker reading, which is a different question from a close and so
    /// gets a different method rather than a flag on the four above.
    ///
    /// A SEPARATE INTERFACE, NOT A FIFTH MEMBER ON <see cref="INinjaTraderFacade"/>.
    /// This library targets netstandard2.0, which has no default interface
    /// implementations, so adding a member there would break every existing test
    /// double of it on a change that none of them care about. NinjaTraderFacade
    /// implements both; nothing else has to.
    /// </summary>
    public interface IAccountSampleFacade
    {
        IEnumerable<AccountSampleCaptureSource> ReadAccountsForSample();
    }

    /// <summary>
    /// One account as a tracker sees it. Compare with <see cref="AccountCaptureSource"/>,
    /// which carries seventeen more fields and the whole AccountValues dictionary:
    /// everything missing here is already in the close, and the desk asked for the
    /// least data that answers which accounts are alive, which are running, and
    /// roughly how the day is going.
    /// </summary>
    public sealed class AccountSampleCaptureSource
    {
        public string AccountName { get; set; }
        public string ConnectionName { get; set; }

        /// <summary>
        /// Whether the connection was live. Carried explicitly because this
        /// sample, unlike the close, keeps disconnected accounts - see
        /// AccountSampleRelevance.
        /// </summary>
        public bool Connected { get; set; }

        public string Status { get; set; }
        public decimal? RealizedPnl { get; set; }
        public decimal? UnrealizedPnl { get; set; }
        public decimal? TotalPnl { get; set; }

        /// <summary>
        /// Each strategy's State word and nothing else about it. Null means the
        /// collection could not be read, which <see cref="StrategyLiveCount"/>
        /// keeps distinct from an account holding none.
        ///
        /// The WORDS rather than a count, so the rule that turns them into
        /// "running" lives in this library where it is unit-testable off Windows,
        /// instead of inside the net48 add-on assembly that only Windows CI
        /// compiles.
        /// </summary>
        public IEnumerable<string> StrategyStates { get; set; }
    }

    /// <summary>
    /// The per strategy reading: each strategy instance with its Realized and
    /// Unrealized as the Strategies tab shows them.
    ///
    /// A THIRD INTERFACE, for the reason <see cref="IAccountSampleFacade"/> is a
    /// second one: netstandard2.0 has no default interface members, so a new
    /// member on an existing interface would break every test double of it.
    /// </summary>
    public interface IStrategySampleFacade
    {
        IEnumerable<StrategySampleCaptureSource> ReadStrategiesForSample();
    }

    /// <summary>
    /// One strategy instance as the per strategy reading sees it. Every
    /// instance the account holds is reported with its State word, and
    /// <see cref="StrategySampleBuilder"/> keeps only the live ones, so the rule
    /// that decides "live" stays in this library where it is testable off Windows.
    /// </summary>
    public sealed class StrategySampleCaptureSource
    {
        public string AccountName { get; set; }
        public string StrategyId { get; set; }
        public string StrategyName { get; set; }
        public string Instrument { get; set; }
        public string State { get; set; }

        /// <summary>Null when it could not be read. Never a zero standing in for one.</summary>
        public decimal? RealizedPnl { get; set; }

        /// <summary>
        /// Zero when the position was read and is flat; null when it could not be
        /// read at all.
        /// </summary>
        public decimal? UnrealizedPnl { get; set; }

        /// <summary>
        /// How many real time trades this run has completed; null when it could
        /// not be read. It only grows within a run and starts again at zero on a
        /// re-enable, which is how the agent sees a restart between two readings.
        /// </summary>
        public int? RealtimeTradeCount { get; set; }

        /// <summary>
        /// Position.MarketPosition as a lower case word, "long", "short" or
        /// "flat"; null when the position could not be read or answered a word
        /// that is none of the three. The desk reads it to know which way
        /// BulletBot fired today, which the strategy catalogue cannot say.
        /// </summary>
        public string MarketPosition { get; set; }

        /// <summary>
        /// Position.Quantity, the contracts held, zero when flat; null when it
        /// could not be read or is not a whole non-negative number.
        /// </summary>
        public int? PositionQuantity { get; set; }
    }

    public sealed class SnapshotBuildContext
    {
        public Guid CaptureId { get; set; }
        public DateTimeOffset CapturedAt { get; set; }
        public string TradingDate { get; set; }
        public string AddonVersion { get; set; }
        public string NinjaTraderVersion { get; set; }
    }

    public sealed class AccountCaptureSource
    {
        public string AccountName { get; set; }
        public string ConnectionName { get; set; }
        public string DisplayName { get; set; }
        public decimal? NetLiquidation { get; set; }
        public decimal? CashValue { get; set; }
        public decimal? RealizedPnl { get; set; }
        public decimal? GrossRealizedPnl { get; set; }
        public decimal? UnrealizedPnl { get; set; }
        public decimal? TotalPnl { get; set; }
        public decimal? WeeklyPnl { get; set; }
        public decimal? TrailingMaxDrawdown { get; set; }
        public decimal? BuyingPower { get; set; }
        public decimal? ExcessIntradayMargin { get; set; }
        public decimal? InitialMargin { get; set; }
        public decimal? MaintenanceMargin { get; set; }
        public string Currency { get; set; }
        public string Status { get; set; }

        /// <summary>
        /// Every AccountItem NinjaTrader reports for this account, keyed by enum
        /// name. Read by enumerating the enum rather than a hand-picked list, so a
        /// value we never thought to ask for still reaches the CRM, and a new one
        /// in a future NinjaTrader version arrives without a code change. Note that
        /// trailing max drawdown and weekly PnL are NOT among them — they are not
        /// exposed by the public API at all, only by the Accounts grid.
        /// </summary>
        public IDictionary<string, decimal?> AccountValues { get; set; }
    }

    public sealed class StrategyCaptureSource
    {
        public string StrategyId { get; set; }
        public string StrategyName { get; set; }
        public string StrategyDisplayName { get; set; }
        public string AccountName { get; set; }
        public string Instrument { get; set; }
        public string State { get; set; }
        public decimal? Quantity { get; set; }
        public string Position { get; set; }
        public decimal? AveragePrice { get; set; }
        public decimal? RealizedPnl { get; set; }
        public decimal? UnrealizedPnl { get; set; }
        public bool? Enabled { get; set; }
        public bool? Sync { get; set; }
        public string DataSeries { get; set; }
        public string ConnectionName { get; set; }
        public DateTimeOffset? StartedAt { get; set; }
        public IEnumerable<StrategyParameterSource> Parameters { get; set; }

        /// <summary>
        /// Every readable scalar property NinjaTrader exposes on the underlying
        /// object, keyed by property name. The named fields above are what the CRM
        /// reads today; this carries everything else so a column nobody asked for
        /// yet is still captured. Unlike a grid export, this does not depend on
        /// which columns a user happens to have switched on.
        /// </summary>
        public IDictionary<string, object> ExtraValues { get; set; }

    }

    public sealed class OrderCaptureSource
    {
        public string OrderId { get; set; }
        public string AccountName { get; set; }
        public string StrategyId { get; set; }
        public string StrategyName { get; set; }
        public string Instrument { get; set; }
        public string Action { get; set; }
        public string OrderType { get; set; }
        public decimal? Quantity { get; set; }
        public decimal? Filled { get; set; }
        public decimal? Remaining { get; set; }
        public decimal? LimitPrice { get; set; }
        public decimal? StopPrice { get; set; }
        public decimal? AverageFillPrice { get; set; }
        public string State { get; set; }
        public DateTimeOffset? Time { get; set; }
        public string Tif { get; set; }
        public string Oco { get; set; }
        public string Name { get; set; }
        public string NativeId { get; set; }

        /// <summary>
        /// Every readable scalar property NinjaTrader exposes on the underlying
        /// object, keyed by property name. The named fields above are what the CRM
        /// reads today; this carries everything else so a column nobody asked for
        /// yet is still captured. Unlike a grid export, this does not depend on
        /// which columns a user happens to have switched on.
        /// </summary>
        public IDictionary<string, object> ExtraValues { get; set; }

    }

    public sealed class ExecutionCaptureSource
    {
        public string ExecutionId { get; set; }
        public string OrderId { get; set; }
        public string AccountName { get; set; }
        public string StrategyId { get; set; }
        public string StrategyName { get; set; }
        public string Instrument { get; set; }
        public string Action { get; set; }
        public decimal? Quantity { get; set; }
        public decimal? Price { get; set; }
        public DateTimeOffset Time { get; set; }
        public string MarketPosition { get; set; }
        public string EntryExit { get; set; }
        public string Name { get; set; }
        public decimal? Commission { get; set; }
        public decimal? Fee { get; set; }
        public decimal? Rate { get; set; }
        public decimal? RealizedPnl { get; set; }
        public string ConnectionName { get; set; }
        public string NativeId { get; set; }

        /// <summary>
        /// Every readable scalar property NinjaTrader exposes on the underlying
        /// object, keyed by property name. The named fields above are what the CRM
        /// reads today; this carries everything else so a column nobody asked for
        /// yet is still captured. Unlike a grid export, this does not depend on
        /// which columns a user happens to have switched on.
        /// </summary>
        public IDictionary<string, object> ExtraValues { get; set; }

    }

    public sealed class StrategyParameterSource
    {
        public StrategyParameterSource(string name, object value, bool isBrowsable = true)
        {
            Name = name;
            Value = value;
            IsBrowsable = isBrowsable;
        }

        public string Name { get; private set; }
        public object Value { get; private set; }
        public bool IsBrowsable { get; private set; }
    }
}
