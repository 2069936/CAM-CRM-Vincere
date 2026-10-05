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
        Assert.Equal(TimeSpan.FromSeconds(900), harness.Loop.Interval);
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

        Assert.Equal(TimeSpan.FromMinutes(10), harness.Loop.Interval);
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
        Assert.Equal(TimeSpan.FromMinutes(30), harness.Loop.Interval);
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

        Assert.Equal(TimeSpan.FromMinutes(10), harness.Loop.Interval);
    }

    /* WHY THAT MATTERS MORE THAN IT LOOKS. Worker.SuperviseAsync reads Interval
     * OUTSIDE its try block, and the host's default behaviour for an unhandled
     * exception in a BackgroundService is to stop. A getter that threw, or returned
     * zero or a negative, would take down the scheduler, the uploader and the
     * heartbeat with it - and the heartbeat is the only thing that says a machine is
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
                interval,
                TimeSpan.FromSeconds(AccountSampleLoop.MinimumIntervalSeconds),
                TimeSpan.FromSeconds(AccountSampleLoop.MaximumIntervalSeconds));

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
            interval,
            TimeSpan.FromSeconds(AccountSampleLoop.MinimumIntervalSeconds),
            TimeSpan.FromSeconds(AccountSampleLoop.MaximumIntervalSeconds));
        // Worker's constructor is the contract that matters: it refuses a loop whose
        // Interval is not positive, and an Interval that threw or went negative at
        // runtime would stop the host and take the heartbeat down with it.
        _ = new Worker(new[] { (ICollectorLoop)harness.Loop }, new ImmediateDelay(), harness.Reporter);
    }

    /* ---------------------------------------------------------------------
     * The wiring, which is the bug this repo has already paid for once.
     * ------------------------------------------------------------------- */

    /* A LOOP TOOK A STORE AS AN OPTIONAL LAST ARGUMENT, A COMPOSITION ROOT FORGOT
     * TO PASS IT, IT COMPILED, AND NOTHING FAILED - the heartbeat succeeded, the
     * mail loop found no secret, and no report was ever sent, forever, with no
     * error anywhere. Nothing in this suite reads Program.cs, so the comment left
     * behind is a tombstone rather than a guard.
     *
     * These two tests are the guard, and they close the bug class rather than the
     * instance. An argument that cannot be defaulted cannot be silently omitted;
     * a by-type registration has no argument list to omit it from. Both halves are
     * asserted, because either one alone leaves the door open. */
    [Fact]
    public void Nothing_the_loop_needs_can_be_quietly_left_out()
    {
        ConstructorInfo constructor = Assert.Single(typeof(AccountSampleLoop).GetConstructors());

        Assert.NotEmpty(constructor.GetParameters());
        Assert.DoesNotContain(
            constructor.GetParameters(),
            parameter => parameter.IsOptional || parameter.HasDefaultValue);
    }

    [Fact]
    public void Program_registers_the_loop_by_type_rather_than_by_a_hand_written_factory()
    {
        string program = ProgramSource();

        // By type: the container fills every argument, so there is no list for a
        // future dependency to be left off of.
        Assert.Contains(
            "AddSingleton<ICollectorLoop, AccountSampleLoop>()",
            program,
            StringComparison.Ordinal);
        // The memory has to be a singleton or the filter forgets on every pass and
        // silently does nothing - which is this bug's exact shape again.
        Assert.Contains("AddSingleton<LiveAccountMemory>()", program, StringComparison.Ordinal);
        // And the sample's pipe client is registered, or the loop cannot resolve.
        Assert.Contains(
            "AddSingleton<INinjaTraderAccountSampleClient, CapturePipeClient>()",
            program,
            StringComparison.Ordinal);
    }

    /* EVERY ARGUMENT THE LOOP ASKS FOR IS SOMETHING Program.cs ALREADY REGISTERS.
     *
     * This is what makes the by-type registration above safe rather than merely
     * tidy: a dependency the container does not hold would throw at service start,
     * on a machine, in front of nobody. Checked against Program.cs's own text so
     * that adding a parameter of a type nothing registers fails here instead. */
    [Fact]
    public void Every_dependency_the_loop_asks_for_is_one_the_container_holds()
    {
        string program = ProgramSource();
        ConstructorInfo constructor = Assert.Single(typeof(AccountSampleLoop).GetConstructors());

        foreach (ParameterInfo parameter in constructor.GetParameters())
        {
            string name = parameter.ParameterType.Name;
            Assert.True(
                program.Contains($"AddSingleton<{name}>", StringComparison.Ordinal)
                || program.Contains($"AddSingleton<{name},", StringComparison.Ordinal)
                || program.Contains($"AddSingleton<{name}>(", StringComparison.Ordinal),
                $"AccountSampleLoop asks for {name}, which Program.cs does not register.");
        }
    }

    // Copied beside the test binary by the csproj, the way Agent.UI.Tests scans the
    // deep export's sources: a composition root cannot be asserted about if the
    // suite cannot read it.
    private static string ProgramSource()
    {
        string path = Path.Combine(
            Path.GetDirectoryName(typeof(AccountSampleLoopTests).Assembly.Location)!,
            "wiring-scan",
            "Program.cs");
        Assert.True(File.Exists(path), $"Program.cs was not copied beside the tests: {path}");
        return File.ReadAllText(path);
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

    private sealed class Harness
    {
        public Harness(
            FakeSampleClient pipe,
            RecordingSampleCrm crm,
            string token = "a-device-token")
        {
            Clock = new SettableClock(Now);
            State = new CollectorState();
            Reporter = new RecordingSampleReporter();
            Logger = new RecordingSampleLogger();
            Loop = new AccountSampleLoop(
                pipe,
                crm,
                new FixedTokenStore(token),
                Clock,
                State,
                new LiveAccountMemory(),
                Reporter,
                Logger);
        }

        public AccountSampleLoop Loop { get; }
        public SettableClock Clock { get; }
        public CollectorState State { get; }
        public RecordingSampleReporter Reporter { get; }
        public RecordingSampleLogger Logger { get; }
    }

    private sealed class FakeSampleClient : INinjaTraderAccountSampleClient
    {
        private Exception failure;

        public AccountSampleAttempt Next { get; set; } =
            new(AccountSampleOutcome.Unavailable, null, "addon_unavailable");

        public int Calls { get; private set; }

        public static FakeSampleClient Returning(AccountSampleAttempt attempt) => new() { Next = attempt };

        public static FakeSampleClient Throwing(Exception exception) => new() { failure = exception };

        public Task<AccountSampleAttempt> SampleAccountsAsync(CancellationToken cancellationToken = default)
        {
            Calls++;
            if (failure != null) throw failure;
            return Task.FromResult(Next);
        }
    }

    private sealed class RecordingSampleCrm : ICollectorCrmClient
    {
        public List<AccountSampleV1> Posted { get; } = new();

        public AccountSampleReportResult Result { get; set; } =
            new(AccountSampleReportStatus.Accepted, null, null);

        public Task<AccountSampleReportResult> PostAccountSampleAsync(
            AccountSampleV1 sample,
            CancellationToken cancellationToken = default)
        {
            Posted.Add(sample);
            return Task.FromResult(Result);
        }

        public Task<PairingResult> PairAsync(string enrollmentCode, string agentVersion, string addonVersion, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<UploadAcknowledgement> UploadAsync(Vincere.AutoExport.Agent.Queue.QueueItem item, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<HeartbeatResult> SendHeartbeatAsync(HeartbeatPayload payload, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QuarantineReportOutcome> ReportQuarantineAsync(QuarantineReport report, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class FixedTokenStore : IDeviceTokenStore
    {
        private string value;
        public FixedTokenStore(string value) => this.value = value;
        public Task SaveTokenAsync(string token, CancellationToken cancellationToken = default) { value = token; return Task.CompletedTask; }
        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult(value);
        public Task DeleteTokenAsync(CancellationToken cancellationToken = default) { value = null; return Task.CompletedTask; }
    }

    private sealed class SettableClock : ICollectorClock
    {
        public SettableClock(Instant now) => Now = now;
        public Instant Now { get; set; }
        public Instant GetCurrentInstant() => Now;
        public DateTimeOffset GetCurrentDateTimeOffset() => Now.ToDateTimeOffset();
    }

    private sealed class RecordingSampleReporter : IServiceReporter
    {
        public List<string> Loops { get; } = new();
        public List<string> Codes { get; } = new();

        public void LoopFailed(string loopName, string errorCode, Exception exception = null)
        {
            Loops.Add(loopName);
            Codes.Add(errorCode);
        }
    }

    private sealed class RecordingSampleLogger : IRedactingLogger
    {
        public List<(string Level, string EventCode, string Message)> Entries { get; } = new();

        public void Write(string level, string eventCode, string message, IEnumerable<string> knownSecrets = null)
        {
            Entries.Add((level, eventCode, message));
        }
    }

    private sealed class ImmediateDelay : ICollectorDelay
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
