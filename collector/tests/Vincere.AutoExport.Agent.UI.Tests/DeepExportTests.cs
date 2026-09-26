using System;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.UI.DeepExport;
using Xunit;

namespace Vincere.AutoExport.Agent.UI.Tests;

/* ONE PACKAGE WITH EVERYTHING THIS NinjaTrader REMEMBERS ABOUT A CLIENT.
 *
 * The first case was an account that had to be reconstructed by hand from a
 * week of Discord messages. These tests build a fake NinjaTrader folder with a
 * real SQLite database in it and run the whole export against it, because the
 * acceptance list is concrete: row counts present, executions range present,
 * database copy opens clean, secrets gone, checksum matches, second run works. */
public sealed class DeepExportTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "vincere-deep-" + Guid.NewGuid().ToString("N"));
    private readonly string nt;
    private readonly string agent;
    private readonly string outDir;

    public DeepExportTests()
    {
        nt = Path.Combine(root, "NinjaTrader 8");
        agent = Path.Combine(root, "ProgramData", "Vincere", "AutoExport");
        outDir = Path.Combine(nt, "AutoExport", "deep");
        Directory.CreateDirectory(Path.Combine(nt, "db", "minute"));
        Directory.CreateDirectory(Path.Combine(nt, "log"));
        Directory.CreateDirectory(Path.Combine(nt, "trace"));
        Directory.CreateDirectory(Path.Combine(nt, "workspaces"));
        Directory.CreateDirectory(Path.Combine(nt, "templates", "Strategy", "Sub"));
        Directory.CreateDirectory(Path.Combine(agent, "queue", "sent"));
        Directory.CreateDirectory(Path.Combine(nt, "bin", "Custom"));

        File.WriteAllText(Path.Combine(nt, "log", "log.20260915.txt"), "log line");
        File.WriteAllText(Path.Combine(nt, "trace", "trace.20260915.txt"), "trace line");
        File.WriteAllText(Path.Combine(nt, "workspaces", "Main.xml"), "<Workspace/>");
        File.WriteAllText(Path.Combine(nt, "templates", "Strategy", "Sub", "G4M.xml"), "<Strategy/>");
        File.WriteAllText(Path.Combine(agent, "queue", "sent", "2026-09-15_abc.json"), "{}");
        File.WriteAllText(Path.Combine(agent, "queue", "sent", "2026-09-15_abc.json.receipt"), "ok");
        File.WriteAllText(Path.Combine(agent, "queue", "sent", "notes.txt"), "not ours");
        File.WriteAllText(Path.Combine(nt, "db", "minute", "ES.mn"), new string('x', 10_000));
        File.WriteAllText(Path.Combine(nt, "bin", "Custom", "x.dll"), "compiled");
        File.WriteAllText(Path.Combine(nt, "Config.xml"), "<Config><Password>hunter2</Password></Config>");

        string db = Path.Combine(nt, "db", "NinjaTrader.sqlite");
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = db, Pooling = false }.ConnectionString);
        connection.Open();
        using (SqliteCommand wal = connection.CreateCommand())
        {
            // NinjaTrader runs its database in WAL mode. So does the fixture.
            wal.CommandText = "PRAGMA journal_mode=WAL";
            wal.ExecuteScalar();
        }
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = @"
            CREATE TABLE Accounts (Id INTEGER PRIMARY KEY, Name TEXT);
            CREATE TABLE Executions (Id INTEGER PRIMARY KEY, Account TEXT, Time TEXT, Price REAL);
            CREATE TABLE Orders (Id INTEGER PRIMARY KEY, Account TEXT);
            CREATE TABLE MarketDataCache (Id INTEGER PRIMARY KEY);
            INSERT INTO Accounts VALUES (1, 'LTATAGREH509159302022');
            INSERT INTO Executions VALUES (1, 'LTATAGREH509159302022', '2026-08-01 09:30:00', 7675.25);
            INSERT INTO Executions VALUES (2, 'LTATAGREH509159302022', '2026-09-15 10:21:00', 7680.00);
            INSERT INTO Orders VALUES (1, 'LTATAGREH509159302022');";
        command.ExecuteNonQuery();
    }

    public void Dispose()
    {
        try { Directory.Delete(root, recursive: true); } catch (Exception) { }
    }

    private DeepExportRunner Runner(string configJson = null)
    {
        if (configJson != null)
            File.WriteAllText(Path.Combine(agent, "config.json"), configJson);
        return new DeepExportRunner(
            nt, agent, outDir, Path.Combine(root, "Desktop"),
            new DeepExportEnvironment("eb205103-0805|host|inst", "SERVER", "1.0.5", "1.0.0", "8.1.6.2", true, "America/New_York"),
            () => new DateTimeOffset(2026, 9, 16, 14, 5, 0, TimeSpan.FromHours(-4)));
    }

    private static JObject ReadManifest(string zipPath)
    {
        using ZipArchive zip = ZipFile.OpenRead(zipPath);
        using Stream stream = zip.GetEntry("manifest.json").Open();
        using var reader = new StreamReader(stream);
        return JObject.Parse(reader.ReadToEnd());
    }

    [Fact]
    public async Task TheManifestSaysHowFarTheExecutionsReach()
    {
        // Acceptance 2. The first thing anyone opens to know whether the export
        // is worth reading.
        DeepExportResult result = await Runner().RunAsync();
        JObject manifest = ReadManifest(result.ZipPath);
        Assert.Equal(2, (int)manifest["db"]["rowCounts"]["Executions"]);
        Assert.Equal(1, (int)manifest["db"]["rowCounts"]["Accounts"]);
        Assert.Equal("2026-08-01 09:30:00", (string)manifest["db"]["executionsRange"]["min"]);
        Assert.Equal("2026-09-15 10:21:00", (string)manifest["db"]["executionsRange"]["max"]);
        Assert.Equal("backup_api", (string)manifest["db"]["copyMethod"]);
        Assert.Equal(nt, (string)manifest["source"]["ntDocumentsPath"]);
        Assert.Equal(agent, (string)manifest["source"]["agentDataPath"]);
    }

    [Fact]
    public async Task TheDatabaseCopyOpensAndIsIntact()
    {
        // Acceptance 3.
        DeepExportResult result = await Runner().RunAsync();
        string extracted = Path.Combine(root, "x");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        string copy = Path.Combine(extracted, "db", "NinjaTrader.sqlite");
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = copy, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ConnectionString);
        connection.Open();
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "PRAGMA integrity_check";
        Assert.Equal("ok", (string)command.ExecuteScalar());
    }

    [Fact]
    public async Task CopiesConsistentlyWhileNinjaTraderHoldsTheDatabaseOpen()
    {
        // Rule 1. NinjaTrader keeps the file open in WAL mode while it trades.
        // The Backup API must still yield a copy with every row in it, as one
        // self-contained file with nothing beside it.
        string db = Path.Combine(nt, "db", "NinjaTrader.sqlite");
        using var held = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = db, Pooling = false }.ConnectionString);
        held.Open();
        using (SqliteCommand insert = held.CreateCommand())
        {
            insert.CommandText = "INSERT INTO Executions VALUES (3, 'LTATAGREH509159302022', '2026-09-16 15:59:00', 7690.5)";
            insert.ExecuteNonQuery();
        }

        DeepExportResult result = await Runner().RunAsync();
        JObject manifest = ReadManifest(result.ZipPath);
        Assert.Equal("backup_api", (string)manifest["db"]["copyMethod"]);
        Assert.Equal(3, (int)manifest["db"]["rowCounts"]["Executions"]);
        Assert.Equal("2026-09-16 15:59:00", (string)manifest["db"]["executionsRange"]["max"]);
        using ZipArchive zip = ZipFile.OpenRead(result.ZipPath);
        Assert.NotNull(zip.GetEntry("db/NinjaTrader.sqlite"));
        Assert.Null(zip.GetEntry("db/NinjaTrader.sqlite-wal"));
        Assert.Null(zip.GetEntry("db/NinjaTrader.sqlite-shm"));
    }

    [Fact]
    public async Task DumpsTheTradingTablesAsJsonLinesWithColumnsUntouched()
    {
        // Acceptance 4. Every column as SQLite returns it, nothing renamed.
        DeepExportResult result = await Runner().RunAsync();
        using ZipArchive zip = ZipFile.OpenRead(result.ZipPath);
        using var reader = new StreamReader(zip.GetEntry("db/tables/Executions.jsonl").Open());
        string[] lines = reader.ReadToEnd().Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Equal(2, lines.Length);
        JObject second = JObject.Parse(lines[1]);
        Assert.Equal("LTATAGREH509159302022", (string)second["Account"]);
        Assert.Equal(7680.0, (double)second["Price"]);
        Assert.NotNull(zip.GetEntry("db/schema.sql"));
        // A table whose name does not say trading is not dumped.
        Assert.Null(zip.GetEntry("db/tables/MarketDataCache.jsonl"));
    }

    [Fact]
    public async Task LeavesMarketDataConfigAndCompiledCodeBehind()
    {
        // The exclusions are the difference between a package and a hard drive.
        DeepExportResult result = await Runner().RunAsync();
        using ZipArchive zip = ZipFile.OpenRead(result.ZipPath);
        string[] names = zip.Entries.Select(e => e.FullName).ToArray();
        Assert.DoesNotContain(names, n => n.Contains("minute", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(names, n => n.EndsWith("Config.xml", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(names, n => n.Contains("bin/Custom", StringComparison.OrdinalIgnoreCase));
        Assert.Contains("logs/log.20260915.txt", names);
        Assert.Contains("trace/trace.20260915.txt", names);
        Assert.Contains("workspaces/Main.xml", names);
        Assert.Contains("templates/Strategy/Sub/G4M.xml", names);
    }

    [Fact]
    public async Task TheSentQueueCarriesOnlySnapshotsReceiptsAndReasons()
    {
        // Acceptance 5, and the stray file in that folder is not ours to ship.
        DeepExportResult result = await Runner().RunAsync();
        using ZipArchive zip = ZipFile.OpenRead(result.ZipPath);
        string[] names = zip.Entries.Select(e => e.FullName).ToArray();
        Assert.Contains("autoexport/sent/2026-09-15_abc.json", names);
        Assert.Contains("autoexport/sent/2026-09-15_abc.json.receipt", names);
        Assert.DoesNotContain("autoexport/sent/notes.txt", names);
    }

    [Fact]
    public async Task NothingThatAuthenticatesLeavesTheMachine()
    {
        // Acceptance 6. A grep over the unpacked package for
        // password|apikey|token|secret finds only "***".
        DeepExportResult result = await Runner(
            "{\"deviceToken\":\"AAAA\",\"nested\":{\"apiKey\":\"BBBB\",\"schedule\":\"16:35\"},\"password\":\"CCCC\",\"emptySecret\":\"\"}")
            .RunAsync();
        string extracted = Path.Combine(root, "y");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        string config = File.ReadAllText(Path.Combine(extracted, "config", "agent.config.redacted.json"));
        Assert.DoesNotContain("AAAA", config);
        Assert.DoesNotContain("BBBB", config);
        Assert.DoesNotContain("CCCC", config);
        Assert.Contains("16:35", config);
        JObject parsed = JObject.Parse(config);
        Assert.Equal("***", (string)parsed["deviceToken"]);
        Assert.Equal("***", (string)parsed["nested"]["apiKey"]);
        // A credential that was never set stays empty, so "never configured"
        // and "configured and hidden" remain distinguishable.
        Assert.Equal("", (string)parsed["emptySecret"]);

        var secretPattern = new Regex("(password|apikey|token|secret)\\s*\"?\\s*:\\s*\"([^\"]*)\"", RegexOptions.IgnoreCase);
        foreach (string file in Directory.EnumerateFiles(extracted, "*", SearchOption.AllDirectories))
        {
            if (file.EndsWith(".sqlite", StringComparison.OrdinalIgnoreCase)) continue;
            foreach (Match match in secretPattern.Matches(File.ReadAllText(file)))
            {
                Assert.True(match.Groups[2].Value == "***" || match.Groups[2].Value == "",
                    $"{Path.GetFileName(file)} leaks a secret: {match.Value}");
            }
        }
    }

    [Fact]
    public async Task TheChecksumBesideThePackageMatchesIt()
    {
        // Acceptance 7.
        DeepExportResult result = await Runner().RunAsync();
        string sidecar = File.ReadAllText(result.ZipPath + ".sha256").Split(' ')[0];
        Assert.Equal(result.Sha256, sidecar);
        Assert.Equal(DeepExportRunner.HashFile(result.ZipPath), sidecar);
    }

    [Fact]
    public async Task ASecondRunProducesASecondPackageAndKeepsTheLastThree()
    {
        // Acceptance 8, plus retention. Nothing is modified and nothing is lost
        // until there are more than three.
        int tick = 0;
        DeepExportRunner runner = new(
            nt, agent, outDir, null,
            new DeepExportEnvironment("m", "h", "1.0.5", "1.0.0", "8.1.6.2", false, "America/New_York"),
            // ADDED AS A TIMESPAN, NOT AS THE SECONDS FIELD. This used to read
            // `14, 0, tick++`, so the clock threw the moment the run made sixty
            // progress reports across five runs - which adding one source to
            // DeepExportSources did. The package names still differ per run,
            // which is all this needs, and now a new source cannot break it.
            () => new DateTimeOffset(2026, 9, 16, 14, 0, 0, TimeSpan.FromHours(-4)).AddSeconds(tick++));
        for (int i = 0; i < 5; i++) await runner.RunAsync();
        Assert.Equal(DeepExportRunner.KeepMostRecent, Directory.EnumerateFiles(outDir, "deep_*.zip").Count());
        Assert.Equal(DeepExportRunner.KeepMostRecent, Directory.EnumerateFiles(outDir, "deep_*.zip.sha256").Count());
    }

    [Fact]
    public async Task AMissingSourceIsAWarningNotAnAbort()
    {
        // Rule 5. A machine with no trace folder still has a database worth
        // exporting.
        Directory.Delete(Path.Combine(nt, "trace"), recursive: true);
        DeepExportResult result = await Runner().RunAsync();
        Assert.Contains(result.Warnings, w => w.Contains("trace", StringComparison.OrdinalIgnoreCase));
        Assert.True(File.Exists(result.ZipPath));
    }

    [Fact]
    public async Task ReportsProgressPerSource()
    {
        var seen = new System.Collections.Generic.List<string>();
        await Runner().RunAsync(new ImmediateProgress(p => seen.Add(p.Source)));
        Assert.Contains("database", seen);
        Assert.Contains("logs", seen);
        Assert.Contains("manifest", seen);
    }

    /// <summary>Progress&lt;T&gt; posts to a sync context; the test wants the calls as they happen.</summary>
    private sealed class ImmediateProgress : IProgress<DeepExportProgress>
    {
        private readonly Action<DeepExportProgress> handler;
        public ImmediateProgress(Action<DeepExportProgress> handler) => this.handler = handler;
        public void Report(DeepExportProgress value) => handler(value);
    }

    [Fact]
    public async Task CopiesThePackageToTheDesktop()
    {
        DeepExportResult result = await Runner().RunAsync();
        Assert.True(File.Exists(Path.Combine(root, "Desktop", Path.GetFileName(result.ZipPath))));
    }
}
