using System;
using System.Collections.Generic;
using NinjaTrader.NinjaScript;

namespace NinjaTrader.Cbi
{
    public enum Currency { UsDollar }

    // Mirrors the members the capture depends on. WeeklyProfitLoss and
    // TrailingMaxDrawdown are absent from NinjaTrader's published AccountItem
    // list but present on a real 8.1.7.2 install, which is why the facade reads
    // values by enumerating this enum rather than naming members.
    public enum AccountItem
    {
        BuyingPower,
        CashValue,
        ExcessIntradayMargin,
        GrossRealizedProfitLoss,
        InitialMargin,
        MaintenanceMargin,
        NetLiquidation,
        RealizedProfitLoss,
        UnrealizedProfitLoss,
        WeeklyProfitLoss,
        TrailingMaxDrawdown,
    }

    public sealed class ConnectionOptions { public string Name { get; set; } }
    public sealed class Connection { public ConnectionOptions Options { get; set; } }
    public sealed class Instrument { public string FullName { get; set; } }

    public sealed class Account
    {
        private readonly IDictionary<AccountItem, double> values = new Dictionary<AccountItem, double>();

        public static IList<Account> All { get; } = new List<Account>();
        public string Name { get; set; }
        public string DisplayName { get; set; }
        public string ConnectionStatus { get; set; }
        public Currency Denomination { get; set; }
        public Connection Connection { get; set; }
        public IList<StrategyBase> Strategies { get; } = new List<StrategyBase>();
        public IList<Order> Orders { get; } = new List<Order>();
        public IList<Execution> Executions { get; } = new List<Execution>();

        public double Get(AccountItem item, Currency currency)
        {
            _ = currency;
            return values.TryGetValue(item, out double value) ? value : Double.MinValue;
        }

        public void Set(AccountItem item, double value) => values[item] = value;
    }

    public enum OrderType { Market, Limit, StopMarket, StopLimit }
    public enum OrderAction { Buy, Sell, BuyToCover, SellShort }
    public enum OrderState { Working, Filled, Cancelled }
    public enum TimeInForce { Day, Gtc }
    public enum MarketPosition { Long, Short }

    public sealed class Order
    {
        public string OrderId { get; set; }
        public Instrument Instrument { get; set; }
        public OrderAction OrderAction { get; set; }
        public OrderType OrderType { get; set; }
        public int Quantity { get; set; }
        public int Filled { get; set; }
        public double LimitPrice { get; set; }
        public double StopPrice { get; set; }
        public double AverageFillPrice { get; set; }
        public OrderState OrderState { get; set; }
        public DateTime Time { get; set; }
        public TimeInForce TimeInForce { get; set; }
        public string Oco { get; set; }
        public string Name { get; set; }
    }

    public sealed class Execution
    {
        public string ExecutionId { get; set; }
        public string OrderId { get; set; }
        public Instrument Instrument { get; set; }
        public Order Order { get; set; }
        public int Quantity { get; set; }
        public double Price { get; set; }
        public DateTime Time { get; set; }
        public MarketPosition MarketPosition { get; set; }
        public string Name { get; set; }
        public double Commission { get; set; }
        public double Rate { get; set; }
    }
}

namespace NinjaTrader.NinjaScript
{
    using NinjaTrader.Cbi;

    public partial class StrategyBase
    {
        public string Name { get; set; }
        public string DisplayName { get; set; }
        public string StrategyId { get; set; }
        public string State { get; set; }
        public object Position { get; set; }
        public IList<Instrument> Instruments { get; } = new List<Instrument>();
        public bool IsInSync { get; set; }
        public string BarsPeriod { get; set; }
    }
}
