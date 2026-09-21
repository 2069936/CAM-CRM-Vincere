using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Diagnostics;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Service;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* THE LOOP THAT MAKES QUARANTINE A PLACE THINGS CAN LEAVE.
 *
 * Once a day at the configured New York time, and whenever the Setup window
 * asks, it has the queue review the folder; then it tells the CRM what is
 * there through the endpoint built for it. The CRM of today answers that
 * endpoint with 404, and the agent will be on the fleet for weeks before that
 * changes, so 404 has to be the quietest thing this loop ever meets. */
public sealed class QuarantineReviewLoopTests
{
    // 2026-07-23 is a Thursday. 16:05 UTC is 12:05 in New York in July.
    private static readonly Instant AfterMidday = Instant.FromUtc(2026, 7, 23, 16, 5);
    private static readonly Instant BeforeMidday = Instant.FromUtc(2026, 7, 23, 15, 55);

    private static readonly QueueQuarantineEntry Retryable = new(
        Guid.Parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        "2026-07-22",
        "snapshot_processing_failed",
        1,
        new DateTimeOffset(2026, 7, 22, 20, 46, 0, TimeSpan.Zero),
        new DateTimeOffset(2026, 7, 23, 16, 0, 0, TimeSpan.Zero),
        true);

    private static readonly QueueQuarantineEntry Final = new(
        Guid.Parse("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        "2026-07-21",
        "snapshot_rejected",
        0,
        new DateTimeOffset(2026, 7, 21, 20, 46, 0, TimeSpan.Zero),
        null,
        false);

    [Fact]
    public async Task TheReviewRunsOncePerNewYorkDayAtTheConfiguredTimeAndIsRemembered()
    {
        Harness harness = Harness.Create(BeforeMidday);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(0, harness.Queue.Reviews);

        harness.Clock.Now = AfterMidday;
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        harness.Clock.Now = AfterMidday + Duration.FromHours(5);
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(1, harness.Queue.Reviews);
        Assert.Equal("2026-07-23", harness.Options.Options.LastQuarantineReviewDate);

        // The next New York day is a new day.
        harness.Clock.Now = AfterMidday + Duration.FromDays(1);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(2, harness.Queue.Reviews);
        Assert.Equal("2026-07-24", harness.Options.Options.LastQuarantineReviewDate);
    }

    [Fact]
    public async Task ADayAlreadyReviewedBeforeARestartIsNotReviewedAgain()
    {
        // Persisted the way lastScheduledTradingDate is, and for the same
        // reason: a service restart at 14:00 must not review the day twice.
        Harness harness = Harness.Create(
            AfterMidday,
            AgentOptions.CreateDefault() with { LastQuarantineReviewDate = "2026-07-23" });

        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(0, harness.Queue.Reviews);
        Assert.Equal(0, harness.Options.SaveCount);
    }

    [Fact]
    public async Task TheConfiguredTimeIsHonoured()
    {
        Harness harness = Harness.Create(
            AfterMidday,
            AgentOptions.CreateDefault() with { QuarantineReviewTime = "20:00" });

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(0, harness.Queue.Reviews);

        // 20:00 in New York is 00:00 UTC the next calendar day, and still the
        // 23rd there.
        harness.Clock.Now = Instant.FromUtc(2026, 7, 24, 0, 1);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(1, harness.Queue.Reviews);
        Assert.Equal("2026-07-23", harness.Options.Options.LastQuarantineReviewDate);
    }

    [Fact]
    public async Task TheSaveDoesNotOverwriteWhatTheSchedulerSavedMeanwhile()
    {
        // The scheduler writes lastScheduledTradingDate through the same file.
        // A stale copy written over it would make the scheduler capture the
        // day a second time, which is worse than any quarantine.
        Harness harness = Harness.Create(AfterMidday);
        harness.Queue.OnReview = () =>
        {
            harness.Options.Options = harness.Options.Options with { LastScheduledTradingDate = "2026-07-23" };
        };

        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal("2026-07-23", harness.Options.Options.LastScheduledTradingDate);
        Assert.Equal("2026-07-23", harness.Options.Options.LastQuarantineReviewDate);
    }

    [Fact]
    public async Task ManualRetryRunsNowAndIgnoresTheDayRule()
    {
        Harness harness = Harness.Create(
            BeforeMidday,
            AgentOptions.CreateDefault() with { LastQuarantineReviewDate = "2026-07-23" });
        harness.Queue.Requeued.Add(Retryable);
        harness.Queue.Remaining.Add(Final);

        QueueQuarantineReviewResult result = await harness.Loop.ReviewNowAsync();
        QueueQuarantineReviewResult again = await harness.Loop.ReviewNowAsync();

        Assert.Equal(2, harness.Queue.Reviews);
        Assert.Same(Retryable, Assert.Single(result.Requeued));
        Assert.Same(Final, Assert.Single(result.Remaining));
        Assert.Single(again.Requeued);
        // The button is not the schedule: the day's own review still stands.
        Assert.Equal("2026-07-23", harness.Options.Options.LastQuarantineReviewDate);
        Assert.Equal(0, harness.Options.SaveCount);
    }

    [Fact]
    public async Task TheInventoryIsReportedOnceOnStartAndAgainAfterEachReview()
    {
        Harness harness = Harness.Create(BeforeMidday);
        harness.Queue.Inventory.Add(Retryable);
        harness.Queue.Inventory.Add(Final);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Single(harness.Crm.Reports);

        harness.Clock.Now = AfterMidday;
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(2, harness.Crm.Reports.Count);

        await harness.Loop.ReviewNowAsync();
        Assert.Equal(3, harness.Crm.Reports.Count);

        QuarantineReport report = harness.Crm.Reports[0];
        Assert.Equal(QuarantineReport.CurrentSchemaVersion, report.SchemaVersion);
        Assert.Equal(BeforeMidday.ToDateTimeOffset(), report.ReportedAt);
        Assert.Equal(2, report.Items.Count);
        QuarantineReportItem item = report.Items[0];
        Assert.Equal("2026-07-22", item.TradingDate);
        Assert.Equal("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", item.CaptureId);
        Assert.Equal("snapshot_processing_failed", item.Code);
        Assert.Equal(1, item.Attempts);
        Assert.Equal(Retryable.QuarantinedAt, item.QuarantinedAt);
        Assert.Equal(Retryable.LastAttemptAt, item.LastAttemptAt);
        Assert.Null(report.Items[1].LastAttemptAt);
    }

    [Fact]
    public async Task AnUnpairedMachineWaitsAndReportsOnTheFirstPassAfterPairing()
    {
        Harness harness = Harness.Create(BeforeMidday, token: null);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Empty(harness.Crm.Reports);

        await harness.Token.SaveTokenAsync("token");
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Single(harness.Crm.Reports);
    }

    /* 404 IS THE ANSWER THIS AGENT WILL GET FOR WEEKS.
     *
     * It ships before the CRM that reads the report. One INFO line, one try a
     * day, nothing in the error log, nothing on the device's error fields,
     * and everything else the loop does carries on. */
    [Fact]
    public async Task ACrmWithoutTheEndpointIsOfferedTheReportOnceADayAndNeverAsAnError()
    {
        Harness harness = Harness.Create(BeforeMidday);
        harness.Crm.Outcome = QuarantineReportOutcome.Unsupported;

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        harness.Clock.Now = AfterMidday;
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        await harness.Loop.ReviewNowAsync();
        harness.Clock.Now = AfterMidday + Duration.FromHours(12);
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Single(harness.Crm.Reports);
        Assert.Equal(2, harness.Queue.Reviews);
        Assert.Empty(harness.Reporter.Codes);
        Assert.Null(harness.State.Snapshot().LastErrorCode);
        (string Level, string Code) line = Assert.Single(harness.Logger.Lines);
        Assert.Equal("INFO", line.Level);
        Assert.Equal("quarantine_report_unsupported", line.Code);

        harness.Clock.Now = BeforeMidday + Duration.FromHours(24) + Duration.FromMinutes(1);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(2, harness.Crm.Reports.Count);
        // Still one line: the answer has not changed.
        Assert.Single(harness.Logger.Lines);
    }

    [Fact]
    public async Task OnceTheCrmAcceptsTheReportTheSilenceEnds()
    {
        Harness harness = Harness.Create(BeforeMidday);
        harness.Crm.Outcome = QuarantineReportOutcome.Unsupported;
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        harness.Crm.Outcome = QuarantineReportOutcome.Accepted;
        harness.Clock.Now = BeforeMidday + Duration.FromHours(25);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        harness.Clock.Now = BeforeMidday + Duration.FromHours(25) + Duration.FromMinutes(1);
        await harness.Loop.ReviewNowAsync();

        Assert.Equal(3, harness.Crm.Reports.Count);
    }

    [Fact]
    public async Task ARevokedCredentialIsDeletedAndTheDeviceReadsAsUnpaired()
    {
        Harness harness = Harness.Create(BeforeMidday);
        harness.Crm.Error = new CrmClientException(
            "device_credential_revoked",
            "revoked",
            false,
            disposition: CrmFailureDisposition.RePair);

        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.True(harness.Token.Deleted);
        Assert.Equal("unpaired", harness.State.Snapshot().DeviceStatus);
        // Never through the heartbeat's error fields: the vocabulary there is
        // the server's, and this code is not in it.
        Assert.Null(harness.State.Snapshot().LastErrorCode);
    }

    [Fact]
    public async Task ServerTroubleIsLoggedOnceAndTriedAgainLater()
    {
        Harness harness = Harness.Create(BeforeMidday);
        harness.Crm.Error = new CrmClientException(
            "quarantine_report_failed",
            "The CRM did not accept the quarantine report.",
            true,
            disposition: CrmFailureDisposition.Retry);

        await harness.Loop.RunOnceAsync(CancellationToken.None);
        harness.Clock.Now = BeforeMidday + Duration.FromMinutes(1);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        harness.Clock.Now = BeforeMidday + Duration.FromTimeSpan(QuarantineReviewLoop.FailedReportBackoff) + Duration.FromMinutes(1);
        await harness.Loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(2, harness.Crm.Reports.Count);
        Assert.Equal(new[] { "quarantine_report_failed" }, harness.Reporter.Codes);
        Assert.Null(harness.State.Snapshot().LastErrorCode);

        harness.Crm.Error = null;
        harness.Clock.Now = BeforeMidday + Duration.FromHours(1);
        await harness.Loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(3, harness.Crm.Reports.Count);
    }

    private sealed class Harness
    {
        private Harness(Instant now, AgentOptions options, string token)
        {
            Token = new FakeTokenStore(token);
            Options = new FakeOptionsStore(options);
            Clock = new FakeClock(now);
            Loop = new QuarantineReviewLoop(Queue, Crm, Token, Options, Clock, State, Reporter, Logger);
        }

        public static Harness Create(Instant now, AgentOptions options = null, string token = "token")
            => new(now, options ?? AgentOptions.CreateDefault(), token);

        public FakeQueue Queue { get; } = new();
        public FakeCrm Crm { get; } = new();
        public FakeTokenStore Token { get; }
        public FakeOptionsStore Options { get; }
        public FakeClock Clock { get; }
        public CollectorState State { get; } = new();
        public RecordingReporter Reporter { get; } = new();
        public RecordingLogger Logger { get; } = new();
        public QuarantineReviewLoop Loop { get; }
    }

    private sealed class FakeQueue : ICollectorQueue
    {
        public int Reviews { get; private set; }
        public Action OnReview { get; set; }
        public List<QueueQuarantineEntry> Inventory { get; } = new();
        public List<QueueQuarantineEntry> Requeued { get; } = new();
        public List<QueueQuarantineEntry> Remaining { get; } = new();

        public Task<IReadOnlyList<QueueQuarantineEntry>> ListQuarantineAsync(CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<QueueQuarantineEntry>>(Inventory.ToList());

        public Task<QueueQuarantineReviewResult> ReviewQuarantineAsync(DateTimeOffset now, CancellationToken cancellationToken = default)
        {
            Reviews++;
            OnReview?.Invoke();
            return Task.FromResult(new QueueQuarantineReviewResult(Requeued.ToList(), Remaining.ToList()));
        }

        public Task<QueueEnqueueResult> EnqueueAsync(AutoExportSnapshotV1 snapshot, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueRecoveryResult> RecoverAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> ClaimNextAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> RetryAsync(QueueItem item, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> CompleteAsync(QueueItem item, string batchId, string hash, DateTimeOffset at, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> QuarantineAsync(QueueItem item, string code, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueStatus> GetStatusAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueCleanupResult> CleanupAsync(DateTimeOffset now, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class FakeCrm : ICollectorCrmClient
    {
        public List<QuarantineReport> Reports { get; } = new();
        public QuarantineReportOutcome Outcome { get; set; } = QuarantineReportOutcome.Accepted;
        public CrmClientException Error { get; set; }

        public Task<QuarantineReportOutcome> ReportQuarantineAsync(QuarantineReport report, CancellationToken cancellationToken = default)
        {
            Reports.Add(report);
            if (Error != null) throw Error;
            return Task.FromResult(Outcome);
        }

        public Task<PairingResult> PairAsync(string code, string agentVersion, string addonVersion, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<UploadAcknowledgement> UploadAsync(QueueItem item, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<HeartbeatResult> SendHeartbeatAsync(HeartbeatPayload payload, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class FakeTokenStore : IDeviceTokenStore
    {
        private string value;
        public FakeTokenStore(string value) => this.value = value;
        public bool Deleted { get; private set; }
        public Task SaveTokenAsync(string token, CancellationToken cancellationToken = default) { value = token; return Task.CompletedTask; }
        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult(value);
        public Task DeleteTokenAsync(CancellationToken cancellationToken = default) { value = null; Deleted = true; return Task.CompletedTask; }
    }

    private sealed class FakeOptionsStore : IAgentOptionsStore
    {
        public FakeOptionsStore(AgentOptions options) => Options = options;
        public AgentOptions Options { get; set; }
        public int SaveCount { get; private set; }

        public Task<ConfigurationLoadResult> LoadAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(new ConfigurationLoadResult(Options, false));

        public Task SaveAsync(AgentOptions options, CancellationToken cancellationToken = default)
        {
            Options = options;
            SaveCount++;
            return Task.CompletedTask;
        }
    }

    private sealed class FakeClock : ICollectorClock
    {
        public FakeClock(Instant now) => Now = now;
        public Instant Now { get; set; }
        public Instant GetCurrentInstant() => Now;
        public DateTimeOffset GetCurrentDateTimeOffset() => Now.ToDateTimeOffset();
    }

    private sealed class RecordingReporter : IServiceReporter
    {
        public List<string> Codes { get; } = new();

        public void LoopFailed(string loopName, string errorCode, Exception exception = null)
        {
            Codes.Add(errorCode);
        }
    }

    private sealed class RecordingLogger : IRedactingLogger
    {
        public List<(string Level, string Code)> Lines { get; } = new();

        public void Write(string level, string eventCode, string message, IEnumerable<string> knownSecrets = null)
        {
            Lines.Add((level, eventCode));
        }
    }
}
