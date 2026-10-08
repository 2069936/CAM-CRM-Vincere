using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
using Vincere.AutoExport.Agent.Capture;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Diagnostics;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Service;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class AccountSampleLoopTests
{
    private static readonly Instant Now = Instant.FromUtc(2026, 10, 5, 14, 15);

    /* THE FIXTURE'S TWO CLOCKS ARE DELIBERATELY DIFFERENT INSTANTS, and that is
     * load-bearing rather than incidental. The first version of this test used
     * 10:15-04:00 against a loop clock of 14:15 UTC, which is the SAME moment: a
     * mutation that re-stamped the reading with the loop's own clock produced an
     * equal value and the test stayed green. Measured by mutation, not assumed.
     * The reading is now four minutes older than the post, which is also the real
     * case - delivery takes time - so a re-stamp changes the value and is caught. */
    [Fact]
    public async Task A_sample_is_read_and_posted_with_the_machines_own_clock_untouched()
    {
        DateTimeOffset sampledAt = new(2026, 10, 5, 10, 11, 0, TimeSpan.FromHours(-4));
        Assert.NotEqual(Now.ToDateTimeOffset(), sampledAt);
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(sampledAt, Row("APEX-1111", connected: true)));
        RecordingSampleCrm crm = new();
        Harness harness = new(pipe, crm);

        await harness.Loop.RunOnceAsync(CancellationToken.None);

        AccountSampleV1 posted = Assert.Single(crm.Posted);
        Assert.Equal(1, posted.SchemaVersion);
        /* THE CLOCK IS THE READING'S, NOT THE POST'S. Every staleness judgement on
         * every screen is made from this. Re-stamping it here - which would look
         * harmless - is what would let a reading delayed on its way arrive looking
         * fresh, and a tracker whose whole value is freshness would be lying in the
         * one way nobody could see. */
        Assert.Equal(sampledAt, posted.SampledAt);
        Assert.Equal("APEX-1111", Assert.Single(posted.Accounts).AccountName);
    }

    [Fact]
    public async Task An_unpaired_machine_never_disturbs_ninjatrader()
    {
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true)));
        Harness harness = new(pipe, new RecordingSampleCrm(), token: null);

        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(0, pipe.Calls);
        Assert.Equal("unpaired", harness.State.Snapshot().DeviceStatus);
        Assert.Empty(harness.Reporter.Codes);
    }

    /* AN OLD ADD-ON IS ASKED ONCE A DAY, NOT EVERY TEN MINUTES.
     *
     * This is most of the fleet for as long as it takes a person to visit each
     * machine with NinjaTrader closed, so getting it wrong is not an edge case - it
     * is the normal state of the rollout. Asking again on the next tick would open
     * a pipe to a trading terminal every ten minutes to be told the same thing, and
     * would write a log line each time. */
    [Fact]
    public async Task An_addon_too_old_to_sample_is_asked_once_and_then_left_alone_for_a_day()
    {
        FakeSampleClient pipe = FakeSampleClient.Returning(
            new AccountSampleAttempt(AccountSampleOutcome.Unsupported, null, "invalid_request"));
        Harness harness = new(pipe, new RecordingSampleCrm());

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        harness.Clock.Now = Now.Plus(Duration.FromHours(23));
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(1, pipe.Calls);
        // One INFO line, not an error: a machine whose add-on predates the tracker
        // is not faulty, and its daily close is unaffected.
        (string level, string code, string message) line = Assert.Single(harness.Logger.Entries);
        Assert.Equal("INFO", line.level);
        Assert.Equal("account_sample_addon_unsupported", line.code);
        Assert.Contains("daily close is unaffected", line.message, StringComparison.Ordinal);
        Assert.Empty(harness.Reporter.Codes);

        // And a day later it offers again, because an add-on does get replaced.
        harness.Clock.Now = Now.Plus(Duration.FromHours(25));
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(2, pipe.Calls);
        // Still one line: the repeat is not news.
        Assert.Single(harness.Logger.Entries);
    }

    [Fact]
    public async Task A_crm_without_the_route_is_offered_once_and_then_left_alone_for_a_day()
    {
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true)));
        RecordingSampleCrm crm = new()
        {
            Result = AccountSampleReportResult.Unsupported("account_sample_unsupported"),
        };
        Harness harness = new(pipe, crm);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        harness.Clock.Now = Now.Plus(Duration.FromHours(23));
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Single(crm.Posted);
        // The pipe is not opened either while the CRM cannot store the answer:
        // reading a trading terminal for a reply nobody will accept is pure cost.
        Assert.Equal(1, pipe.Calls);
        Assert.Equal("account_sample_unsupported", Assert.Single(harness.Logger.Entries).EventCode);
        Assert.Empty(harness.Reporter.Codes);
    }

    /* THE TWO SILENCES ARE SEPARATE TIMERS, because the fleet is in both states at
     * once and will be for weeks. Collapsing them into one would let a CRM deploy
     * sit unused behind an add-on's day of silence, or the reverse. */
    [Fact]
    public async Task The_addon_silence_and_the_crm_silence_do_not_share_a_timer()
    {
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true)));
        RecordingSampleCrm crm = new()
        {
            Result = AccountSampleReportResult.Unsupported("account_sample_unsupported"),
        };
        Harness harness = new(pipe, crm);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        // The CRM is now silent for a day. A day later the CRM has been deployed.
        harness.Clock.Now = Now.Plus(Duration.FromHours(25));
        crm.Result = new AccountSampleReportResult(AccountSampleReportStatus.Accepted, 900, null);
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(2, crm.Posted.Count);
        Assert.Equal(TimeSpan.FromSeconds(900), harness.Loop.Cadence);
    }

    [Fact]
    public async Task A_success_forgets_both_silences_so_a_fault_returning_is_reported_again()
    {
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true)));
        RecordingSampleCrm crm = new()
        {
            Result = AccountSampleReportResult.Unsupported("account_sample_unsupported"),
        };
        Harness harness = new(pipe, crm);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        harness.Clock.Now = Now.Plus(Duration.FromHours(25));
        crm.Result = new AccountSampleReportResult(AccountSampleReportStatus.Accepted, 600, null);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        // The CRM is rolled back. The next pass must offer immediately rather than
        // still be inside a silence it should have forgotten.
        crm.Result = AccountSampleReportResult.Unsupported("account_sample_unsupported");
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(3, crm.Posted.Count);
        Assert.Equal(2, harness.Logger.Entries.Count);
    }

    /* THE TRAP THIS LOOP WAS MOST LIKELY TO FALL INTO.
     *
     * CollectorState.RecordError feeds LastErrorCode straight onto the heartbeat,
     * and the fleet view paints a machine "Failed - the collector reported an
     * operational error" for any code it finds there. Both codes a tracker
     * naturally produces - a busy pipe, an unavailable add-on - are INSIDE the
     * heartbeat's accepted vocabulary, so they would be accepted, stored and
     * rendered. A CAM would be sent to look at a machine whose daily close is
     * perfect, because a dot on a convenience screen could not be read.
     *
     * So: the tracker owns its own status and never touches those fields. This
     * asserts it across every way a sample can fail. */
    [Theory]
    [InlineData(AccountSampleOutcome.Unavailable, "addon_unavailable")]
    [InlineData(AccountSampleOutcome.Unavailable, "capture_busy")]
    [InlineData(AccountSampleOutcome.Unavailable, "ninjatrader_not_running")]
    [InlineData(AccountSampleOutcome.Unsupported, "invalid_request")]
    public async Task No_tracker_failure_ever_reaches_the_heartbeats_error_fields(
        AccountSampleOutcome outcome,
        string code)
    {
        FakeSampleClient pipe = FakeSampleClient.Returning(new AccountSampleAttempt(outcome, null, code));
        Harness harness = new(pipe, new RecordingSampleCrm());

        await harness.Loop.RunOnceAsync(CancellationToken.None);

        CollectorStatusSnapshot status = harness.State.Snapshot();
        Assert.Null(status.LastErrorCode);
        Assert.Null(status.LastErrorMessage);
        // And it must not claim the add-on has gone, either: that is the field the
        // fleet view reads to say a machine's collector is broken, and a sample
        // colliding with the 16:30 close would otherwise report exactly that.
        Assert.Null(status.AddonAvailable);
    }

    [Fact]
    public async Task A_crm_refusal_never_reaches_the_heartbeats_error_fields_either()
    {
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true)));
        RecordingSampleCrm crm = new() { Result = AccountSampleReportResult.Failed("account_sample_timeout") };
        Harness harness = new(pipe, crm);

        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Null(harness.State.Snapshot().LastErrorCode);
        // It is written to this machine's own log, which is where a tracker fault
        // belongs: readable from a diagnostics bundle, invisible to the fleet view.
        Assert.Equal(new[] { "account_sample_timeout" }, harness.Reporter.Codes);
    }

    /* NOTHING PILES UP. One read and one post per pass, whatever happened, and a
     * failure leaves nothing behind to be caught up on. The interval is the only
     * thing that decides when the next attempt happens. */
    [Fact]
    public async Task A_failed_pass_retries_nothing_and_the_next_pass_starts_clean()
    {
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true)));
        RecordingSampleCrm crm = new() { Result = AccountSampleReportResult.Failed("account_sample_unreachable") };
        Harness harness = new(pipe, crm);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(3, pipe.Calls);
        Assert.Equal(3, crm.Posted.Count);
        // Reported on the change and then never again while it is the same fault.
        Assert.Equal(new[] { "account_sample_unreachable" }, harness.Reporter.Codes);
    }

    [Fact]
    public async Task A_pipe_that_throws_outright_costs_the_reading_and_nothing_else()
    {
        FakeSampleClient pipe = FakeSampleClient.Throwing(new InvalidOperationException("no dispatcher"));
        Harness harness = new(pipe, new RecordingSampleCrm());

        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "account_sample_failed" }, harness.Reporter.Codes);
        Assert.Null(harness.State.Snapshot().LastErrorCode);
        // The supervisor must not see this: an escaped exception costs the loop a
        // five-second penalty delay and a line it has already written itself.
        Assert.Equal("account-sample", Assert.Single(harness.Reporter.Loops));
    }

    /* LEFTOVERS DO NOT REACH THE CRM, BUT AN ACCOUNT THAT WENT DARK DOES.
     *
     * The add-on deliberately reports disconnected accounts - dropping them would
     * make a dark account an absent row, indistinguishable from an unreachable
     * machine. But a real machine carried 44 accounts where the grid showed 3, the
     * rest leftovers from connections that no longer exist, and forwarding those
     * would have the CRM count 41 accounts as needing attention on that client
     * forever. */
    [Fact]
    public async Task A_dark_account_is_reported_and_an_account_never_seen_working_is_not()
    {
        FakeSampleClient pipe = new();
        RecordingSampleCrm crm = new();
        Harness harness = new(pipe, crm);

        // Pass one: the real account is up; the leftover has never been seen up.
        pipe.Next = Sampled(Row("APEX-1111", connected: true), Row("DEMO5289161", connected: false));
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        // Pass two: the real account has gone dark.
        pipe.Next = Sampled(Row("APEX-1111", connected: false), Row("DEMO5289161", connected: false));
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "APEX-1111" }, crm.Posted[0].Accounts.Select(row => row.AccountName));
        AccountSampleRowV1 dark = Assert.Single(crm.Posted[1].Accounts);
        Assert.Equal("APEX-1111", dark.AccountName);
        Assert.False(dark.Connected);
    }

    [Fact]
    public async Task A_machine_with_nothing_to_say_says_nothing()
    {
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(Row("DEMO5289161", connected: false)));
        RecordingSampleCrm crm = new();
        Harness harness = new(pipe, crm);

        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Empty(crm.Posted);
        // Silent, not logged: an ordinary reason not to act is a return.
        Assert.Empty(harness.Reporter.Codes);
        Assert.Empty(harness.Logger.Entries);
    }

    /* ---------------------------------------------------------------------
     * The interval, which is the one thing here that can stop the service.
     * ------------------------------------------------------------------- */

    [Fact]
    public void The_interval_starts_at_ten_minutes_before_the_crm_has_said_anything()
    {
        Harness harness = new(new FakeSampleClient(), new RecordingSampleCrm());

        Assert.Equal(TimeSpan.FromMinutes(10), harness.Loop.Cadence);
    }

    [Fact]
    public async Task The_crm_can_retune_the_cadence_without_a_restart()
    {
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true)));
        RecordingSampleCrm crm = new()
        {
            Result = new AccountSampleReportResult(AccountSampleReportStatus.Accepted, 1800, null),
        };
        Harness harness = new(pipe, crm);

        await harness.Loop.RunOnceAsync(CancellationToken.None);

        // Worker re-reads Interval on every iteration, which is what makes a column
        // edited in the SQL editor take effect on a running service.
        Assert.Equal(TimeSpan.FromMinutes(30), harness.Loop.Cadence);
    }

    /* A NUMBER THAT ARRIVED OVER A NETWORK DECIDES HOW OFTEN A TRADING MACHINE IS
     * DISTURBED, so nothing out of range moves it. The floor is what matters: no
     * value the CRM can send makes this sample faster than every five minutes. */
    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(1)]
    [InlineData(299)]
    [InlineData(3601)]
    [InlineData(int.MaxValue)]
    [InlineData(int.MinValue)]
    public async Task An_interval_outside_the_tables_own_bounds_is_ignored_entirely(int seconds)
    {
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true)));
        RecordingSampleCrm crm = new()
        {
            Result = new AccountSampleReportResult(AccountSampleReportStatus.Accepted, seconds, null),
        };
        Harness harness = new(pipe, crm);

        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(TimeSpan.FromMinutes(10), harness.Loop.Cadence);
    }

    /* WHY THAT MATTERS MORE THAN IT LOOKS. Worker.SuperviseAsync hands Interval
     * straight to its delay, and a negative delay throws outside any catch; the
     * host's default behaviour for an unhandled exception in a BackgroundService is
     * to stop. A getter that returned zero or a negative would take down the
     * scheduler, the uploader and the heartbeat with it - and the heartbeat is the only thing that says a machine is
     * alive. Losing the fleet's traffic light in order to build one. Worker's own
     * constructor refuses a loop whose Interval is not positive, so this asserts
     * what that constructor demands, after every value the CRM might send. */
    [Fact]
    public async Task The_interval_is_always_something_the_supervisor_will_accept()
    {
        foreach (int seconds in new[] { int.MinValue, -1, 0, 1, 299, 300, 600, 3600, 3601, int.MaxValue })
        {
            FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true)));
            RecordingSampleCrm crm = new()
            {
                Result = new AccountSampleReportResult(AccountSampleReportStatus.Accepted, seconds, null),
            };
            Harness harness = new(pipe, crm);

            await harness.Loop.RunOnceAsync(CancellationToken.None);

            TimeSpan interval = harness.Loop.Interval;
            Assert.True(interval > TimeSpan.Zero, $"{seconds} produced {interval}");
            Assert.InRange(
                harness.Loop.Cadence,
                TimeSpan.FromSeconds(AccountSampleLoop.MinimumIntervalSeconds),
                TimeSpan.FromSeconds(AccountSampleLoop.MaximumIntervalSeconds));
            // The wait is to the next boundary, so never more than one cadence
            // plus the alignment slack.
            Assert.InRange(interval, TimeSpan.FromSeconds(1), harness.Loop.Cadence + TimeSpan.FromSeconds(5));

            // And the supervisor itself accepts it, which is the real contract.
            _ = new Worker(new[] { (ICollectorLoop)harness.Loop }, new ImmediateDelay(), harness.Reporter);
        }
    }

    /* THE GETTER IS SAFE WHATEVER THE FIELD HOLDS, WHICH IS A SEPARATE CLAIM FROM
     * THE ONE ABOVE AND HAS TO BE TESTED SEPARATELY.
     *
     * The loop guards the interval twice: StoreInterval refuses a value outside the
     * table's own bounds, and the getter clamps whatever it finds. Measured by
     * mutation: with StoreInterval intact, deleting the getter's clamp changes
     * nothing any test could see, because no input can reach the field out of
     * range. That makes the clamp untested defence-in-depth - a line a future
     * reader would be right to delete as dead, and whose deletion costs the entire
     * service the day somebody adds a second writer to that field.
     *
     * So the field is set directly here. The subject is the getter alone: given ANY
     * int, does it return something Worker will accept. Reflection is the right
     * tool for that question and the wrong tool for every other question in this
     * file. */
    [Theory]
    [InlineData(int.MinValue)]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(299)]
    [InlineData(3601)]
    [InlineData(int.MaxValue)]
    public void The_interval_getter_survives_a_field_no_validation_ever_touched(int seconds)
    {
        Harness harness = new(new FakeSampleClient(), new RecordingSampleCrm());
        FieldInfo field = typeof(AccountSampleLoop).GetField(
            "intervalSeconds",
            BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(field);
        field.SetValue(harness.Loop, seconds);

        TimeSpan interval = harness.Loop.Interval;

        Assert.InRange(
            harness.Loop.Cadence,
            TimeSpan.FromSeconds(AccountSampleLoop.MinimumIntervalSeconds),
            TimeSpan.FromSeconds(AccountSampleLoop.MaximumIntervalSeconds));
        Assert.InRange(
            interval,
            TimeSpan.FromSeconds(1),
            TimeSpan.FromSeconds(AccountSampleLoop.MaximumIntervalSeconds + 5));
        // Worker's constructor is the contract that matters: it refuses a loop whose
        // Interval is not positive, and an Interval that threw or went negative at
        // runtime would stop the host and take the heartbeat down with it.
        _ = new Worker(new[] { (ICollectorLoop)harness.Loop }, new ImmediateDelay(), harness.Reporter);
    }

    /* ---------------------------------------------------------------------
     * The wiring, which is the bug this repo has already paid for once, is in
     * AgentCompositionTests.
     *
     * It used to be three Assert.Contains calls against the text of Program.cs,
     * and a comment satisfies an Assert.Contains: the registration was commented
     * out with the asserted string left on the line, the account tracker was
     * registered on no machine, and 344 of 344 tests passed. The question is
     * whether the supervisor the host starts HOLDS the loop, which is a question
     * about a built container. AgentComposition.Register exists so that a test can
     * build one, and AgentCompositionTests builds it, resolves the Worker and asks
     * it which loops it is going to run.
     * ------------------------------------------------------------------- */

    /* ---------------------------------------------------------------------
     * The per strategy reading, which rides this loop's tick and must never cost
     * the account rows anything.
     * ------------------------------------------------------------------- */

    private static readonly DateTimeOffset StrategyClock = new(2026, 10, 5, 10, 10, 2, TimeSpan.FromHours(-4));

    [Fact]
    public async Task The_strategies_are_read_and_posted_after_the_accounts_are_posted()
    {
        RecordingSampleCrm crm = new();
        FakeStrategyClient strategies = new() { Next = () => Strategies(StrategyRow("APEX-1111", "1")) };
        Harness harness = new(FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true))), crm, strategies: strategies);

        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "accounts-pipe", "accounts-post", "strategies-pipe", "strategies-post" }, harness.Calls);
        StrategySampleV1 posted = Assert.Single(crm.StrategyPosted);
        Assert.Equal(1, posted.SchemaVersion);
        // The add-on's clock, untouched: the CRM files the reading under the cycle
        // this falls in, so a re-stamp would move it to another cycle.
        Assert.Equal(StrategyClock, posted.SampledAt);
        StrategySampleRowV1 row = Assert.Single(posted.Strategies);
        Assert.Equal(-412.5m, row.RealizedPnl);
        Assert.Equal(37.5m, row.UnrealizedPnl);
        Assert.Equal("0 - OGX-PF-2.4", row.StrategyName);
        Assert.Equal("MNQ 12-26", row.Instrument);
        Assert.Empty(harness.Reporter.Codes);
    }

    /* THE STRATEGY HALF THROWING COSTS THE STRATEGIES AND NOTHING ELSE. The account
     * post has happened once, nothing reaches the supervisor (which would rerun the
     * whole tick in five seconds and post the accounts again), and the account
     * half's log memory is untouched: the same account fault on the next tick is
     * still a repeat and is not written again. */
    [Fact]
    public async Task A_strategy_client_that_throws_leaves_the_account_half_exactly_as_it_was()
    {
        RecordingSampleCrm crm = new() { Result = AccountSampleReportResult.Failed("account_sample_timeout") };
        FakeStrategyClient strategies = new() { Next = () => throw new InvalidOperationException("pipe broke") };
        Harness harness = new(FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true))), crm, strategies: strategies);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(2, crm.Posted.Count);
        Assert.Equal(new[] { "account_sample_timeout", "strategy_sample_failed" }, harness.Reporter.Codes);
        Assert.DoesNotContain("account_sample_failed", harness.Reporter.Codes);
        Assert.Null(harness.State.Snapshot().LastErrorCode);
    }

    [Fact]
    public async Task A_strategy_post_that_throws_is_caught_the_same_way()
    {
        RecordingSampleCrm crm = new() { StrategyFailure = new StrategyPostExploded() };
        FakeStrategyClient strategies = new() { Next = () => Strategies(StrategyRow("APEX-1111", "1")) };
        Harness harness = new(FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true))), crm, strategies: strategies);

        Exception escaped = await Record.ExceptionAsync(() => harness.Loop.RunOnceAsync(CancellationToken.None));

        Assert.Null(escaped);
        Assert.Single(crm.Posted);
        Assert.Equal(new[] { "strategy_sample_failed" }, harness.Reporter.Codes);
    }

    /* A CRM WITHOUT THE ROUTE, OR WITHOUT MIGRATION 57, SILENCES THE STRATEGIES FOR
     * AN HOUR AND THE ACCOUNTS NOT AT ALL. Reusing the account silence here would
     * cost the tracker a day of account rows for a feature that is not deployed. */
    [Fact]
    public async Task A_strategies_404_silences_only_the_strategies_and_only_for_an_hour()
    {
        RecordingSampleCrm crm = new() { StrategyResult = StrategySampleReportResult.Unsupported("strategy_sample_unsupported") };
        FakeStrategyClient strategies = new() { Next = () => Strategies(StrategyRow("APEX-1111", "1")) };
        Harness harness = new(FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true))), crm, strategies: strategies);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        harness.Clock.Now = Now.Plus(Duration.FromMinutes(10));
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        harness.Clock.Now = Now.Plus(Duration.FromMinutes(50));
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        // The accounts went out on every tick.
        Assert.Equal(3, crm.Posted.Count);
        // The strategies were asked once in the hour.
        Assert.Equal(1, strategies.Calls);
        Assert.Single(crm.StrategyPosted);
        (string level, string code, string message) line = Assert.Single(harness.Logger.Entries);
        Assert.Equal("INFO", line.level);
        Assert.Equal("strategy_sample_unsupported", line.code);
        Assert.Empty(harness.Reporter.Codes);

        // An hour on, they are offered again, so applying 57 shows the same day.
        harness.Clock.Now = Now.Plus(Duration.FromMinutes(61));
        crm.StrategyResult = StrategySampleReportResult.Accepted();
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(4, crm.Posted.Count);
        Assert.Equal(2, crm.StrategyPosted.Count);
        Assert.Equal(TimeSpan.FromHours(1), AccountSampleLoop.StrategyCrmUnsupportedBackoff);
    }

    /* AN ADD-ON OLDER THAN 1.2.0 IS ASKED FOR STRATEGIES ONCE A DAY, AND KEEPS
     * ANSWERING FOR ACCOUNTS EVERY TICK. */
    [Fact]
    public async Task An_addon_too_old_for_strategies_keeps_sampling_accounts()
    {
        RecordingSampleCrm crm = new();
        FakeStrategyClient strategies = new()
        {
            Next = () => new StrategySampleAttempt(StrategySampleOutcome.Unsupported, null, "invalid_request"),
        };
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true)));
        Harness harness = new(pipe, crm, strategies: strategies);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        harness.Clock.Now = Now.Plus(Duration.FromHours(23));
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(2, pipe.Calls);
        Assert.Equal(2, crm.Posted.Count);
        Assert.Equal(1, strategies.Calls);
        (string level, string code, string message) line = Assert.Single(harness.Logger.Entries);
        Assert.Equal("strategy_sample_addon_unsupported", line.code);
        Assert.Contains("account tracker is unaffected", line.message, StringComparison.Ordinal);

        harness.Clock.Now = Now.Plus(Duration.FromHours(25));
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(2, strategies.Calls);
    }

    /* ONLY THE CONNECTED ACCOUNTS THIS TICK REPORTS. A dark account's strategies,
     * and strategies on an account the tracker does not report at all, stay home. */
    [Fact]
    public async Task Only_strategies_on_connected_reported_accounts_are_posted()
    {
        RecordingSampleCrm crm = new();
        FakeStrategyClient strategies = new()
        {
            Next = () => Strategies(
                StrategyRow("APEX-1111", "1"),
                StrategyRow("APEX-2222", "2"),
                StrategyRow("DEMO5289161", "3"),
                StrategyRow("apex-1111 ", "4")),
        };
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(
            Row("APEX-1111", connected: true),
            Row("APEX-2222", connected: true),
            Row("DEMO5289161", connected: false)));
        Harness harness = new(pipe, crm, strategies: strategies);
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        // APEX-2222 goes dark: it is still reported as an account, but its
        // strategies are not compared.
        pipe.Next = Sampled(
            Row("APEX-1111", connected: true),
            Row("APEX-2222", connected: false),
            Row("DEMO5289161", connected: false));
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "1", "2", "4" }, crm.StrategyPosted[0].Strategies.Select(row => row.StrategyId));
        Assert.Equal(new[] { "1", "4" }, crm.StrategyPosted[1].Strategies.Select(row => row.StrategyId));
    }

    [Fact]
    public async Task No_connected_account_or_no_account_reading_means_no_strategy_reading()
    {
        RecordingSampleCrm crm = new();
        FakeStrategyClient strategies = new() { Next = () => Strategies(StrategyRow("APEX-1111", "1")) };
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true)));
        Harness harness = new(pipe, crm, strategies: strategies);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(1, strategies.Calls);

        pipe.Next = Sampled(Row("APEX-1111", connected: false));
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        pipe.Next = new AccountSampleAttempt(AccountSampleOutcome.Unavailable, null, "capture_busy");
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(1, strategies.Calls);
        Assert.Single(crm.StrategyPosted);
    }

    /* THE RESTART TIME IS FILLED BY THE AGENT. Live, missing from one successful
     * reading, live again: the row carries the time of the reading it came back in. */
    [Fact]
    public async Task A_strategy_that_went_away_and_came_back_is_posted_with_its_restart_time()
    {
        RecordingSampleCrm crm = new();
        DateTimeOffset clock = StrategyClock;
        bool present = true;
        FakeStrategyClient strategies = new()
        {
            Next = () => present
                ? Strategies(clock, StrategyRow("APEX-1111", "1"), StrategyRow("APEX-1111", "2"))
                : Strategies(clock, StrategyRow("APEX-1111", "2")),
        };
        Harness harness = new(FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true))), crm, strategies: strategies);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        present = false;
        clock = StrategyClock.AddMinutes(10);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        present = true;
        clock = StrategyClock.AddMinutes(20);
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.All(crm.StrategyPosted[0].Strategies, row => Assert.Null(row.RestartedAt));
        StrategySampleRowV1[] third = crm.StrategyPosted[2].Strategies.ToArray();
        Assert.Equal(StrategyClock.AddMinutes(20), third.Single(row => row.StrategyId == "1").RestartedAt);
        Assert.Null(third.Single(row => row.StrategyId == "2").RestartedAt);
    }

    /* THE TOGGLE NO ABSENCE SHOWS. A disable and enable inside one cycle leaves the
     * instance live in both readings; the add-on's run count going from 4 to 0 is
     * what tells the agent, and the CRM gets the restart time. The count itself is
     * the add-on talking to the agent and never travels to the CRM. */
    [Fact]
    public async Task A_toggle_between_two_readings_is_posted_as_a_restart_and_the_count_stays_behind()
    {
        RecordingSampleCrm crm = new();
        DateTimeOffset clock = StrategyClock;
        int trades = 4;
        FakeStrategyClient strategies = new()
        {
            Next = () => Strategies(clock, Counted(StrategyRow("APEX-1111", "1"), trades), Counted(StrategyRow("APEX-1111", "2"), 1)),
        };
        Harness harness = new(FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true))), crm, strategies: strategies);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        trades = 0;
        clock = StrategyClock.AddMinutes(10);
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.All(crm.StrategyPosted[0].Strategies, row => Assert.Null(row.RestartedAt));
        StrategySampleRowV1[] second = crm.StrategyPosted[1].Strategies.ToArray();
        Assert.Equal(StrategyClock.AddMinutes(10), second.Single(row => row.StrategyId == "1").RestartedAt);
        Assert.Null(second.Single(row => row.StrategyId == "2").RestartedAt);
        Assert.All(
            crm.StrategyPosted.SelectMany(sample => sample.Strategies),
            row => Assert.Null(row.RealtimeTradeCount));
        // The same number the restart detection read, under the wire's own name:
        // 4 trades before the toggle, 0 after it, the way the CRM will show it.
        Assert.Equal(4, crm.StrategyPosted[0].Strategies.Single(row => row.StrategyId == "1").TradesThisRun);
        Assert.Equal(0, second.Single(row => row.StrategyId == "1").TradesThisRun);
        Assert.Equal(1, second.Single(row => row.StrategyId == "2").TradesThisRun);
    }

    /* THE POSITION TRAVELS AS READ. The desk asks in the team chat whether
     * BulletBot fired long or short; the add-on reads it off the strategy's
     * Position and the agent passes it through untouched, with the run's trade
     * count beside it. An add-on that could not read the position (or a 1.2.0
     * add-on, which never sends one) leaves null, and null is what is posted:
     * never "flat", never zero. */
    [Fact]
    public async Task The_position_and_the_run_count_are_posted_as_read_and_null_stays_null()
    {
        RecordingSampleCrm crm = new();
        FakeStrategyClient strategies = new()
        {
            Next = () => Strategies(
                Positioned(Counted(StrategyRow("APEX-1111", "1"), 7), "long", 2),
                Positioned(Counted(StrategyRow("APEX-1111", "2"), 0), "flat", 0),
                Positioned(Counted(StrategyRow("APEX-1111", "3"), null), null, null),
                Positioned(Counted(StrategyRow("APEX-1111", "4"), 3), "short", null)),
        };
        Harness harness = new(FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true))), crm, strategies: strategies);

        await harness.Loop.RunOnceAsync(CancellationToken.None);

        StrategySampleRowV1[] posted = Assert.Single(crm.StrategyPosted).Strategies.ToArray();
        Assert.Equal(4, posted.Length);
        Assert.Equal(("long", (int?)2, (int?)7), Triple(posted[0]));
        Assert.Equal(("flat", (int?)0, (int?)0), Triple(posted[1]));
        Assert.Equal(((string)null, (int?)null, (int?)null), Triple(posted[2]));
        Assert.Equal(("short", (int?)null, (int?)3), Triple(posted[3]));
        Assert.All(posted, row => Assert.Null(row.RealtimeTradeCount));
        Assert.Empty(harness.Reporter.Codes);
    }

    private static (string, int?, int?) Triple(StrategySampleRowV1 row) =>
        (row.MarketPosition, row.PositionQuantity, row.TradesThisRun);

    /* A RE-ENABLE WHILE THE STRATEGY PART WAS NOT READING. The accounts failed to
     * read for a while, so no strategy reading was taken; the strategy was switched
     * off and on in that gap. Absence never had a chance to show it, but the count
     * is still lower when readings resume. */
    [Fact]
    public async Task A_restart_during_a_gap_in_readings_is_seen_when_they_resume()
    {
        RecordingSampleCrm crm = new();
        DateTimeOffset clock = StrategyClock;
        int trades = 3;
        FakeStrategyClient strategies = new()
        {
            Next = () => Strategies(clock, Counted(StrategyRow("APEX-1111", "1"), trades)),
        };
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true)));
        Harness harness = new(pipe, crm, strategies: strategies);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        pipe.Next = new AccountSampleAttempt(AccountSampleOutcome.Unavailable, null, "capture_busy");
        clock = StrategyClock.AddMinutes(10);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        pipe.Next = Sampled(Row("APEX-1111", connected: true));
        trades = 1;
        clock = StrategyClock.AddMinutes(20);
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(2, strategies.Calls);
        Assert.Equal(StrategyClock.AddMinutes(20), Assert.Single(crm.StrategyPosted[1].Strategies).RestartedAt);
    }

    /* A FAILED STRATEGY READING IS NOT AN ABSENCE. A busy pipe between two readings
     * that both hold the instance must not flag it as restarted. */
    [Fact]
    public async Task A_failed_strategy_reading_in_between_does_not_make_a_restart()
    {
        RecordingSampleCrm crm = new();
        DateTimeOffset clock = StrategyClock;
        bool fail = false;
        FakeStrategyClient strategies = new()
        {
            Next = () => fail
                ? new StrategySampleAttempt(StrategySampleOutcome.Unavailable, null, "capture_busy")
                : Strategies(clock, StrategyRow("APEX-1111", "1")),
        };
        Harness harness = new(FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true))), crm, strategies: strategies);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        fail = true;
        clock = StrategyClock.AddMinutes(10);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        fail = false;
        clock = StrategyClock.AddMinutes(20);
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Null(Assert.Single(crm.StrategyPosted[1].Strategies).RestartedAt);
        // And the failure was reported under a strategy code.
        Assert.Equal(new[] { "strategy_capture_busy" }, harness.Reporter.Codes);
    }

    /* A CONNECTION THAT DROPS FOR ONE READING IS NOT A RESTART. NinjaTrader keeps
     * the instance and its figure across a dropped connection, so presence is
     * judged from everything the add-on reported, before the connected filter.
     * Judged after it, every strategy on that account would come back flagged as
     * restarted and drop out of the comparison for the rest of the day. */
    [Fact]
    public async Task A_strategy_on_an_account_that_dropped_its_connection_for_a_reading_has_not_restarted()
    {
        RecordingSampleCrm crm = new();
        DateTimeOffset clock = StrategyClock;
        FakeStrategyClient strategies = new()
        {
            Next = () => Strategies(clock, StrategyRow("APEX-1111", "1"), StrategyRow("APEX-2222", "2")),
        };
        FakeSampleClient pipe = FakeSampleClient.Returning(Sampled(
            Row("APEX-1111", connected: true),
            Row("APEX-2222", connected: true)));
        Harness harness = new(pipe, crm, strategies: strategies);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        pipe.Next = Sampled(Row("APEX-1111", connected: true), Row("APEX-2222", connected: false));
        clock = StrategyClock.AddMinutes(10);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        pipe.Next = Sampled(Row("APEX-1111", connected: true), Row("APEX-2222", connected: true));
        clock = StrategyClock.AddMinutes(20);
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        StrategySampleRowV1 back = crm.StrategyPosted[2].Strategies.Single(row => row.StrategyId == "2");
        Assert.Null(back.RestartedAt);
    }

    [Fact]
    public async Task More_strategy_rows_than_the_route_takes_are_not_posted_and_the_accounts_still_are()
    {
        RecordingSampleCrm crm = new();
        StrategySampleRowV1[] many = Enumerable.Range(0, AccountSampleLoop.MaximumStrategyRows + 1)
            .Select(i => StrategyRow("APEX-1111", i.ToString(System.Globalization.CultureInfo.InvariantCulture)))
            .ToArray();
        StrategySampleRowV1[] exactly = many.Take(AccountSampleLoop.MaximumStrategyRows).ToArray();
        bool tooMany = true;
        FakeStrategyClient strategies = new() { Next = () => Strategies(tooMany ? many : exactly) };
        Harness harness = new(FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true))), crm, strategies: strategies);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        tooMany = false;
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(2, crm.Posted.Count);
        Assert.Equal(AccountSampleLoop.MaximumStrategyRows, Assert.Single(crm.StrategyPosted).Strategies.Count);
        Assert.Equal(new[] { "strategy_sample_too_large" }, harness.Reporter.Codes);
    }

    [Fact]
    public async Task A_refused_strategy_post_is_reported_under_its_own_code_with_the_crms_word()
    {
        RecordingSampleCrm crm = new()
        {
            StrategyResult = StrategySampleReportResult.Failed("strategy_sample_http_400", "invalid_strategy_sample"),
        };
        FakeStrategyClient strategies = new() { Next = () => Strategies(StrategyRow("APEX-1111", "1")) };
        Harness harness = new(FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true))), crm, strategies: strategies);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        // Tried again next tick, no backoff, written once.
        Assert.Equal(2, crm.StrategyPosted.Count);
        Assert.Equal(new[] { "strategy_sample_http_400" }, harness.Reporter.Codes);
        Assert.Equal("The CRM answered: invalid_strategy_sample", Assert.Single(harness.Logger.Entries).Message);
    }

    /* ---------------------------------------------------------------------
     * The aligned wait. Every machine wakes two seconds after the same UTC
     * boundaries, so desk and client are read in the same cycle.
     * ------------------------------------------------------------------- */

    [Fact]
    public void The_wait_runs_to_two_seconds_after_the_next_boundary()
    {
        Harness harness = new(new FakeSampleClient(), new RecordingSampleCrm());
        // 10:13:27 in New York, 14:13:27 UTC, with the default ten minutes.
        harness.Clock.Now = Instant.FromUtc(2026, 10, 5, 14, 13, 27);

        // 10:20:00 is 6 min 33 s away, plus the 2 s lead.
        Assert.Equal(TimeSpan.FromMinutes(6) + TimeSpan.FromSeconds(33 + 2), harness.Loop.Interval);
    }

    // Exactly on a boundary, the next boundary is the next one, not this one.
    [Fact]
    public void Exactly_on_a_boundary_the_wait_is_a_whole_cycle_and_never_zero()
    {
        Harness harness = new(new FakeSampleClient(), new RecordingSampleCrm());
        harness.Clock.Now = Instant.FromUtc(2026, 10, 5, 14, 20, 0);

        Assert.Equal(TimeSpan.FromSeconds(600 + 2), harness.Loop.Interval);
    }

    /* THE GRID IS UTC SECONDS, SO EVERY MACHINE AGREES FOR ANY INTERVAL. Three
     * readings taken at different moments inside one cycle all wake for the same
     * next boundary, and a retuned cadence aligns to its own grid. */
    [Fact]
    public async Task Machines_reading_anywhere_in_a_cycle_wake_at_the_same_moment()
    {
        Harness harness = new(new FakeSampleClient(), new RecordingSampleCrm());
        Instant[] moments =
        {
            Instant.FromUtc(2026, 10, 5, 14, 10, 3),
            Instant.FromUtc(2026, 10, 5, 14, 14, 59),
            Instant.FromUtc(2026, 10, 5, 14, 19, 59),
        };

        foreach (Instant moment in moments)
        {
            harness.Clock.Now = moment;
            Assert.Equal(Instant.FromUtc(2026, 10, 5, 14, 20, 2), moment.Plus(Duration.FromTimeSpan(harness.Loop.Interval)));
        }

        RecordingSampleCrm crm = new() { Result = new AccountSampleReportResult(AccountSampleReportStatus.Accepted, 300, null) };
        Harness retuned = new(FakeSampleClient.Returning(Sampled(Row("APEX-1111", connected: true))), crm);
        await retuned.Loop.RunOnceAsync(CancellationToken.None);
        retuned.Clock.Now = Instant.FromUtc(2026, 10, 5, 14, 13, 27);
        Assert.Equal(Instant.FromUtc(2026, 10, 5, 14, 15, 2), retuned.Clock.Now.Plus(Duration.FromTimeSpan(retuned.Loop.Interval)));
    }

    [Fact]
    public void A_clock_that_throws_still_leaves_a_wait_the_supervisor_accepts()
    {
        AccountSampleLoop loop = new(
            new FakeSampleClient(),
            new RecordingSampleCrm(),
            new FixedTokenStore("t"),
            new ThrowingClock(),
            new CollectorState(),
            new LiveAccountMemory(),
            new RecordingSampleReporter(),
            new RecordingSampleLogger(),
            new FakeStrategyClient(),
            new StrategyRunMemory());

        Assert.Equal(TimeSpan.FromSeconds(AccountSampleLoop.DefaultIntervalSeconds), loop.Interval);
    }

    private static StrategySampleRowV1 StrategyRow(string account, string id) => new()
    {
        AccountName = account,
        StrategyId = id,
        StrategyName = "0 - OGX-PF-2.4",
        Instrument = "MNQ 12-26",
        RealizedPnl = -412.5m,
        UnrealizedPnl = 37.5m,
    };

    private static StrategySampleRowV1 Counted(StrategySampleRowV1 row, int? realtimeTradeCount)
    {
        row.RealtimeTradeCount = realtimeTradeCount;
        return row;
    }

    private static StrategySampleRowV1 Positioned(StrategySampleRowV1 row, string marketPosition, int? quantity)
    {
        row.MarketPosition = marketPosition;
        row.PositionQuantity = quantity;
        return row;
    }

    internal static StrategySampleAttempt Strategies(params StrategySampleRowV1[] rows) =>
        Strategies(StrategyClock, rows);

    private static StrategySampleAttempt Strategies(DateTimeOffset sampledAt, params StrategySampleRowV1[] rows) =>
        new(
            StrategySampleOutcome.Sampled,
            new StrategySampleV1 { SchemaVersion = 1, SampledAt = sampledAt, Strategies = rows.ToList() },
            null);

    internal sealed class ThrowingClock : ICollectorClock
    {
        public Instant GetCurrentInstant() => throw new InvalidOperationException("clock unavailable");
        public DateTimeOffset GetCurrentDateTimeOffset() => throw new InvalidOperationException("clock unavailable");
    }

    private sealed class StrategyPostExploded : Exception
    {
    }

    /* ---------------------------------------------------------------------
     * Fixtures.
     * ------------------------------------------------------------------- */

    private static AccountSampleAttempt Sampled(params AccountSampleRowV1[] rows) =>
        Sampled(new DateTimeOffset(2026, 10, 5, 10, 15, 0, TimeSpan.FromHours(-4)), rows);

    private static AccountSampleAttempt Sampled(DateTimeOffset sampledAt, params AccountSampleRowV1[] rows)
    {
        return new AccountSampleAttempt(
            AccountSampleOutcome.Sampled,
            new AccountSampleV1
            {
                SchemaVersion = 1,
                SampledAt = sampledAt,
                Accounts = rows.ToList(),
            },
            null);
    }

    private static AccountSampleRowV1 Row(string name, bool connected) => new()
    {
        AccountName = name,
        Connected = connected,
        Status = connected ? "Connected" : "Disconnected",
        StrategyCount = 2,
        EnabledStrategyCount = connected ? 1 : 0,
    };

    internal sealed class Harness
    {
        public Harness(
            FakeSampleClient pipe,
            RecordingSampleCrm crm,
            string token = "a-device-token",
            FakeStrategyClient strategies = null)
        {
            Clock = new SettableClock(Now);
            State = new CollectorState();
            Reporter = new RecordingSampleReporter();
            Logger = new RecordingSampleLogger();
            // The strategy half answers "unavailable" by default, which is what an
            // account-only test would see from a busy pipe: no post, one strategy
            // line, and nothing about the accounts.
            Strategies = strategies ?? new FakeStrategyClient();
            pipe.Log = Calls;
            crm.Calls = Calls;
            Strategies.Log = Calls;
            Loop = new AccountSampleLoop(
                pipe,
                crm,
                new FixedTokenStore(token),
                Clock,
                State,
                new LiveAccountMemory(),
                Reporter,
                Logger,
                Strategies,
                new StrategyRunMemory());
        }

        public FakeStrategyClient Strategies { get; }
        public List<string> Calls { get; } = new();
        public AccountSampleLoop Loop { get; }
        public SettableClock Clock { get; }
        public CollectorState State { get; }
        public RecordingSampleReporter Reporter { get; }
        public RecordingSampleLogger Logger { get; }
    }

    internal sealed class FakeStrategyClient : INinjaTraderStrategySampleClient
    {
        // An add-on with nothing live: a successful reading of no strategies, which
        // posts nothing and reports nothing, so a test about accounts sees only
        // accounts.
        public Func<StrategySampleAttempt> Next { get; set; } = () => Strategies();

        public int Calls { get; private set; }
        public List<string> Log { get; set; }

        public Task<StrategySampleAttempt> SampleStrategiesAsync(CancellationToken cancellationToken = default)
        {
            Calls++;
            Log?.Add("strategies-pipe");
            return Task.FromResult(Next());
        }
    }

    internal sealed class FakeSampleClient : INinjaTraderAccountSampleClient
    {
        private Exception failure;

        public AccountSampleAttempt Next { get; set; } =
            new(AccountSampleOutcome.Unavailable, null, "addon_unavailable");

        public int Calls { get; private set; }
        public List<string> Log { get; set; }

        public static FakeSampleClient Returning(AccountSampleAttempt attempt) => new() { Next = attempt };

        public static FakeSampleClient Throwing(Exception exception) => new() { failure = exception };

        public Task<AccountSampleAttempt> SampleAccountsAsync(CancellationToken cancellationToken = default)
        {
            Calls++;
            Log?.Add("accounts-pipe");
            if (failure != null) throw failure;
            return Task.FromResult(Next);
        }
    }

    internal sealed class RecordingSampleCrm : ICollectorCrmClient
    {
        public List<AccountSampleV1> Posted { get; } = new();

        public AccountSampleReportResult Result { get; set; } =
            new(AccountSampleReportStatus.Accepted, null, null);

        public Task<AccountSampleReportResult> PostAccountSampleAsync(
            AccountSampleV1 sample,
            CancellationToken cancellationToken = default)
        {
            Calls.Add("accounts-post");
            Posted.Add(sample);
            return Task.FromResult(Result);
        }

        public List<string> Calls { get; set; } = new();
        public List<StrategySampleV1> StrategyPosted { get; } = new();

        public StrategySampleReportResult StrategyResult { get; set; } = StrategySampleReportResult.Accepted();

        public Exception StrategyFailure { get; set; }

        public Task<StrategySampleReportResult> PostStrategySampleAsync(
            StrategySampleV1 sample,
            CancellationToken cancellationToken = default)
        {
            Calls.Add("strategies-post");
            StrategyPosted.Add(sample);
            if (StrategyFailure != null) throw StrategyFailure;
            return Task.FromResult(StrategyResult);
        }

        public Task<PairingResult> PairAsync(string enrollmentCode, string agentVersion, string addonVersion, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<UploadAcknowledgement> UploadAsync(Vincere.AutoExport.Agent.Queue.QueueItem item, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<HeartbeatResult> SendHeartbeatAsync(HeartbeatPayload payload, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QuarantineReportOutcome> ReportQuarantineAsync(QuarantineReport report, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    internal sealed class FixedTokenStore : IDeviceTokenStore
    {
        private string value;
        public FixedTokenStore(string value) => this.value = value;
        public Task SaveTokenAsync(string token, CancellationToken cancellationToken = default) { value = token; return Task.CompletedTask; }
        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult(value);
        public Task DeleteTokenAsync(CancellationToken cancellationToken = default) { value = null; return Task.CompletedTask; }
    }

    internal sealed class SettableClock : ICollectorClock
    {
        public SettableClock(Instant now) => Now = now;
        public Instant Now { get; set; }
        public Instant GetCurrentInstant() => Now;
        public DateTimeOffset GetCurrentDateTimeOffset() => Now.ToDateTimeOffset();
    }

    internal sealed class RecordingSampleReporter : IServiceReporter
    {
        public List<string> Loops { get; } = new();
        public List<string> Codes { get; } = new();

        public void LoopFailed(string loopName, string errorCode, Exception exception = null)
        {
            Loops.Add(loopName);
            Codes.Add(errorCode);
        }
    }

    internal sealed class RecordingSampleLogger : IRedactingLogger
    {
        public List<(string Level, string EventCode, string Message)> Entries { get; } = new();

        public void Write(string level, string eventCode, string message, IEnumerable<string> knownSecrets = null)
        {
            Entries.Add((level, eventCode, message));
        }
    }

    internal sealed class ImmediateDelay : ICollectorDelay
    {
        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken) => Task.CompletedTask;
    }
}

public sealed class LiveAccountMemoryTests
{
    [Fact]
    public void An_account_seen_connected_is_kept_once_it_goes_dark()
    {
        LiveAccountMemory memory = new();

        memory.Retain(new[] { Row("APEX-1111", true) });
        IList<AccountSampleRowV1> second = memory.Retain(new[] { Row("APEX-1111", false) });

        Assert.Equal("APEX-1111", Assert.Single(second).AccountName);
    }

    [Fact]
    public void An_account_never_seen_connected_is_never_mentioned()
    {
        Assert.Empty(new LiveAccountMemory().Retain(new[] { Row("DEMO5289161", false) }));
    }

    /* THE ANSWER MUST NOT DEPEND ON THE ORDER NINJATRADER HAPPENED TO RETURN THEM
     * IN. With one pass, an account listed as disconnected BEFORE its own connected
     * sibling - or a duplicate name in either order - would decide the question
     * against evidence that was in the same reading. */
    [Fact]
    public void A_connected_row_later_in_the_list_still_counts()
    {
        LiveAccountMemory memory = new();

        IList<AccountSampleRowV1> kept = memory.Retain(new[]
        {
            Row("APEX-1111", false),
            Row("APEX-2222", true),
            Row("APEX-1111", true),
        });

        Assert.Equal(
            new[] { "APEX-1111", "APEX-2222", "APEX-1111" },
            kept.Select(row => row.AccountName));
    }

    [Fact]
    public void The_platforms_casing_is_not_something_the_desk_controls()
    {
        LiveAccountMemory memory = new();

        memory.Retain(new[] { Row("apex-1111", true) });

        Assert.Single(memory.Retain(new[] { Row("APEX-1111", false) }));
    }

    [Fact]
    public void A_row_with_no_name_is_dropped_rather_than_forwarded()
    {
        // The CRM refuses a whole report for one bad row, so one unnameable account
        // must not cost the reading.
        IList<AccountSampleRowV1> kept = new LiveAccountMemory().Retain(new[]
        {
            Row("APEX-1111", true),
            Row("   ", true),
            null,
        });

        Assert.Equal("APEX-1111", Assert.Single(kept).AccountName);
    }

    [Fact]
    public void Nothing_in_means_nothing_out_and_no_exception()
    {
        Assert.Empty(new LiveAccountMemory().Retain(null));
        Assert.Empty(new LiveAccountMemory().Retain(Array.Empty<AccountSampleRowV1>()));
    }

    [Fact]
    public void The_rows_themselves_are_handed_on_untouched()
    {
        AccountSampleRowV1 row = Row("APEX-1111", true);

        Assert.Same(row, Assert.Single(new LiveAccountMemory().Retain(new[] { row })));
    }

    private static AccountSampleRowV1 Row(string name, bool connected) => new()
    {
        AccountName = name,
        Connected = connected,
    };
}
