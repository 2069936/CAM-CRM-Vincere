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
 *   - Nothing that authenticates leaves the machine. Two rules, because there
 *     are two kinds of file: SecretRedactor for the JSON config, by key name,
 *     and TraceRedactor for the trace and log text, by measured line shape.
 *     TraceRedactor's header says why one could not do both jobs.
 *   - The database in the package holds only the allowlisted tables. It is a
 *     new file built from the consistent copy, not the copy itself, and the
 *     copy is made OUTSIDE the staging folder that becomes the ZIP so the
 *     unfiltered file is never in the package for a single step. See
 *     SqliteSnapshot's header for what that costs and what it buys.
 *   - It is the ONLY copy of those tables in the package. db/ holds the
 *     database and the schema, and each allowlisted table appears in it once.
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
        // A SIBLING OF STAGING, NOT A CHILD. The consistent copy of the database
        // holds every table NinjaTrader has; only the filtered one belongs in the
        // package. staging is what gets zipped, so the unfiltered copy is kept
        // out of it entirely rather than put there and tidied up afterwards.
        string working = Path.Combine(outputRoot, $".work_{stamp}");
        Directory.CreateDirectory(staging);
        Directory.CreateDirectory(working);
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

            // database, attribution, config, manifest: four steps beside the
            // folder sources, and the bar has to know about all of them or it
            // reports 105% on the way past the last one.
            int total = DeepExportSources.All.Count + 4;
            int done = 0;
            void Report(string source)
            {
                log.Add($"{now():HH:mm:ss} {source} done ({stopwatch.ElapsedMilliseconds} ms)");
                progress?.Report(new DeepExportProgress(source, ++done, total));
            }
            log.Add($"{started:o} deep export started; NinjaTrader at {ninjaTraderRoot}; agent data at {agentRoot ?? "(none)"}");

            // 1. The database: one consistent copy to work from, and a filtered
            //    one to ship. workingCopy holds every table and never enters the
            //    package; copyPath is built from it by the allowlist.
            SqliteSnapshotResult database = null;
            SqliteFilterResult filter = null;
            string livePath = Path.GetFullPath(Path.Combine(ninjaTraderRoot, DeepExportSources.DatabaseRelativePath));
            string workingCopy = Path.Combine(working, "NinjaTrader.sqlite");
            string copyPath = Path.Combine(staging, "db", "NinjaTrader.sqlite");
            if (File.Exists(livePath))
            {
                string method = SqliteSnapshot.Copy(livePath, workingCopy, warnings);
                filter = SqliteSnapshot.CopyAllowedTables(workingCopy, copyPath, warnings);
                // DESCRIBED FROM THE FILE THAT SHIPS. Row counts, size and the
                // executions range are read off the filtered database, so the
                // manifest cannot describe a file the reader does not have.
                if (filter != null) database = SqliteSnapshot.Describe(copyPath, method, warnings);
                try
                {
                    Directory.CreateDirectory(Path.Combine(staging, "db"));
                    // THE SCHEMA OF ALL OF IT, from the working copy, and that is
                    // deliberate. It is DDL and nothing else - measured on a real
                    // export: 21 CREATE TABLE and 24 CREATE INDEX statements, no
                    // views, no triggers, not one quoted literal and not one
                    // DEFAULT clause, so there is no value in it to leak. What it
                    // does carry is the record that 21 tables existed, which is
                    // the only evidence in the package that the allowlist did
                    // anything; a reader who diffs it against the shipped
                    // database learns exactly which 9 were withheld. The manifest
                    // names them outright so nobody has to.
                    await File.WriteAllTextAsync(Path.Combine(staging, "db", "schema.sql"), SqliteSnapshot.ReadSchema(workingCopy), cancellationToken).ConfigureAwait(false);
                    // AND NOTHING ELSE. db/tables/*.jsonl used to be written here,
                    // one file per allowlisted table, dumped from copyPath - the
                    // same file that is already in the package. So db/ carried the
                    // same 12 tables twice and the JSONL was the lossy half of the
                    // pair. It is gone; SqliteSnapshot's header has the numbers and
                    // the argument for one artefact rather than two.
                }
                catch (Exception exception) when (exception is not OperationCanceledException)
                {
                    warnings.Add($"schema could not be written: {exception.GetType().Name}");
                }
            }
            else
            {
                warnings.Add("database not found at " + DeepExportSources.DatabaseRelativePath);
            }
            Report("database");

            // 1b. WHICH ALGORITHM PLACED WHAT, worked out here rather than
            // shipped as tables for somebody else to join. The join mostly
            // fails anyway: NinjaTrader cascades Strategy2Order away every time
            // a strategy is removed, so a real machine holds a few dozen links
            // against tens of thousands of orders. This reads the template
            // catalogue, reconstructs the trades, and writes the answer, and it
            // accumulates every link the platform has ever shown us so the
            // cascade cannot take back what we have already seen.
            //
            // IT READS THE WORKING COPY, NOT THE SHIPPED ONE, and it has to: the
            // join goes through Instruments and MasterInstruments to turn an
            // order's integer instrument id into a symbol, and both are withheld
            // from the package. That is a need during the run, not a reason to
            // ship them - this step resolves the symbols so the reader does not
            // have to. It therefore has to run before the working copy is gone.
            AttributionSummary attribution = !File.Exists(workingCopy)
                ? null
                : AttributionExport.Write(
                    staging,
                    ninjaTraderRoot,
                    workingCopy,
                    agentRoot == null ? null : Path.Combine(agentRoot, "attribution-ledger.jsonl"),
                    warnings);
            Report("attribution");

            // 2. Every file source. A missing folder is a warning and nothing more.
            //
            // THE TRACE AND THE LOGS ARE REDACTED HERE, IN THE COPY ITSELF, and
            // not in a tidying pass afterwards. The broker login appears 2,179
            // times across those two folders, and a staged file that holds it
            // even briefly is a file that ships with it the day somebody moves
            // the pass or returns early. Redaction is part of how the bytes
            // arrive or it is not a guarantee. It also has to precede step 4,
            // which hashes whatever is on disk into the manifest.
            foreach (DeepExportSource source in DeepExportSources.All)
            {
                cancellationToken.ThrowIfCancellationRequested();
                int copied = 0;
                bool redacted = TraceRedactor.AppliesTo(source);
                try
                {
                    foreach ((string fullPath, string zipRelative) in DeepExportSources.Enumerate(ninjaTraderRoot, agentRoot, source))
                    {
                        string target = Path.Combine(staging, zipRelative.Replace('/', Path.DirectorySeparatorChar));
                        Directory.CreateDirectory(Path.GetDirectoryName(target));
                        using (FileStream input = new(fullPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete))
                        using (FileStream output = File.Create(target))
                        {
                            if (redacted)
                                await TraceRedactor.RedactTextStreamAsync(input, output, cancellationToken).ConfigureAwait(false);
                            else
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
                    // WHAT IS NOT IN THE FILE, BY NAME. rowCounts only ever
                    // listed the allowed tables, so for as long as the whole
                    // database shipped, the manifest described 12 tables while
                    // the file beside it held 21 and nothing said so. An analyst
                    // reads this before anything else; it has to account for the
                    // gap rather than leave it to be discovered.
                    tablesShipped = filter.TablesShipped,
                    tablesWithheld = filter.TablesWithheld,
                },
                attribution = attribution == null ? null : new
                {
                    templates = attribution.Templates,
                    trades = attribution.Trades,
                    inferred = attribution.Inferred,
                    versioned = attribution.Versioned,
                    recorded = attribution.Recorded,
                    ledgerOrders = attribution.LedgerOrders,
                    orders = attribution.Orders,
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
            // The unfiltered copy was never in the package and does not stay on
            // the disk either. Deleted on the failure path too, which is the one
            // that matters: an aborted run must not leave 21 tables in a folder
            // beside the packages somebody zips by hand.
            try { Directory.Delete(working, recursive: true); } catch (Exception) { }
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
