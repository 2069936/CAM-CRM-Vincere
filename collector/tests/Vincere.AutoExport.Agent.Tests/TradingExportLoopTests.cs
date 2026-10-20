using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Diagnostics;
using Vincere.AutoExport.Agent.Exports;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Service;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* THE LOOP, WITH THE CRM AND THE STORAGE FAKED.
 *
 * Most tests fake the builder too, to say what the loop does with each answer;
 * the last one runs the real builder against the fixture machine, end to end. */
public sealed class TradingExportLoopTests : IDisposable
{
    private const string Sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private const string Storage = "https://abcdefgh.supabase.co/storage/v1/object/upload/sign/exports/req-1.jsonl.gz?token=signed";
    private static readonly DateTimeOffset Noon = new(2026, 10, 20, 16, 0, 0, TimeSpan.Zero);

    private readonly UpdateTempDirectory temp = new();
    private readonly FakeExportCrm crm = new();
    private readonly FakeTokens tokens = new() { Value = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD" };
    private readonly FakeClock clock = new() { Now = Noon };
    private readonly RecordingReporter reporter = new();
    private readonly RecordingLogger logger = new();
    private readonly FakeBuilder builder;
    private readonly TradingExportStateStore store;

    public TradingExportLoopTests()
    {
        builder = new FakeBuilder(Path.Combine(temp.Path, "exports"));
        store = new TradingExportStateStore(Path.Combine(temp.Path, "exports"));
    }

    public void Dispose() => temp.Dispose();

    private TradingExportLoop Loop(ITradingExportBuilder with = null)
        => new(crm, tokens, with ?? builder, store, clock, "1.4.0", reporter, logger);

    private static TradingExportRequest Request(
        string id = "req-1",
        string from = "2026-08-03",
        string to = "2026-08-07",
        string[] datasets = null,
        long? maxBytes = 10L * 1024 * 1024)
        => new(id, from, to, datasets ?? new[] { "executions", "orders", "strategies", "trades" }, maxBytes);

    [Fact]
    public async Task An_unpaired_machine_asks_nothing_and_builds_nothing()
    {
        tokens.Value = null;
        crm.Request = Request();

        await Loop().RunOnceAsync(CancellationToken.None);

        Assert.Empty(crm.Calls);
        Assert.Equal(0, builder.Builds);
        Assert.False(File.Exists(store.FilePath));
    }

    [Fact]
    public void It_is_named_and_paced_like_the_other_crm_pollers()
    {
        TradingExportLoop loop = Loop();

        Assert.Equal("trading-export", loop.Name);
        Assert.Equal(TimeSpan.FromMinutes(5), loop.Interval);
    }

    [Fact]
    public async Task With_nothing_asked_it_polls_with_its_version_and_does_nothing()
    {
        await Loop().RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "poll:1.4.0" }, crm.Calls);
        Assert.Equal(0, builder.Builds);
        Assert.Empty(reporter.Codes);
    }

    [Fact]
    public async Task Asked_for_an_export_it_builds_uploads_and_says_ready_once()
    {
        crm.Request = Request();
        TradingExportLoop loop = Loop();

        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "poll:1.4.0", "upload-url", "put", "complete:ready" }, crm.Calls);
        TradingExportPlan plan = Assert.Single(builder.Plans);
        Assert.Equal("req-1", plan.RequestId);
        Assert.Equal(new DateOnly(2026, 8, 3), plan.From);
        Assert.Equal(new DateOnly(2026, 8, 7), plan.To);
        Assert.Equal(10L * 1024 * 1024, plan.MaxBytes);

        ExportUploadUrlRequest asked = Assert.Single(crm.UploadUrlRequests);
        Assert.Equal(new ExportUploadUrlRequest("req-1", Sha, FakeBuilder.Size), asked);
        (Uri url, bool fileExisted) = Assert.Single(crm.Puts);
        Assert.Equal(new Uri(Storage), url);
        Assert.True(fileExisted);

        ExportCompleteRequest complete = Assert.Single(crm.Completions);
        Assert.Equal(new ExportCompleteRequest("req-1", "ready", Sha, FakeBuilder.Size, FakeBuilder.Counts, "2026-08-03", "2026-08-07", null), complete);
        // Deleted after the upload, whatever happens next.
        Assert.False(Directory.Exists(builder.LastWorkDirectory));
        TradingExportState state = store.Load();
        Assert.Equal(TradingExportState.Completed, state.Phase);
        Assert.Equal("2026-08-03", state.From);
        Assert.Empty(reporter.Codes);

        // The CRM is told; the request is not answered twice if it is offered again.
        await loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(1, builder.Builds);
        Assert.Single(crm.Completions);
    }

    [Fact]
    public async Task An_older_crm_is_asked_again_in_an_hour_and_the_fact_is_logged_once()
    {
        crm.Unsupported = true;
        TradingExportLoop loop = Loop();

        await loop.RunOnceAsync(CancellationToken.None);
        clock.Now = Noon.AddMinutes(30);
        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Single(crm.Calls);
        Assert.Equal(0, builder.Builds);
        Assert.Empty(reporter.Codes);
        Assert.Single(logger.Lines, line => line.Code == "trading_export_unsupported");

        clock.Now = Noon.AddMinutes(61);
        await loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(2, crm.Calls.Count);
        Assert.Single(logger.Lines, line => line.Code == "trading_export_unsupported");
    }

    [Fact]
    public async Task A_refused_upload_is_completed_as_failed_with_a_code_once()
    {
        crm.Request = Request();
        crm.PutAnswer = ExportUploadResult.Failed("upload_http_403");

        await Loop().RunOnceAsync(CancellationToken.None);

        ExportCompleteRequest complete = Assert.Single(crm.Completions);
        Assert.Equal("failed", complete.Status);
        Assert.Equal("upload_failed", complete.ErrorCode);
        Assert.Null(complete.Sha256);
        Assert.Null(complete.RowCounts);
        Assert.Equal("2026-08-03", complete.From);
        Assert.False(Directory.Exists(builder.LastWorkDirectory));
        Assert.Equal(new[] { "upload_failed" }, reporter.Codes);
    }

    [Theory]
    [InlineData("upload_timeout", "upload_timeout")]
    [InlineData("upload_unreachable", "upload_failed")]
    [InlineData("url_not_allowed", "url_not_allowed")]
    public async Task Each_upload_failure_has_its_stable_word(string clientCode, string reported)
    {
        crm.Request = Request();
        crm.PutAnswer = ExportUploadResult.Failed(clientCode);

        await Loop().RunOnceAsync(CancellationToken.None);

        Assert.Equal(reported, Assert.Single(crm.Completions).ErrorCode);
    }

    [Theory]
    [InlineData("url_not_allowed", "url_not_allowed")]
    [InlineData("export_upload_url_http_500", "upload_url_failed")]
    public async Task No_upload_address_means_no_upload(string clientCode, string reported)
    {
        crm.Request = Request();
        crm.UploadUrlAnswer = ExportUploadUrlResult.Failed(clientCode);

        await Loop().RunOnceAsync(CancellationToken.None);

        Assert.Empty(crm.Puts);
        Assert.Equal(reported, Assert.Single(crm.Completions).ErrorCode);
        Assert.False(Directory.Exists(builder.LastWorkDirectory));
    }

    [Fact]
    public async Task A_build_that_fails_is_reported_with_its_code_and_nothing_is_uploaded()
    {
        crm.Request = Request();
        builder.FailWith = "export_too_large";

        await Loop().RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "poll:1.4.0", "complete:failed" }, crm.Calls);
        Assert.Equal("export_too_large", Assert.Single(crm.Completions).ErrorCode);
    }

    [Theory]
    [InlineData("2026-08-07", "2026-08-03")]  // backwards
    [InlineData("2026-02-30", null)]          // not a date
    [InlineData("08/03/2026", null)]          // not the CRM's shape
    public async Task Dates_that_do_not_make_a_range_are_request_invalid(string from, string to)
    {
        crm.Request = Request(from: from, to: to);

        await Loop().RunOnceAsync(CancellationToken.None);

        Assert.Equal(0, builder.Builds);
        Assert.Equal("request_invalid", Assert.Single(crm.Completions).ErrorCode);
    }

    [Fact]
    public async Task A_dataset_off_the_allowlist_or_no_size_limit_is_request_invalid()
    {
        crm.Request = Request(datasets: new[] { "orders", "logs" });
        await Loop().RunOnceAsync(CancellationToken.None);
        crm.Request = Request(id: "req-2", maxBytes: 0);
        await Loop().RunOnceAsync(CancellationToken.None);
        crm.Request = Request(id: "req-3", datasets: Array.Empty<string>());
        await Loop().RunOnceAsync(CancellationToken.None);

        Assert.Equal(0, builder.Builds);
        Assert.Equal(new[] { "request_invalid", "request_invalid", "request_invalid" }, crm.Completions.Select(c => c.ErrorCode).ToArray());
    }

    [Fact]
    public async Task A_size_limit_above_25_MB_is_held_to_25_MB()
    {
        crm.Request = Request(maxBytes: 500L * 1024 * 1024);

        await Loop().RunOnceAsync(CancellationToken.None);

        Assert.Equal(25L * 1024 * 1024, Assert.Single(builder.Plans).MaxBytes);
    }

    [Fact]
    public async Task A_request_without_a_usable_id_is_never_built_or_completed()
    {
        crm.Request = Request(id: "../../etc");

        await Loop().RunOnceAsync(CancellationToken.None);

        Assert.Equal(0, builder.Builds);
        Assert.Empty(crm.Completions);
        Assert.Equal(new[] { "export_request_invalid" }, reporter.Codes);
    }

    [Fact]
    public async Task When_the_crm_cannot_be_told_the_next_poll_tells_it_without_building_again()
    {
        crm.Request = Request();
        crm.CompleteAnswer = ExportCompleteResult.Failed("export_complete_unreachable", CrmFailureDisposition.Retry);
        TradingExportLoop loop = Loop();

        await loop.RunOnceAsync(CancellationToken.None);
        Assert.Equal(TradingExportState.Uploaded, store.Load().Phase);
        Assert.Equal(new[] { "export_complete_unreachable" }, reporter.Codes);

        crm.CompleteAnswer = ExportCompleteResult.Accepted();
        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(1, builder.Builds);
        Assert.Single(crm.Puts);
        Assert.Equal(2, crm.Completions.Count);
        Assert.Equal(crm.Completions[0], crm.Completions[1]);
        Assert.Equal(TradingExportState.Completed, store.Load().Phase);
    }

    [Fact]
    public async Task A_new_request_after_a_finished_one_is_built()
    {
        crm.Request = Request();
        TradingExportLoop loop = Loop();
        await loop.RunOnceAsync(CancellationToken.None);

        crm.Request = Request(id: "req-2", from: null, to: null);
        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(2, builder.Builds);
        Assert.Null(builder.Plans[1].From);
        ExportCompleteRequest second = crm.Completions[1];
        Assert.Equal("req-2", second.RequestId);
        Assert.Null(second.From);
        Assert.Null(second.To);
    }

    [Fact]
    public async Task A_poll_that_fails_is_reported_once_and_builds_nothing()
    {
        crm.PollFailure = "export_request_http_503";
        TradingExportLoop loop = Loop();

        await loop.RunOnceAsync(CancellationToken.None);
        await loop.RunOnceAsync(CancellationToken.None);

        Assert.Equal(0, builder.Builds);
        Assert.Equal(new[] { "export_request_http_503" }, reporter.Codes);
    }

    [Fact]
    public async Task Nothing_ordinary_escapes_the_loop()
    {
        crm.Request = Request();
        builder.Throw = new IOException("disk went away");

        await Loop().RunOnceAsync(CancellationToken.None);

        Assert.Equal(new[] { "trading_export_failed" }, reporter.Codes);
    }

    [Fact]
    public async Task End_to_end_on_a_machine_the_file_reaches_storage_and_nothing_outside_ProgramData_changes()
    {
        using TradingExportFixture machine = new();
        Dictionary<string, string> before = machine.EverythingOutsideTheDataFolder();
        TradingExportStateStore realStore = new(machine.ExportsRoot);
        crm.Request = Request(from: null, to: null);
        crm.ReadUploadedFile = true;
        TradingExportLoop loop = new(crm, tokens, machine.Builder(), realStore, clock, "1.4.0", reporter, logger);

        await loop.RunOnceAsync(CancellationToken.None);

        ExportCompleteRequest complete = Assert.Single(crm.Completions);
        Assert.Equal("ready", complete.Status);
        Assert.Equal(new ExportRowCounts(3, 5, 3, 2), complete.RowCounts);
        byte[] uploaded = Assert.Single(crm.UploadedBytes);
        Assert.Equal(complete.Sha256, UpdateFixtures.Sha256(uploaded));
        Assert.Equal(complete.ByteSize, uploaded.LongLength);
        Assert.Equal(before, machine.EverythingOutsideTheDataFolder());
        // Only the record of the last export stays; the file and the copy are gone.
        Assert.Equal(new[] { "state.json" }, Directory.GetFiles(machine.ExportsRoot).Select(Path.GetFileName).ToArray());
        Assert.Empty(Directory.GetDirectories(machine.ExportsRoot));
        // The log names the request and the counts, never where the bytes went.
        Assert.DoesNotContain(logger.Messages, message => message.Contains("supabase", StringComparison.OrdinalIgnoreCase) || message.Contains("token=", StringComparison.Ordinal));
    }

    private sealed class FakeBuilder : ITradingExportBuilder
    {
        public const long Size = 1234;
        public static readonly ExportRowCounts Counts = new(3, 5, 3, 2);
        private readonly string root;

        public FakeBuilder(string root) => this.root = root;

        public int Builds => Plans.Count;
        public List<TradingExportPlan> Plans { get; } = new();
        public string FailWith { get; set; }
        public Exception Throw { get; set; }
        public string LastWorkDirectory { get; private set; }

        public Task<TradingExportBuild> BuildAsync(TradingExportPlan plan, CancellationToken cancellationToken)
        {
            Plans.Add(plan);
            if (Throw != null) throw Throw;
            if (FailWith != null) return Task.FromResult(TradingExportBuild.Failure(FailWith));
            LastWorkDirectory = Path.Combine(root, "work-" + Plans.Count);
            Directory.CreateDirectory(LastWorkDirectory);
            string file = Path.Combine(LastWorkDirectory, TradingExportBuilder.FileName);
            File.WriteAllBytes(file, new byte[Size]);
            return Task.FromResult(TradingExportBuild.Success(file, LastWorkDirectory, Sha, Size, Counts));
        }
    }

    private sealed class FakeExportCrm : ICollectorCrmClient
    {
        public TradingExportRequest Request { get; set; }
        public bool Unsupported { get; set; }
        public string PollFailure { get; set; }
        public bool ReadUploadedFile { get; set; }
        public ExportUploadUrlResult UploadUrlAnswer { get; set; } =
            ExportUploadUrlResult.Accepted(new ExportUploadTarget(new Uri(Storage), "exports/req-1.jsonl.gz", "2026-10-20T17:00:00Z"));
        public ExportUploadResult PutAnswer { get; set; } = ExportUploadResult.Accepted();
        public ExportCompleteResult CompleteAnswer { get; set; } = ExportCompleteResult.Accepted();

        public List<string> Calls { get; } = new();
        public List<ExportUploadUrlRequest> UploadUrlRequests { get; } = new();
        public List<(Uri Url, bool FileExisted)> Puts { get; } = new();
        public List<byte[]> UploadedBytes { get; } = new();
        public List<ExportCompleteRequest> Completions { get; } = new();

        public Task<ExportRequestPollResult> PollExportRequestAsync(string agentVersion, CancellationToken cancellationToken = default)
        {
            Calls.Add("poll:" + agentVersion);
            if (Unsupported) return Task.FromResult(ExportRequestPollResult.Unsupported());
            if (PollFailure != null) return Task.FromResult(ExportRequestPollResult.Failed(PollFailure, CrmFailureDisposition.Retry));
            return Task.FromResult(ExportRequestPollResult.Accepted(Request));
        }

        public Task<ExportUploadUrlResult> RequestExportUploadUrlAsync(ExportUploadUrlRequest request, CancellationToken cancellationToken = default)
        {
            Calls.Add("upload-url");
            UploadUrlRequests.Add(request);
            return Task.FromResult(UploadUrlAnswer);
        }

        public Task<ExportUploadResult> UploadExportAsync(Uri uploadUrl, string filePath, CancellationToken cancellationToken = default)
        {
            Calls.Add("put");
            Puts.Add((uploadUrl, File.Exists(filePath)));
            if (ReadUploadedFile) UploadedBytes.Add(File.ReadAllBytes(filePath));
            return Task.FromResult(PutAnswer);
        }

        public Task<ExportCompleteResult> CompleteExportAsync(ExportCompleteRequest request, CancellationToken cancellationToken = default)
        {
            Calls.Add("complete:" + request.Status);
            Completions.Add(request);
            return Task.FromResult(CompleteAnswer);
        }

        public Task<PairingResult> PairAsync(string code, string agentVersion, string addonVersion, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<UploadAcknowledgement> UploadAsync(QueueItem item, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<HeartbeatResult> SendHeartbeatAsync(HeartbeatPayload payload, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QuarantineReportOutcome> ReportQuarantineAsync(QuarantineReport report, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class FakeTokens : IDeviceTokenStore
    {
        public string Value { get; set; }
        public Task SaveTokenAsync(string token, CancellationToken cancellationToken = default) { Value = token; return Task.CompletedTask; }
        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult(Value);
        public Task DeleteTokenAsync(CancellationToken cancellationToken = default) { Value = null; return Task.CompletedTask; }
    }

    private sealed class FakeClock : ICollectorClock
    {
        public DateTimeOffset Now { get; set; }
        public Instant GetCurrentInstant() => Instant.FromDateTimeOffset(Now);
        public DateTimeOffset GetCurrentDateTimeOffset() => Now;
    }

    private sealed class RecordingReporter : IServiceReporter
    {
        public List<string> Codes { get; } = new();
        public void LoopFailed(string loopName, string errorCode, Exception exception = null) => Codes.Add(errorCode);
    }

    private sealed class RecordingLogger : IRedactingLogger
    {
        public List<(string Level, string Code)> Lines { get; } = new();
        public List<string> Messages { get; } = new();

        public void Write(string level, string eventCode, string message, IEnumerable<string> knownSecrets = null)
        {
            Lines.Add((level, eventCode));
            Messages.Add(message);
        }
    }
}
