using System;
using System.Collections.Generic;
using System.Linq;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript;
using Vincere.AutoExport.Contracts;
using Vincere.AutoExport.NinjaTrader.Capture;
using Vincere.AutoExport.NinjaTrader.Core.Capture;
using Xunit;

namespace Vincere.AutoExport.NinjaTrader.Core.Tests;

/* THE TRACKER READING, AS FAR AS IT CAN BE TESTED OFF WINDOWS.
 *
 * NinjaTraderFacade is compiled INTO this test project against the stubs in
 * NinjaTraderApiStubs.cs, which is what lets the real production read be exercised
 * here rather than a copy of it. What cannot be tested here is everything in
 * VincereAutoExportAddOn - the dispatcher marshalling and the priority - because
 * that file only compiles on the self-hosted Windows runner with NinjaTrader
 * installed. No assertion in this file is about threading. */
[Collection(NinjaTraderAccountCollection.Name)]
public sealed class AccountSampleFacadeTests : IDisposable
{
    public AccountSampleFacadeTests() => Account.All.Clear();
    public void Dispose() => Account.All.Clear();

    /* THE DIFFERENCE BETWEEN THE TWO READS, STATED AS AN ASSERTION.
     *
     * The close drops a disconnected account - AccountRelevance.IsRelevant ends in
     * `return isConnected` - and for a money number that is right. The tracker must
     * keep it, because a dropped account is an ABSENT ROW, and an absent row is
     * what an unreachable machine and a collector too old to sample also look
     * like. Three situations, one observable, nothing recoverable downstream.
     *
     * This is the single most important test in the file: it is the trap that
     * would have destroyed the feature while looking like correct reuse, and it
     * fails the moment someone "tidies up" by routing the sample through
     * SnapshotAccounts(). */
    [Fact]
    public void The_sample_keeps_a_disconnected_account_that_the_close_drops()
    {
        Account live = AccountFixture("APEX-1111", connected: true);
        Account dark = AccountFixture("APEX-2222", connected: false);
        Account.All.Add(live);
        Account.All.Add(dark);
        var facade = new NinjaTraderFacade();

        // The close sees one account.
        Assert.Equal(new[] { "APEX-1111" }, facade.ReadAccounts().Select(row => row.AccountName));

        // The sample sees both, and says which is which.
        List<AccountSampleCaptureSource> sampled = new NinjaTraderFacade()
            .ReadAccountsForSample().ToList();
        Assert.Equal(new[] { "APEX-1111", "APEX-2222" }, sampled.Select(row => row.AccountName));
        Assert.True(sampled[0].Connected);
        Assert.False(sampled[1].Connected);
        // The platform's own word survives beside the boolean, for the tooltip.
        Assert.Equal("Connected", sampled[0].Status);
        Assert.Equal("Disconnected", sampled[1].Status);
    }

    // The platform's own fixtures still go, for the reason the close drops them:
    // they exist on every install whether or not anyone trades, and forwarding them
    // would raise "new account needs classification" for accounts nobody owns.
    [Theory]
    [InlineData("Backtest")]
    [InlineData("Playback101")]
    public void The_sample_still_drops_the_platforms_own_accounts(string name)
    {
        Account.All.Add(AccountFixture(name, connected: true));

        Assert.Empty(new NinjaTraderFacade().ReadAccountsForSample());
    }

    [Fact]
    public void The_sample_carries_the_money_the_traffic_light_needs_and_nothing_more()
    {
        Account account = AccountFixture("APEX-1111", connected: true);
        account.Set(AccountItem.RealizedProfitLoss, 125.50);
        account.Set(AccountItem.UnrealizedProfitLoss, -12.25);
        // Present on the account and deliberately NOT on the sample: the close
        // already stores every one of these.
        account.Set(AccountItem.NetLiquidation, 50_125.50);
        account.Set(AccountItem.CashValue, 49_000);
        account.Set(AccountItem.WeeklyProfitLoss, 171.54);
        account.Set(AccountItem.TrailingMaxDrawdown, 888.48);
        account.Set(AccountItem.BuyingPower, 200_000);
        Account.All.Add(account);

        AccountSampleCaptureSource row = Assert.Single(new NinjaTraderFacade().ReadAccountsForSample());

        Assert.Equal(125.50m, row.RealizedPnl);
        Assert.Equal(-12.25m, row.UnrealizedPnl);
        Assert.Equal(113.25m, row.TotalPnl);
        Assert.Equal("Live", row.ConnectionName);
        // The shape of the source type is the assertion that nothing else rides
        // along: there is nowhere on it to put net liquidation or the drawdown.
        Assert.Equal(
            new[]
            {
                "AccountName", "ConnectionName", "Connected", "Status",
                "RealizedPnl", "UnrealizedPnl", "TotalPnl", "StrategyStates",
            }.OrderBy(name => name, StringComparer.Ordinal),
            typeof(AccountSampleCaptureSource).GetProperties()
                .Select(property => property.Name)
                .OrderBy(name => name, StringComparer.Ordinal));
    }

    /* A TOTAL ONLY EXISTS WHEN BOTH HALVES DO. The same rule MapAccount keeps. An
     * account reporting no unrealized figure must not publish its realized figure
     * as the day's total: that is a confident number about something half of which
     * nobody measured, and it would be summed into a client's live total on a
     * briefing card. */
    [Fact]
    public void A_half_reported_account_carries_no_total()
    {
        Account account = AccountFixture("APEX-1111", connected: true);
        account.Set(AccountItem.RealizedProfitLoss, 125.50);
        Account.All.Add(account);

        AccountSampleCaptureSource row = Assert.Single(new NinjaTraderFacade().ReadAccountsForSample());

        Assert.Equal(125.50m, row.RealizedPnl);
        Assert.Null(row.UnrealizedPnl);
        Assert.Null(row.TotalPnl);
    }

    [Fact]
    public void The_sample_reads_each_strategys_state_and_nothing_else_about_it()
    {
        Account account = AccountFixture("APEX-1111", connected: true);
        account.Strategies.Add(new TestStrategy { Name = "Opening Range", State = "Realtime" });
        account.Strategies.Add(new TestStrategy { Name = "Mean Reversion", State = "Terminated" });
        Account.All.Add(account);

        AccountSampleCaptureSource row = Assert.Single(new NinjaTraderFacade().ReadAccountsForSample());

        Assert.Equal(new[] { "Realtime", "Terminated" }, row.StrategyStates);
    }

    /* AN ACCOUNT WITH NO STRATEGIES IS MEASURED, NOT UNMEASURED, on the wire.
     * Both render the same today, because the CRM's run_state rule folds
     * strategy_count = 0 into "unmeasured". That is the CRM's call; what this half
     * owes it is the truthful pair, so the distinction is there the day the rule
     * is refined. */
    [Fact]
    public void An_account_with_no_strategies_reports_an_empty_list_and_not_null()
    {
        Account.All.Add(AccountFixture("APEX-1111", connected: true));

        AccountSampleCaptureSource row = Assert.Single(new NinjaTraderFacade().ReadAccountsForSample());

        Assert.NotNull(row.StrategyStates);
        Assert.Empty(row.StrategyStates);
    }

    /* THE CLAIM THAT JUSTIFIES THE WHOLE SECOND COMMAND, MEASURED.
     *
     * The saving is NOT the response size. A real machine-day is around a hundred
     * orders - the 18,827 figure that gets quoted at this feature is seven MONTHS of
     * deep-export history on one VPS, and any argument built on bytes will not
     * survive someone checking. What the sample saves is work done on NinjaTrader's
     * own UI thread while the desk is trading:
     *
     *   * the per-account value walk, counted here. The close enumerates the entire
     *     AccountItem enum to build a dictionary the sample does not carry; the
     *     sample asks for the two figures the traffic light needs.
     *   * lock (account.Orders) and lock (account.Executions) - the two collections
     *     the trading path writes on every single fill - which the sample never
     *     takes, because it never reads either section.
     *   * the per-row TypeDescriptor walk in ReadExtraValues, which runs once per
     *     order and once per execution against a custom type descriptor answering
     *     platform code property by property.
     *
     * The repo's own written budget for the heavy read is one extra intraday
     * capture per trading day, never retried: "a convenience read must never be
     * able to disturb" a machine that is trading. Ten-minute sampling is about
     * thirty-nine of those a session, which is why this had to be a new command and
     * not a new schedule. */
    [Fact]
    public void The_sample_asks_the_platform_for_two_account_values_where_the_close_asks_for_thirty()
    {
        Account sampled = AccountFixture("APEX-1111", connected: true);
        Account closed = AccountFixture("APEX-1111", connected: true);

        Account.All.Add(sampled);
        _ = new NinjaTraderFacade().ReadAccountsForSample().ToList();
        Account.All.Clear();

        Account.All.Add(closed);
        _ = new NinjaTraderFacade().ReadAccounts().ToList();

        Assert.Equal(2, sampled.GetCalls);
        // The exact number is the stub's enum size and is not the point; that the
        // close asks an order of magnitude more times is.
        Assert.True(
            closed.GetCalls > sampled.GetCalls * 5,
            $"close asked {closed.GetCalls} times, sample asked {sampled.GetCalls}");
    }

    private static Account AccountFixture(string name, bool connected)
    {
        return new Account
        {
            Name = name,
            DisplayName = name,
            ConnectionStatus = connected ? "Connected" : "Disconnected",
            Denomination = Currency.UsDollar,
            Connection = new Connection { Options = new ConnectionOptions { Name = "Live" } },
        };
    }

    private sealed class TestStrategy : StrategyBase
    {
    }
}

public sealed class StrategyLiveCountTests
{
    /* NOT `enabled`, AND THIS IS THE TEST THAT SAYS WHY.
     *
     * NinjaTraderFacade.MapStrategy sets `Enabled = true` as a literal on every
     * strategy of every capture. A live count built on it would equal the total on
     * every account forever and the "running" light would be welded on. The State
     * word is a real reading, and two screens already decide that a strategy ran
     * by asking for exactly this word. */
    [Fact]
    public void Realtime_is_live_and_terminated_is_not()
    {
        StrategyLiveTally tally = StrategyLiveCount.Tally(
            new[] { "Realtime", "Terminated", "Realtime" });

        Assert.Equal(3, tally.Total);
        Assert.Equal(2, tally.Live);
    }

    // The step between the historical fill and real time, on a strategy the desk
    // has switched on. It is about to trade, so it counts.
    [Fact]
    public void Transition_counts_as_live()
    {
        Assert.Equal(1, StrategyLiveCount.Tally(new[] { "Transition" }).Live);
    }

    [Theory]
    [InlineData("SetDefaults")]
    [InlineData("Configure")]
    [InlineData("Active")]
    [InlineData("DataLoaded")]
    [InlineData("Historical")]
    [InlineData("Terminated")]
    [InlineData("Finalized")]
    public void Every_other_state_in_the_platforms_enum_is_known_and_not_live(string state)
    {
        StrategyLiveTally tally = StrategyLiveCount.Tally(new[] { state });

        // Known, so the account is still measured - the point being that an
        // unrecognised word is what makes it unmeasured, not merely a non-live one.
        Assert.Equal(1, tally.Total);
        Assert.Equal(0, tally.Live);
    }

    /* ONE WORD WE CANNOT PLACE AND THE WHOLE ACCOUNT GOES UNMEASURED.
     *
     * "None of these are live" would be the claim that the desk had switched
     * everything off, and `idle` and `unmeasured` lead to opposite actions - which
     * is the whole reason liveAccounts.js keeps them apart. All-or-nothing per
     * ACCOUNT rather than per strategy, because a count that silently omits the
     * rows it did not understand is a wrong number rather than a missing one. */
    [Fact]
    public void An_unrecognised_state_makes_the_whole_account_unmeasured()
    {
        StrategyLiveTally tally = StrategyLiveCount.Tally(
            new[] { "Realtime", "SomeFutureState", "Realtime" });

        Assert.Null(tally.Total);
        Assert.Null(tally.Live);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void A_strategy_with_no_state_is_a_state_we_cannot_place(string state)
    {
        Assert.Null(StrategyLiveCount.Tally(new[] { "Realtime", state }).Total);
    }

    /* ZERO IS A MEASUREMENT AND NULL IS NOT, and they must not be the same value.
     * "Nobody looked" and "nothing is on" lead to different actions. */
    [Fact]
    public void No_strategies_is_zero_of_zero_and_an_unreadable_collection_is_null()
    {
        StrategyLiveTally none = StrategyLiveCount.Tally(Array.Empty<string>());
        Assert.Equal(0, none.Total);
        Assert.Equal(0, none.Live);

        StrategyLiveTally unreadable = StrategyLiveCount.Tally(null);
        Assert.Null(unreadable.Total);
        Assert.Null(unreadable.Live);
    }

    // The words arrive as a ToString() from an assembly this one does not compile
    // against, across three NinjaTrader versions on the fleet.
    [Theory]
    [InlineData("realtime")]
    [InlineData("REALTIME")]
    [InlineData(" Realtime ")]
    public void The_state_word_is_matched_loosely_enough_to_survive_the_platform(string state)
    {
        Assert.Equal(1, StrategyLiveCount.Tally(new[] { state }).Live);
    }
}

public sealed class AccountSampleBuilderTests
{
    [Fact]
    public void Build_carries_the_sampling_clock_and_the_counted_strategies()
    {
        DateTimeOffset sampledAt = new(2026, 10, 5, 10, 15, 0, TimeSpan.FromHours(-4));
        var builder = new AccountSampleBuilder(new FakeSampleFacade(new AccountSampleCaptureSource
        {
            AccountName = "APEX-1111",
            ConnectionName = "Rithmic",
            Connected = true,
            Status = "Connected",
            RealizedPnl = 125.50m,
            UnrealizedPnl = -12.25m,
            TotalPnl = 113.25m,
            StrategyStates = new[] { "Realtime", "Terminated" },
        }));

        AccountSampleV1 sample = builder.Build(new AccountSampleBuildContext { SampledAt = sampledAt });

        Assert.Equal(1, sample.SchemaVersion);
        Assert.Equal(sampledAt, sample.SampledAt);
        AccountSampleRowV1 row = Assert.Single(sample.Accounts);
        Assert.Equal("APEX-1111", row.AccountName);
        Assert.True(row.Connected);
        Assert.Equal(2, row.StrategyCount);
        Assert.Equal(1, row.EnabledStrategyCount);
    }

    /* THE PAIR TRAVELS TOGETHER OR NOT AT ALL, which the CRM enforces with a CHECK
     * and refuses the whole report over. A total with no live count derives
     * `idle` - "the desk switched everything off" - about an account nobody
     * measured. */
    [Fact]
    public void An_unmeasured_account_sends_both_counts_as_null()
    {
        AccountSampleV1 sample = new AccountSampleBuilder(new FakeSampleFacade(
            new AccountSampleCaptureSource { AccountName = "APEX-1111", StrategyStates = null }))
            .Build(new AccountSampleBuildContext { SampledAt = DateTimeOffset.UtcNow });

        AccountSampleRowV1 row = Assert.Single(sample.Accounts);
        Assert.Null(row.StrategyCount);
        Assert.Null(row.EnabledStrategyCount);
    }

    [Fact]
    public void A_facade_that_answers_nothing_builds_an_empty_sample_rather_than_throwing()
    {
        AccountSampleV1 sample = new AccountSampleBuilder(new FakeSampleFacade(null))
            .Build(new AccountSampleBuildContext { SampledAt = DateTimeOffset.UtcNow });

        Assert.NotNull(sample.Accounts);
        Assert.Empty(sample.Accounts);
    }

    private sealed class FakeSampleFacade : IAccountSampleFacade
    {
        private readonly IEnumerable<AccountSampleCaptureSource> rows;

        public FakeSampleFacade(params AccountSampleCaptureSource[] rows)
        {
            this.rows = rows is { Length: 1 } && rows[0] is null ? null : rows;
        }

        public IEnumerable<AccountSampleCaptureSource> ReadAccountsForSample() => rows;
    }
}
