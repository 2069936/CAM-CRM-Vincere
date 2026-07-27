using System;
using System.ComponentModel;
using System.Linq;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript;
using Vincere.AutoExport.NinjaTrader.Capture;
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

    private sealed class TestStrategy : StrategyBase
    {
        [DisplayName("Risk")]
        public decimal Risk { get; set; }

        public string ApiToken { get; set; }
    }

    private sealed class TestPosition
    {
        public int Quantity { get; set; }
        public string MarketPosition { get; set; }
        public double AveragePrice { get; set; }
    }
}
