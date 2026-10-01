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
    /// <summary>
    /// The platform login the fixture's trace and logs carry. INVENTED for this
    /// file, and shaped like what NinjaTrader writes - a mail address with its @
    /// and . flattened to underscores. No value from a real export is in here.
    /// </summary>
    private const string TestLogin = "someoperator_example_org";

    /// <summary>
    /// Planted in the fixture's WITHHELD tables and searched for in the shipped
    /// database's raw bytes. INVENTED; nothing from a real export is in here.
    /// </summary>
    private const string WithheldLive = "ZZLIVEWITHHELDROWZZ";

    /// <summary>
    /// The same idea for rows that were inserted and then DELETED, so the table
    /// is empty and its content is still in the file's freed pages. This is the
    /// measured shape of the real leak, not a hypothetical one.
    /// </summary>
    private const string WithheldFreed = "ZZFREEDWITHHELDROWZZ";

    /// <summary>
    /// The NinjaTrader licence key, planted in ALL THREE CARRIERS it was measured
    /// in. FABRICATED for this file, in the measured shape
    /// V-XXXXXX-XXXXXXXX-XXXXXXX. No value from a real export is in here, and
    /// none may be put here: the two commits that closed earlier secrets leaks in
    /// this repo each pasted a live value in to make an assertion concrete, and
    /// that is how one ended up in git history.
    ///
    /// WHY THREE CARRIERS AND NOT ONE. The export was measured carrying this key
    /// three ways, and any one of them alone gives a green that means nothing:
    ///   templates/ .xml           886 of 886 files, plain ASCII in an element.
    ///   autoexport/sent/*.json    12 occurrences, plain ASCII in a map.
    ///   Strategies.Userdata       12 of 12 rows, UTF-16LE and HTML-ESCAPED, so
    ///                             an ASCII grep over the 21.9 MB database
    ///                             returns 0 while the key is in the file.
    /// The third is why the sweep below reads every file in three forms.
    /// </summary>
    private const string TestLicence = "V-ZZQQ77-FIXTUREK-TESTKEY";

    /// <summary>
    /// The fixture's one strategy template, its path and its content. The name
    /// carries the instrument, risk and version the way a real one does, because
    /// StrategyTemplateReader takes the identity from the PATH and only the
    /// geometry from the XML - a file called G4M.xml yields no catalogue row and
    /// could not show that the catalogue survives templates/ not shipping.
    /// </summary>
    private const string TemplateFamily = "G4M";
    private const string TemplateFile = "1 - G4M (MES) - 15 Min - Low Risk - v1 - Period 0.xml";

    /// <summary>
    /// What a Strategies.Userdata blob really holds, reproduced: an outer plain
    /// XML document whose text content is HTML-escaped XML. The licence key is
    /// inside the escaped half, which is the whole reason the sweep has to look
    /// for the escaped form in UTF-16LE. The parameterisation beside it is the
    /// part the rule deliberately leaves alone, so it is here to be asserted on.
    /// </summary>
    private const string StrategyBlobText =
        "<NinjaTrader><_Impl>&lt;?xml version=\"1.0\"?&gt;\r\n&lt;G4M_PF&gt;\r\n"
        + "  &lt;PosSize1&gt;2&lt;/PosSize1&gt;\r\n"
        + "  &lt;StopLossTicks&gt;40&lt;/StopLossTicks&gt;\r\n"
        + "  &lt;TrailByTicks&gt;8&lt;/TrailByTicks&gt;\r\n"
        + "  &lt;LicenseKey&gt;" + TestLicence + "&lt;/LicenseKey&gt;\r\n"
        + "  &lt;MondayFilter&gt;true&lt;/MondayFilter&gt;\r\n"
        + "&lt;/G4M_PF&gt;</_Impl></NinjaTrader>";

    /// <summary>The same blob after the rule, built by hand so the assertion is not circular.</summary>
    private const string StrategyBlobMasked =
        "<NinjaTrader><_Impl>&lt;?xml version=\"1.0\"?&gt;\r\n&lt;G4M_PF&gt;\r\n"
        + "  &lt;PosSize1&gt;2&lt;/PosSize1&gt;\r\n"
        + "  &lt;StopLossTicks&gt;40&lt;/StopLossTicks&gt;\r\n"
        + "  &lt;TrailByTicks&gt;8&lt;/TrailByTicks&gt;\r\n"
        + "  &lt;LicenseKey&gt;***&lt;/LicenseKey&gt;\r\n"
        + "  &lt;MondayFilter&gt;true&lt;/MondayFilter&gt;\r\n"
        + "&lt;/G4M_PF&gt;</_Impl></NinjaTrader>";

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
        Directory.CreateDirectory(Path.Combine(nt, "templates", "Strategy", TemplateFamily));
        Directory.CreateDirectory(Path.Combine(agent, "queue", "sent"));
        Directory.CreateDirectory(Path.Combine(nt, "bin", "Custom"));

        // THE FIXTURE CARRIES THE LOGIN, IN BOTH SHAPES IT REALLY TAKES, because
        // an export the tests run over without one cannot show that it is gone.
        // Measured on a real export: the keyed shape appears 1,816 times in
        // trace/ and never in logs/, and the prose sentence appears 121 times in
        // trace/ and 242 times in logs/, where it is the whole exposure. CRLF
        // because a Windows VPS writes CRLF. Login is invented; see TestLogin.
        File.WriteAllText(
            Path.Combine(nt, "log", "log.20260915.txt"),
            $"2026-09-15 09:30:00:100|3|2|There was a problem authenticating account {TestLogin} online. Please try again.\r\n"
            + "2026-09-15 09:30:01:200|3|2|account='LTATAGREH509159302022' connected\r\n");
        File.WriteAllText(
            Path.Combine(nt, "trace", "trace.20260915.txt"),
            $"2026-09-15 09:30:00:100 (Continuum) Cbi.Auth.RenewToken: renew requested user='{TestLogin}'\r\n"
            + $"2026-09-15 09:30:00:150 ERROR: There was a problem authenticating account {TestLogin} online. Please try again.\r\n"
            + "2026-09-15 09:30:01:200 (Continuum) Cbi.Order: account='LTATAGREH509159302022' orderId='12345678901' user=''\r\n");
        File.WriteAllText(Path.Combine(nt, "workspaces", "Main.xml"), "<Workspace/>");

        // THE TEMPLATE LIBRARY ON THE MACHINE, WHICH IS NOT THE SAME THING AS IN
        // THE PACKAGE. It stays on disk because the catalogue is derived from it
        // at export time, from the live folder; what this fixture now proves is
        // that the derivation still happens while the 886 raw files stop
        // travelling. It carries the geometry a real one carries and the licence
        // key a real one carries - 886 of 886 files had a non-empty element.
        File.WriteAllText(
            Path.Combine(nt, "templates", "Strategy", TemplateFamily, TemplateFile),
            "<StrategyTemplate><Strategy><G4M>"
            + "<PosSize1>2</PosSize1><PosSize2>1</PosSize2><PosSize3>1</PosSize3>"
            + "<StopLossTicks>40</StopLossTicks>"
            + "<ProfitTarget1Ticks>20</ProfitTarget1Ticks>"
            + "<ProfitTarget2Ticks>60</ProfitTarget2Ticks>"
            + "<ProfitTarget3Ticks>120</ProfitTarget3Ticks>"
            + "<TrailByTicks>8</TrailByTicks><BreakEvenAfterTicks>12</BreakEvenAfterTicks>"
            + $"<LicenseKey>{TestLicence}</LicenseKey>"
            + "</G4M></Strategy></StrategyTemplate>");

        // A QUEUE SNAPSHOT SHAPED LIKE A REAL ONE. Measured: a strategy row
        // carries 87 entries in `parameters` and 149 in `extraValues`, and the
        // key sits in extraValues twice - once as LicenseKey and once inside the
        // DisplayParameters string. Both are here, with the geometry beside them,
        // and the trading fields that must SURVIVE the rule.
        File.WriteAllText(
            Path.Combine(agent, "queue", "sent", "2026-09-15_abc.json"),
            "{\"captureId\":\"c1\",\"tradingDate\":\"2026-09-15\","
            + "\"accounts\":[{\"accountName\":\"LTATAGREH509159302022\","
            + "\"accountValues\":{\"NetLiquidation\":51234.5,\"BuyingPower\":120000}}],"
            + "\"orders\":[{\"orderId\":\"12345678901\",\"instrument\":\"MES\"}],"
            + "\"executions\":[{\"executionId\":\"e1\",\"price\":7675.25}],"
            + "\"strategies\":[{\"strategyId\":\"s1\",\"strategyName\":\"G4M\","
            + "\"accountName\":\"LTATAGREH509159302022\",\"instrument\":\"MES\","
            + "\"state\":\"Enabled\",\"realizedPnl\":312.5,"
            + "\"parameterCaptureStatus\":\"captured\","
            + "\"parameters\":{\"PosSize1\":2,\"StopLossTicks\":40},"
            + "\"extraValues\":{\"PosSize1\":\"2\",\"StopLossTicks\":\"40\","
            + "\"TrailByTicks\":\"8\",\"StartTrailAfterTicks\":\"16\","
            + $"\"LicenseKey\":\"{TestLicence}\","
            + $"\"DisplayParameters\":\"StopLossTicks=40;LicenseKey={TestLicence}\"}}}}]}}");
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
        // THE FIXTURE CARRIES THE TABLES THE ALLOWLIST EXCLUDES, because an
        // export run over a database that only has allowed tables in it cannot
        // show that the excluded ones stayed behind. Users and JournalEntries are
        // the two that matter on a real machine; Users is named for its columns,
        // which on the measured export include Password and Salt.
        //
        // Accounts.Data is a BLOB. The JSONL can only say "<blob 4 bytes>", so it
        // is what proves the shipped database is not a lossy restatement of it.
        //
        // AND IT CARRIES THE SHAPE THE CONSOLIDATION WAS ASKED ABOUT: the
        // per-order history, the link table, the account items and the
        // open-position table, because the decision not to fold them is only
        // testable against a database that has them. Column names and the
        // composite primary keys are NinjaTrader's, taken off the two real
        // exports; the rows are invented.
        command.CommandText = @"
            CREATE TABLE Accounts (Id INTEGER PRIMARY KEY, Name TEXT, Data BLOB);
            CREATE TABLE Executions (Id INTEGER PRIMARY KEY, Account TEXT, Time TEXT, Price REAL);
            -- THE COLUMNS AttributionExport ACTUALLY SELECTS. This table used to
            -- be (Id, Account TEXT, Instrument) and the attribution step died on
            -- it every single run: the query reads o.Name, o.Quantity,
            -- o.AvgFillPrice and o.Time, none of which existed, and
            -- AttributionExport swallows the SqliteException into a warning. So
            -- the fixture produced a package with a catalogue and no trades and
            -- nothing noticed. Account is an integer key into Accounts here, as it
            -- is on a real machine, so the join resolves instead of silently
            -- yielding nothing.
            CREATE TABLE Orders (
                Id INTEGER PRIMARY KEY, Account INTEGER REFERENCES Accounts(Id),
                Instrument INTEGER REFERENCES Instruments(Id), Name TEXT,
                Quantity INTEGER, AvgFillPrice REAL, Time INTEGER);
            CREATE INDEX IX_Executions_Time ON Executions (Time);
            CREATE TABLE MarketDataCache (Id INTEGER PRIMARY KEY);
            -- WITHHELD, AND ALSO WHAT ATTRIBUTION NEEDS DURING THE RUN. The
            -- instrument join goes Orders -> Instruments -> MasterInstruments to
            -- turn an integer id into a symbol, which is why AttributionExport
            -- reads the WORKING copy and not the shipped one. MasterInstruments
            -- and Instruments.MasterInstrument were missing from this fixture
            -- entirely, so every package it produced carried an attribution-
            -- skipped warning and a null attribution block in the manifest -
            -- half the step failing silently, which is exactly what makes a green
            -- meaningless. Both tables still have to stay out of the package.
            CREATE TABLE Instruments (Id INTEGER PRIMARY KEY, Name TEXT, MasterInstrument INTEGER);
            CREATE TABLE MasterInstruments (Id INTEGER PRIMARY KEY, Name TEXT, TickSize REAL);
            CREATE TABLE Users (Id INTEGER PRIMARY KEY, Name TEXT, Password TEXT, Salt TEXT);
            CREATE TABLE JournalEntries (Id INTEGER PRIMARY KEY, Text TEXT);
            -- LimitPrice beside StopPrice because AttributionExport reads both to
            -- recover the price before the trail moved it, and a column it selects
            -- that does not exist throws inside a swallowed catch.
            CREATE TABLE OrderUpdates (
                [Order] INTEGER NOT NULL REFERENCES Orders(Id), Nr INTEGER NOT NULL,
                OrderId TEXT, OrderState INTEGER, StatementDate INTEGER,
                LimitPrice REAL, StopPrice REAL, Time INTEGER,
                PRIMARY KEY ([Order], Nr));
            CREATE TABLE AccountItems (
                Account INTEGER NOT NULL REFERENCES Accounts(Id), Currency INTEGER, ItemType INTEGER,
                Value REAL, TimeUtc INTEGER, PRIMARY KEY (Account, ItemType, Currency));
            CREATE TABLE Positions (
                Account INTEGER NOT NULL, Instrument INTEGER NOT NULL, AvgPrice REAL,
                MarketPosition INTEGER, Quantity INTEGER, StatementDate INTEGER);
            CREATE INDEX Positions_i0 ON Positions (Account);
            CREATE TABLE Strategies (Id INTEGER PRIMARY KEY, Name TEXT, Template TEXT, Userdata BLOB);
            CREATE TABLE Strategy2Order ([Order] INTEGER NOT NULL, Strategy INTEGER NOT NULL);
            INSERT INTO Accounts VALUES (1, 'LTATAGREH509159302022', X'01020304');
            INSERT INTO Executions VALUES (1, 'LTATAGREH509159302022', '2026-08-01 09:30:00', 7675.25);
            INSERT INTO Executions VALUES (2, 'LTATAGREH509159302022', '2026-09-15 10:21:00', 7680.00);
            INSERT INTO Instruments VALUES (1, 'MNQ 12-26', 1);
            INSERT INTO MasterInstruments VALUES (1, 'MES', 0.25);
            INSERT INTO Orders VALUES (1, 1, 1, 'Buy', 2, 7650.00, 638000000000000121);
            INSERT INTO Orders VALUES (2, 1, 1, 'Sell', 2, 7655.00, 638000000000000125);
            INSERT INTO JournalEntries VALUES (1, '" + WithheldLive + @" a note about a client');
            INSERT INTO Users VALUES (1, '" + WithheldLive + @"', 'hunter2', 'salt');
            INSERT INTO AccountItems VALUES (1, 1, 1, 50000.0, 638000000000000001);
            INSERT INTO AccountItems VALUES (1, 1, 2, 1250.5, 638000000000000002);
            INSERT INTO Strategies VALUES (1, 'G4M', '', X'0A0B0C');
            INSERT INTO Strategies VALUES (2, 'Unlinked', '', NULL);
            INSERT INTO Strategy2Order VALUES (1, 1);";
        command.ExecuteNonQuery();

        // THE CARRIER AN ASCII GREP CANNOT SEE. Measured on a real export:
        // Strategies holds 12 rows, all 12 Userdata blobs carry a non-empty
        // LicenseKey, and the payload is UTF-16LE with no BOM whose text is
        // HTML-ESCAPED XML - the outer document is <NinjaTrader><_Impl> and the
        // inner tag reads &lt;LicenseKey&gt;. An ASCII search of that 21.9 MB
        // file returns 0 while the key is in it 12 times. Row 3 gets this blob,
        // so the fixture holds one blob with the key and two without.
        using (SqliteCommand userdata = connection.CreateCommand())
        {
            userdata.CommandText = "INSERT INTO Strategies (Id, Name, Template, Userdata) VALUES (3, 'G4M_PF', '', $u)";
            userdata.Parameters.AddWithValue("$u", System.Text.Encoding.Unicode.GetBytes(StrategyBlobText));
            userdata.ExecuteNonQuery();
        }

        // THE HISTORY, INSERTED OUT OF ORDER ON PURPOSE. Nr is the sequence and
        // the rows arrive in 3, 1, 2. Nothing may depend on insertion order, and
        // the two distinct OrderId values are the measured shape of a real
        // order's life: 18,610 of 18,827 orders on the big export carry exactly
        // two, because the broker reassigns the id. Order 2 has no updates at
        // all. Times are 18-digit .NET ticks, above 2^53, as the real ones are.
        using (SqliteCommand history = connection.CreateCommand())
        {
            history.CommandText = @"
                INSERT INTO OrderUpdates ([Order], Nr, OrderId, OrderState, StatementDate, StopPrice, Time)
                    VALUES (1, 3, 'BROKER-SECOND', 6, 638000000000000000, 7650.25, 638000000000000123);
                INSERT INTO OrderUpdates ([Order], Nr, OrderId, OrderState, StatementDate, StopPrice, Time)
                    VALUES (1, 1, 'BROKER-FIRST', 1, 638000000000000000, 7640.75, 638000000000000121);
                INSERT INTO OrderUpdates ([Order], Nr, OrderId, OrderState, StatementDate, StopPrice, Time)
                    VALUES (1, 2, 'BROKER-FIRST', 2, 638000000000000000, 7645.50, 638000000000000122);";
            history.ExecuteNonQuery();
        }

        // ROWS THAT WERE DELETED, so no SELECT can see them and the bytes are
        // still in the file. Enough of them to occupy pages SQLite then frees:
        // the measured export has Users at 0 rows and 36 freed pages holding 19
        // strategy signatures and 20 UTF-16 licence keys, which is why "the table
        // is empty" and "its content is gone" are different statements. DROP
        // TABLE without a rebuild satisfies the first and not the second.
        using (SqliteCommand churn = connection.CreateCommand())
        {
            churn.CommandText = "INSERT INTO Users (Name, Password, Salt) VALUES ($n, $p, $s)";
            churn.Parameters.AddWithValue("$n", WithheldFreed);
            churn.Parameters.AddWithValue("$p", new string('p', 60));
            churn.Parameters.AddWithValue("$s", new string('s', 60));
            for (int i = 0; i < 200; i++) churn.ExecuteNonQuery();
        }
        using (SqliteCommand purge = connection.CreateCommand())
        {
            purge.CommandText = "DELETE FROM Users WHERE Name = $n";
            purge.Parameters.AddWithValue("$n", WithheldFreed);
            purge.ExecuteNonQuery();
        }
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
    public async Task EachTableTravelsExactlyOnceAndTheJsonLinesCopyIsGone()
    {
        // THE CONSOLIDATION, ASSERTED AS A COUNT. db/ used to carry the same 12
        // tables twice - once in the database and once as tables/<T>.jsonl - and
        // the desk asked for fewer tables in what travels. So the property is not
        // "the JSONL is absent", it is "each allowlisted table is stated once".
        DeepExportResult result = await Runner().RunAsync();
        using ZipArchive zip = ZipFile.OpenRead(result.ZipPath);
        string[] db = zip.Entries
            .Select(e => e.FullName)
            .Where(n => n.StartsWith("db/", StringComparison.Ordinal))
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToArray();
        Assert.Equal(new[] { "db/NinjaTrader.sqlite", "db/schema.sql" }, db);

        // Not one entry under db/tables/, whatever it might be called, and no
        // JSON Lines file anywhere in the package restating a database table.
        Assert.DoesNotContain(zip.Entries, e => e.FullName.StartsWith("db/tables", StringComparison.Ordinal));
        string extracted = Path.Combine(root, "once");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        string[] shippedTables = TablesIn(Path.Combine(extracted, "db", "NinjaTrader.sqlite"));
        foreach (string table in shippedTables)
        {
            Assert.DoesNotContain(zip.Entries, e =>
                e.FullName.EndsWith("/" + table + ".jsonl", StringComparison.OrdinalIgnoreCase));
        }

        // And the manifest agrees, because it is the thing an analyst reads
        // first: it names the tables once each and lists no dump beside them.
        JObject manifest = ReadManifest(result.ZipPath);
        Assert.DoesNotContain(manifest["files"].Select(f => (string)f["path"]), p => p.EndsWith(".jsonl", StringComparison.OrdinalIgnoreCase) && p.StartsWith("db/", StringComparison.Ordinal));
        Assert.Equal(shippedTables.Length, ((JObject)manifest["db"]["rowCounts"]).Count);
    }

    [Fact]
    public void TheAllowlistIsStatedInExactlyOnePlace()
    {
        // THIS REPO HAS ALREADY MADE THIS MISTAKE ONCE. The allowlist was
        // honoured for db/tables/*.jsonl and then undone by the whole database
        // being copied in beside them, so the package described 12 tables and
        // carried 21. The rule now decides what is inside the shipped file, which
        // makes a second statement of it a security bug rather than an
        // untidiness - and a second copy that agrees today is exactly the one
        // that stops agreeing later. So it is counted, not trusted.
        string[] sources = DeepExportSourceFiles();
        int nameMatch = 0;
        int alwaysList = 0;
        foreach (string file in sources)
        {
            string text = File.ReadAllText(file);
            nameMatch += Occurrences(text, "(Account|Execution|Order|Position|Strateg|Trade)");
            alwaysList += Occurrences(text, "\"Accounts\", \"Executions\", \"Orders\", \"Positions\", \"Strategies\"");
        }
        Assert.Equal(1, nameMatch);
        Assert.Equal(1, alwaysList);

        // AND NO DENYLIST CREPT IN BESIDE IT. Naming the tables to withhold is
        // the tempting fix and the wrong one: it is fail-open in the direction
        // that costs, so Users would stay out and a future UserPasswords would
        // walk in. The inclusion rule is fail-open in the other direction, which
        // SqliteSnapshot's header says out loud.
        foreach (string file in sources)
        {
            string text = File.ReadAllText(file);
            foreach (string withheld in new[]
            {
                "Users", "JournalEntries", "Logs", "User2MarketDataEntitlement", "Instruments",
                "MasterInstruments", "InstrumentLists", "Instrument2InstrumentList", "Versions",
            })
            {
                Assert.DoesNotContain("\"" + withheld + "\"", text);
            }
        }
    }

    [Fact]
    public async Task ATableTheAllowlistExcludesReachesNoPartOfThePackage()
    {
        // The fixture's Users and JournalEntries are what the allowlist excludes
        // on a real machine. Users carries a live row AND 200 deleted ones, so
        // this checks both what a SELECT can see and what only the bytes hold.
        string live = Path.Combine(nt, "db", "NinjaTrader.sqlite");
        string before = Latin1(live);
        // The guard that stops this test passing for the wrong reason: the freed
        // rows really are still in the source file after the DELETE.
        Assert.Contains(WithheldFreed, before);
        Assert.Contains(WithheldLive, before);

        DeepExportResult result = await Runner().RunAsync();
        string extracted = Path.Combine(root, "filtered");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        string shipped = Path.Combine(extracted, "db", "NinjaTrader.sqlite");

        // Not as a table, not as a file of its own anywhere in the package, and
        // not as a byte. The per-table dump that used to be the second place to
        // check is gone, so the check is now "no entry names it" rather than
        // "that one entry is absent", which cannot pass for the wrong reason.
        Assert.DoesNotContain("Users", TablesIn(shipped));
        Assert.DoesNotContain("JournalEntries", TablesIn(shipped));
        using (ZipArchive zip = ZipFile.OpenRead(result.ZipPath))
        {
            Assert.DoesNotContain(zip.Entries, e =>
                e.FullName.StartsWith("db/", StringComparison.Ordinal)
                && (e.FullName.Contains("Users", StringComparison.OrdinalIgnoreCase)
                    || e.FullName.Contains("JournalEntries", StringComparison.OrdinalIgnoreCase)));
        }
        string after = Latin1(shipped);
        Assert.DoesNotContain(WithheldLive, after);
        // THE ASSERTION A DROP-TABLE FIX WOULD FAIL. Dropping the table leaves
        // the freed pages exactly where they were; only building a new file
        // means the content was never written.
        Assert.DoesNotContain(WithheldFreed, after);

        // And the manifest accounts for the gap by name rather than leaving an
        // analyst to notice that rowCounts is shorter than the schema.
        JObject manifest = ReadManifest(result.ZipPath);
        string[] withheld = manifest["db"]["tablesWithheld"].Select(t => (string)t).ToArray();
        Assert.Contains("Users", withheld);
        Assert.Contains("JournalEntries", withheld);
        Assert.Contains("Instruments", withheld);
        Assert.Contains("MarketDataCache", withheld);
        string[] shippedNames = manifest["db"]["tablesShipped"].Select(t => (string)t).ToArray();
        Assert.Equal(
            new[] { "AccountItems", "Accounts", "Executions", "OrderUpdates", "Orders", "Positions", "Strategies", "Strategy2Order" },
            shippedNames.OrderBy(n => n, StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public async Task TheShippedDatabaseOpensAndHoldsOnlyTheAllowlistedTables()
    {
        // Acceptance 3, now with the second half of the promise: it opens clean
        // AND there is nothing in it that was not allowed.
        DeepExportResult result = await Runner().RunAsync();
        string extracted = Path.Combine(root, "only");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        string shipped = Path.Combine(extracted, "db", "NinjaTrader.sqlite");

        using var connection = new SqliteConnection(Read(shipped));
        connection.Open();
        using (SqliteCommand integrity = connection.CreateCommand())
        {
            integrity.CommandText = "PRAGMA integrity_check";
            Assert.Equal("ok", (string)integrity.ExecuteScalar());
        }

        string[] tables = TablesIn(shipped);
        Assert.Equal(
            new[] { "AccountItems", "Accounts", "Executions", "OrderUpdates", "Orders", "Positions", "Strategies", "Strategy2Order" },
            tables);
        Assert.All(tables, t => Assert.True(SqliteSnapshot.IsAllowedTable(t), $"{t} is in the shipped database and the allowlist does not allow it"));

        // ONE PREDICATE, AND NOW ONLY ONE SHAPE FOR IT TO GOVERN. This used to
        // assert the database's table set equalled the db/tables/*.jsonl
        // basenames, which was the tripwire proving one rule fed both artefacts.
        // There is one artefact, so the tripwire becomes the stronger statement:
        // the manifest's row counts are keyed by exactly the tables in the file.
        JObject manifest = ReadManifest(result.ZipPath);
        Assert.Equal(tables, ((JObject)manifest["db"]["rowCounts"]).Properties().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray());
        Assert.Equal(tables, manifest["db"]["tablesShipped"].Select(t => (string)t).OrderBy(n => n, StringComparer.Ordinal).ToArray());

        using ZipArchive zip = ZipFile.OpenRead(result.ZipPath);
        // A new file, built by us, so there is no journal beside it to lose - and
        // no longer any dependence on the copy's journal_mode having been folded.
        Assert.Null(zip.GetEntry("db/NinjaTrader.sqlite-wal"));
        Assert.Null(zip.GetEntry("db/NinjaTrader.sqlite-shm"));
    }

    [Fact]
    public async Task TheAllowedTablesArriveWithTheirRowsColumnsAndTypesIntact()
    {
        // Filtering is only defensible if it costs the reader nothing. The rows,
        // the column names in their declared order, the real SQLite types and the
        // indexes all have to survive - and the blob has to survive as a blob,
        // which is the one thing db/tables/*.jsonl cannot do.
        DeepExportResult result = await Runner().RunAsync();
        string extracted = Path.Combine(root, "intact");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        string shipped = Path.Combine(extracted, "db", "NinjaTrader.sqlite");

        using var connection = new SqliteConnection(Read(shipped));
        connection.Open();
        using (SqliteCommand rows = connection.CreateCommand())
        {
            rows.CommandText = "SELECT Id, Account, Time, Price FROM Executions ORDER BY Id";
            using SqliteDataReader reader = rows.ExecuteReader();
            Assert.Equal(new[] { "Id", "Account", "Time", "Price" }, Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray());
            Assert.True(reader.Read());
            Assert.Equal("LTATAGREH509159302022", reader.GetString(1));
            Assert.Equal("2026-08-01 09:30:00", reader.GetString(2));
            // A REAL double, not the string a JSON round trip would leave.
            Assert.Equal(7675.25, reader.GetDouble(3));
            Assert.True(reader.Read());
            Assert.Equal(7680.00, reader.GetDouble(3));
            Assert.False(reader.Read());
        }
        using (SqliteCommand blob = connection.CreateCommand())
        {
            blob.CommandText = "SELECT Data FROM Accounts WHERE Id = 1";
            Assert.Equal(new byte[] { 1, 2, 3, 4 }, (byte[])blob.ExecuteScalar());
        }
        using (SqliteCommand index = connection.CreateCommand())
        {
            // The indexes of a kept table come across, so the file is queryable
            // and not merely readable.
            index.CommandText = "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name = 'IX_Executions_Time'";
            Assert.Equal(1L, (long)index.ExecuteScalar());
        }

        // AND NO PLACEHOLDER SHIPS ANY MORE. This used to assert that
        // db/tables/Accounts.jsonl said "<blob 4 bytes>", on the argument that
        // the two artefacts differed only in fidelity. That argument is retired:
        // there is one artefact and it is the high-fidelity one, so the
        // placeholder text must appear nowhere in the package at all.
        string[] textFiles = Directory.EnumerateFiles(extracted, "*", SearchOption.AllDirectories)
            .Where(f => !f.EndsWith(".sqlite", StringComparison.OrdinalIgnoreCase))
            .ToArray();
        Assert.All(textFiles, f => Assert.DoesNotContain("<blob ", File.ReadAllText(f)));
    }

    [Fact]
    public async Task NothingTheJsonLinesCarriedLeftThePackageWithIt()
    {
        // THE RULE: nothing that was in the package may silently leave it. The
        // per-table JSONL dump left it, so this is the proof that it took nothing
        // with it, and it is the reason this consolidation is free.
        //
        // The dump was written FROM the staged database - the runner handed
        // DumpTable copyPath, the file that ships, not the working copy - so it
        // was a projection of the file that stays: the same rows in the same
        // order, the same columns under the names SQLite gives them, with each
        // blob reduced to "<blob N bytes>". JsonLinesProjection below reproduces
        // that projection exactly. Generating it from the LIVE database and from
        // the SHIPPED one and finding them identical asserts both halves at once:
        // the rebuild loses no row, column, name, order or value, and the dump
        // held nothing the database does not still hold.
        DeepExportResult result = await Runner().RunAsync();
        string extracted = Path.Combine(root, "superset");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        string shipped = Path.Combine(extracted, "db", "NinjaTrader.sqlite");
        string live = Path.Combine(nt, "db", "NinjaTrader.sqlite");

        string[] tables = TablesIn(shipped);
        Assert.NotEmpty(tables);
        foreach (string table in tables)
        {
            // EXCEPT THE ONE CELL A RULE DELIBERATELY REWRITES, named here rather
            // than tolerated by a loose comparison. The credential rule masks a
            // secret-named element inside Strategies.Userdata, so that blob's
            // length changes and the projection cannot be identical. Every other
            // table still has to match to the byte, and the Strategies row's every
            // other column does too - see below.
            if (string.Equals(table, "Strategies", StringComparison.OrdinalIgnoreCase)) continue;
            Assert.Equal(JsonLinesProjection(live, table), JsonLinesProjection(shipped, table));
        }

        // Strategies: same rows in the same order with the same columns, and the
        // only difference in the whole table is the length of the one blob the
        // credential rule rewrote. TheLicenceKeyInsideADatabaseBlobIsMaskedAndThe
        // GeometryIsNot asserts what it was rewritten TO.
        string[] liveRows = JsonLinesProjection(live, "Strategies");
        string[] shippedRows = JsonLinesProjection(shipped, "Strategies");
        Assert.Equal(liveRows.Length, shippedRows.Length);
        int rewritten = 0;
        for (int at = 0; at < liveRows.Length; at++)
        {
            if (liveRows[at] == shippedRows[at]) continue;
            rewritten++;
            JObject before = JObject.Parse(liveRows[at]);
            JObject after = JObject.Parse(shippedRows[at]);
            Assert.Equal(before.Properties().Select(p => p.Name), after.Properties().Select(p => p.Name));
            foreach (JProperty property in before.Properties())
            {
                if (property.Name == "Userdata") continue;
                Assert.Equal(property.Value, after[property.Name]);
            }
            Assert.StartsWith("<blob ", (string)after["Userdata"]);
        }
        Assert.Equal(1, rewritten);

        // And the one cell the projection could not carry is still in the file as
        // a blob, with its length recoverable - so the placeholder was strictly
        // less than what ships, never something else.
        using var connection = new SqliteConnection(Read(shipped));
        connection.Open();
        using SqliteCommand blob = connection.CreateCommand();
        blob.CommandText = "SELECT length(Data), typeof(Data) FROM Accounts WHERE Id = 1";
        using SqliteDataReader reader = blob.ExecuteReader();
        Assert.True(reader.Read());
        Assert.Equal(4L, reader.GetInt64(0));
        Assert.Equal("blob", reader.GetString(1));
    }

    [Fact]
    public void AnOrphanChildIsKeptBecauseTheRebuildNeverJoins()
    {
        // THE DECISION THIS TEST NAMES: an orphan child row SHIPS, unchanged.
        //
        // Measured on both real exports there are none - 0 orphan OrderUpdates
        // against 18,827 and 229 orders, 0 orphan AccountItems, 0 orphans on all
        // three Strategy2 link tables, in both directions. So this is not a case
        // the data has shown us. It is the case the FOLD would have had to
        // decide, and having no good answer to it is part of why the fold was
        // refused: nesting an orphan under a parent means either dropping the row
        // or inventing a parent for it, and both are the silent loss this package
        // exists to prevent. Copying tables rather than joining them has no such
        // choice to make - foreign keys are off and every row is copied as it
        // stands - so the orphan arrives and an analyst can see that it is one.
        (string _, string shipped) = Rebuild(@"
            CREATE TABLE Orders (Id INTEGER PRIMARY KEY, Account INTEGER);
            CREATE TABLE OrderUpdates ([Order] INTEGER NOT NULL, Nr INTEGER NOT NULL, OrderId TEXT, PRIMARY KEY ([Order], Nr));
            CREATE TABLE Accounts (Id INTEGER PRIMARY KEY, Name TEXT);
            CREATE TABLE AccountItems (Account INTEGER NOT NULL, ItemType INTEGER, Value REAL);
            INSERT INTO Orders VALUES (1, 1);
            INSERT INTO Accounts VALUES (1, 'A');
            INSERT INTO OrderUpdates VALUES (1, 1, 'HAS-A-PARENT');
            INSERT INTO OrderUpdates VALUES (99, 1, 'ORPHANED');
            INSERT INTO AccountItems VALUES (1, 1, 10.0);
            INSERT INTO AccountItems VALUES (77, 1, 20.0);");

        using var connection = new SqliteConnection(Read(shipped));
        connection.Open();
        Assert.Equal(2L, Count(connection, "OrderUpdates"));
        Assert.Equal(2L, Count(connection, "AccountItems"));
        // The orphan is there AND it is still identifiable as an orphan, which is
        // the whole value of keeping it: the dangling key is preserved, not
        // repointed at something that exists.
        using SqliteCommand orphan = connection.CreateCommand();
        orphan.CommandText = "SELECT count(*) FROM OrderUpdates u LEFT JOIN \"Orders\" o ON o.Id = u.[Order] WHERE o.Id IS NULL";
        Assert.Equal(1L, (long)orphan.ExecuteScalar());
        using SqliteCommand item = connection.CreateCommand();
        item.CommandText = "SELECT count(*) FROM AccountItems i LEFT JOIN Accounts a ON a.Id = i.Account WHERE a.Id IS NULL";
        Assert.Equal(1L, (long)item.ExecuteScalar());
    }

    [Fact]
    public void AnEmptyParentWithChildrenAndAParentWithNoChildrenBothSurvive()
    {
        // BOTH ENDS OF THE RELATION, because a fold gets each of them wrong in a
        // different way: an empty parent table loses its children entirely, and a
        // childless parent gains an empty list that costs bytes on every row.
        // Measured on the real exports both cases are the common one, not the
        // edge - the small machine has 0 strategies while its link tables would
        // have had to hang off them, and 132 of 135 accounts on the big machine
        // have no AccountItems at all, which is why folding those two COSTS 582
        // bytes rather than saving any.
        (string _, string shipped) = Rebuild(@"
            CREATE TABLE Strategies (Id INTEGER PRIMARY KEY, Name TEXT);
            CREATE TABLE Strategy2Order ([Order] INTEGER NOT NULL, Strategy INTEGER NOT NULL);
            CREATE TABLE Orders (Id INTEGER PRIMARY KEY, Account INTEGER);
            CREATE TABLE OrderUpdates ([Order] INTEGER NOT NULL, Nr INTEGER NOT NULL, PRIMARY KEY ([Order], Nr));
            INSERT INTO Strategy2Order VALUES (1, 5);
            INSERT INTO Strategy2Order VALUES (2, 5);
            INSERT INTO Orders VALUES (1, 1);
            INSERT INTO Orders VALUES (2, 1);
            INSERT INTO OrderUpdates VALUES (1, 1);
            INSERT INTO OrderUpdates VALUES (1, 2);");

        using var connection = new SqliteConnection(Read(shipped));
        connection.Open();
        // The empty parent ships as an empty table and its children all arrive.
        Assert.Contains("Strategies", TablesIn(shipped));
        Assert.Equal(0L, Count(connection, "Strategies"));
        Assert.Equal(2L, Count(connection, "Strategy2Order"));
        // The childless parent ships with nothing added to it.
        Assert.Equal(2L, Count(connection, "Orders"));
        Assert.Equal(2L, Count(connection, "OrderUpdates"));
        using SqliteCommand childless = connection.CreateCommand();
        childless.CommandText = "SELECT count(*) FROM \"Orders\" o WHERE NOT EXISTS (SELECT 1 FROM OrderUpdates u WHERE u.[Order] = o.Id)";
        Assert.Equal(1L, (long)childless.ExecuteScalar());
        // And the childless one has no column and no value it did not have.
        using SqliteCommand columns = connection.CreateCommand();
        columns.CommandText = "SELECT * FROM \"Orders\"";
        using SqliteDataReader reader = columns.ExecuteReader();
        Assert.Equal(new[] { "Id", "Account" }, Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray());
    }

    [Fact]
    public async Task TheHistoryOrderIsCarriedByItsPrimaryKeyNotByRowOrder()
    {
        // THE ORDER OF A PER-ORDER HISTORY IS Nr ASCENDING WITHIN Order, and it is
        // declared, not incidental: OrderUpdates is PRIMARY KEY ([Order], Nr), so
        // the ordering is in the DDL and in the index that arrives with it. The
        // fixture inserts Nr 3, 1, 2 in that sequence precisely so that nothing
        // here can be passing because the rows happen to sit in a helpful order.
        //
        // This is the ordering question the fold raised, and the reason the
        // relation answers it better: a nested JSON history has an order and
        // nothing enforces it, so somebody has to choose one and write it down,
        // and every reader has to trust that they did. A primary key is the same
        // answer for every reader, checkable with one query.
        DeepExportResult result = await Runner().RunAsync();
        string extracted = Path.Combine(root, "history");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        string shipped = Path.Combine(extracted, "db", "NinjaTrader.sqlite");

        using var connection = new SqliteConnection(Read(shipped));
        connection.Open();
        using (SqliteCommand ordered = connection.CreateCommand())
        {
            ordered.CommandText = "SELECT Nr, OrderId FROM OrderUpdates WHERE [Order] = 1 ORDER BY Nr";
            using SqliteDataReader reader = ordered.ExecuteReader();
            var sequence = new System.Collections.Generic.List<(long, string)>();
            while (reader.Read()) sequence.Add((reader.GetInt64(0), reader.GetString(1)));
            Assert.Equal(new[] { 1L, 2L, 3L }, sequence.Select(s => s.Item1).ToArray());
            // AND THE SECOND BROKER ID SURVIVED. This is the assertion the fold
            // the request asked for would have failed: hoisting OrderId to the
            // parent as "the column every row repeats" deletes the later id, and
            // on the big export 18,610 of 18,827 orders (98.8%) carry exactly two.
            Assert.Equal(new[] { "BROKER-FIRST", "BROKER-FIRST", "BROKER-SECOND" }, sequence.Select(s => s.Item2).ToArray());
            Assert.Equal(2, sequence.Select(s => s.Item2).Distinct().Count());
        }
        // The ordering is a property of the schema that shipped, not of this run.
        using (SqliteCommand key = connection.CreateCommand())
        {
            key.CommandText = "PRAGMA table_info(OrderUpdates)";
            using SqliteDataReader reader = key.ExecuteReader();
            var primary = new System.Collections.Generic.List<string>();
            while (reader.Read())
            {
                if (reader.GetInt32(5) > 0) primary.Add(reader.GetString(1) + ":" + reader.GetInt32(5));
            }
            Assert.Equal(new[] { "Order:1", "Nr:2" }, primary.ToArray());
        }
        // StopPrice is in the file. The column list the fold was specified from
        // omitted it, and AttributionExport reads it for the stop price before the
        // trail moved it, so a fold built from that list would have broken the one
        // part of the package anything automated consumes - silently, because the
        // SqliteException is swallowed and the ZIP still ships.
        using (SqliteCommand stop = connection.CreateCommand())
        {
            stop.CommandText = "SELECT count(StopPrice) FROM OrderUpdates";
            Assert.Equal(3L, (long)stop.ExecuteScalar());
        }
    }

    [Fact]
    public async Task TheEmptyAllowlistedTablesStillShipAsTables()
    {
        // THE DECISION THIS TEST NAMES: a table the allowlist allows ships even
        // with 0 rows, and Positions is the one that matters.
        //
        // Positions, Strategy2Execution and User2Account hold 0 rows on both real
        // exports, and dropping them was the tidiest-looking part of the request.
        // It saves ZERO bytes - an empty table is a page of DDL, and their JSONL
        // files were already 0 bytes. Positions is a live open-position snapshot
        // and both exports were taken near the open with the desk flat, at 10:31
        // and 07:15; the first export taken mid-session has rows in it. So the
        // table has to be there, with its index, for those rows to arrive in.
        DeepExportResult result = await Runner().RunAsync();
        string extracted = Path.Combine(root, "empty");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        string shipped = Path.Combine(extracted, "db", "NinjaTrader.sqlite");

        Assert.Contains("Positions", TablesIn(shipped));
        using var connection = new SqliteConnection(Read(shipped));
        connection.Open();
        Assert.Equal(0L, Count(connection, "Positions"));
        using (SqliteCommand columns = connection.CreateCommand())
        {
            columns.CommandText = "SELECT * FROM Positions";
            using SqliteDataReader reader = columns.ExecuteReader();
            Assert.Equal(
                new[] { "Account", "Instrument", "AvgPrice", "MarketPosition", "Quantity", "StatementDate" },
                Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray());
        }
        using (SqliteCommand index = connection.CreateCommand())
        {
            // The index of an EMPTY table comes across too, so the first
            // mid-session export lands in a table that is already queryable.
            index.CommandText = "SELECT count(*) FROM sqlite_master WHERE type = 'index' AND name = 'Positions_i0'";
            Assert.Equal(1L, (long)index.ExecuteScalar());
        }
        // And the manifest counts it, so a reader sees 0 rather than a gap where
        // the table might or might not have been considered.
        JObject manifest = ReadManifest(result.ZipPath);
        Assert.Equal(0, (int)manifest["db"]["rowCounts"]["Positions"]);
    }

    /// <summary>
    /// A real temporary SQLite database built by hand, and the real filtered file
    /// CopyAllowedTables writes from it. Not a mock: the source is opened
    /// read-only and a second file is written beside it, exactly as in a run.
    /// </summary>
    private (string Source, string Shipped) Rebuild(string schemaAndRows)
    {
        Directory.CreateDirectory(root);
        string id = Guid.NewGuid().ToString("N");
        string source = Path.Combine(root, "shape-" + id + ".sqlite");
        using (var build = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = source, Pooling = false }.ConnectionString))
        {
            build.Open();
            using SqliteCommand command = build.CreateCommand();
            command.CommandText = schemaAndRows;
            command.ExecuteNonQuery();
        }
        string shipped = Path.Combine(root, "shape-out-" + id + ".sqlite");
        var warnings = new System.Collections.Generic.List<string>();
        Assert.NotNull(SqliteSnapshot.CopyAllowedTables(source, shipped, warnings));
        return (source, shipped);
    }

    private static long Count(SqliteConnection connection, string table)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = $"SELECT count(*) FROM \"{table}\"";
        return (long)command.ExecuteScalar();
    }

    /// <summary>
    /// Exactly what the removed DumpTable used to write for one table: SELECT *
    /// in the file's own order, one JSON object per row, every column under the
    /// name SQLite gives it, a blob reduced to its length. It lives here, in the
    /// test, because the promise being checked is about a file that no longer
    /// exists - generating it from two databases and comparing is how "the
    /// database still holds everything the dump did" becomes an assertion.
    /// </summary>
    private static string[] JsonLinesProjection(string databasePath, string table)
    {
        using var connection = new SqliteConnection(Read(databasePath));
        connection.Open();
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = $"SELECT * FROM \"{table}\"";
        using SqliteDataReader reader = command.ExecuteReader();
        var lines = new System.Collections.Generic.List<string>();
        while (reader.Read())
        {
            var row = new JObject();
            for (int i = 0; i < reader.FieldCount; i++)
            {
                object value = reader.IsDBNull(i) ? null : reader.GetValue(i);
                if (value is byte[] bytes) value = $"<blob {bytes.Length} bytes>";
                row[reader.GetName(i)] = value == null ? JValue.CreateNull() : JToken.FromObject(value);
            }
            lines.Add(row.ToString(Newtonsoft.Json.Formatting.None));
        }
        return lines.ToArray();
    }

    [Fact]
    public async Task TheManifestListsExactlyTheFilesThatShip()
    {
        // A manifest that names a file the package no longer has is a defect of
        // its own, and changing what ships is how you get one. files[] is built
        // by walking the staging tree after the database step, so it self-
        // corrects; db.sizeBytes and db.sha256 are the two that did not, because
        // they used to be taken off the copy rather than off the shipped file.
        DeepExportResult result = await Runner().RunAsync();
        string extracted = Path.Combine(root, "agree");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        JObject manifest = ReadManifest(result.ZipPath);

        using ZipArchive zip = ZipFile.OpenRead(result.ZipPath);
        string[] inPackage = zip.Entries.Select(e => e.FullName).OrderBy(n => n, StringComparer.Ordinal).ToArray();
        string[] listed = manifest["files"].Select(f => (string)f["path"])
            .Concat(new[] { "manifest.json" })
            .OrderBy(n => n, StringComparer.Ordinal)
            .ToArray();
        // Both directions: nothing listed that is missing, nothing shipped that
        // is unlisted.
        Assert.Equal(inPackage, listed);

        string shipped = Path.Combine(extracted, "db", "NinjaTrader.sqlite");
        Assert.Equal(new FileInfo(shipped).Length, (long)manifest["db"]["sizeBytes"]);
        Assert.Equal(DeepExportRunner.HashFile(shipped), (string)manifest["db"]["sha256"]);
        // The schema still records all of it. That is what makes the withheld
        // list checkable rather than a claim.
        string schema = ReadEntry(zip, "db/schema.sql");
        Assert.Contains("CREATE TABLE Users", schema);
        Assert.Contains("CREATE TABLE Accounts", schema);
    }

    [Fact]
    public async Task TheUnfilteredCopyIsGoneWhenTheRunEnds()
    {
        // The consistent copy is made outside the folder that becomes the ZIP, so
        // it cannot be packaged. It must not be left lying beside the packages
        // either, where the next person to zip that folder by hand would find it.
        DeepExportResult result = await Runner().RunAsync();
        Assert.True(File.Exists(result.ZipPath));
        Assert.Empty(Directory.EnumerateDirectories(outDir, ".work_*"));
        Assert.Empty(Directory.EnumerateDirectories(outDir, ".staging_*"));
        Assert.Empty(Directory.EnumerateFiles(outDir, "NinjaTrader.sqlite", SearchOption.AllDirectories));
    }

    [Fact]
    public void AFilteredDatabaseThatCannotBeBuiltMeansNoDatabaseAtAll()
    {
        // The unfiltered copy is not a fallback. It is the thing being fixed, so
        // the failure path has to ship nothing rather than ship that - and it has
        // to say so, because a package quietly missing its database would
        // otherwise look like a machine that never had one.
        string source = Path.Combine(root, "not-a-database.sqlite");
        Directory.CreateDirectory(root);
        File.WriteAllText(source, "this is not a SQLite file");
        string destination = Path.Combine(root, "out", "NinjaTrader.sqlite");
        var warnings = new System.Collections.Generic.List<string>();

        Assert.Null(SqliteSnapshot.CopyAllowedTables(source, destination, warnings));
        Assert.False(File.Exists(destination));
        Assert.Contains(warnings, w => w.Contains("no database is in this package", StringComparison.Ordinal));
    }

    /// <summary>The DeepExport sources as text, copied beside the test binary by the csproj.</summary>
    private static string[] DeepExportSourceFiles()
    {
        string folder = Path.Combine(AppContext.BaseDirectory, "allowlist-scan");
        Assert.True(Directory.Exists(folder), $"the DeepExport sources were not copied to {folder}; see the csproj");
        string[] files = Directory.GetFiles(folder, "*.cs");
        Assert.True(files.Length >= 6, $"expected every DeepExport source, found {files.Length}");
        return files;
    }

    private static int Occurrences(string text, string needle)
    {
        int count = 0;
        for (int at = text.IndexOf(needle, StringComparison.Ordinal); at >= 0; at = text.IndexOf(needle, at + 1, StringComparison.Ordinal))
            count++;
        return count;
    }

    /// <summary>Every byte of a database file as searchable characters, journal included.</summary>
    private static string Latin1(string databasePath)
    {
        var all = new System.Text.StringBuilder();
        foreach (string suffix in new[] { "", "-wal" })
        {
            if (File.Exists(databasePath + suffix))
                all.Append(System.Text.Encoding.Latin1.GetString(File.ReadAllBytes(databasePath + suffix)));
        }
        return all.ToString();
    }

    private static string Read(string databasePath)
    {
        return new SqliteConnectionStringBuilder { DataSource = databasePath, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ConnectionString;
    }

    private static string[] TablesIn(string databasePath)
    {
        using var connection = new SqliteConnection(Read(databasePath));
        connection.Open();
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
        using SqliteDataReader reader = command.ExecuteReader();
        var names = new System.Collections.Generic.List<string>();
        while (reader.Read()) names.Add(reader.GetString(0));
        return names.ToArray();
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
    }

    [Fact]
    public async Task TheRawTemplateLibraryDoesNotTravelAndTheCatalogueStillDoes()
    {
        // THE WHOLE OF RULE 1 IN ONE TEST, both halves, because either alone is
        // misleading. The library shipped as 886 raw .xml files in 20 family
        // directories - 88.7% of a real manifest's file list, 1,879,557 bytes
        // deflated, 657x the derived form - and nothing anywhere read it out of a
        // finished package. attribution/catalog.jsonl is the derived form, it is
        // the only export file any consumer opens, and it is NOT affected,
        // because AttributionExport reads the live NinjaTrader folder at step 1b
        // and not the staged copy.
        //
        // The fixture's template is still on disk under templates/Strategy, so a
        // green here means the copy stopped and the derivation did not.
        DeepExportResult result = await Runner().RunAsync();
        Assert.True(File.Exists(Path.Combine(nt, "templates", "Strategy", TemplateFamily, TemplateFile)),
            "the export must not touch NinjaTrader's own folders");

        using ZipArchive zip = ZipFile.OpenRead(result.ZipPath);
        string[] names = zip.Entries.Select(e => e.FullName).ToArray();

        // GONE, by path and by extension, so a renamed destination is caught too.
        Assert.DoesNotContain(names, n => n.StartsWith("templates", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(names, n => n.Contains("/Strategy/", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(names, n => n.EndsWith(TemplateFile, StringComparison.OrdinalIgnoreCase));

        // AND KEPT, with its row intact. 823 rows on a real machine; one here,
        // and the geometry has to be the template's own numbers or the catalogue
        // is present and useless - which is the failure the importer's loud
        // missing-file guard does NOT catch, because the file would exist.
        string catalog = ReadEntry(zip, "attribution/catalog.jsonl");
        Assert.NotEmpty(catalog);
        string[] rows = catalog.Split('\n', StringSplitOptions.RemoveEmptyEntries);
        Assert.Single(rows);
        JObject row = JObject.Parse(rows[0]);
        Assert.Equal(TemplateFamily, (string)row["family"]);
        Assert.Equal("MES", (string)row["instrument"]);
        Assert.Equal("v1", (string)row["version"]);
        Assert.Equal("Low", (string)row["risk"]);
        Assert.Equal(40, (int)row["stopTicks"]);
        Assert.Equal(new[] { 20, 60, 120 }, row["targetTicks"].Select(t => (int)t).ToArray());
        Assert.Equal(new[] { 2, 1, 1 }, row["sizes"].Select(t => (int)t).ToArray());

        // The catalogue carries no credential - measured 0 on the real one - so
        // keeping it is not keeping a key.
        Assert.DoesNotContain(TestLicence, catalog, StringComparison.Ordinal);
        Assert.DoesNotContain("LicenseKey", catalog, StringComparison.Ordinal);

        // AND THE MANIFEST AGREES, in the same package. A manifest that still
        // named 886 files the package no longer has would read as tampering, and
        // the .sha256 beside the ZIP would still verify, which is worse.
        JObject manifest = ReadManifest(result.ZipPath);
        Assert.DoesNotContain(
            manifest["files"].Select(f => (string)f["path"]),
            p => p.StartsWith("templates", StringComparison.OrdinalIgnoreCase));
        Assert.Equal(1, (int)manifest["attribution"]["templates"]);
    }

    [Fact]
    public void NoSourcePutsTheRawTemplateLibraryBackInThePackage()
    {
        // THE STRUCTURAL GUARD. The test above proves the files are absent from
        // one package; this one proves nobody can put them back by adding a
        // source, which is the quiet way a fix like this gets undone. The list is
        // the single definition of what ships as a file - DeepExportSources'
        // header says so - so asserting against the list is asserting against
        // every package it will ever produce.
        Assert.DoesNotContain(DeepExportSources.All, s =>
            s.ZipFolder.StartsWith("templates", StringComparison.OrdinalIgnoreCase)
            || s.RelativeFolder.Replace('\\', '/').StartsWith("templates", StringComparison.OrdinalIgnoreCase));

        // And the sources that remain are exactly these, so a NEW one has to be
        // decided here rather than appearing in a package nobody re-measured.
        Assert.Equal(
            new[]
            {
                "logs", "pending snapshots", "quarantined snapshots", "sent snapshots",
                "trace", "uploading snapshots", "workspaces",
            },
            DeepExportSources.All.Select(s => s.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray());
    }

    [Fact]
    public async Task TheQueueSnapshotsLoseTheirConfigurationAndKeepTheirDay()
    {
        // RULE 2. The queue snapshots carried the licence key in plain ASCII - 12
        // occurrences across 2 of 15 files on a real export, all 6 strategy rows -
        // and with it the full tuning: 149 extraValues entries including
        // TrailByTicks and StartTrailAfterTicks, which attribution/catalog.jsonl
        // does not carry at all. Emptied rather than deleted, because
        // src/domain/autoExportContract.js requires `parameters` to be an object
        // and deleting it broke every capture that had a strategy.
        DeepExportResult result = await Runner().RunAsync();
        using ZipArchive zip = ZipFile.OpenRead(result.ZipPath);
        JObject capture = JObject.Parse(ReadEntry(zip, "autoexport/sent/2026-09-15_abc.json"));
        JObject strategy = (JObject)capture["strategies"][0];

        // The maps are there and they are empty, so "configured and hidden" and
        // "never captured" stay different facts, and the contract still holds.
        Assert.Empty((JObject)strategy["parameters"]);
        Assert.Empty((JObject)strategy["extraValues"]);
        Assert.Equal("captured", (string)strategy["parameterCaptureStatus"]);

        // THE DAY SURVIVES INTACT, which is the whole reason these folders are
        // copied: pending/ holds the one day the CRM could not be reached.
        Assert.Equal("2026-09-15", (string)capture["tradingDate"]);
        Assert.Equal(312.5, (double)strategy["realizedPnl"]);
        Assert.Equal("G4M", (string)strategy["strategyName"]);
        Assert.Equal("MES", (string)strategy["instrument"]);
        Assert.Single((JArray)capture["orders"]);
        Assert.Single((JArray)capture["executions"]);
        // accounts[].accountValues is the client's own account and is NOT a
        // strategy row, so it stays - the rule's one deliberate exception.
        Assert.Equal(51234.5, (double)capture["accounts"][0]["accountValues"]["NetLiquidation"]);

        // And the key is gone with the map that held it, in both of the two
        // places it sat: LicenseKey itself and inside DisplayParameters.
        string raw = ReadEntry(zip, "autoexport/sent/2026-09-15_abc.json");
        Assert.DoesNotContain(TestLicence, raw, StringComparison.Ordinal);
        Assert.DoesNotContain("DisplayParameters", raw, StringComparison.Ordinal);

        // THE REST OF THE QUEUE IS NOT JSON AND IS NOT TOUCHED. A .receipt is not
        // a capture, and running a JSON rule over it would have withheld it.
        Assert.Equal("ok", ReadEntry(zip, "autoexport/sent/2026-09-15_abc.json.receipt"));
    }

    [Fact]
    public async Task TheLicenceKeyInsideADatabaseBlobIsMaskedAndTheGeometryIsNot()
    {
        // RULE 3, and the carrier no ASCII grep finds. Measured on a real export:
        // 12 of 12 Strategies rows carry a non-empty LicenseKey inside Userdata,
        // UTF-16LE and HTML-escaped, two distinct values, and ONE OF THEM APPEARS
        // NOWHERE ELSE IN THE PACKAGE - so dropping templates/ and emptying the
        // queue could never have reached it. Strategies is allowlisted and has to
        // be: AttributionExport joins it to name an algorithm. The constraint is
        // on the table, not the cell.
        DeepExportResult result = await Runner().RunAsync();
        string extracted = Path.Combine(root, "blob");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        string shipped = Path.Combine(extracted, "db", "NinjaTrader.sqlite");

        // THE GUARD THAT STOPS THIS PASSING FOR THE WRONG REASON: the key really
        // is in the live database, and really is invisible to ASCII there.
        // ORDINAL, because the default comparison is culture-sensitive and ICU
        // treats NUL as ignorable - so "V-..." is "found" inside "V\0-\0..." and
        // this guard would pass while proving the opposite of what it claims.
        string liveBytes = Latin1(Path.Combine(nt, "db", "NinjaTrader.sqlite"));
        Assert.DoesNotContain(TestLicence, liveBytes, StringComparison.Ordinal);
        Assert.Contains(TestLicence, System.Text.Encoding.Unicode.GetString(
            File.ReadAllBytes(Path.Combine(nt, "db", "NinjaTrader.sqlite"))), StringComparison.Ordinal);

        using var connection = new SqliteConnection(Read(shipped));
        connection.Open();
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT Userdata FROM Strategies WHERE Id = 3";
        byte[] stored = (byte[])command.ExecuteScalar();
        string text = System.Text.Encoding.Unicode.GetString(stored);

        // The key is gone, the element is still there, and the mask is the same
        // one the other three rules use so a single search finds all of them.
        Assert.DoesNotContain(TestLicence, text, StringComparison.Ordinal);
        Assert.Contains("&lt;LicenseKey&gt;***&lt;/LicenseKey&gt;", text, StringComparison.Ordinal);

        // AND NOTHING ELSE IN THE CELL MOVED. The same blob carries the live
        // parameterisation - 144 element names on a real row, about 35 of them the
        // stop, targets, sizes, trail, break-even and day filters - and that is
        // deliberately NOT removed: nothing else in the package holds it, and
        // attribution/catalog.jsonl already ships the same class of declared
        // geometry on purpose. The expectation is written out by hand above, so
        // this does not assert the rule against itself.
        Assert.Equal(StrategyBlobMasked, text);
        Assert.Contains("&lt;StopLossTicks&gt;40&lt;/StopLossTicks&gt;", text);
        Assert.Contains("&lt;TrailByTicks&gt;8&lt;/TrailByTicks&gt;", text);

        // The blobs with nothing to mask are copied byte for byte.
        command.CommandText = "SELECT Userdata FROM Strategies WHERE Id = 1";
        Assert.Equal(new byte[] { 0x0A, 0x0B, 0x0C }, (byte[])command.ExecuteScalar());
        command.CommandText = "SELECT Data FROM Accounts WHERE Id = 1";
        Assert.Equal(new byte[] { 0x01, 0x02, 0x03, 0x04 }, (byte[])command.ExecuteScalar());
    }

    [Fact]
    public void EveryRuleAboutWhatShipsIsStatedOnce()
    {
        // THE SAME DISCIPLINE AS TheAllowlistIsStatedInExactlyOnePlace, for the
        // rules this change added. The previous two PRs in this area exist
        // because a list was honoured in one file and undone by the file beside
        // it, and the strategy-configuration rule is the one with real history: it
        // was a private method in OfflineReportWriter, and the Deep Export was
        // copying the very same queue snapshots raw at the same time.
        string[] sources = DeepExportSourceFiles();

        // The recursive walk that empties a strategy row exists once. Counted by
        // its two property names together, which is what a second copy would have
        // to repeat whatever it called the method.
        int stripper = sources.Sum(f => Occurrences(File.ReadAllText(f), "o[\"extraValues\"] = new JObject()"));
        Assert.Equal(1, stripper);

        // And the file holding it is not the one that used to.
        string shared = sources.Single(f => Path.GetFileName(f) == "StrategyConfigurationRedactor.cs");
        Assert.Contains("o[\"extraValues\"] = new JObject()", File.ReadAllText(shared));
        string offline = sources.Single(f => Path.GetFileName(f) == "OfflineReportWriter.cs");
        Assert.DoesNotContain("o[\"extraValues\"] = new JObject()", File.ReadAllText(offline));
        Assert.Contains("StrategyConfigurationRedactor.Strip", File.ReadAllText(offline));

        // "NAMED LIKE A SECRET" IS ONE PREDICATE WITH THREE CALLERS NOW. The
        // licence term was added to it rather than beside it, which is the only
        // reason the blob rule and the config rule cannot disagree about whether
        // LicenseKey is a credential.
        int keyList = sources.Sum(f => Occurrences(File.ReadAllText(f), "password|passwd|pwd|api[_-]?key"));
        Assert.Equal(1, keyList);
        Assert.True(SecretRedactor.IsSecretKey("LicenseKey"));
        Assert.True(SecretRedactor.IsSecretKey("licenceKey"));
        Assert.True(SecretRedactor.IsSecretKey("deviceToken"));
        Assert.True(SecretRedactor.IsSecretKey("api_key"));
        Assert.False(SecretRedactor.IsSecretKey("StopLossTicks"));
        Assert.False(SecretRedactor.IsSecretKey("schedule"));

        // The mask is one constant, so one search over a package finds whatever
        // any of the four rules hid.
        Assert.Equal(SecretRedactor.Mask, TraceRedactor.Mask);
        Assert.Equal(SecretRedactor.Mask, StrategyUserdataRedactor.Mask);
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
            "{\"scheduleTime\":\"16:35\",\"deviceToken\":\"AAAA\",\"nested\":{\"apiKey\":\"BBBB\",\"schedule\":\"16:40\"},\"password\":\"CCCC\",\"emptySecret\":\"\"}")
            .RunAsync();
        string extracted = Path.Combine(root, "y");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        string config = File.ReadAllText(Path.Combine(extracted, "config", "agent.config.redacted.json"));
        Assert.DoesNotContain("AAAA", config);
        Assert.DoesNotContain("BBBB", config);
        Assert.DoesNotContain("CCCC", config);

        // THESE USED TO BE ASSERTED AS "***", AND THE RULE CHANGED UNDER THEM.
        // The file was copied through SecretRedactor, a denylist, which masked a
        // secret-named key and passed everything else - including clientName, a
        // person, which is why this test was green while the export said who it
        // was about. It is now an allowlist: a key it does not name is not in
        // the file at all, so there is no value left to mask. The keys are still
        // accounted for, by name, under _projection.notProjected; the mask and
        // the empty-stays-empty rule still apply to the fields the projection
        // DOES name, and AgentConfigProjectionTests is where that is asserted.
        JObject parsed = JObject.Parse(config);
        Assert.Equal("16:35", (string)parsed["scheduleTime"]);
        Assert.Null(parsed["deviceToken"]);
        Assert.Null(parsed["nested"]);
        Assert.Null(parsed["password"]);
        string[] accountedFor = parsed["_projection"]["notProjected"].Select(name => (string)name).ToArray();
        Assert.Equal(new[] { "deviceToken", "nested", "password", "emptySecret" }, accountedFor);

        var secretPattern = new Regex("(password|apikey|token|secret)\\s*\"?\\s*:\\s*\"([^\"]*)\"", RegexOptions.IgnoreCase);

        // THE SWEEP ABOVE COULD NEVER HAVE SEEN THE TRACE, which is why the
        // login travelled 2,179 times in a real export while this test was
        // green. It wants a JSON `key: "value"` in double quotes, and it lists
        // no key called `user`; the trace writes `user='value'` with single
        // quotes and an equals sign. So the same promise is now asserted in the
        // trace's own syntax as well.
        var keyedIdentityPattern = new Regex("\\buser\\s*=\\s*'([^']*)'", RegexOptions.IgnoreCase);
        var prosePattern = new Regex("\\bauthenticating\\s+(?:account|user)\\s+(\\S+)", RegexOptions.IgnoreCase);

        // AND IT COULD NEVER HAVE SEEN THE LICENCE KEY EITHER, for four reasons
        // that stacked, all of them measured rather than reasoned:
        //   (a) `LicenseKey` matches none of password|apikey|token|secret.
        //   (b) secretPattern wants a JSON key: "value" with a colon and double
        //       quotes; templates/ wrote <LicenseKey>v</LicenseKey>.
        //   (c) the fixture's only template was the literal "<Strategy/>", so
        //       the sweep read it and there was nothing in it to find.
        //   (d) the .sqlite branch `continue`d past the CONTENT, and an ASCII
        //       regex could not have seen a UTF-16LE payload anyway.
        // So the shape is asserted too, and the fixture now plants a value.
        var licencePattern = new Regex("V-[A-Za-z0-9]{6}-[A-Za-z0-9]{8}-[A-Za-z0-9]{7}");

        foreach (string file in Directory.EnumerateFiles(extracted, "*", SearchOption.AllDirectories))
        {
            // THE DATABASE IS NO LONGER EXEMPT, AND NOW NOR IS ITS CONTENT. This
            // sweep used to `continue` past the file entirely, which is why the
            // one test named after the promise could not see the 9 excluded
            // tables riding along inside it. Asking only which tables are present
            // was the next version of the same blind spot: it cannot see a
            // credential inside a cell of a table that is allowed to be there.
            // So both questions are asked - which tables, and then every cell of
            // every one of them, through the same three-form search as any file.
            if (file.EndsWith(".sqlite", StringComparison.OrdinalIgnoreCase))
            {
                Assert.All(TablesIn(file), t => Assert.True(
                    SqliteSnapshot.IsAllowedTable(t),
                    $"{Path.GetFileName(file)} ships {t}, which the allowlist excludes"));
                foreach ((string where, byte[] cell) in EveryCell(file))
                {
                    foreach (string form in Forms(cell))
                    {
                        Assert.DoesNotContain(TestLicence, form, StringComparison.Ordinal);
                        Assert.False(licencePattern.IsMatch(form), $"{where} holds a licence-shaped value");
                        Assert.DoesNotContain(TestLogin, form, StringComparison.Ordinal);
                    }
                }
                continue;
            }

            // THREE FORMS OF EVERY FILE, not one string. The bytes as text, the
            // bytes decoded as UTF-16LE, and the HTML-unescaped text. A check
            // that reads only the first comes back near-zero on a real package
            // and reads as success while the key is still in it.
            byte[] bytes = File.ReadAllBytes(file);
            string text = File.ReadAllText(file);
            foreach (string form in Forms(bytes))
            {
                foreach (Match match in secretPattern.Matches(form))
                {
                    Assert.True(match.Groups[2].Value == "***" || match.Groups[2].Value == "",
                        $"{Path.GetFileName(file)} leaks a secret: {match.Value}");
                }
                foreach (Match match in keyedIdentityPattern.Matches(form))
                {
                    Assert.True(match.Groups[1].Value == "***" || match.Groups[1].Value == "",
                        $"{Path.GetFileName(file)} leaks a login: {match.Value}");
                }
                foreach (Match match in prosePattern.Matches(form))
                {
                    Assert.True(match.Groups[1].Value == "***",
                        $"{Path.GetFileName(file)} leaks a login in prose: {match.Value}");
                }
                // THE VALUES THE FIXTURE PLANTED, BY VALUE, in every file of the
                // package. These are the assertions that fail without the rules
                // rather than merely describing a shape. And the SHAPE as well,
                // so a second key nobody planted is caught too - never a count of
                // `LicenseKey` tags, which on a real export is 1,772 for 886
                // values and does not move at all when a rule empties an element.
                Assert.DoesNotContain(TestLicence, form, StringComparison.Ordinal);
                Assert.False(licencePattern.IsMatch(form),
                    $"{Path.GetFileName(file)} holds a licence-shaped value");
                Assert.DoesNotContain(TestLogin, form, StringComparison.Ordinal);
            }
            Assert.DoesNotContain(TestLogin, text);
        }
    }

    /// <summary>
    /// Every TEXT and BLOB cell of every table in a shipped database, with where
    /// it came from. The licence key was measured in a BLOB on an ALLOWLISTED
    /// table, so no table-level question can reach it - only reading the cells.
    /// </summary>
    private static System.Collections.Generic.IEnumerable<(string Where, byte[] Value)> EveryCell(string databasePath)
    {
        using var connection = new SqliteConnection(Read(databasePath));
        connection.Open();
        foreach (string table in TablesIn(databasePath))
        {
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = $"SELECT * FROM \"{table}\"";
            using SqliteDataReader reader = command.ExecuteReader();
            while (reader.Read())
            {
                for (int i = 0; i < reader.FieldCount; i++)
                {
                    if (reader.IsDBNull(i)) continue;
                    object value = reader.GetValue(i);
                    byte[] bytes = value switch
                    {
                        byte[] blob => blob,
                        string text => System.Text.Encoding.UTF8.GetBytes(text),
                        _ => null,
                    };
                    if (bytes != null) yield return ($"{Path.GetFileName(databasePath)} {table}.{reader.GetName(i)}", bytes);
                }
            }
        }
    }

    /// <summary>
    /// The three forms any check of this package has to search, because the key
    /// was measured in all three: the bytes as text, the bytes as UTF-16LE, and
    /// either of those with HTML escapes resolved. SqliteSnapshot's header asks
    /// for exactly this and the measurement is why - 0 ASCII hits and 12 UTF-16LE
    /// hits in the same cells of one real database.
    /// </summary>
    private static System.Collections.Generic.IEnumerable<string> Forms(byte[] bytes)
    {
        string narrow = System.Text.Encoding.UTF8.GetString(bytes);
        yield return narrow;
        yield return System.Net.WebUtility.HtmlDecode(narrow);
        if (bytes.Length % 2 == 0)
        {
            string wide = System.Text.Encoding.Unicode.GetString(bytes);
            yield return wide;
            yield return System.Net.WebUtility.HtmlDecode(wide);
        }
    }

    [Fact]
    public async Task TheTraceAndTheLogsAreRedactedOnTheWayIntoThePackage()
    {
        // The login is in the trace and the logs in two shapes, and both have to
        // go while the rest of the line stays: mask the value, keep the key, so a
        // reader still sees that a login happened and when. The trading data on
        // the same lines is the export's reason to exist and is not touched.
        DeepExportResult result = await Runner().RunAsync();
        using ZipArchive zip = ZipFile.OpenRead(result.ZipPath);

        string trace = ReadEntry(zip, "trace/trace.20260915.txt");
        Assert.DoesNotContain(TestLogin, trace);
        Assert.Contains("user='***'", trace);
        Assert.Contains("authenticating account ***", trace);
        Assert.Contains("Cbi.Auth.RenewToken", trace);
        Assert.Contains("2026-09-15 09:30:00:100", trace);
        Assert.Contains("account='LTATAGREH509159302022'", trace);
        Assert.Contains("orderId='12345678901'", trace);
        // An empty value stays empty, so "no login recorded" and "a login
        // recorded and not named" stay distinguishable, as they do in the JSON.
        Assert.Contains("user=''", trace);
        // The CRLF a Windows VPS wrote is the CRLF that ships.
        Assert.Contains("\r\n", trace);
        Assert.DoesNotContain("\n\n", trace);

        // logs/ was not named by the review and carries the login in PROSE ONLY.
        // A fix scoped to trace/, or to the keyed shape, leaves it fully exposed.
        string log = ReadEntry(zip, "logs/log.20260915.txt");
        Assert.DoesNotContain(TestLogin, log);
        Assert.Contains("authenticating account ***", log);
        Assert.Contains("Please try again.", log);
        Assert.Contains("account='LTATAGREH509159302022'", log);
    }

    [Fact]
    public async Task TheManifestDigestsDescribeTheRedactedBytes()
    {
        // Redaction happens in the copy, so the manifest hashes what actually
        // ships. A pass bolted on after step 4 would leave every trace and log
        // digest describing bytes that no longer exist in the package.
        DeepExportResult result = await Runner().RunAsync();
        string extracted = Path.Combine(root, "z");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        JObject manifest = ReadManifest(result.ZipPath);

        foreach (string relative in new[] { "trace/trace.20260915.txt", "logs/log.20260915.txt" })
        {
            JToken entry = manifest["files"].First(f => (string)f["path"] == relative);
            string onDisk = Path.Combine(extracted, relative.Replace('/', Path.DirectorySeparatorChar));
            // The file that shipped is the redacted one AND the digest beside it
            // is that file's digest. Together these two rule out both ways of
            // getting the order wrong: no redaction at all, and redaction done
            // after step 4 hashed the originals.
            Assert.Contains(TraceRedactor.Mask, File.ReadAllText(onDisk));
            Assert.Equal(DeepExportRunner.HashFile(onDisk), (string)entry["sha256"]);
            Assert.Equal(new FileInfo(onDisk).Length, (long)entry["sizeBytes"]);
        }
    }

    private static string ReadEntry(ZipArchive zip, string name)
    {
        ZipArchiveEntry entry = zip.GetEntry(name);
        Assert.NotNull(entry);
        using var reader = new StreamReader(entry.Open());
        return reader.ReadToEnd();
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

    /* THE SECOND STATEMENT OF WHAT SHIPS, AND THE ONLY ONE A HUMAN READS.
     *
     * DeepExportSources.All is the list the code obeys. MainWindow.xaml holds a
     * sentence telling the operator what they are about to hand to the desk, and
     * nothing has ever tied the two together. When the template library stopped
     * shipping, that sentence still promised it, so the screen described a
     * package that no longer existed and the commit claiming All was "the only
     * statement of what ships" was wrong about the one statement that reaches a
     * person.
     *
     * This cannot check prose against a list in general. It pins the two claims
     * that would mislead: the operator must not be told the templates travel,
     * and must be told the licence does not. */
    [Fact]
    public void TheOperatorIsToldWhatTheExportActuallyCarries()
    {
        string xaml = File.ReadAllText(Path.Combine(CollectorRoot(), "src", "Vincere.AutoExport.Agent.UI", "MainWindow.xaml"));
        int at = xaml.IndexOf("Packages NinjaTrader", StringComparison.Ordinal);
        Assert.True(at >= 0, "the Deep Export description moved; this test points at nothing");
        string sentence = xaml.Substring(at, Math.Min(600, xaml.Length - at));

        // The first clause is the list of what the ZIP CONTAINS; the rest says what
        // is left out. Naming the templates in the second is right and was the
        // whole point, so this reads the two halves apart rather than banning the
        // word, which is what my first version did and it failed on the correct
        // text.
        int stop = sentence.IndexOf(". ", StringComparison.Ordinal);
        Assert.True(stop > 0, "the description is no longer two sentences; re-read it before trusting this test");
        string contains = sentence.Substring(0, stop);

        Assert.DoesNotContain("template", contains, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("template", sentence, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("left out", sentence, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("licence", sentence, StringComparison.OrdinalIgnoreCase);

        // AND THE CLIENT'S NAME, which is a third claim and the newest one.
        // config/agent.config.redacted.json carried it on both real exports while
        // this sentence listed only credentials, so the operator was told the
        // package was anonymous and was handing over one that named a person.
        // The name is masked now; the one sentence a human reads has to say so,
        // and must not imply the name is in there.
        Assert.DoesNotContain("client", contains, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("client", sentence, StringComparison.OrdinalIgnoreCase);
    }

    private static string CollectorRoot()
    {
        DirectoryInfo directory = new(AppContext.BaseDirectory);
        while (directory != null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "Directory.Build.props"))) return directory.FullName;
            directory = directory.Parent;
        }
        throw new DirectoryNotFoundException("Could not locate the collector root.");
    }
}
