using System;
using System.ComponentModel;
using System.Linq;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript;
using Vincere.AutoExport.NinjaTrader.Capture;
using Vincere.AutoExport.NinjaTrader.Core.Capture;
using Xunit;

namespace Vincere.AutoExport.NinjaTrader.Core.Tests;

public sealed class NinjaTraderFacadeTests : IDisposable
{
    public NinjaTraderFacadeTests() => Account.All.Clear();
    public void Dispose() => Account.All.Clear();

    [Fact]
    public void Reads_all_four_live_collections_into_detached_sources()
    {
        Account account = AccountFixture();
        account.Strategies.Add(new TestStrategy
        {
            Name = "Opening Range",
            DisplayName = "Opening Range NQ",
            StrategyId = "strategy-1",
            State = "Realtime",
            Position = new TestPosition
            {
                Quantity = 2,
                MarketPosition = "Long",
                AveragePrice = 23100.25,
            },
            IsInSync = true,
            BarsPeriod = "1 Minute",
            Risk = 125.50m,
            ApiToken = "must-not-leak",
        });
        account.Strategies[0].Instruments.Add(new Instrument { FullName = "NQ SEP26" });
        var order = new Order
        {
            OrderId = "order-1",
            Instrument = new Instrument { FullName = "NQ SEP26" },
            OrderAction = OrderAction.Buy,
            OrderType = OrderType.Limit,
            Quantity = 2,
            Filled = 1,
            LimitPrice = 23100.25,
            OrderState = OrderState.Working,
            Time = new DateTime(2026, 7, 23, 16, 44, 0, DateTimeKind.Local),
            TimeInForce = TimeInForce.Day,
            Name = "Entry",
        };
        account.Orders.Add(order);
        account.Executions.Add(new Execution
        {
            ExecutionId = "execution-1",
            OrderId = order.OrderId,
            Order = order,
            Instrument = order.Instrument,
            Quantity = 1,
            Price = 23100.25,
            Time = order.Time,
            MarketPosition = MarketPosition.Long,
            Name = "Entry",
            Commission = 2.05,
            Rate = 1,
        });
        Account.All.Add(account);

        var facade = new NinjaTraderFacade();
        var accountRow = Assert.Single(facade.ReadAccounts());
        var strategyRow = Assert.Single(facade.ReadStrategies());
        var orderRow = Assert.Single(facade.ReadOrders());
        var executionRow = Assert.Single(facade.ReadExecutions());

        Assert.Equal(0m, accountRow.RealizedPnl);
        Assert.Equal(125.50m, accountRow.GrossRealizedPnl);
        Assert.Equal(12.25m, accountRow.UnrealizedPnl);
        Assert.Equal(12.25m, accountRow.TotalPnl);
        Assert.Null(accountRow.WeeklyPnl);
        Assert.Null(accountRow.TrailingMaxDrawdown);
        Assert.Equal("strategy-1", strategyRow.StrategyId);
        Assert.Equal(2m, strategyRow.Quantity);
        Assert.Contains(strategyRow.Parameters, parameter => parameter.Name == "Risk" && Equals(parameter.Value, 125.50m));
        Assert.Equal(1m, orderRow.Remaining);
        Assert.Equal("execution-1", executionRow.ExecutionId);
        Assert.Equal(2.05m, executionRow.Commission);
    }

    [Fact]
    public void Attributes_orders_and_fills_to_the_strategy_that_owns_them()
    {
        Account account = AccountFixture();
        var strategyOrder = OrderFixture("order-1");
        var manualOrder = OrderFixture("order-2");
        var strategy = new TestStrategy { Name = "Opening Range", StrategyId = "strategy-1" };
        strategy.Orders.Add(strategyOrder);
        account.Strategies.Add(strategy);
        account.Orders.Add(strategyOrder);
        account.Orders.Add(manualOrder);
        // Neither fill is listed under the strategy, which is the shape a live
        // machine has: the strategy keeps its orders and both fills have to be
        // attributed through the order they filled.
        account.Executions.Add(FillFixture("execution-1", strategyOrder));
        account.Executions.Add(FillFixture("execution-2", manualOrder));
        Account.All.Add(account);

        var facade = new NinjaTraderFacade();
        var orders = facade.ReadOrders().ToList();
        var executions = facade.ReadExecutions().ToList();

        OrderCaptureSource placed = orders.Single(row => row.OrderId == "order-1");
        Assert.Equal("strategy-1", placed.StrategyId);
        Assert.Equal("Opening Range", placed.StrategyName);
        ExecutionCaptureSource filled = executions.Single(row => row.ExecutionId == "execution-1");
        Assert.Equal("strategy-1", filled.StrategyId);
        Assert.Equal("Opening Range", filled.StrategyName);

        // The manual trade keeps the two nulls it has always carried.
        Assert.Null(orders.Single(row => row.OrderId == "order-2").StrategyId);
        Assert.Null(orders.Single(row => row.OrderId == "order-2").StrategyName);
        Assert.Null(executions.Single(row => row.ExecutionId == "execution-2").StrategyName);
    }

    [Fact]
    public void Attributes_a_fill_the_strategy_lists_but_whose_order_it_no_longer_holds()
    {
        Account account = AccountFixture();
        Order order = OrderFixture("order-1");
        Execution fill = FillFixture("execution-1", order);
        var strategy = new TestStrategy { Name = "Opening Range", StrategyId = "strategy-1" };
        strategy.Executions.Add(fill);
        account.Strategies.Add(strategy);
        account.Orders.Add(order);
        account.Executions.Add(fill);
        Account.All.Add(account);

        var facade = new NinjaTraderFacade();

        Assert.Equal("Opening Range", Assert.Single(facade.ReadExecutions()).StrategyName);
        // The order is claimed through the fill that names it, so a close carries
        // one answer for the trade rather than an attributed fill beside an
        // unattributed order.
        Assert.Equal("Opening Range", Assert.Single(facade.ReadOrders()).StrategyName);
    }

    [Fact]
    public void Attributes_through_a_strategy_whose_type_descriptor_hides_its_collections()
    {
        // A NinjaScript object can carry a custom type descriptor: it is how the
        // platform's own grids show a strategy's parameters and nothing else. One
        // that answers with no properties at all is the worst case, and its orders
        // are still an ordinary property on the type.
        Account account = AccountFixture();
        Order order = OrderFixture("order-1");
        var strategy = new DescriptorlessStrategy { Name = "Opening Range", StrategyId = "strategy-1" };
        strategy.Orders.Add(order);
        account.Strategies.Add(strategy);
        account.Orders.Add(order);
        Account.All.Add(account);

        OrderCaptureSource row = Assert.Single(new NinjaTraderFacade().ReadOrders());

        Assert.Equal("Opening Range", row.StrategyName);
        // The id is read the way MapStrategy reads it, so it degrades with the
        // rest of that view. The name is what the CRM attributes on.
        Assert.Null(row.StrategyId);
    }

    [Fact]
    public void Leaves_a_trade_two_strategies_claim_unattributed()
    {
        Account account = AccountFixture();
        Order order = OrderFixture("order-1");
        var first = new TestStrategy { Name = "Opening Range", StrategyId = "strategy-1" };
        var second = new TestStrategy { Name = "Mean Reversion", StrategyId = "strategy-2" };
        first.Orders.Add(order);
        second.Orders.Add(order);
        account.Strategies.Add(first);
        account.Strategies.Add(second);
        account.Orders.Add(order);
        account.Executions.Add(FillFixture("execution-1", order));
        Account.All.Add(account);

        var facade = new NinjaTraderFacade();

        Assert.Null(Assert.Single(facade.ReadOrders()).StrategyName);
        Assert.Null(Assert.Single(facade.ReadExecutions()).StrategyName);
    }

    [Fact]
    public void Leaves_provider_sentinels_and_grid_only_values_null()
    {
        var account = new Account
        {
            Name = "Sparse",
            // Connected, so the relevance filter keeps it: this test is about how
            // unset provider values map, not about which accounts are captured.
            ConnectionStatus = "Connected",
            Denomination = Currency.UsDollar,
            Connection = new Connection { Options = new ConnectionOptions { Name = "Provider" } },
        };
        Account.All.Add(account);

        var row = Assert.Single(new NinjaTraderFacade().ReadAccounts());

        Assert.Null(row.CashValue);
        Assert.Null(row.RealizedPnl);
        Assert.Null(row.GrossRealizedPnl);
        Assert.Null(row.TotalPnl);
        // Null only because this provider reports neither. A real install does
        // report them, under AccountItem members the published list omits.
        Assert.Null(row.WeeklyPnl);
        Assert.Null(row.TrailingMaxDrawdown);
    }

    [Fact]
    public void Skips_accounts_that_are_disconnected_and_hold_nothing()
    {
        // A real machine carried 44 accounts where the grid showed 3; the rest
        // were leftovers from connections that no longer exist.
        Account.All.Add(new Account
        {
            Name = "DEMO5289161",
            Denomination = Currency.UsDollar,
            Connection = new Connection { Options = new ConnectionOptions { Name = "Provider" } },
        });

        Assert.Empty(new NinjaTraderFacade().ReadAccounts());
    }

    [Fact]
    public void Reports_weekly_and_trailing_when_the_provider_exposes_them()
    {
        var account = AccountFixture();
        account.Set(AccountItem.WeeklyProfitLoss, 171.54);
        account.Set(AccountItem.TrailingMaxDrawdown, 888.48);
        Account.All.Add(account);

        var row = Assert.Single(new NinjaTraderFacade().ReadAccounts());

        Assert.Equal(171.54m, row.WeeklyPnl);
        Assert.Equal(888.48m, row.TrailingMaxDrawdown);
    }

    private static Account AccountFixture()
    {
        var account = new Account
        {
            Name = "Sim101",
            DisplayName = "Primary",
            ConnectionStatus = "Connected",
            Denomination = Currency.UsDollar,
            Connection = new Connection { Options = new ConnectionOptions { Name = "Live" } },
        };
        account.Set(AccountItem.RealizedProfitLoss, 0);
        account.Set(AccountItem.GrossRealizedProfitLoss, 125.50);
        account.Set(AccountItem.UnrealizedProfitLoss, 12.25);
        account.Set(AccountItem.CashValue, 49_000);
        account.Set(AccountItem.NetLiquidation, 50_125.50);
        return account;
    }

    private static Order OrderFixture(string orderId)
    {
        return new Order
        {
            OrderId = orderId,
            Instrument = new Instrument { FullName = "NQ SEP26" },
            OrderAction = OrderAction.Buy,
            OrderType = OrderType.Limit,
            Quantity = 1,
            Filled = 1,
            LimitPrice = 23100.25,
            AverageFillPrice = 23100.25,
            OrderState = OrderState.Filled,
            Time = new DateTime(2026, 9, 22, 16, 44, 0, DateTimeKind.Local),
            TimeInForce = TimeInForce.Day,
            Name = "Entry",
        };
    }

    private static Execution FillFixture(string executionId, Order order)
    {
        return new Execution
        {
            ExecutionId = executionId,
            OrderId = order.OrderId,
            Order = order,
            Instrument = order.Instrument,
            Quantity = order.Filled,
            Price = order.AverageFillPrice,
            Time = order.Time,
            MarketPosition = MarketPosition.Long,
            Name = order.Name,
            Commission = 2.05,
            Rate = 1,
        };
    }

    private sealed class TestStrategy : StrategyBase
    {
        [DisplayName("Risk")]
        public decimal Risk { get; set; }

        public string ApiToken { get; set; }
    }

    // Answers no properties at all through TypeDescriptor, which is the shape a
    // NinjaScript object with a custom descriptor has: what the platform's grids
    // are shown is not what the type declares.
    private sealed class DescriptorlessStrategy : StrategyBase, ICustomTypeDescriptor
    {
        public AttributeCollection GetAttributes() => AttributeCollection.Empty;
        public string GetClassName() => null;
        public string GetComponentName() => null;
        public TypeConverter GetConverter() => null;
        public EventDescriptor GetDefaultEvent() => null;
        public PropertyDescriptor GetDefaultProperty() => null;
        public object GetEditor(Type editorBaseType) => null;
        public EventDescriptorCollection GetEvents() => EventDescriptorCollection.Empty;
        public EventDescriptorCollection GetEvents(Attribute[] attributes) => EventDescriptorCollection.Empty;
        public PropertyDescriptorCollection GetProperties() => PropertyDescriptorCollection.Empty;
        public PropertyDescriptorCollection GetProperties(Attribute[] attributes) => PropertyDescriptorCollection.Empty;
        public object GetPropertyOwner(PropertyDescriptor pd) => this;
    }

    private sealed class TestPosition
    {
        public int Quantity { get; set; }
        public string MarketPosition { get; set; }
        public double AveragePrice { get; set; }
    }
}
