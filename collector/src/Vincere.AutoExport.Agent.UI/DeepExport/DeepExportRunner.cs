using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;

namespace Vincere.AutoExport.Agent.UI.DeepExport;

/* ---------------------------------------------------------------------------
 * One package with everything this NinjaTrader remembers about a client.
 *
 * The daily capture answers "what happened today". This answers "what has
 * happened on this machine, ever", for the day a client's history needs to be
 * read end to end: the first case was an account that had to be reconstructed
 * by hand from a week of Discord messages.
 *
 * WHAT IT PROMISES.
 *   - It never writes into NinjaTrader's folders. The output goes to
 *     AutoExport\deep and a copy to the Desktop.
 *   - It never blocks the platform. The database is read through the SQLite
 *     backup API and everything else is a file copy at BelowNormal priority.
 *   - A source that fails is a warning in the manifest, not an abort. The only
 *     abort is being unable to write the ZIP itself.
 *   - Nothing that authenticates leaves the machine. See SecretRedactor.
 *   - Two runs produce two independent packages. Nothing is modified.
 *
 * WHAT IT DOES NOT DO. It does not analyse. The package is raw material plus a
 * manifest that says what is in it and how far the executions reach, which is
 * the first thing anyone opens to know whether the export is worth reading.
 * ------------------------------------------------------------------------- */
public sealed record DeepExportEnvironment(
    string MachineId,
    string Hostname,
    string AgentVersion,
    string AddonVersion,
    string NinjaTraderVersion,
    bool NinjaTraderRunning,
    string TimeZone);

public sealed record DeepExportProgress(string Source, int Completed, int Total);

public sealed record DeepExportResult(
    string ZipPath,
    string Sha256,
    long SizeBytes,
    IReadOnlyList<string> Warnings,
    TimeSpan Duration);

public sealed class DeepExportRunner
{
    public const int KeepMostRecent = 3;
    public const long WarnAboveBytes = 500L * 1024 * 1024;

    private readonly string ninjaTraderRoot;
    private readonly string agentRoot;
    private readonly string outputRoot;
    private readonly string desktopCopyRoot;
    private readonly string agentConfigPath;
    private readonly DeepExportEnvironment environment;
    private readonly Func<DateTimeOffset> now;

    /// <param name="ninjaTraderRoot">Documents\NinjaTrader 8.</param>
    /// <param name="agentRoot">%ProgramData%\Vincere\AutoExport. The queue and config.json live here, not under NinjaTrader.</param>
    public DeepExportRunner(
        string ninjaTraderRoot,
        string agentRoot,
        string outputRoot,
        string desktopCopyRoot,
        DeepExportEnvironment environment,
        Func<DateTimeOffset> now = null)
    {
        this.ninjaTraderRoot = ninjaTraderRoot ?? throw new ArgumentNullException(nameof(ninjaTraderRoot));
        this.agentRoot = agentRoot;
        this.outputRoot = outputRoot ?? throw new ArgumentNullException(nameof(outputRoot));
        this.desktopCopyRoot = desktopCopyRoot;
        this.agentConfigPath = agentRoot == null ? null : Path.Combine(agentRoot, "config.json");
        this.environment = environment ?? throw new ArgumentNullException(nameof(environment));
        this.now = now ?? (() => DateTimeOffset.Now);
    }

    public async Task<DeepExportResult> RunAsync(
        IProgress<DeepExportProgress> progress = null,
        CancellationToken cancellationToken = default)
    {
        Stopwatch stopwatch = Stopwatch.StartNew();
        var warnings = new List<string>();
        var files = new List<object>();
        var log = new List<string>();
        DateTimeOffset started = now();
        string stamp = started.ToString("yyyyMMdd-HHmmss");
        string machine8 = (environment.MachineId ?? "unknown").Replace("|", "-");
        machine8 = machine8.Length > 8 ? machine8.Substring(0, 8) : machine8;
        Directory.CreateDirectory(outputRoot);
        string zipPath = Path.Combine(outputRoot, $"deep_{machine8}_{stamp}.zip");
        string staging = Path.Combine(outputRoot, $".staging_{stamp}");
        Directory.CreateDirectory(staging);
        ProcessPriorityClass? previousPriority = null;

        try
        {
            // Nothing here is urgent and the machine may be trading.
            try
            {
                previousPriority = Process.GetCurrentProcess().PriorityClass;
                Process.GetCurrentProcess().PriorityClass = ProcessPriorityClass.BelowNormal;
            }
            catch (Exception) { }

            int total = DeepExportSources.All.Count + 3;
            int done = 0;
            void Report(string source)
            {
                log.Add($"{now():HH:mm:ss} {source} done ({stopwatch.ElapsedMilliseconds} ms)");
                progress?.Report(new DeepExportProgress(source, ++done, total));
            }
            log.Add($"{started:o} deep export started; NinjaTrader at {ninjaTraderRoot}; agent data at {agentRoot ?? "(none)"}");

            // 1. The database, consistently.
            SqliteSnapshotResult database = null;
            string livePath = Path.Combine(ninjaTraderRoot, DeepExportSources.DatabaseRelativePath);
            string copyPath = Path.Combine(staging, "db", "NinjaTrader.sqlite");
            if (File.Exists(livePath))
            {
                string method = SqliteSnapshot.Copy(livePath, copyPath, warnings);
                database = SqliteSnapshot.Describe(copyPath, method, warnings);
                try
                {
                    await File.WriteAllTextAsync(Path.Combine(staging, "db", "schema.sql"), SqliteSnapshot.ReadSchema(copyPath), cancellationToken).ConfigureAwait(false);
                    Directory.CreateDirectory(Path.Combine(staging, "db", "tables"));
                    foreach (string table in SqliteSnapshot.TablesToDump(copyPath))
                    {
                        using FileStream output = File.Create(Path.Combine(staging, "db", "tables", table + ".jsonl"));
                        SqliteSnapshot.DumpTable(copyPath, table, output);
                    }
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    warnings.Add($"table dump incomplete: {exception.GetType().Name}");
                }
            }
            else
            {
                warnings.Add("database not found at " + DeepExportSources.DatabaseRelativePath);
            }
            Report("database");

            // 2. Every file source. A missing folder is a warning and nothing more.
            foreach (DeepExportSource source in DeepExportSources.All)
            {
                cancellationToken.ThrowIfCancellationRequested();
                int copied = 0;
                try
                {
                    foreach ((string fullPath, string zipRelative) in DeepExportSources.Enumerate(ninjaTraderRoot, agentRoot, source))
                    {
                        string target = Path.Combine(staging, zipRelative.Replace('/', Path.DirectorySeparatorChar));
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        using (FileStream input = new(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                        using (FileStream output = File.Create(target))
                        {
                            await input.CopyToAsync(output, 81920, cancellationToken).ConfigureAwait(false);
                        }
                        copied++;
                    }
                    string folder = DeepExportSources.Folder(ninjaTraderRoot, agentRoot, source);
                    if (copied == 0 && (folder == null || !Directory.Exists(folder)))
                        warnings.Add($"{source.Name} folder missing");
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    warnings.Add($"{source.Name}: {exception.GetType().Name} after {copied} files");
                }
                Report(source.Name);
            }

            // 3. The agent's own configuration, with nothing that authenticates.
            if (!string.IsNullOrEmpty(agentConfigPath) && File.Exists(agentConfigPath))
            {
                try
                {
                    string raw = await File.ReadAllTextAsync(agentConfigPath, cancellationToken).ConfigureAwait(false);
                    Directory.CreateDirectory(Path.Combine(staging, "config"));
                    await File.WriteAllTextAsync(
                        Path.Combine(staging, "config", "agent.config.redacted.json"),
                        SecretRedactor.RedactJsonText(raw), cancellationToken).ConfigureAwait(false);
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    warnings.Add($"agent config: {exception.GetType().Name}");
                }
            }
            Report("config");

            // 4. Hash every staged file for the manifest, then the manifest itself.
            foreach (string path in Directory.EnumerateFiles(staging, "*", SearchOption.AllDirectories).OrderBy(p => p, StringComparer.OrdinalIgnoreCase))
            {
                string relative = Path.GetRelativePath(staging, path).Replace(Path.DirectorySeparatorChar, '/');
                files.Add(new { path = relative, sizeBytes = new FileInfo(path).Length, sha256 = HashFile(path) });
            }
            var manifest = new
            {
                schemaVersion = 1,
                kind = "deep_export",
                exportId = Guid.NewGuid().ToString("D"),
                createdAt = started.ToString("o"),
                timeZone = environment.TimeZone,
                source = new
                {
                    machineId = environment.MachineId,
                    hostname = environment.Hostname,
                    agentVersion = environment.AgentVersion,
                    addonVersion = environment.AddonVersion,
                    ninjaTraderVersion = environment.NinjaTraderVersion,
                    ninjaTraderRunning = environment.NinjaTraderRunning,
                    ntDocumentsPath = ninjaTraderRoot,
                    agentDataPath = agentRoot,
                },
                db = database == null ? null : new
                {
                    copyMethod = database.CopyMethod,
                    sizeBytes = database.SizeBytes,
                    sha256 = File.Exists(copyPath) ? HashFile(copyPath) : null,
                    rowCounts = database.RowCounts,
                    executionsRange = new { min = database.ExecutionsMin, max = database.ExecutionsMax },
                },
                files,
                warnings,
                durationMs = stopwatch.ElapsedMilliseconds,
            };
            await File.WriteAllTextAsync(
                Path.Combine(staging, "manifest.json"),
                JsonConvert.SerializeObject(manifest, Formatting.Indented), cancellationToken).ConfigureAwait(false);
            Report("manifest");

            // 5. The ZIP, its checksum beside it, and a copy where the operator will look.
            if (File.Exists(zipPath)) File.Delete(zipPath);
            ZipFile.CreateFromDirectory(staging, zipPath, CompressionLevel.Optimal, includeBaseDirectory: false);
            long size = new FileInfo(zipPath).Length;
            string sha = HashFile(zipPath);
            await File.WriteAllTextAsync(zipPath + ".sha256", $"{sha}  {Path.GetFileName(zipPath)}\n", cancellationToken).ConfigureAwait(false);
            if (size > WarnAboveBytes) warnings.Add($"package is {size / (1024 * 1024)} MB; trace folders are usually the reason");

            if (!string.IsNullOrEmpty(desktopCopyRoot))
            {
                try
                {
                    Directory.CreateDirectory(desktopCopyRoot);
                    File.Copy(zipPath, Path.Combine(desktopCopyRoot, Path.GetFileName(zipPath)), overwrite: true);
                    File.Copy(zipPath + ".sha256", Path.Combine(desktopCopyRoot, Path.GetFileName(zipPath) + ".sha256"), overwrite: true);
                }
                catch (Exception exception)
                {
                    warnings.Add($"desktop copy: {exception.GetType().Name}");
                }
            }

            Retain();
            stopwatch.Stop();
            log.Add($"package {Path.GetFileName(zipPath)} {size} bytes sha256 {sha}");
            return new DeepExportResult(zipPath, sha, size, warnings, stopwatch.Elapsed);
        }
        catch (Exception exception)
        {
            log.Add($"failed: {exception.GetType().Name}: {exception.Message}");
            throw;
        }
        finally
        {
            if (previousPriority.HasValue)
            {
                try { Process.GetCurrentProcess().PriorityClass = previousPriority.Value; } catch (Exception) { }
            }
            try { Directory.Delete(staging, recursive: true); } catch (Exception) { }
            // The run's own account of itself, beside the package. Warnings
            // are the part worth reading when something looks thin.
            foreach (string warning in warnings) log.Add("warning: " + warning);
            try { File.WriteAllLines(Path.Combine(outputRoot, $"deep_{stamp}.log"), log); } catch (Exception) { }
        }
    }

    /// <summary>Keep the last few packages in the output folder. The Desktop copy is the operator's to manage.</summary>
    private void Retain()
    {
        try
        {
            var packages = Directory.EnumerateFiles(outputRoot, "deep_*.zip")
                .OrderByDescending(p => p, StringComparer.OrdinalIgnoreCase)
                .Skip(KeepMostRecent)
                .ToList();
            foreach (string old in packages)
            {
                File.Delete(old);
                if (File.Exists(old + ".sha256")) File.Delete(old + ".sha256");
            }
            foreach (string old in Directory.EnumerateFiles(outputRoot, "deep_*.log")
                .OrderByDescending(p => p, StringComparer.OrdinalIgnoreCase)
                .Skip(KeepMostRecent + 1))
            {
                File.Delete(old);
            }
        }
        catch (Exception) { }
    }

    public static string HashFile(string path)
    {
        using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }
}
