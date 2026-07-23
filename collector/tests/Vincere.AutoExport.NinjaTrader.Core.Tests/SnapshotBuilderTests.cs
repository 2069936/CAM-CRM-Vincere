using System;
using System.Collections;
using System.Collections.Generic;
using Vincere.AutoExport.NinjaTrader.Core.Capture;
using Xunit;

namespace Vincere.AutoExport.NinjaTrader.Core.Tests;

public sealed class SnapshotBuilderTests
{
    [Fact]
    public void Build_maps_all_four_sections_without_collapsing_realized_and_gross_pnl()
    {
        var capturedAt = new DateTimeOffset(2026, 7, 23, 16, 45, 0, TimeSpan.FromHours(-4));
        var facade = new FakeFacade
        {
            Accounts = new[]
            {
                new AccountCaptureSource
                {
                    AccountName = "Sim101",
                    DisplayName = "Primary",
                    ConnectionName = "Live",
                    NetLiquidation = 50125.50m,
                    CashValue = 49000m,
                    RealizedPnl = 0m,
                    GrossRealizedPnl = 125.50m,
                    UnrealizedPnl = 12.25m,
                    TotalPnl = 137.75m,
                    WeeklyPnl = null,
                    TrailingMaxDrawdown = -500m,
                    BuyingPower = 100000m,
                    ExcessIntradayMargin = 80000m,
                    InitialMargin = 15000m,
                    MaintenanceMargin = 12000m,
                    Currency = "UsDollar",
                    Status = "Connected",
                },
            },
            Strategies = new[]
            {
                new StrategyCaptureSource
                {
                    StrategyId = "strategy-1",
                    StrategyName = "Opening Range",
                    AccountName = "Sim101",
                    Instrument = "NQ SEP26",
                    State = "Realtime",
                    StrategyDisplayName = "Opening Range NQ",
                    Quantity = 2m,
                    Position = "Long",
                    AveragePrice = 23100.25m,
                    RealizedPnl = 125.50m,
                    UnrealizedPnl = 12.25m,
                    Enabled = true,
                    Sync = true,
                    DataSeries = "1 Minute",
                    ConnectionName = "Live",
                    StartedAt = capturedAt.AddHours(-7),
                    Parameters = new[] { new StrategyParameterSource("Contracts", 2) },
                },
            },
            Orders = new[]
            {
                new OrderCaptureSource
                {
                    OrderId = "order-1",
                    AccountName = "Sim101",
                    Instrument = "NQ SEP26",
                    Action = "Buy",
                    OrderType = "Limit",
                    State = "Filled",
                    Quantity = 2m,
                    Filled = 2m,
                    Remaining = 0m,
                    LimitPrice = 23100.25m,
                    StopPrice = null,
                    AverageFillPrice = 23100.25m,
                    Time = capturedAt.AddMinutes(-1),
                    Tif = "Day",
                    Oco = "oco-1",
                    Name = "Entry",
                    StrategyId = "strategy-1",
                    StrategyName = "Opening Range",
                    NativeId = "native-order-1",
                },
            },
            Executions = new[]
            {
                new ExecutionCaptureSource
                {
                    ExecutionId = "execution-1",
                    OrderId = "order-1",
                    AccountName = "Sim101",
                    Instrument = "NQ SEP26",
                    Action = "Buy",
                    Quantity = 2m,
                    Price = 23100.25m,
                    Time = capturedAt,
                    StrategyId = "strategy-1",
                    StrategyName = "Opening Range",
                    MarketPosition = "Long",
                    EntryExit = "Entry",
                    Name = "Entry fill",
                    Commission = 4.10m,
                    Fee = 0.50m,
                    Rate = 1m,
                    RealizedPnl = 125.50m,
                    ConnectionName = "Live",
                    NativeId = "native-execution-1",
                },
            },
        };

        var snapshot = new SnapshotBuilder(facade).Build(new SnapshotBuildContext
        {
            CaptureId = Guid.Parse("e1329d2c-cce0-4ef7-8b06-0fc49809e74e"),
            CapturedAt = capturedAt,
            TradingDate = "2026-07-23",
            AddonVersion = "1.0.0",
            NinjaTraderVersion = "8.1.5.2",
        });

        Assert.Equal(1, snapshot.SchemaVersion);
        Assert.Equal(0m, snapshot.Accounts[0].RealizedPnl);
        Assert.Equal(125.50m, snapshot.Accounts[0].GrossRealizedPnl);
        Assert.Null(snapshot.Accounts[0].WeeklyPnl);
        Assert.Equal(-500m, snapshot.Accounts[0].TrailingMaxDrawdown);
        Assert.Equal(50125.50m, snapshot.Accounts[0].NetLiquidation);
        Assert.Equal("UsDollar", snapshot.Accounts[0].Currency);

        Assert.Equal("Opening Range NQ", snapshot.Strategies[0].StrategyDisplayName);
        Assert.Equal("Long", snapshot.Strategies[0].Position);
        Assert.Equal(2, snapshot.Strategies[0].Parameters["Contracts"]);
        Assert.Equal("captured", snapshot.Strategies[0].ParameterCaptureStatus);

        Assert.Equal("strategy-1", snapshot.Orders[0].StrategyId);
        Assert.Equal(2m, snapshot.Orders[0].Filled);
        Assert.Equal("native-order-1", snapshot.Orders[0].NativeId);

        Assert.Equal("Entry", snapshot.Executions[0].EntryExit);
        Assert.Equal(4.10m, snapshot.Executions[0].Commission);
        Assert.Equal(0.50m, snapshot.Executions[0].Fee);
        Assert.Equal(1m, snapshot.Executions[0].Rate);
        Assert.Equal("native-execution-1", snapshot.Executions[0].NativeId);
    }

    [Fact]
    public void Build_snapshots_each_source_sequence_exactly_once()
    {
        var facade = FakeFacade.Empty();
        facade.Accounts = new SingleUseEnumerable<AccountCaptureSource>(Array.Empty<AccountCaptureSource>());
        facade.Strategies = new SingleUseEnumerable<StrategyCaptureSource>(Array.Empty<StrategyCaptureSource>());
        facade.Orders = new SingleUseEnumerable<OrderCaptureSource>(Array.Empty<OrderCaptureSource>());
        facade.Executions = new SingleUseEnumerable<ExecutionCaptureSource>(Array.Empty<ExecutionCaptureSource>());

        var snapshot = new SnapshotBuilder(facade).Build(ValidContext());

        Assert.Empty(snapshot.Accounts);
        Assert.Empty(snapshot.Strategies);
        Assert.Empty(snapshot.Orders);
        Assert.Empty(snapshot.Executions);
    }

    [Fact]
    public void Build_fails_the_whole_capture_with_a_stable_section_error()
    {
        var facade = FakeFacade.Empty();
        facade.AccountFailure = new InvalidOperationException("account vanished");

        var exception = Assert.Throws<SnapshotCaptureException>(
            () => new SnapshotBuilder(facade).Build(ValidContext()));

        Assert.Equal("section_capture_failed", exception.Code);
        Assert.Equal("accounts", exception.Section);
        Assert.DoesNotContain("account vanished", exception.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void Build_wraps_mapping_failures_with_the_section_name()
    {
        var facade = FakeFacade.Empty();
        facade.Strategies = new[]
        {
            new StrategyCaptureSource
            {
                StrategyId = "strategy-1",
                StrategyName = "Opening Range",
                AccountName = "Sim101",
                Instrument = "NQ SEP26",
                State = "Realtime",
                Parameters = new ThrowingEnumerable<StrategyParameterSource>(),
            },
        };

        var exception = Assert.Throws<SnapshotCaptureException>(
            () => new SnapshotBuilder(facade).Build(ValidContext()));

        Assert.Equal("section_capture_failed", exception.Code);
        Assert.Equal("strategies", exception.Section);
        Assert.DoesNotContain("parameter getter failed", exception.Message, StringComparison.Ordinal);
    }

    private static SnapshotBuildContext ValidContext()
    {
        return new SnapshotBuildContext
        {
            CaptureId = Guid.NewGuid(),
            CapturedAt = new DateTimeOffset(2026, 7, 23, 16, 45, 0, TimeSpan.FromHours(-4)),
            TradingDate = "2026-07-23",
            AddonVersion = "1.0.0",
            NinjaTraderVersion = "8.1.5.2",
        };
    }

    private sealed class FakeFacade : INinjaTraderFacade
    {
        public IEnumerable<AccountCaptureSource> Accounts { get; set; }
        public IEnumerable<StrategyCaptureSource> Strategies { get; set; }
        public IEnumerable<OrderCaptureSource> Orders { get; set; }
        public IEnumerable<ExecutionCaptureSource> Executions { get; set; }
        public Exception AccountFailure { get; set; }

        public static FakeFacade Empty()
        {
            return new FakeFacade
            {
                Accounts = Array.Empty<AccountCaptureSource>(),
                Strategies = Array.Empty<StrategyCaptureSource>(),
                Orders = Array.Empty<OrderCaptureSource>(),
                Executions = Array.Empty<ExecutionCaptureSource>(),
            };
        }

        public IEnumerable<AccountCaptureSource> ReadAccounts()
        {
            if (AccountFailure != null) throw AccountFailure;
            return Accounts;
        }

        public IEnumerable<StrategyCaptureSource> ReadStrategies() => Strategies;
        public IEnumerable<OrderCaptureSource> ReadOrders() => Orders;
        public IEnumerable<ExecutionCaptureSource> ReadExecutions() => Executions;
    }

    private sealed class SingleUseEnumerable<T> : IEnumerable<T>
    {
        private readonly IEnumerable<T> values;
        private bool enumerated;

        public SingleUseEnumerable(IEnumerable<T> values)
        {
            this.values = values;
        }

        public IEnumerator<T> GetEnumerator()
        {
            if (enumerated) throw new InvalidOperationException("enumerated more than once");
            enumerated = true;
            return values.GetEnumerator();
        }

        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }

    private sealed class ThrowingEnumerable<T> : IEnumerable<T>
    {
        public IEnumerator<T> GetEnumerator() => throw new InvalidOperationException("parameter getter failed");
        IEnumerator IEnumerable.GetEnumerator() => GetEnumerator();
    }
}
