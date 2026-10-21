using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.UI.DeepExport;
using Vincere.AutoExport.Agent.Updates;

namespace Vincere.AutoExport.Agent.Exports;

public interface ITradingExportBuilder
{
    /// <summary>Builds the file the plan describes. Never throws for an ordinary failure; cancellation is the exception.</summary>
    Task<TradingExportBuild> BuildAsync(TradingExportPlan plan, CancellationToken cancellationToken);
}

/// <summary>
/// The built file, or why there is none. Disposing it deletes the folder the file
/// was built in, which is how "deleted after upload" is kept on every path.
/// </summary>
public sealed class TradingExportBuild : IDisposable
{
    private TradingExportBuild(string errorCode, string filePath, string workDirectory, string sha256, long byteSize, ExportRowCounts rowCounts)
    {
        ErrorCode = errorCode;
        FilePath = filePath;
        WorkDirectory = workDirectory;
        Sha256 = sha256;
        ByteSize = byteSize;
        RowCounts = rowCounts;
    }

    public static TradingExportBuild Failure(string code) => new(code, null, null, null, 0, null);

    public static TradingExportBuild Success(string filePath, string workDirectory, string sha256, long byteSize, ExportRowCounts rowCounts)
        => new(null, filePath, workDirectory, sha256, byteSize, rowCounts);

    public bool Ok => ErrorCode == null;
    public string ErrorCode { get; }
    public string FilePath { get; }
    public string WorkDirectory { get; }
    public string Sha256 { get; }
    public long ByteSize { get; }
    public ExportRowCounts RowCounts { get; }

    public void Dispose()
    {
        if (WorkDirectory == null) return;
        try
        {
            if (Directory.Exists(WorkDirectory)) Directory.Delete(WorkDirectory, recursive: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            // Left for the next build's sweep of stale work folders.
        }
    }
}

/* ---------------------------------------------------------------------------
 * THE SLIM TRADING EXPORT: ONE GZIP OF JSON LINES, BUILT UNDER ProgramData.
 *
 * The Deep Export answers "everything this machine remembers" for a person at
 * the VPS. This answers the CRM's narrower question - the trading over a range
 * of days - without anyone at the VPS, so it is built from the same parts and
 * ships none of what made the Deep Export heavy or dangerous:
 *
 *   the database    copied by SqliteSnapshot, through the backup API while
 *                   NinjaTrader holds it, as plain bytes while it is at rest -
 *                   CopyLeavingSourceFolderUntouched says why - into a work
 *                   folder here; read; deleted before the file is even written.
 *                   The copy holds every table and never leaves this folder.
 *   executions, orders
 *                   allowlisted fields of the copy's rows in the range.
 *   strategies      each stored instance's configuration, every secret-named
 *                   value masked by the existing rules; see
 *                   StrategyConfigurationReader.
 *   trades          AttributionExport's reconstruction, the same rows the Deep
 *                   Export's attribution/trades.jsonl carries, in the range.
 *
 * NOT IN IT: logs, traces, workspaces, the templates folder, the agent's queue
 * or configuration, the database file, any path, any machine or Windows user
 * name. Account names are, because the CRM already holds them.
 *
 * WHERE IT WRITES. Only under ProgramData\Vincere\AutoExport: exports\work-*
 * for the copy and the file, which go when the build is disposed after the
 * upload, and the attribution ledger beside the queue, which AttributionExport
 * has always kept there. NinjaTrader's folders are read and never written; the
 * test suite holds that by hashing the fixture's NinjaTrader folder before and
 * after a build.
 *
 * NEVER IN THE PLATFORM'S WAY. The work runs on its own thread at BelowNormal
 * priority, so the trading platform's threads always come first, and it refuses
 * to start unless the ProgramData drive keeps half a gigabyte free beyond twice
 * the database and the largest file allowed: a full disk under a live trading
 * database is a far worse outcome than an export that did not happen.
 *
 * THE MANIFEST COMES FIRST AND KNOWS ITS COUNTS. The rows are read into memory
 * (tens of thousands on the largest machine measured), counted, and then written
 * after the manifest line, so a reader learns what the file holds from line one.
 * ------------------------------------------------------------------------- */
public sealed class TradingExportBuilder : ITradingExportBuilder
{
    /// <summary>What the ProgramData drive must keep free beyond the export's own needs.</summary>
    public const long DiskMargin = 512L * 1024 * 1024;

    public const string FileName = "trading-export.jsonl.gz";
    public const string WorkFolderPrefix = "work-";

    private readonly INinjaTraderFolderLocator locator;
    private readonly string exportsRoot;
    private readonly string agentRoot;
    private readonly IUpdateDisk disk;
    private readonly IAgentDirectorySecurity directorySecurity;
    private readonly string agentVersion;
    private readonly Func<string> ninjaTraderVersion;
    private readonly Func<DateTimeOffset> utcNow;

    /* No optional parameters, for the reason AgentUpdateLoop gives: a builder
     * registered without one of these would still compile. */
    public TradingExportBuilder(
        INinjaTraderFolderLocator locator,
        string exportsRoot,
        string agentRoot,
        IUpdateDisk disk,
        IAgentDirectorySecurity directorySecurity,
        string agentVersion,
        Func<string> ninjaTraderVersion,
        Func<DateTimeOffset> utcNow)
    {
        this.locator = locator ?? throw new ArgumentNullException(nameof(locator));
        if (string.IsNullOrWhiteSpace(exportsRoot)) throw new ArgumentException("An exports folder is required.", nameof(exportsRoot));
        if (string.IsNullOrWhiteSpace(agentRoot)) throw new ArgumentException("The agent's data folder is required.", nameof(agentRoot));
        this.exportsRoot = Path.GetFullPath(exportsRoot);
        this.agentRoot = Path.GetFullPath(agentRoot);
        this.disk = disk ?? throw new ArgumentNullException(nameof(disk));
        this.directorySecurity = directorySecurity ?? throw new ArgumentNullException(nameof(directorySecurity));
        this.agentVersion = string.IsNullOrWhiteSpace(agentVersion) ? throw new ArgumentException("A version is required.", nameof(agentVersion)) : agentVersion;
        this.ninjaTraderVersion = ninjaTraderVersion ?? throw new ArgumentNullException(nameof(ninjaTraderVersion));
        this.utcNow = utcNow ?? throw new ArgumentNullException(nameof(utcNow));
    }

    public string ExportsRoot => exportsRoot;

    /// <summary>On a thread of its own at BelowNormal priority, so the platform's threads come first.</summary>
    public Task<TradingExportBuild> BuildAsync(TradingExportPlan plan, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var done = new TaskCompletionSource<TradingExportBuild>(TaskCreationOptions.RunContinuationsAsynchronously);
        var thread = new Thread(() =>
        {
            try
            {
                done.TrySetResult(Build(plan, cancellationToken));
            }
            catch (OperationCanceledException)
            {
                done.TrySetCanceled(cancellationToken);
            }
            catch (Exception exception)
            {
                done.TrySetException(exception);
            }
        })
        {
            IsBackground = true,
            Name = "trading-export",
            Priority = ThreadPriority.BelowNormal,
        };
        thread.Start();
        return done.Task;
    }

    /// <summary>The build itself, on the calling thread.</summary>
    public TradingExportBuild Build(TradingExportPlan plan, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(plan);
        string work = null;
        try
        {
            directorySecurity.EnsureProtected(exportsRoot);
            RemoveStaleWork();

            NinjaTraderFolderLookup lookup = locator.Locate();
            if (!lookup.Found) return TradingExportBuild.Failure(lookup.ErrorCode);
            string live = Path.GetFullPath(Path.Combine(lookup.Folder, DeepExportSources.DatabaseRelativePath));
            if (!File.Exists(live)) return TradingExportBuild.Failure(TradingExportErrorCodes.DatabaseNotFound);

            long databaseBytes = SizeOf(live) + SizeOf(live + "-wal");
            if (disk.GetAvailableFreeBytes(exportsRoot) < 2 * databaseBytes + plan.MaxBytes + DiskMargin)
                return TradingExportBuild.Failure(TradingExportErrorCodes.DiskSpace);

            work = Path.Combine(exportsRoot, WorkFolderPrefix + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(work);
            string copy = Path.Combine(work, "NinjaTrader.sqlite");
            var warnings = new SortedSet<string>(StringComparer.Ordinal);
            string method;
            try
            {
                method = SqliteSnapshot.CopyLeavingSourceFolderUntouched(live, copy, new List<string>());
            }
            catch (Exception exception) when (exception is SqliteException or IOException or UnauthorizedAccessException)
            {
                return TradingExportBuild.Failure(TradingExportErrorCodes.DatabaseUnreadable);
            }
            // The backup API failed and Copy fell back to the raw files of a
            // database in use: possibly inconsistent, and the reader is told.
            if (method == "raw") warnings.Add("database_copy_raw");
            if (!IntegrityHolds(copy)) return TradingExportBuild.Failure(TradingExportErrorCodes.DatabaseUnreadable);
            cancellationToken.ThrowIfCancellationRequested();

            AttributionReading attribution = null;
            if (plan.Wants(TradingExportDatasets.Trades) || plan.Wants(TradingExportDatasets.Strategies))
            {
                // Its warnings are free text with type names in them; the file
                // carries a fixed word instead.
                var attributionWarnings = new List<string>();
                attribution = AttributionExport.Read(
                    lookup.Folder,
                    copy,
                    Path.Combine(agentRoot, "attribution-ledger.jsonl"),
                    attributionWarnings);
                if (attribution == null) warnings.Add("attribution_unavailable");
            }

            TradingExportContent content = TradingExportReader.Read(copy, plan, attribution, cancellationToken);
            warnings.UnionWith(content.Warnings);
            DeleteDatabase(copy);
            cancellationToken.ThrowIfCancellationRequested();

            string file = Path.Combine(work, FileName);
            ExportRowCounts counts = new(
                content.Executions.Count, content.Orders.Count, content.Strategies.Count, content.Trades.Count);
            Write(file, plan, content, counts, warnings, cancellationToken);
            long size = new FileInfo(file).Length;
            if (size > plan.MaxBytes) return TradingExportBuild.Failure(TradingExportErrorCodes.ExportTooLarge);

            string sha256;
            using (FileStream stream = new(file, FileMode.Open, FileAccess.Read, FileShare.Read))
                sha256 = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
            TradingExportBuild built = TradingExportBuild.Success(file, work, sha256, size, counts);
            work = null; // the build owns the folder now, and deletes it when disposed
            return built;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (TradingExportException exception)
        {
            return TradingExportBuild.Failure(exception.Code);
        }
        catch (SqliteException)
        {
            return TradingExportBuild.Failure(TradingExportErrorCodes.DatabaseUnreadable);
        }
        catch (Exception exception) when (IsDiskFull(exception))
        {
            return TradingExportBuild.Failure(TradingExportErrorCodes.DiskSpace);
        }
        catch (Exception)
        {
            return TradingExportBuild.Failure(TradingExportErrorCodes.ExportFailed);
        }
        finally
        {
            if (work != null) TryDeleteDirectory(work);
        }
    }

    private void Write(
        string file,
        TradingExportPlan plan,
        TradingExportContent content,
        ExportRowCounts counts,
        IReadOnlyCollection<string> warnings,
        CancellationToken cancellationToken)
    {
        using FileStream output = new(file, FileMode.CreateNew, FileAccess.Write, FileShare.None);
        using (GZipStream gzip = new(output, CompressionLevel.Optimal, leaveOpen: true))
        using (StreamWriter text = new(gzip, new UTF8Encoding(false), 65536) { NewLine = "\n" })
        {
            var lines = new JsonLineWriter(text, content.SecretValues, () => output.Position, plan.MaxBytes, cancellationToken);
            lines.Write("manifest", new (string, object)[]
            {
                ("agentVersion", agentVersion),
                ("ninjaTraderVersion", Blank(ninjaTraderVersion())),
                ("from", plan.FromText),
                ("to", plan.ToText),
                ("generatedAt", utcNow().UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", System.Globalization.CultureInfo.InvariantCulture)),
                ("rowCounts", counts),
                ("datasets", plan.Datasets),
                ("warnings", warnings.ToArray()),
            });
            foreach (ExecutionLine line in content.Executions)
            {
                lines.Write(TradingExportDatasets.Executions, new (string, object)[]
                {
                    ("executionRowId", line.RowId),
                    ("executionId", line.ExecutionId),
                    ("orderRowId", line.OrderRowId),
                    ("orderId", line.OrderId),
                    ("time", line.Time),
                    ("accountName", line.AccountName),
                    ("instrument", line.Instrument),
                    ("marketPosition", line.MarketPosition),
                    ("quantity", line.Quantity),
                    ("price", line.Price),
                    ("isEntry", line.IsEntry),
                    ("isExit", line.IsExit),
                    ("name", line.Name),
                    ("commission", line.Commission),
                    ("fee", line.Fee),
                    ("strategyId", line.StrategyId),
                    ("strategyName", line.StrategyName),
                });
            }
            foreach (OrderLine line in content.Orders)
            {
                lines.Write(TradingExportDatasets.Orders, new (string, object)[]
                {
                    ("orderRowId", line.RowId),
                    ("orderId", line.OrderId),
                    ("orderIdHistory", line.OrderIdHistory),
                    ("time", line.Time),
                    ("accountName", line.AccountName),
                    ("instrument", line.Instrument),
                    ("action", line.Action),
                    ("orderType", line.OrderType),
                    ("quantity", line.Quantity),
                    ("filled", line.Filled),
                    ("limitPrice", line.LimitPrice),
                    ("stopPrice", line.StopPrice),
                    ("averageFillPrice", line.AverageFillPrice),
                    ("state", line.State),
                    ("oco", line.Oco),
                    ("name", line.Name),
                    ("strategyId", line.StrategyId),
                    ("strategyName", line.StrategyName),
                });
            }
            foreach (StrategyLine line in content.Strategies)
            {
                lines.Write(TradingExportDatasets.Strategies, new (string, object)[]
                {
                    ("strategyId", line.Id),
                    ("strategyName", line.Name),
                    ("family", line.Family),
                    ("propFirm", line.PropFirm),
                    ("version", line.Version),
                    ("risk", line.Risk),
                    ("accountName", line.AccountName),
                    ("instrument", line.Instrument),
                    ("enabled", line.Enabled),
                    ("parameterStatus", line.Configuration.Status),
                    ("parameters", line.Configuration.Parameters),
                });
            }
            foreach (AttributionTrade trade in content.Trades)
            {
                lines.Write(TradingExportDatasets.Trades, new (string, object)[]
                {
                    ("accountName", trade.Account),
                    ("instrument", trade.Instrument),
                    ("entryOrderRowId", trade.EntryOrderId),
                    ("entryTime", TradingExportTime.FromValue(trade.EntryTime)),
                    ("entryQuantity", trade.EntryQuantity),
                    ("exits", trade.Exits),
                    ("geometry", trade.Geometry),
                    ("basis", trade.Basis),
                    ("strategyName", trade.Strategy),
                    ("family", trade.Family),
                    ("version", trade.Version),
                    ("risk", trade.Risk),
                    ("candidates", trade.Candidates),
                });
            }
        }
        output.Flush(flushToDisk: true);
    }

    /// <summary>The copy reads back whole, or it is not used.</summary>
    private static bool IntegrityHolds(string copy)
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = copy,
            Mode = SqliteOpenMode.ReadOnly,
            Pooling = false,
        }.ConnectionString);
        connection.Open();
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "PRAGMA quick_check";
        return string.Equals(command.ExecuteScalar() as string, "ok", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>A crash leaves a work folder; the next build sweeps it. Only folders this class names.</summary>
    private void RemoveStaleWork()
    {
        if (!Directory.Exists(exportsRoot)) return;
        foreach (string folder in Directory.EnumerateDirectories(exportsRoot, WorkFolderPrefix + "*"))
            TryDeleteDirectory(folder);
    }

    private static void DeleteDatabase(string copy)
    {
        foreach (string suffix in new[] { "", "-wal", "-shm", "-journal" })
        {
            if (File.Exists(copy + suffix)) File.Delete(copy + suffix);
        }
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
        }
    }

    private static long SizeOf(string path) => File.Exists(path) ? new FileInfo(path).Length : 0;

    private static string Blank(string value) => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    // ERROR_DISK_FULL and ERROR_HANDLE_DISK_FULL on Windows, ENOSPC elsewhere: UpdatePackageStager's test.
    private static bool IsDiskFull(Exception exception)
    {
        if (exception is not IOException) return false;
        int code = exception.HResult & 0xFFFF;
        return code is 0x70 or 0x27 || exception.HResult == 28;
    }
}

/* ONE JSON OBJECT PER LINE, EVERY STRING SWEPT FOR A KNOWN SECRET ON THE WAY OUT.
 *
 * The sweep is the last line of StrategyConfigurationReader's rule: a value it
 * masked under a secret name is replaced wherever else it appears, in a strategy
 * parameter, an order name or a field nobody predicted. Longest first, so a
 * secret that contains another is not half replaced. */
internal sealed class JsonLineWriter
{
    private readonly TextWriter text;
    private readonly string[] secrets;
    private readonly Func<long> written;
    private readonly long limit;
    private readonly CancellationToken cancellationToken;
    private long lines;

    public JsonLineWriter(TextWriter text, IEnumerable<string> secrets, Func<long> written, long limit, CancellationToken cancellationToken)
    {
        this.text = text;
        this.secrets = secrets.Where(secret => !string.IsNullOrEmpty(secret)).OrderByDescending(secret => secret.Length).ToArray();
        this.written = written;
        this.limit = limit;
        this.cancellationToken = cancellationToken;
    }

    public void Write(string dataset, IEnumerable<(string Name, object Value)> fields)
    {
        using (var json = new JsonTextWriter(text) { CloseOutput = false, AutoCompleteOnClose = false, Formatting = Formatting.None })
        {
            json.WriteStartObject();
            json.WritePropertyName("dataset");
            json.WriteValue(dataset);
            foreach ((string name, object value) in fields)
            {
                json.WritePropertyName(name);
                WriteValue(json, value);
            }
            json.WriteEndObject();
        }
        text.Write('\n');
        if (++lines % 1000 == 0) cancellationToken.ThrowIfCancellationRequested();
        // What has reached the file so far. The compressor holds a little back,
        // so this stops a file that is plainly too large early; the builder
        // checks the finished file exactly.
        if (written() > limit) throw new TradingExportException(TradingExportErrorCodes.ExportTooLarge);
    }

    private void WriteValue(JsonTextWriter json, object value)
    {
        switch (value)
        {
            case null:
                json.WriteNull();
                break;
            case string s:
                json.WriteValue(Clean(s));
                break;
            case DateTime time:
                json.WriteValue(TradingExportTime.Format(time));
                break;
            case bool flag:
                json.WriteValue(flag);
                break;
            case long number:
                json.WriteValue(number);
                break;
            case int number:
                json.WriteValue(number);
                break;
            case double number:
                json.WriteValue(number);
                break;
            case ExportRowCounts counts:
                json.WriteStartObject();
                json.WritePropertyName("executions");
                json.WriteValue(counts.Executions);
                json.WritePropertyName("orders");
                json.WriteValue(counts.Orders);
                json.WritePropertyName("strategies");
                json.WriteValue(counts.Strategies);
                json.WritePropertyName("trades");
                json.WriteValue(counts.Trades);
                json.WriteEndObject();
                break;
            case IReadOnlyList<KeyValuePair<string, string>> pairs:
                json.WriteStartObject();
                foreach (KeyValuePair<string, string> pair in pairs)
                {
                    json.WritePropertyName(Clean(pair.Key));
                    WriteValue(json, pair.Value);
                }
                json.WriteEndObject();
                break;
            case IEnumerable<string> items:
                json.WriteStartArray();
                foreach (string item in items) WriteValue(json, item);
                json.WriteEndArray();
                break;
            default:
                // Nothing else is a field this file carries; a type nobody
                // planned for is written as nothing rather than as its ToString.
                json.WriteNull();
                break;
        }
    }

    private string Clean(string value)
    {
        if (string.IsNullOrEmpty(value)) return value;
        foreach (string secret in secrets)
        {
            if (value.Contains(secret, StringComparison.Ordinal))
                value = value.Replace(secret, SecretRedactor.Mask, StringComparison.Ordinal);
        }
        return value;
    }
}
