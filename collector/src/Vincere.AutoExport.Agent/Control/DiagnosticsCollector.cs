using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Service;

namespace Vincere.AutoExport.Agent.Control;

public sealed class DiagnosticsCollector : IDiagnosticsCollector
{
    private const int MaximumLogBytes = 1024 * 1024;
    private static readonly UTF8Encoding Utf8WithoutBom = new(false);
    private readonly AgentPaths paths;
    private readonly IAgentOptionsStore optionsStore;
    private readonly IDeviceTokenStore tokenStore;
    private readonly IMachineGuidSource machineGuidSource;
    private readonly ICollectorQueue queue;
    private readonly CollectorState state;
    private readonly string agentVersion;
    private readonly string addonVersion;
    private readonly Func<DateTimeOffset> utcNow;

    public DiagnosticsCollector(
        AgentPaths paths,
        IAgentOptionsStore optionsStore,
        IDeviceTokenStore tokenStore,
        IMachineGuidSource machineGuidSource,
        ICollectorQueue queue,
        CollectorState state,
        string agentVersion,
        string addonVersion,
        Func<DateTimeOffset> utcNow = null)
    {
        this.paths = paths ?? throw new ArgumentNullException(nameof(paths));
        this.optionsStore = optionsStore ?? throw new ArgumentNullException(nameof(optionsStore));
        this.tokenStore = tokenStore ?? throw new ArgumentNullException(nameof(tokenStore));
        this.machineGuidSource = machineGuidSource ?? throw new ArgumentNullException(nameof(machineGuidSource));
        this.queue = queue ?? throw new ArgumentNullException(nameof(queue));
        this.state = state ?? throw new ArgumentNullException(nameof(state));
        this.agentVersion = agentVersion ?? throw new ArgumentNullException(nameof(agentVersion));
        this.addonVersion = addonVersion ?? throw new ArgumentNullException(nameof(addonVersion));
        this.utcNow = utcNow ?? (() => DateTimeOffset.UtcNow);
    }

    public async Task<string> CollectAsync(CancellationToken cancellationToken = default)
    {
        DateTimeOffset now = utcNow();
        AgentOptions options = (await optionsStore.LoadAsync(cancellationToken).ConfigureAwait(false)).Options;
        bool hasCredential = !string.IsNullOrWhiteSpace(
            await tokenStore.LoadTokenAsync(cancellationToken).ConfigureAwait(false));
        RedactedAgentState redacted = RedactedAgentState.From(
            options,
            hasCredential,
            MachineIdentity.HashForDiagnostics(machineGuidSource.ReadMachineGuid()));
        QueueStatus queueStatus = await queue.GetStatusAsync(cancellationToken).ConfigureAwait(false);

        string diagnosticsDirectory = Path.Combine(paths.Root, "diagnostics");
        Directory.CreateDirectory(diagnosticsDirectory);
        string finalPath = Path.Combine(diagnosticsDirectory, $"Vincere-AutoExport-{now:yyyyMMdd-HHmmss}.zip");
        string temporaryPath = finalPath + ".tmp";
        if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        try
        {
            await using (FileStream output = new(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.ReadWrite,
                FileShare.None))
            {
                using (ZipArchive archive = new(output, ZipArchiveMode.Create, leaveOpen: true))
                {
                    WriteJson(archive, "configuration.json", redacted);
                    WriteJson(archive, "status.json", new
                    {
                        generatedAt = now,
                        agentVersion,
                        addonVersion,
                        runtime = state.Snapshot(),
                        queue = queueStatus,
                    });
                    AddBoundedLogs(archive);
                }
                await output.FlushAsync(cancellationToken).ConfigureAwait(false);
                output.Flush(true);
            }
            File.Move(temporaryPath, finalPath, true);
            return finalPath;
        }
        finally
        {
            if (File.Exists(temporaryPath)) File.Delete(temporaryPath);
        }
    }

    private void AddBoundedLogs(ZipArchive archive)
    {
        if (!Directory.Exists(paths.Logs)) return;
        foreach (string path in Directory.EnumerateFiles(paths.Logs, "agent-*.log")
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .Take(5))
        {
            byte[] bytes = File.ReadAllBytes(path);
            int offset = Math.Max(0, bytes.Length - MaximumLogBytes);
            ZipArchiveEntry entry = archive.CreateEntry("logs/" + Path.GetFileName(path), CompressionLevel.Optimal);
            using Stream target = entry.Open();
            target.Write(bytes, offset, bytes.Length - offset);
        }
    }

    private static void WriteJson(ZipArchive archive, string name, object value)
    {
        ZipArchiveEntry entry = archive.CreateEntry(name, CompressionLevel.Optimal);
        using Stream stream = entry.Open();
        byte[] bytes = Utf8WithoutBom.GetBytes(JsonConvert.SerializeObject(value, Formatting.Indented));
        stream.Write(bytes, 0, bytes.Length);
    }
}
