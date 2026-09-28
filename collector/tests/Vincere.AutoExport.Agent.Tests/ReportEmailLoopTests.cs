using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Service;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* The loop that mails this machine's own close.
 *
 * What these pin is the behaviour on the day it matters, which is a day when
 * the CRM cannot be reached: it still runs, it uses a secret it was handed
 * earlier, and a refusal leaves the day open rather than marking it done. */
public sealed class ReportEmailLoopTests : IDisposable
{
    private const string Today = "2026-09-28";
    private readonly string root = Path.Combine(Path.GetTempPath(), "vincere-mail-" + Guid.NewGuid().ToString("n"));

    public void Dispose()
    {
        try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch (Exception) { }
    }

    private string WriteCapture(string folder, string tradingDate, string body = "{\"tradingDate\":\"2026-09-28\"}")
    {
        string path = Path.Combine(root, folder);
        Directory.CreateDirectory(path);
        string file = Path.Combine(path, $"{tradingDate}_{Guid.NewGuid():D}.json");
        File.WriteAllText(file, body);
        return file;
    }

    [Fact]
    public async Task MailsTodaysCaptureAndRecordsTheDay()
    {
        WriteCapture("pending", Today);
        FakeCrm crm = new(sends: true);
        FakeOptions options = new();
        ReportEmailLoop loop = Create(crm, options, secret: "a-long-shared-secret");

        await loop.RunOnceAsync(default);

        Assert.Single(crm.Sent);
        Assert.Equal("Joel Onafowokan", crm.Sent[0].ClientName);
        Assert.Equal("a-long-shared-secret", crm.Sent[0].Secret);
        Assert.Equal(Today, options.Saved.LastReportEmailDate);
    }

    [Fact]
    public async Task DoesNotMailTheSameDayTwice()
    {
        // The loop runs every few minutes and a machine that restarts at 17:05
        // must not mail the close again.
        WriteCapture("pending", Today);
        FakeCrm crm = new(sends: true);
        ReportEmailLoop loop = Create(crm, new FakeOptions { LastReportEmailDate = Today }, secret: "s");

        await loop.RunOnceAsync(default);

        Assert.Empty(crm.Sent);
    }

    [Fact]
    public async Task ARefusalLeavesTheDayOpenSoTheNextPassTriesAgain()
    {
        /* This is what makes a deployment that gets its mail configured at
         * 18:00 still send that evening, instead of the date being written on
         * the first 503 and the day lost. */
        WriteCapture("pending", Today);
        FakeCrm crm = new(sends: false);
        FakeOptions options = new();
        ReportEmailLoop loop = Create(crm, options, secret: "s");

        await loop.RunOnceAsync(default);

        Assert.Single(crm.Sent);
        Assert.Null(options.Saved);
    }

    [Fact]
    public async Task SendsNothingWithoutASecret()
    {
        // Every machine is in this state until somebody sets the deployment's
        // mail variables, and it is not a fault of theirs.
        WriteCapture("pending", Today);
        FakeCrm crm = new(sends: true);
        ReportEmailLoop loop = Create(crm, new FakeOptions(), secret: null);

        await loop.RunOnceAsync(default);

        Assert.Empty(crm.Sent);
    }

    [Fact]
    public async Task SendsNothingBeforeThereIsACloseToSend()
    {
        // Not an error: the close has not happened, or the scheduler is still
        // inside its retry window.
        WriteCapture("pending", "2026-09-25");
        FakeCrm crm = new(sends: true);
        FakeOptions options = new();
        ReportEmailLoop loop = Create(crm, options, secret: "s");

        await loop.RunOnceAsync(default);

        Assert.Empty(crm.Sent);
        Assert.Null(options.Saved);
    }

    [Fact]
    public async Task PrefersTheNewestCaptureWhicheverFolderItIsIn()
    {
        /* A day can be captured more than once and the copies do not all sit
         * in one place: today's is usually in pending, one mid-flight in
         * uploading. Picking by folder would mail a stale close on the day an
         * upload happens to be in progress. */
        string older = WriteCapture("sent", Today, "{\"tradingDate\":\"2026-09-28\",\"which\":\"older\"}");
        File.SetLastWriteTimeUtc(older, DateTime.UtcNow.AddHours(-2));
        string newer = WriteCapture("uploading", Today, "{\"tradingDate\":\"2026-09-28\",\"which\":\"newer\"}");
        File.SetLastWriteTimeUtc(newer, DateTime.UtcNow);

        FakeCrm crm = new(sends: true);
        ReportEmailLoop loop = Create(crm, new FakeOptions(), secret: "s");

        await loop.RunOnceAsync(default);

        Assert.Contains("newer", Assert.Single(crm.Sent).Capture);
    }

    [Fact]
    public async Task DoesNotMailAQuarantinedCapture()
    {
        // It failed our own contract, and a report built from one would be
        // wrong in a way nobody reading it could see.
        WriteCapture("quarantine", Today);
        FakeCrm crm = new(sends: true);
        ReportEmailLoop loop = Create(crm, new FakeOptions(), secret: "s");

        await loop.RunOnceAsync(default);

        Assert.Empty(crm.Sent);
    }

    [Fact]
    public async Task CarriesTheCachedRosterSoTheReportCanClassify()
    {
        WriteCapture("pending", Today);
        FakeCrm crm = new(sends: true);
        ReportEmailLoop loop = Create(
            crm, new FakeOptions(), secret: "s",
            roster: new CachedRoster("{\"A1\":{\"accountType\":\"Funded\"}}", "v1",
                new DateTimeOffset(2026, 9, 27, 0, 0, 0, TimeSpan.Zero)));

        await loop.RunOnceAsync(default);

        Assert.Contains("Funded", Assert.Single(crm.Sent).Roster);
    }

    private ReportEmailLoop Create(
        FakeCrm crm, FakeOptions options, string secret, CachedRoster roster = null)
    {
        return new ReportEmailLoop(
            new QueueCaptureReader(root),
            crm,
            new FakeRoster(roster),
            new FakeSecretStore(secret),
            options,
            new FixedClock(Instant.FromUtc(2026, 9, 28, 21, 30)));
    }

    private sealed record SentReport(string Capture, string ClientName, string Roster, string Secret);

    private sealed class FakeCrm : ICollectorCrmClient
    {
        private readonly bool sends;

        public FakeCrm(bool sends) => this.sends = sends;

        public List<SentReport> Sent { get; } = new();

        public Task<bool> SendReportEmailAsync(
            string captureJson, string clientName, string rosterJson,
            DateTimeOffset? rosterFetchedAt, string relaySecret,
            CancellationToken cancellationToken = default)
        {
            Sent.Add(new SentReport(captureJson, clientName, rosterJson, relaySecret));
            return Task.FromResult(sends);
        }

        public Task<PairingResult> PairAsync(
            string enrollmentCode, string agentVersion, string addonVersion,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<UploadAcknowledgement> UploadAsync(QueueItem item, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<HeartbeatResult> SendHeartbeatAsync(HeartbeatPayload payload, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<QuarantineReportOutcome> ReportQuarantineAsync(
            QuarantineReport report, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }

    private sealed class FakeOptions : IAgentOptionsStore
    {
        public string LastReportEmailDate { get; init; }

        public AgentOptions Saved { get; private set; }

        public Task<ConfigurationLoadResult> LoadAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(new ConfigurationLoadResult(
                AgentOptions.CreateDefault() with
                {
                    ClientName = "Joel Onafowokan",
                    LastReportEmailDate = LastReportEmailDate,
                },
                false));

        public Task SaveAsync(AgentOptions options, CancellationToken cancellationToken = default)
        {
            Saved = options;
            return Task.CompletedTask;
        }
    }

    private sealed class FakeRoster : IRosterStore
    {
        private readonly CachedRoster roster;

        public FakeRoster(CachedRoster roster) => this.roster = roster;

        public Task<CachedRoster> LoadAsync(CancellationToken cancellationToken = default)
            => Task.FromResult(roster);

        public Task SaveAsync(string registryJson, string version, DateTimeOffset fetchedAt, CancellationToken cancellationToken = default)
            => Task.CompletedTask;
    }

    private sealed class FakeSecretStore : IDeviceTokenStore
    {
        private readonly string secret;

        public FakeSecretStore(string secret) => this.secret = secret;

        public Task SaveTokenAsync(string token, CancellationToken cancellationToken = default) => Task.CompletedTask;

        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult(secret);

        public Task DeleteTokenAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class FixedClock : ICollectorClock
    {
        private readonly Instant now;

        public FixedClock(Instant now) => this.now = now;

        public Instant GetCurrentInstant() => now;

        public DateTimeOffset GetCurrentDateTimeOffset() => now.ToDateTimeOffset();
    }
}
