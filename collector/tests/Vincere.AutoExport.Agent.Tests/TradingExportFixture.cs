using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.Exports;

namespace Vincere.AutoExport.Agent.Tests;

/* A MACHINE, IN A TEMP FOLDER: ProgramData beside a Windows profile.
 *
 *   <root>\ProgramData\Vincere\AutoExport          the only place a build may write
 *   <root>\Users\zz-trader-profile\Documents\NinjaTrader 8
 *       db\NinjaTrader.sqlite                       WAL mode, as the platform runs it
 *       templates\Strategy\G4M\<one template>.xml
 *       log\, trace\, workspaces\, Config.xml       what must never travel
 *
 * The database is shaped like the Deep Export's fixture (DeepExportTests), with
 * the order and execution columns this export reads, and carries the things
 * that must not leave: the withheld Users and JournalEntries tables, a password,
 * and the licence key in the measured carrier - a UTF-16LE Strategies.Userdata
 * blob whose escaped inner XML holds <LicenseKey> and a DisplayParameters string
 * that repeats it. Every value is INVENTED; nothing from a real export is here.
 *
 * Two trading days: 2026-08-03 (a whole trade - entry, stop, first target - by
 * the strategy that is linked to it) and 2026-09-15 (an entry and a stop). */
internal sealed class TradingExportFixture : IDisposable
{
    public const string Account = "LTATAGREH509159302022";
    public const string ProfileName = "zz-trader-profile";
    public const string TestLicence = "V-ZZQQ77-FIXTUREK-TESTKEY";
    public const string WithheldMarker = "ZZWITHHELDROWZZ";
    public const string Password = "hunter2-fixture";
    public const string TemplateFile = "1 - G4M (MES) - 15 Min - Low Risk - v1 - Period 0.xml";

    public static readonly DateTime DayA = new(2026, 8, 3, 9, 30, 0);
    public static readonly DateTime DayB = new(2026, 9, 15, 10, 21, 0);

    /// <summary>What Strategies.Userdata really holds: plain XML around HTML-escaped XML.</summary>
    public static readonly string StrategyBlobText =
        "<NinjaTrader><_Impl>&lt;?xml version=\"1.0\"?&gt;\r\n&lt;G4M_PF&gt;\r\n"
        + "  &lt;PosSize1&gt;2&lt;/PosSize1&gt;\r\n"
        + "  &lt;StopLossTicks&gt;40&lt;/StopLossTicks&gt;\r\n"
        + "  &lt;ProfitTarget1Ticks&gt;20&lt;/ProfitTarget1Ticks&gt;\r\n"
        + "  &lt;TrailByTicks&gt;8&lt;/TrailByTicks&gt;\r\n"
        + "  &lt;LicenseKey&gt;" + TestLicence + "&lt;/LicenseKey&gt;\r\n"
        + "  &lt;ApiToken&gt;&lt;/ApiToken&gt;\r\n"
        + "  &lt;DisplayParameters&gt;StopLossTicks=40;LicenseKey=" + TestLicence + "&lt;/DisplayParameters&gt;\r\n"
        + "  &lt;IsEnabled&gt;true&lt;/IsEnabled&gt;\r\n"
        + "  &lt;MondayFilter&gt;true&lt;/MondayFilter&gt;\r\n"
        + "&lt;/G4M_PF&gt;</_Impl></NinjaTrader>";

    public TradingExportFixture()
    {
        Root = Path.Combine(Path.GetTempPath(), "vincere-trading-export-" + Guid.NewGuid().ToString("n"));
        AgentRoot = Path.Combine(Root, "ProgramData", "Vincere", "AutoExport");
        ExportsRoot = Path.Combine(AgentRoot, "exports");
        UsersRoot = Path.Combine(Root, "Users");
        NinjaTrader = Path.Combine(UsersRoot, ProfileName, "Documents", "NinjaTrader 8");
        Database = Path.Combine(NinjaTrader, "db", "NinjaTrader.sqlite");
        Directory.CreateDirectory(AgentRoot);
        Directory.CreateDirectory(Path.Combine(NinjaTrader, "db"));
        Directory.CreateDirectory(Path.Combine(NinjaTrader, "log"));
        Directory.CreateDirectory(Path.Combine(NinjaTrader, "trace"));
        Directory.CreateDirectory(Path.Combine(NinjaTrader, "workspaces"));
        Directory.CreateDirectory(Path.Combine(NinjaTrader, "templates", "Strategy", "G4M"));
        File.WriteAllText(Path.Combine(NinjaTrader, "log", "log.20260803.txt"), "2026-08-03 09:30:00|account='" + Account + "' connected\r\n");
        File.WriteAllText(Path.Combine(NinjaTrader, "trace", "trace.20260803.txt"), "renew requested user='someoperator_example_org'\r\n");
        File.WriteAllText(Path.Combine(NinjaTrader, "workspaces", "Main.xml"), "<Workspace/>");
        File.WriteAllText(Path.Combine(NinjaTrader, "Config.xml"), "<Config><Password>" + Password + "</Password></Config>");
        File.WriteAllText(
            Path.Combine(NinjaTrader, "templates", "Strategy", "G4M", TemplateFile),
            "<StrategyTemplate><Strategy><G4M>"
            + "<PosSize1>2</PosSize1><PosSize2>1</PosSize2><PosSize3>1</PosSize3>"
            + "<StopLossTicks>40</StopLossTicks>"
            + "<ProfitTarget1Ticks>20</ProfitTarget1Ticks>"
            + "<ProfitTarget2Ticks>60</ProfitTarget2Ticks>"
            + "<ProfitTarget3Ticks>120</ProfitTarget3Ticks>"
            + "<LicenseKey>" + TestLicence + "</LicenseKey>"
            + "</G4M></Strategy></StrategyTemplate>");
        CreateDatabase();
    }

    public string Root { get; }
    public string AgentRoot { get; }
    public string ExportsRoot { get; }
    public string UsersRoot { get; }
    public string NinjaTrader { get; }
    public string Database { get; }

    public FixedUpdateDisk Disk { get; } = new();
    public RecordingDirectorySecurity Security { get; } = new();

    public TradingExportBuilder Builder(INinjaTraderFolderLocator locator = null, string ninjaTraderVersion = "8.1.6.0") => new(
        locator ?? new ProfileNinjaTraderFolderLocator(UsersRoot),
        ExportsRoot,
        AgentRoot,
        Disk,
        Security,
        "1.4.0",
        () => ninjaTraderVersion,
        () => new DateTimeOffset(2026, 10, 20, 16, 0, 0, TimeSpan.Zero));

    public static TradingExportPlan Plan(
        DateOnly? from = null,
        DateOnly? to = null,
        string[] datasets = null,
        long maxBytes = 25L * 1024 * 1024)
        => new("req-1", from, to, datasets ?? TradingExportDatasets.All.ToArray(), maxBytes);

    /// <summary>The decompressed file, line by line, dates left as the text they are.</summary>
    public static List<JObject> Lines(string gzipPath)
    {
        var lines = new List<JObject>();
        foreach (string line in Text(gzipPath).Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            using JsonTextReader reader = new(new StringReader(line)) { DateParseHandling = DateParseHandling.None };
            lines.Add((JObject)JToken.ReadFrom(reader));
        }
        return lines;
    }

    public static string Text(string gzipPath)
    {
        using FileStream file = File.OpenRead(gzipPath);
        using GZipStream gzip = new(file, CompressionMode.Decompress);
        using StreamReader reader = new(gzip, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    /// <summary>Every file outside the agent's data folder, by relative path, with its SHA-256.</summary>
    public Dictionary<string, string> EverythingOutsideTheDataFolder(bool ignoreSharedMemoryContent = false)
    {
        var files = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (string path in Directory.EnumerateFiles(Root, "*", SearchOption.AllDirectories))
        {
            string full = Path.GetFullPath(path);
            if (full.StartsWith(Path.GetFullPath(AgentRoot) + Path.DirectorySeparatorChar, StringComparison.Ordinal)) continue;
            string relative = Path.GetRelativePath(Root, full);
            // A reader of a live WAL database takes its read lock in the
            // platform's shared-memory index; that is the protocol, not a write
            // of data, and only its presence is compared.
            files[relative] = ignoreSharedMemoryContent && relative.EndsWith("-shm", StringComparison.Ordinal)
                ? "present"
                : Convert.ToHexString(SHA256.HashData(ReadSharingWithThePlatform(full)));
        }
        return files;
    }

    // File.ReadAllBytes allows only other readers, so on Windows it fails while
    // the platform's SQLite holds the database open for writing. Share the way
    // the agent's own copy does.
    private static byte[] ReadSharingWithThePlatform(string path)
    {
        using FileStream stream = new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
        using MemoryStream bytes = new();
        stream.CopyTo(bytes);
        return bytes.ToArray();
    }

    /// <summary>A connection that holds the database as the running platform does: WAL, a write not yet checkpointed.</summary>
    public SqliteConnection HoldLikeThePlatform(string extraExecutionName)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Database, Pooling = false }.ConnectionString);
        connection.Open();
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "PRAGMA wal_autocheckpoint=0; INSERT INTO Executions (Id, Account, Instrument, ExecutionId, [Order], OrderId, MarketPosition, Quantity, Price, IsEntry, IsExit, Name, Commission, Fee, Time) "
            + "VALUES (9, 1, 1, 'EX-9', NULL, NULL, 1, 1, 7700.0, 1, 0, $name, 0.5, 0.1, $time)";
        command.Parameters.AddWithValue("$name", extraExecutionName);
        command.Parameters.AddWithValue("$time", DayB.AddHours(1).Ticks);
        command.ExecuteNonQuery();
        return connection;
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { Directory.Delete(Root, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }

    private void CreateDatabase()
    {
        using var connection = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = Database, Pooling = false }.ConnectionString);
        connection.Open();
        Execute(connection, "PRAGMA journal_mode=WAL");
        Execute(connection, @"
            CREATE TABLE Accounts (Id INTEGER PRIMARY KEY, Name TEXT, Data BLOB);
            CREATE TABLE Instruments (Id INTEGER PRIMARY KEY, MasterInstrument INTEGER);
            CREATE TABLE MasterInstruments (Id INTEGER PRIMARY KEY, Name TEXT, TickSize REAL);
            CREATE TABLE Orders (
                Id INTEGER PRIMARY KEY, Account INTEGER, Instrument INTEGER, OrderId TEXT, OrderAction INTEGER,
                OrderType INTEGER, Quantity INTEGER, Filled INTEGER, LimitPrice REAL, StopPrice REAL,
                AvgFillPrice REAL, OrderState INTEGER, Oco TEXT, Name TEXT, Time INTEGER, Data BLOB);
            CREATE TABLE OrderUpdates (
                [Order] INTEGER NOT NULL, Nr INTEGER NOT NULL, OrderId TEXT, OrderState INTEGER,
                LimitPrice REAL, StopPrice REAL, Time INTEGER, PRIMARY KEY ([Order], Nr));
            CREATE TABLE Executions (
                Id INTEGER PRIMARY KEY, Account INTEGER, Instrument INTEGER, ExecutionId TEXT, [Order] INTEGER,
                OrderId TEXT, MarketPosition INTEGER, Quantity INTEGER, Price REAL, IsEntry INTEGER, IsExit INTEGER,
                Name TEXT, Commission REAL, Fee REAL, Time INTEGER);
            CREATE TABLE Strategies (Id INTEGER PRIMARY KEY, Name TEXT, Template TEXT, Userdata BLOB);
            CREATE TABLE Strategy2Order ([Order] INTEGER NOT NULL, Strategy INTEGER NOT NULL);
            CREATE TABLE Users (Id INTEGER PRIMARY KEY, Name TEXT, Password TEXT, Salt TEXT);
            CREATE TABLE JournalEntries (Id INTEGER PRIMARY KEY, Text TEXT);
            INSERT INTO Accounts VALUES (1, '" + Account + @"', X'01020304');
            INSERT INTO Instruments VALUES (1, 1);
            INSERT INTO MasterInstruments VALUES (1, 'MES', 0.25);
            INSERT INTO Users VALUES (1, '" + WithheldMarker + "', '" + Password + @"', 'salt');
            INSERT INTO JournalEntries VALUES (1, '" + WithheldMarker + @" a note about a client');
            INSERT INTO Strategies VALUES (2, 'Unlinked', '', NULL);
            INSERT INTO Strategies VALUES (3, 'Broken', '', X'0A0B0C');
            INSERT INTO Strategy2Order VALUES (1, 1);
            INSERT INTO Strategy2Order VALUES (2, 1);
            INSERT INTO Strategy2Order VALUES (3, 1);");

        using (SqliteCommand userdata = connection.CreateCommand())
        {
            userdata.CommandText = "INSERT INTO Strategies (Id, Name, Template, Userdata) VALUES (1, 'G4M_PF', '', $u)";
            userdata.Parameters.AddWithValue("$u", Encoding.Unicode.GetBytes(StrategyBlobText));
            userdata.ExecuteNonQuery();
        }

        // Day A: entry 2 @ 7650, stop placed at 7640 (40 ticks), first target at 7655 (20 ticks).
        Order(connection, 1, "BROKER-SECOND", 0, 1, 2, 2, 0, 0, 7650.00, 6, null, "Enter-Long", DayA);
        Order(connection, 2, "BROKER-STOP-A", 2, 4, 2, 0, 0, 7645.00, 0, 1, "oco-a", "Stop-Long", DayA.AddSeconds(1));
        Order(connection, 3, "BROKER-PT1-A", 2, 0, 2, 2, 7655.00, 0, 7655.00, 6, "oco-a", "PT1-Long", DayA.AddSeconds(1));
        // Day B: an entry and its stop, linked to no strategy.
        Order(connection, 4, "BROKER-ENTRY-B", 3, 1, 1, 1, 0, 0, 7680.00, 6, null, "Enter-Short", DayB);
        Order(connection, 5, "BROKER-STOP-B", 0, 4, 1, 0, 0, 7690.00, 0, 1, null, "Stop-Short", DayB.AddSeconds(1));

        // The broker reassigns an order's id over its life; the history keeps both.
        Update(connection, 1, 1, "BROKER-FIRST", 0, 0, DayA);
        Update(connection, 1, 2, "BROKER-SECOND", 0, 0, DayA);
        // The stop was placed at 7640 and trailed to 7645: the first update holds the original.
        Update(connection, 2, 1, "BROKER-STOP-A", 0, 7640.00, DayA);
        Update(connection, 2, 2, "BROKER-STOP-A", 0, 7645.00, DayA);
        Update(connection, 3, 1, "BROKER-PT1-A", 7655.00, 0, DayA);

        Execution(connection, 1, "EX-1", 1, "BROKER-SECOND", 1, 2, 7650.00, entry: true, "Enter-Long", DayA);
        Execution(connection, 2, "EX-2", 3, "BROKER-PT1-A", 2, 2, 7655.00, entry: false, "PT1-Long", DayA.AddMinutes(4));
        Execution(connection, 3, "EX-3", 4, "BROKER-ENTRY-B", 2, 1, 7680.00, entry: true, "Enter-Short", DayB);
    }

    private static void Order(
        SqliteConnection connection, long id, string orderId, int action, int type, int quantity, int filled,
        double limit, double stop, double average, int state, string oco, string name, DateTime time)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "INSERT INTO Orders (Id, Account, Instrument, OrderId, OrderAction, OrderType, Quantity, Filled, LimitPrice, StopPrice, AvgFillPrice, OrderState, Oco, Name, Time) "
            + "VALUES ($id, 1, 1, $orderId, $action, $type, $quantity, $filled, $limit, $stop, $average, $state, $oco, $name, $time)";
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$orderId", orderId);
        command.Parameters.AddWithValue("$action", action);
        command.Parameters.AddWithValue("$type", type);
        command.Parameters.AddWithValue("$quantity", quantity);
        command.Parameters.AddWithValue("$filled", filled);
        command.Parameters.AddWithValue("$limit", limit);
        command.Parameters.AddWithValue("$stop", stop);
        command.Parameters.AddWithValue("$average", average);
        command.Parameters.AddWithValue("$state", state);
        command.Parameters.AddWithValue("$oco", (object)oco ?? DBNull.Value);
        command.Parameters.AddWithValue("$name", name);
        command.Parameters.AddWithValue("$time", time.Ticks);
        command.ExecuteNonQuery();
    }

    private static void Update(SqliteConnection connection, long order, int nr, string orderId, double limit, double stop, DateTime time)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "INSERT INTO OrderUpdates ([Order], Nr, OrderId, OrderState, LimitPrice, StopPrice, Time) VALUES ($o, $n, $id, 1, $l, $s, $t)";
        command.Parameters.AddWithValue("$o", order);
        command.Parameters.AddWithValue("$n", nr);
        command.Parameters.AddWithValue("$id", orderId);
        command.Parameters.AddWithValue("$l", limit);
        command.Parameters.AddWithValue("$s", stop);
        command.Parameters.AddWithValue("$t", time.Ticks);
        command.ExecuteNonQuery();
    }

    private static void Execution(
        SqliteConnection connection, long id, string executionId, long order, string orderId, int position,
        int quantity, double price, bool entry, string name, DateTime time)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "INSERT INTO Executions (Id, Account, Instrument, ExecutionId, [Order], OrderId, MarketPosition, Quantity, Price, IsEntry, IsExit, Name, Commission, Fee, Time) "
            + "VALUES ($id, 1, 1, $eid, $order, $oid, $pos, $q, $p, $entry, $exit, $name, 0.62, 0.35, $t)";
        command.Parameters.AddWithValue("$id", id);
        command.Parameters.AddWithValue("$eid", executionId);
        command.Parameters.AddWithValue("$order", order);
        command.Parameters.AddWithValue("$oid", orderId);
        command.Parameters.AddWithValue("$pos", position);
        command.Parameters.AddWithValue("$q", quantity);
        command.Parameters.AddWithValue("$p", price);
        command.Parameters.AddWithValue("$entry", entry ? 1 : 0);
        command.Parameters.AddWithValue("$exit", entry ? 0 : 1);
        command.Parameters.AddWithValue("$name", name);
        command.Parameters.AddWithValue("$t", time.Ticks);
        command.ExecuteNonQuery();
    }

    private static void Execute(SqliteConnection connection, string sql)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }
}
