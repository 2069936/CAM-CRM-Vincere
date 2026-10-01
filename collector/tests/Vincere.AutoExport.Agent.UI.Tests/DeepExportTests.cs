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
            CREATE TABLE Orders (Id INTEGER PRIMARY KEY, Account TEXT, Instrument INTEGER REFERENCES Instruments(Id));
            CREATE INDEX IX_Executions_Time ON Executions (Time);
            CREATE TABLE MarketDataCache (Id INTEGER PRIMARY KEY);
            CREATE TABLE Instruments (Id INTEGER PRIMARY KEY, Name TEXT);
            CREATE TABLE Users (Id INTEGER PRIMARY KEY, Name TEXT, Password TEXT, Salt TEXT);
            CREATE TABLE JournalEntries (Id INTEGER PRIMARY KEY, Text TEXT);
            CREATE TABLE OrderUpdates (
                [Order] INTEGER NOT NULL REFERENCES Orders(Id), Nr INTEGER NOT NULL,
                OrderId TEXT, OrderState INTEGER, StatementDate INTEGER, StopPrice REAL, Time INTEGER,
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
            INSERT INTO Instruments VALUES (1, 'MNQ 12-26');
            INSERT INTO Orders VALUES (1, 'LTATAGREH509159302022', 1);
            INSERT INTO Orders VALUES (2, 'LTATAGREH509159302022', 1);
            INSERT INTO JournalEntries VALUES (1, '" + WithheldLive + @" a note about a client');
            INSERT INTO Users VALUES (1, '" + WithheldLive + @"', 'hunter2', 'salt');
            INSERT INTO AccountItems VALUES (1, 1, 1, 50000.0, 638000000000000001);
            INSERT INTO AccountItems VALUES (1, 1, 2, 1250.5, 638000000000000002);
            INSERT INTO Strategies VALUES (1, 'G4M', '', X'0A0B0C');
            INSERT INTO Strategies VALUES (2, 'Unlinked', '', NULL);
            INSERT INTO Strategy2Order VALUES (1, 1);";
        command.ExecuteNonQuery();

        // THE HISTORY, INSERTED OUT OF ORDER ON PURPOSE. Nr is the sequence and
        // the rows arrive in 3, 1, 2. Nothing may depend on insertion order, and
        // the two distinct OrderId values are the measured shape of a real
        // order's life: 18,610 of 18,827 orders on the big export carry exactly
        // two, because the broker reassigns the id. Order 2 has no updates at
        // all. Times are 18-digit .NET ticks, above 2^53, as the real ones are.
        using (SqliteCommand history = connection.CreateCommand())
        {
            history.CommandText = @"
                INSERT INTO OrderUpdates VALUES (1, 3, 'BROKER-SECOND', 6, 638000000000000000, 7650.25, 638000000000000123);
                INSERT INTO OrderUpdates VALUES (1, 1, 'BROKER-FIRST', 1, 638000000000000000, 7640.75, 638000000000000121);
                INSERT INTO OrderUpdates VALUES (1, 2, 'BROKER-FIRST', 2, 638000000000000000, 7645.50, 638000000000000122);";
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
            Assert.Equal(JsonLinesProjection(live, table), JsonLinesProjection(shipped, table));
        }

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

        // THE SWEEP ABOVE COULD NEVER HAVE SEEN THE TRACE, which is why the
        // login travelled 2,179 times in a real export while this test was
        // green. It wants a JSON `key: "value"` in double quotes, and it lists
        // no key called `user`; the trace writes `user='value'` with single
        // quotes and an equals sign. So the same promise is now asserted in the
        // trace's own syntax as well.
        var keyedIdentityPattern = new Regex("\\buser\\s*=\\s*'([^']*)'", RegexOptions.IgnoreCase);
        var prosePattern = new Regex("\\bauthenticating\\s+(?:account|user)\\s+(\\S+)", RegexOptions.IgnoreCase);
        foreach (string file in Directory.EnumerateFiles(extracted, "*", SearchOption.AllDirectories))
        {
            // THE DATABASE IS NO LONGER EXEMPT, it is checked as a database.
            // This sweep used to `continue` past it, which is why the one test
            // named after the promise could not see the 9 excluded tables riding
            // along inside it. A text regex over a binary file would not have
            // seen them either - the question a database file answers is which
            // tables are in it, so that is the question asked of it here.
            if (file.EndsWith(".sqlite", StringComparison.OrdinalIgnoreCase))
            {
                Assert.All(TablesIn(file), t => Assert.True(
                    SqliteSnapshot.IsAllowedTable(t),
                    $"{Path.GetFileName(file)} ships {t}, which the allowlist excludes"));
                continue;
            }
            string text = File.ReadAllText(file);
            foreach (Match match in secretPattern.Matches(text))
            {
                Assert.True(match.Groups[2].Value == "***" || match.Groups[2].Value == "",
                    $"{Path.GetFileName(file)} leaks a secret: {match.Value}");
            }
            foreach (Match match in keyedIdentityPattern.Matches(text))
            {
                Assert.True(match.Groups[1].Value == "***" || match.Groups[1].Value == "",
                    $"{Path.GetFileName(file)} leaks a login: {match.Value}");
            }
            foreach (Match match in prosePattern.Matches(text))
            {
                Assert.True(match.Groups[1].Value == "***",
                    $"{Path.GetFileName(file)} leaks a login in prose: {match.Value}");
            }
            // And the one the fixture actually planted, by value, in every file
            // of the package. This is the assertion that fails without the
            // redactor rather than merely describing a shape.
            Assert.DoesNotContain(TestLogin, text);
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
}
