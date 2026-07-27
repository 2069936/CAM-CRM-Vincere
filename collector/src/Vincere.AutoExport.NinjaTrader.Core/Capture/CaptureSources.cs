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
