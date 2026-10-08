using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript;
using Vincere.AutoExport.Contracts;
using Vincere.AutoExport.NinjaTrader.Capture;
using Vincere.AutoExport.NinjaTrader.Core.Capture;
using Vincere.AutoExport.NinjaTrader.Core.Pipe;
using Xunit;

namespace Vincere.AutoExport.NinjaTrader.Core.Tests;

public sealed class StrategySampleBuilderTests
{
    private static readonly DateTimeOffset SampledAt = new(2026, 10, 6, 10, 10, 2, TimeSpan.FromHours(-4));

    [Fact]
    public void Only_live_instances_travel()
    {
        StrategySampleV1 sample = Build(
            Source("SIM-1", "1", "Realtime"),
            Source("SIM-1", "2", "Transition"),
            Source("SIM-1", "3", "Finalized"),
            Source("SIM-1", "4", "Terminated"),
            Source("SIM-1", "5", "Historical"),
            Source("SIM-1", "6", "SomethingNew"),
            Source("SIM-1", "7", null));

        Assert.Equal(new[] { "1", "2" }, sample.Strategies.Select(row => row.StrategyId));
    }

    /* THE MEASURED DUPLICATE: a Finalized instance and a Realtime one sharing an
     * id, in 7 groups across 6 real captures. The dead one is dropped before the
     * duplicate check, so the live one is what is sent, whichever comes first. */
    [Fact]
    public void A_finalized_and_a_realtime_instance_sharing_an_id_send_the_live_one()
    {
        StrategySampleCaptureSource dead = Source("SIM-1", "123456789", "Finalized");
        dead.RealizedPnl = 999m;
        StrategySampleCaptureSource live = Source("SIM-1", "123456789", "Realtime");
        live.RealizedPnl = -412.5m;

        StrategySampleV1 sample = Build(dead, live);

        StrategySampleRowV1 row = Assert.Single(sample.Strategies);
        Assert.Equal(-412.5m, row.RealizedPnl);
    }

    // The route refuses a post naming one (account, id) twice, so the second is
    // dropped here rather than costing the whole reading.
    [Fact]
    public void Two_live_rows_with_one_identity_keep_the_first()
    {
        StrategySampleCaptureSource first = Source("SIM-1", "9", "Realtime");
        first.RealizedPnl = 1m;
        StrategySampleCaptureSource second = Source("sim-1 ", "9", "Realtime");
        second.RealizedPnl = 2m;

        StrategySampleRowV1 row = Assert.Single(Build(first, second).Strategies);

        Assert.Equal(1m, row.RealizedPnl);
    }

    [Fact]
    public void The_same_id_on_two_accounts_is_two_instances()
    {
        Assert.Equal(2, Build(Source("SIM-1", "9", "Realtime"), Source("SIM-2", "9", "Realtime")).Strategies.Count);
    }

    [Theory]
    [InlineData(null, "1", "0 - OGX-PF-2.4", "MNQ 12-26")]
    [InlineData("SIM-1", " ", "0 - OGX-PF-2.4", "MNQ 12-26")]
    [InlineData("SIM-1", "1", "", "MNQ 12-26")]
    [InlineData("SIM-1", "1", "0 - OGX-PF-2.4", null)]
    public void A_row_without_an_identity_is_dropped_and_the_rest_still_travel(
        string account,
        string id,
        string name,
        string instrument)
    {
        var broken = new StrategySampleCaptureSource
        {
            AccountName = account,
            StrategyId = id,
            StrategyName = name,
            Instrument = instrument,
            State = "Realtime",
        };

        StrategySampleV1 sample = Build(broken, Source("SIM-1", "2", "Realtime"));

        Assert.Equal("2", Assert.Single(sample.Strategies).StrategyId);
    }

    [Fact]
    public void Each_field_lands_in_its_own_member_and_null_stays_null()
    {
        StrategySampleCaptureSource measured = Source("SIM-1", "1", "Realtime");
        measured.RealizedPnl = -412.5m;
        measured.UnrealizedPnl = 37.5m;
        StrategySampleCaptureSource unmeasured = Source("SIM-1", "2", "Realtime");
        unmeasured.RealizedPnl = null;
        unmeasured.UnrealizedPnl = null;
        StrategySampleCaptureSource halfMeasured = Source("SIM-1", "3", "Realtime");
        halfMeasured.RealizedPnl = 10m;
        halfMeasured.UnrealizedPnl = null;

        StrategySampleV1 sample = Build(measured, unmeasured, halfMeasured);

        Assert.Equal(-412.5m, sample.Strategies[0].RealizedPnl);
        Assert.Equal(37.5m, sample.Strategies[0].UnrealizedPnl);
        Assert.Equal("SIM-1", sample.Strategies[0].AccountName);
        Assert.Equal("0 - OGX-PF-2.4", sample.Strategies[0].StrategyName);
        Assert.Equal("MNQ 12-26", sample.Strategies[0].Instrument);
        Assert.Null(sample.Strategies[1].RealizedPnl);
        Assert.Null(sample.Strategies[1].UnrealizedPnl);
        Assert.Equal(10m, sample.Strategies[2].RealizedPnl);
        Assert.Null(sample.Strategies[2].UnrealizedPnl);
        // The add-on never claims a restart; only the agent can see one.
        Assert.All(sample.Strategies, row => Assert.Null(row.RestartedAt));
    }

    // The run count goes through as read: the agent reads a drop in it as a
    // restart, so an unread count must not turn into a zero on the way.
    [Fact]
    public void The_run_count_is_passed_through_and_an_unread_one_stays_null()
    {
        StrategySampleCaptureSource counted = Source("SIM-1", "1", "Realtime");
        counted.RealtimeTradeCount = 4;
        StrategySampleCaptureSource unread = Source("SIM-1", "2", "Realtime");
        unread.RealtimeTradeCount = null;

        StrategySampleV1 sample = Build(counted, unread);

        Assert.Equal(4, sample.Strategies[0].RealtimeTradeCount);
        Assert.Null(sample.Strategies[1].RealtimeTradeCount);
    }

    /* THE POSITION GOES THROUGH AS READ, and an unread one stays null rather than
     * becoming "flat" or zero: "flat" is an answer about BulletBot's day and null
     * is the absence of one. TradesThisRun is the agent's member and the add-on
     * leaves it alone. */
    [Fact]
    public void The_position_is_passed_through_and_an_unread_one_stays_null()
    {
        StrategySampleCaptureSource shortTwo = Source("SIM-1", "1", "Realtime");
        shortTwo.MarketPosition = "short";
        shortTwo.PositionQuantity = 2;
        StrategySampleCaptureSource flat = Source("SIM-1", "2", "Realtime");
        flat.MarketPosition = "flat";
        flat.PositionQuantity = 0;
        StrategySampleCaptureSource unread = Source("SIM-1", "3", "Realtime");
        unread.MarketPosition = null;
        unread.PositionQuantity = null;
        unread.RealtimeTradeCount = 9;

        StrategySampleV1 sample = Build(shortTwo, flat, unread);

        Assert.Equal("short", sample.Strategies[0].MarketPosition);
        Assert.Equal(2, sample.Strategies[0].PositionQuantity);
        Assert.Equal("flat", sample.Strategies[1].MarketPosition);
        Assert.Equal(0, sample.Strategies[1].PositionQuantity);
        Assert.Null(sample.Strategies[2].MarketPosition);
        Assert.Null(sample.Strategies[2].PositionQuantity);
        Assert.All(sample.Strategies, row => Assert.Null(row.TradesThisRun));
        Assert.Equal(9, sample.Strategies[2].RealtimeTradeCount);
    }

    [Fact]
    public void The_version_and_the_clock_are_set_and_nothing_read_is_an_empty_list()
    {
        StrategySampleV1 sample = new StrategySampleBuilder(new FakeStrategyFacade(null))
            .Build(new StrategySampleBuildContext { SampledAt = SampledAt });

        Assert.Equal(1, sample.SchemaVersion);
        Assert.Equal(SampledAt, sample.SampledAt);
        Assert.NotNull(sample.Strategies);
        Assert.Empty(sample.Strategies);
    }

    private static StrategySampleV1 Build(params StrategySampleCaptureSource[] sources)
    {
        return new StrategySampleBuilder(new FakeStrategyFacade(sources))
            .Build(new StrategySampleBuildContext { SampledAt = SampledAt });
    }

    private static StrategySampleCaptureSource Source(string account, string id, string state) => new()
    {
        AccountName = account,
        StrategyId = id,
        StrategyName = "0 - OGX-PF-2.4",
        Instrument = "MNQ 12-26",
        State = state,
    };

    private sealed class FakeStrategyFacade : IStrategySampleFacade
    {
        private readonly IEnumerable<StrategySampleCaptureSource> sources;

        public FakeStrategyFacade(IEnumerable<StrategySampleCaptureSource> sources) => this.sources = sources;

        public IEnumerable<StrategySampleCaptureSource> ReadStrategiesForSample() => sources;
    }
}

public sealed class StrategySampleProcessorTests
{
    [Fact]
    public async Task The_strategy_command_answers_with_a_strategy_sample_and_nothing_else()
    {
        var sample = new StrategySampleV1 { SchemaVersion = 1, Strategies = new List<StrategySampleRowV1>() };
        bool accountsRead = false;
        var processor = new CaptureRequestProcessor(
            _ => throw new InvalidOperationException("no close here"),
            TimeSpan.FromSeconds(1),
            _ =>
            {
                accountsRead = true;
                return Task.FromResult(new AccountSampleV1());
            },
            null,
            _ => Task.FromResult(sample));
        Guid requestId = Guid.NewGuid();

        CaptureResponse response = await processor.ProcessAsync(Request("sample_strategies", requestId));

        Assert.True(response.Ok);
        Assert.Equal(requestId, response.RequestId);
        Assert.Same(sample, response.StrategySample);
        Assert.Null(response.Sample);
        Assert.Null(response.Snapshot);
        Assert.False(accountsRead);
    }

    /* AN ADD-ON BUILT WITHOUT THE DELEGATE ANSWERS WHAT A 1.1.3 ADD-ON ANSWERS,
     * which is the only version negotiation the pipe has. */
    [Fact]
    public async Task Without_the_delegate_the_command_is_an_invalid_request()
    {
        var processor = new CaptureRequestProcessor(
            _ => Task.FromResult(new AutoExportSnapshotV1()),
            TimeSpan.FromSeconds(1),
            _ => Task.FromResult(new AccountSampleV1()));

        CaptureResponse response = await processor.ProcessAsync(Request("sample_strategies"));

        Assert.False(response.Ok);
        Assert.Equal("invalid_request", response.ErrorCode);
        Assert.Null(response.StrategySample);
    }

    // And the strategy delegate does not make the account command answerable, or
    // the reverse: each command answers only for its own delegate.
    [Fact]
    public async Task The_strategy_delegate_does_not_answer_the_account_command()
    {
        var processor = new CaptureRequestProcessor(
            _ => Task.FromResult(new AutoExportSnapshotV1()),
            TimeSpan.FromSeconds(1),
            sampleStrategies: _ => Task.FromResult(new StrategySampleV1()));

        CaptureResponse response = await processor.ProcessAsync(Request("sample_accounts"));

        Assert.Equal("invalid_request", response.ErrorCode);
    }

    [Fact]
    public async Task A_slow_strategy_read_times_out_under_its_own_code()
    {
        var processor = new CaptureRequestProcessor(
            _ => Task.FromResult(new AutoExportSnapshotV1()),
            TimeSpan.FromSeconds(30),
            _ => Task.FromResult(new AccountSampleV1()),
            TimeSpan.FromSeconds(30),
            async token =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, token);
                return new StrategySampleV1();
            },
            TimeSpan.FromMilliseconds(50));

        CaptureResponse response = await processor.ProcessAsync(Request("sample_strategies"));

        Assert.False(response.Ok);
        Assert.Equal("strategy_sample_timeout", response.ErrorCode);
    }

    [Fact]
    public async Task A_strategy_read_that_throws_or_returns_nothing_fails_under_its_own_code()
    {
        var throwing = new CaptureRequestProcessor(
            _ => Task.FromResult(new AutoExportSnapshotV1()),
            TimeSpan.FromSeconds(1),
            sampleStrategies: _ => throw new InvalidOperationException("position unreadable"));
        var empty = new CaptureRequestProcessor(
            _ => Task.FromResult(new AutoExportSnapshotV1()),
            TimeSpan.FromSeconds(1),
            sampleStrategies: _ => Task.FromResult<StrategySampleV1>(null));

        CaptureResponse thrown = await throwing.ProcessAsync(Request("sample_strategies"));
        CaptureResponse nothing = await empty.ProcessAsync(Request("sample_strategies"));

        Assert.Equal("strategy_sample_failed", thrown.ErrorCode);
        Assert.DoesNotContain("position unreadable", thrown.Message, StringComparison.Ordinal);
        Assert.Equal("strategy_sample_failed", nothing.ErrorCode);
    }

    // One gate for all three commands: a strategy read never shares the dispatcher
    // with a close, and a failed one releases the gate.
    [Fact]
    public async Task A_strategy_read_cannot_start_while_a_capture_runs_and_a_failed_one_releases_the_gate()
    {
        var release = new TaskCompletionSource<AutoExportSnapshotV1>();
        var processor = new CaptureRequestProcessor(
            _ => release.Task,
            TimeSpan.FromSeconds(5),
            sampleStrategies: _ => throw new InvalidOperationException());

        Task<CaptureResponse> capture = processor.ProcessAsync(Request("capture"));
        CaptureResponse busy = await processor.ProcessAsync(Request("sample_strategies"));
        release.SetResult(null);
        await capture;
        CaptureResponse afterwards = await processor.ProcessAsync(Request("sample_strategies"));
        CaptureResponse again = await processor.ProcessAsync(Request("sample_strategies"));

        Assert.Equal("capture_busy", busy.ErrorCode);
        Assert.Equal("strategy_sample_failed", afterwards.ErrorCode);
        Assert.Equal("strategy_sample_failed", again.ErrorCode);
    }

    private static CaptureRequest Request(string command, Guid? requestId = null) => new()
    {
        Command = command,
        RequestId = requestId ?? Guid.NewGuid(),
    };
}

/* THE PRODUCTION FACADE, COMPILED AGAINST THE STUBS. The stub StrategyBase has no
 * SystemPerformance and an object Position, which is exactly the situation the
 * reflection read is written for: a test strategy declares the members the real
 * platform is expected to have, and one that does not declare them reads null. */
[Collection(NinjaTraderAccountCollection.Name)]
public sealed class StrategySampleFacadeTests : IDisposable
{
    public StrategySampleFacadeTests() => Account.All.Clear();
    public void Dispose() => Account.All.Clear();

    [Fact]
    public void Each_live_strategy_reads_its_identity_and_both_halves_of_its_pnl()
    {
        Account account = AccountFixture("SIM-1", connected: true);
        account.Strategies.Add(Strategy("123456789", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime",
            cumProfit: -412.5, position: Long(unrealized: 37.5, lastPrice: 21000.25)));
        Account.All.Add(account);

        StrategySampleCaptureSource row = Assert.Single(new NinjaTraderFacade().ReadStrategiesForSample());

        Assert.Equal("SIM-1", row.AccountName);
        Assert.Equal("123456789", row.StrategyId);
        Assert.Equal("0 - OGX-PF-2.4", row.StrategyName);
        Assert.Equal("MNQ 12-26", row.Instrument);
        Assert.Equal("Realtime", row.State);
        Assert.Equal(-412.5m, row.RealizedPnl);
        Assert.Equal(37.5m, row.UnrealizedPnl);
    }

    /* THE RUN COUNT: the real time trades this run has completed, read from the
     * same performance object as the realized figure. A platform without the
     * member, a stopped instance and a reading past its budget all give null,
     * which the agent treats as "no evidence", never as a zero. */
    [Fact]
    public void Each_live_strategy_reads_its_run_count_and_an_unreadable_one_is_null()
    {
        Account account = AccountFixture("SIM-1", connected: true);
        TestStrategy counted = Strategy("1", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 10, Long(1m, 100));
        counted.SystemPerformance.RealTimeTrades.Count = 4;
        account.Strategies.Add(counted);
        account.Strategies.Add(new BareStrategy { StrategyId = "2", Name = "1 - ALPHA-1.2", State = "Realtime" });
        TestStrategy stopped = Strategy("3", "0 - OGX-PF-2.4", "MNQ 12-26", "Terminated", 10, Long(1m, 100));
        stopped.SystemPerformance.RealTimeTrades.Count = 4;
        account.Strategies.Add(stopped);
        Account.All.Add(account);

        List<StrategySampleCaptureSource> rows = new NinjaTraderFacade().ReadStrategiesForSample().ToList();
        List<StrategySampleCaptureSource> pastBudget = new NinjaTraderFacade(TimeSpan.Zero).ReadStrategiesForSample().ToList();

        Assert.Equal(4, rows[0].RealtimeTradeCount);
        Assert.Null(rows[1].RealtimeTradeCount);
        Assert.Null(rows[2].RealtimeTradeCount);
        Assert.All(pastBudget, row => Assert.Null(row.RealtimeTradeCount));
    }

    // A count that is not a whole non-negative number is not a count.
    [Fact]
    public void A_run_count_that_is_not_a_count_is_null()
    {
        Account account = AccountFixture("SIM-1", connected: true);
        TestStrategy negative = Strategy("1", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 10, Long(1m, 100));
        negative.SystemPerformance.RealTimeTrades.Count = -1;
        account.Strategies.Add(negative);
        account.Strategies.Add(new OddCountStrategy { StrategyId = "2", Name = "1 - ALPHA-1.2", State = "Realtime" });
        Account.All.Add(account);

        List<StrategySampleCaptureSource> rows = new NinjaTraderFacade().ReadStrategiesForSample().ToList();

        Assert.Null(rows[0].RealtimeTradeCount);
        Assert.Null(rows[1].RealtimeTradeCount);
    }

    /* THE POSITION ITSELF: which way the instance is in the market and how many
     * contracts it holds, so the desk knows whether BulletBot fired long or short.
     * Read from the same Position object the open figure is asked of, lower
     * cased, and null for anything that is not one of the three words. */
    [Fact]
    public void Each_live_strategy_reads_its_market_position_and_quantity_as_words_the_wire_takes()
    {
        Account account = AccountFixture("SIM-1", connected: true);
        TestPosition longTwo = Long(unrealized: 37.5m, lastPrice: 21000.25);
        longTwo.Quantity = 2;
        account.Strategies.Add(Strategy("1", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", -412.5, longTwo));
        account.Strategies.Add(Strategy("2", "1 - ALPHA-1.2", "NQ 12-26", "Realtime", 10,
            new TestPosition { MarketPosition = "Short", Quantity = 1 }));
        account.Strategies.Add(Strategy("3", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 10,
            new TestPosition { MarketPosition = "Flat", Quantity = 0 }));
        // The platform's own type: an enum, not a string, as NinjaTrader.Cbi declares it.
        account.Strategies.Add(Strategy("4", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 10,
            new EnumPosition { MarketPosition = MarketPosition.Short, Quantity = 3 }));
        Account.All.Add(account);

        List<StrategySampleCaptureSource> rows = new NinjaTraderFacade().ReadStrategiesForSample().ToList();

        Assert.Equal("long", rows[0].MarketPosition);
        Assert.Equal(2, rows[0].PositionQuantity);
        Assert.Equal("short", rows[1].MarketPosition);
        Assert.Equal(1, rows[1].PositionQuantity);
        Assert.Equal("flat", rows[2].MarketPosition);
        Assert.Equal(0, rows[2].PositionQuantity);
        Assert.Equal("short", rows[3].MarketPosition);
        Assert.Equal(3, rows[3].PositionQuantity);
    }

    /* NOT READ IS NULL, NOT "FLAT" AND NOT ZERO. A strategy without a Position
     * object, a position whose word is none of the three, a position whose
     * getter throws, a quantity that is not an int or is negative: each reads
     * null in its own member and costs the other nothing. */
    [Fact]
    public void A_position_that_cannot_be_read_is_null_member_by_member()
    {
        Account account = AccountFixture("SIM-1", connected: true);
        account.Strategies.Add(new BareStrategy { StrategyId = "1", Name = "0 - OGX-PF-2.4", State = "Realtime" });
        account.Strategies.Add(Strategy("2", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 10,
            new TestPosition { MarketPosition = "Sideways", Quantity = 2 }));
        account.Strategies.Add(Strategy("3", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 10,
            new OddQuantityPosition { MarketPosition = "Long" }));
        account.Strategies.Add(Strategy("4", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 10,
            new TestPosition { MarketPosition = "Long", Quantity = -1 }));
        account.Strategies.Add(Strategy("5", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 10,
            new ThrowingWordPosition()));
        account.Strategies.Add(Strategy("6", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 10,
            new TestPosition { MarketPosition = "   ", Quantity = 4 }));
        Account.All.Add(account);

        List<StrategySampleCaptureSource> rows = new NinjaTraderFacade().ReadStrategiesForSample().ToList();

        Assert.Null(rows[0].MarketPosition);
        Assert.Null(rows[0].PositionQuantity);
        Assert.Null(rows[1].MarketPosition);
        Assert.Equal(2, rows[1].PositionQuantity);
        Assert.Equal("long", rows[2].MarketPosition);
        Assert.Null(rows[2].PositionQuantity);
        Assert.Equal("long", rows[3].MarketPosition);
        Assert.Null(rows[3].PositionQuantity);
        Assert.Null(rows[4].MarketPosition);
        Assert.Equal(5, rows[4].PositionQuantity);
        Assert.Equal(10m, rows[4].RealizedPnl);
        Assert.Null(rows[5].MarketPosition);
        Assert.Equal(4, rows[5].PositionQuantity);
    }

    // Like the P&L: not read for a stopped instance (the builder drops it) and
    // lost, not invented, past the budget.
    [Fact]
    public void A_stopped_instance_and_a_reading_past_the_budget_carry_no_position()
    {
        Account account = AccountFixture("SIM-1", connected: true);
        TestPosition held = Long(unrealized: 5m, lastPrice: 100);
        held.Quantity = 2;
        account.Strategies.Add(Strategy("1", "0 - OGX-PF-2.4", "MNQ 12-26", "Terminated", 10, held));
        account.Strategies.Add(Strategy("2", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 10, held));
        Account.All.Add(account);

        List<StrategySampleCaptureSource> rows = new NinjaTraderFacade().ReadStrategiesForSample().ToList();
        List<StrategySampleCaptureSource> pastBudget = new NinjaTraderFacade(TimeSpan.Zero).ReadStrategiesForSample().ToList();

        Assert.Null(rows[0].MarketPosition);
        Assert.Null(rows[0].PositionQuantity);
        Assert.Equal("long", rows[1].MarketPosition);
        Assert.Equal(2, rows[1].PositionQuantity);
        Assert.All(pastBudget, row =>
        {
            Assert.Null(row.MarketPosition);
            Assert.Null(row.PositionQuantity);
        });
    }

    /* THE POSITION IS ASKED IN CURRENCY, AT THE LAST PRICE. A position asked in
     * points or at a stale price would give a plausible number that is not the
     * grid's, which is worse than null. */
    [Fact]
    public void The_open_figure_is_asked_in_currency_at_the_last_price()
    {
        TestPosition position = Long(unrealized: 12m, lastPrice: 21000.25);
        Account account = AccountFixture("SIM-1", connected: true);
        account.Strategies.Add(Strategy("1", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 0, position));
        Account.All.Add(account);

        _ = new NinjaTraderFacade().ReadStrategiesForSample().ToList();

        Assert.Equal(TestPerformanceUnit.Currency, position.AskedUnit);
        Assert.Equal(21000.25, position.AskedPrice);
    }

    [Fact]
    public void A_flat_position_is_zero_open_and_is_not_asked()
    {
        TestPosition flat = new() { MarketPosition = "Flat", Unrealized = 55m };
        Account account = AccountFixture("SIM-1", connected: true);
        account.Strategies.Add(Strategy("1", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 10, flat));
        Account.All.Add(account);

        StrategySampleCaptureSource row = Assert.Single(new NinjaTraderFacade().ReadStrategiesForSample());

        Assert.Equal(0m, row.UnrealizedPnl);
        Assert.Null(flat.AskedUnit);
    }

    /* NOT MEASURED IS NULL, HALF BY HALF. A strategy whose performance members do
     * not exist on this platform, or whose position has no price yet, keeps the
     * half that could be read. */
    [Fact]
    public void A_half_that_cannot_be_read_is_null_and_the_other_half_survives()
    {
        Account account = AccountFixture("SIM-1", connected: true);
        account.Strategies.Add(new BareStrategy
        {
            StrategyId = "1",
            Name = "0 - OGX-PF-2.4",
            State = "Realtime",
            Position = new TestPosition { MarketPosition = "Flat" },
        });
        account.Strategies.Add(Strategy("2", "1 - ALPHA-1.2", "NQ 12-26", "Realtime", 25,
            new TestPosition { MarketPosition = "Long", Unrealized = 5m, Instrument = null }));
        account.Strategies.Add(Strategy("3", "1 - ALPHA-1.2", "NQ 12-26", "Realtime", 25,
            new ThrowingPosition { MarketPosition = "Short" }));
        Account.All.Add(account);

        List<StrategySampleCaptureSource> rows = new NinjaTraderFacade().ReadStrategiesForSample().ToList();

        Assert.Null(rows[0].RealizedPnl);
        Assert.Equal(0m, rows[0].UnrealizedPnl);
        Assert.Equal(25m, rows[1].RealizedPnl);
        Assert.Null(rows[1].UnrealizedPnl);
        Assert.Equal(25m, rows[2].RealizedPnl);
        Assert.Null(rows[2].UnrealizedPnl);
    }

    // A stopped instance is reported with its state so the builder can drop it,
    // and its P&L is not read: that would be work on the dispatcher for a row
    // that is about to be thrown away.
    [Fact]
    public void A_stopped_instance_is_listed_but_its_pnl_is_not_read()
    {
        TestPosition position = Long(unrealized: 5m, lastPrice: 100);
        Account account = AccountFixture("SIM-1", connected: true);
        account.Strategies.Add(Strategy("1", "0 - OGX-PF-2.4", "MNQ 12-26", "Terminated", 10, position));
        Account.All.Add(account);

        StrategySampleCaptureSource row = Assert.Single(new NinjaTraderFacade().ReadStrategiesForSample());

        Assert.Equal("Terminated", row.State);
        Assert.Null(row.RealizedPnl);
        Assert.Null(position.AskedUnit);
    }

    /* PAST THE BUDGET, NUMBERS ARE LOST AND ROWS ARE NOT. */
    [Fact]
    public void Past_the_budget_every_row_keeps_its_identity_and_carries_null_pnl()
    {
        Account account = AccountFixture("SIM-1", connected: true);
        account.Strategies.Add(Strategy("1", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 10, Long(5m, 100)));
        account.Strategies.Add(Strategy("2", "1 - ALPHA-1.2", "NQ 12-26", "Realtime", 20, Long(6m, 100)));
        Account.All.Add(account);

        List<StrategySampleCaptureSource> rows = new NinjaTraderFacade(TimeSpan.Zero)
            .ReadStrategiesForSample().ToList();

        Assert.Equal(new[] { "1", "2" }, rows.Select(row => row.StrategyId));
        Assert.All(rows, row =>
        {
            Assert.Null(row.RealizedPnl);
            Assert.Null(row.UnrealizedPnl);
        });
    }

    // The same accounts as the account sample: platform fixtures dropped, a dark
    // account kept (the agent decides which accounts it reports on).
    [Fact]
    public void The_accounts_read_are_the_account_samples_accounts()
    {
        Account dark = AccountFixture("SIM-DARK", connected: false);
        dark.Strategies.Add(Strategy("1", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 1, Long(1m, 1)));
        Account playback = AccountFixture("Playback101", connected: true);
        playback.Strategies.Add(Strategy("2", "0 - OGX-PF-2.4", "MNQ 12-26", "Realtime", 1, Long(1m, 1)));
        Account.All.Add(dark);
        Account.All.Add(playback);

        StrategySampleCaptureSource row = Assert.Single(new NinjaTraderFacade().ReadStrategiesForSample());

        Assert.Equal("SIM-DARK", row.AccountName);
    }

    private static TestStrategy Strategy(
        string id,
        string name,
        string instrument,
        string state,
        double cumProfit,
        object position)
    {
        var strategy = new TestStrategy
        {
            StrategyId = id,
            Name = name,
            State = state,
            Position = position,
            SystemPerformance = new TestSystemPerformance(cumProfit),
        };
        strategy.Instruments.Add(new Instrument { FullName = instrument });
        return strategy;
    }

    private static TestPosition Long(decimal unrealized, double lastPrice) => new()
    {
        MarketPosition = "Long",
        Unrealized = unrealized,
        Instrument = new TestInstrument { MarketData = new TestMarketData { Last = new TestLast { Price = lastPrice } } },
    };

    private static TestPosition Long(double unrealized, double lastPrice) => Long((decimal)unrealized, lastPrice);

    private static Account AccountFixture(string name, bool connected) => new()
    {
        Name = name,
        DisplayName = name,
        ConnectionStatus = connected ? "Connected" : "Disconnected",
        Denomination = Currency.UsDollar,
        Connection = new Connection { Options = new ConnectionOptions { Name = "Live" } },
    };

    private sealed class TestStrategy : StrategyBase
    {
        public TestSystemPerformance SystemPerformance { get; set; }
    }

    // No SystemPerformance at all, the way a platform version without the member
    // would look to the reflection read.
    private sealed class BareStrategy : StrategyBase
    {
    }

    public sealed class TestSystemPerformance
    {
        public TestSystemPerformance(double cumProfit) =>
            RealTimeTrades = new TestTrades { TradesPerformance = new TestPerformance { Currency = new TestValues { CumProfit = cumProfit } } };

        public TestTrades RealTimeTrades { get; }
    }

    public sealed class TestTrades
    {
        public TestPerformance TradesPerformance { get; set; }
        public int Count { get; set; }
    }

    // A performance object whose trade count answers something that is not an int.
    private sealed class OddCountStrategy : StrategyBase
    {
        public OddPerformance SystemPerformance { get; } = new();
    }

    public sealed class OddPerformance
    {
        public OddTrades RealTimeTrades { get; } = new();
    }

    public sealed class OddTrades
    {
        public string Count => "four";
    }

    public sealed class TestPerformance
    {
        public TestValues Currency { get; set; }
    }

    public sealed class TestValues
    {
        public double CumProfit { get; set; }
    }

    public enum TestPerformanceUnit { Points, Ticks, Percent, Currency }

    public class TestPosition
    {
        public string MarketPosition { get; set; }
        public int Quantity { get; set; }
        public decimal Unrealized { get; set; }
        public TestInstrument Instrument { get; set; }
        public TestPerformanceUnit? AskedUnit { get; private set; }
        public double? AskedPrice { get; private set; }

        public virtual double GetUnrealizedProfitLoss(TestPerformanceUnit unit, double price)
        {
            AskedUnit = unit;
            AskedPrice = price;
            return unit == TestPerformanceUnit.Currency ? (double)Unrealized : 9999;
        }
    }

    public sealed class ThrowingPosition : TestPosition
    {
        public ThrowingPosition() =>
            Instrument = new TestInstrument { MarketData = new TestMarketData { Last = new TestLast { Price = 10 } } };

        public override double GetUnrealizedProfitLoss(TestPerformanceUnit unit, double price) =>
            throw new InvalidOperationException("position is being rebuilt");
    }

    // The platform's shape: MarketPosition is the NinjaTrader.Cbi enum, Quantity an int.
    public sealed class EnumPosition
    {
        public MarketPosition MarketPosition { get; set; }
        public int Quantity { get; set; }
    }

    // A quantity that is not an int at all.
    public sealed class OddQuantityPosition
    {
        public string MarketPosition { get; set; }
        public string Quantity => "two";
    }

    // A position whose word throws on read; its quantity is still readable.
    public sealed class ThrowingWordPosition
    {
        public string MarketPosition => throw new InvalidOperationException("position is being rebuilt");
        public int Quantity => 5;
    }

    public sealed class TestInstrument
    {
        public TestMarketData MarketData { get; set; }
    }

    public sealed class TestMarketData
    {
        public TestLast Last { get; set; }
    }

    public sealed class TestLast
    {
        public double Price { get; set; }
    }
}
