using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Control;
using Vincere.AutoExport.Agent.Diagnostics;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Service;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class DiagnosticsCollectorTests : IDisposable
{
    private readonly string directory = Path.Combine(Path.GetTempPath(), "vincere-diagnostics-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task PackageContainsOnlyRedactedConfigurationStatusAndBoundedLogs()
    {
        AgentPaths paths = AgentPaths.FromProgramData(directory);
        ConfigurationStore options = new(paths.Configuration, new TestDirectorySecurity());
        await options.SaveAsync(AgentOptions.CreateDefault() with { ClientName = "client-name", DeviceId = "device-id" });
        Directory.CreateDirectory(paths.Logs);
        await File.WriteAllTextAsync(Path.Combine(paths.Logs, "agent-20260723.log"), "safe-log-line");
        Directory.CreateDirectory(paths.PendingQueue);
        await File.WriteAllTextAsync(Path.Combine(paths.PendingQueue, "snapshot.json"), "RAW-SNAPSHOT-MARKER");
        FakeTokenStore token = new("DEVICE-TOKEN-MARKER");
        DiagnosticsCollector collector = new(
            paths,
            options,
            token,
            new FixedMachineGuidSource("machine-guid"),
            new FakeQueue(),
            new CollectorState(),
            "1.2.3",
            "4.5.6",
            () => new DateTimeOffset(2026, 7, 23, 21, 0, 0, TimeSpan.Zero));

        string path = await collector.CollectAsync();

        using ZipArchive archive = ZipFile.OpenRead(path);
        Assert.Equal(
            new[] { "configuration.json", "logs/agent-20260723.log", "status.json" },
            archive.Entries.Select(entry => entry.FullName).OrderBy(name => name).ToArray());
        string allText = string.Join('\n', archive.Entries.Select(ReadEntry));
        Assert.DoesNotContain("DEVICE-TOKEN-MARKER", allText);
        Assert.DoesNotContain("RAW-SNAPSHOT-MARKER", allText);
        Assert.Contains("safe-log-line", allText);
        Assert.Contains("\"hasCredential\": true", allText);
    }

    [Fact]
    public void RollingLoggerRedactsKnownSecretsAndPreventsLineInjection()
    {
        string logs = Path.Combine(directory, "logs");
        RedactingLogger logger = new(logs, retainedFiles: 2, maximumFileBytes: 1000, utcNow: () => DateTimeOffset.UnixEpoch);

        logger.Write("INFO", "pairing", "token=SECRET\r\nforged", new[] { "SECRET" });

        string text = File.ReadAllText(Assert.Single(Directory.EnumerateFiles(logs)));
        Assert.DoesNotContain("SECRET", text);
        Assert.Contains("[REDACTED]  forged", text);
        Assert.Single(text.Split(Environment.NewLine, StringSplitOptions.RemoveEmptyEntries));
    }

    public void Dispose()
    {
        if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
    }

    private static string ReadEntry(ZipArchiveEntry entry)
    {
        using StreamReader reader = new(entry.Open());
        return reader.ReadToEnd();
    }

    private sealed class FakeQueue : ICollectorQueue
    {
        public Task<QueueEnqueueResult> EnqueueAsync(AutoExportSnapshotV1 snapshot, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueRecoveryResult> RecoverAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> ClaimNextAsync(CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> RetryAsync(QueueItem item, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> CompleteAsync(QueueItem item, string batchId, string hash, DateTimeOffset at, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueItem> QuarantineAsync(QueueItem item, string code, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QueueStatus> GetStatusAsync(CancellationToken cancellationToken = default) => Task.FromResult(new QueueStatus(1, 0, 2, 0, 256, false));
        public Task<QueueCleanupResult> CleanupAsync(DateTimeOffset now, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }

    private sealed class FakeTokenStore : IDeviceTokenStore
    {
        private string token;
        public FakeTokenStore(string token) => this.token = token;
        public Task SaveTokenAsync(string value, CancellationToken cancellationToken = default) { token = value; return Task.CompletedTask; }
        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult(token);
        public Task DeleteTokenAsync(CancellationToken cancellationToken = default) { token = null; return Task.CompletedTask; }
    }

    private sealed class FixedMachineGuidSource : IMachineGuidSource
    {
        private readonly string value;
        public FixedMachineGuidSource(string value) => this.value = value;
        public string ReadMachineGuid() => value;
    }

    private sealed class TestDirectorySecurity : IAgentDirectorySecurity
    {
        public void EnsureProtected(string path) => Directory.CreateDirectory(path);
    }
}
