using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.Exports;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* THE SLIM TRADING EXPORT, BUILT FOR REAL AGAINST A FAKE MACHINE.
 *
 * Real SQLite, real copy, real attribution, real gzip. What is faked is where
 * the machine is: a temp folder holding a ProgramData and a Windows profile. */
public sealed class TradingExportBuilderTests : IDisposable
{
    private static readonly string[] Allowed = { "manifest", "executions", "orders", "strategies", "trades" };
    private readonly TradingExportFixture machine = new();

    public void Dispose() => machine.Dispose();

    [Fact]
    public async Task The_manifest_comes_first_and_counts_what_follows_it()
    {
        using TradingExportBuild build = await machine.Builder().BuildAsync(TradingExportFixture.Plan(), CancellationToken.None);

        Assert.True(build.Ok, build.ErrorCode);
        List<JObject> lines = TradingExportFixture.Lines(build.FilePath);
        JObject manifest = lines[0];
        Assert.Equal("manifest", (string)manifest["dataset"]);
        Assert.Single(lines, line => (string)line["dataset"] == "manifest");
        Assert.Equal("1.4.0", (string)manifest["agentVersion"]);
        Assert.Equal("8.1.6.0", (string)manifest["ninjaTraderVersion"]);
        Assert.Equal(JTokenType.Null, manifest["from"].Type);
        Assert.Equal(JTokenType.Null, manifest["to"].Type);
        Assert.Equal("2026-10-20T16:00:00.000Z", (string)manifest["generatedAt"]);
        Assert.Equal(new[] { "executions", "orders", "strategies", "trades" }, manifest["datasets"].Values<string>().ToArray());

        // Each dataset's lines are together, in the allowlist's order, and the
        // counts in the manifest are the lines that follow it.
        string[] order = lines.Skip(1).Select(line => (string)line["dataset"]).ToArray();
        Assert.Equal(order.OrderBy(name => Array.IndexOf(Allowed, name)).ToArray(), order);
        foreach (string dataset in new[] { "executions", "orders", "strategies", "trades" })
            Assert.Equal((long)manifest["rowCounts"][dataset], order.LongCount(name => name == dataset));
        Assert.Equal(3, (long)manifest["rowCounts"]["executions"]);
        Assert.Equal(5, (long)manifest["rowCounts"]["orders"]);
        Assert.Equal(3, (long)manifest["rowCounts"]["strategies"]);
        Assert.Equal(2, (long)manifest["rowCounts"]["trades"]);

        // What the loop reports to the CRM is what the file says.
        Assert.Equal(new Vincere.AutoExport.Agent.Crm.ExportRowCounts(3, 5, 3, 2), build.RowCounts);
        Assert.Equal(new FileInfo(build.FilePath).Length, build.ByteSize);
        Assert.Equal(UpdateFixtures.Sha256(File.ReadAllBytes(build.FilePath)), build.Sha256);
    }

    [Fact]
    public async Task Only_the_datasets_asked_for_are_written_and_the_others_count_zero()
    {
        using TradingExportBuild build = await machine.Builder()
            .BuildAsync(TradingExportFixture.Plan(datasets: new[] { "orders" }), CancellationToken.None);

        List<JObject> lines = TradingExportFixture.Lines(build.FilePath);
        Assert.Equal(new[] { "orders" }, lines[0]["datasets"].Values<string>().ToArray());
        Assert.All(lines.Skip(1), line => Assert.Equal("orders", (string)line["dataset"]));
        Assert.Equal(new Vincere.AutoExport.Agent.Crm.ExportRowCounts(0, 5, 0, 0), build.RowCounts);
        Assert.Equal(0, (long)lines[0]["rowCounts"]["executions"]);
    }

    [Fact]
    public async Task Executions_orders_and_trades_keep_to_the_range_and_strategies_do_not_depend_on_it()
    {
        DateOnly dayA = DateOnly.FromDateTime(TradingExportFixture.DayA);
        using TradingExportBuild build = await machine.Builder()
            .BuildAsync(TradingExportFixture.Plan(dayA, dayA), CancellationToken.None);

        List<JObject> lines = TradingExportFixture.Lines(build.FilePath);
        Assert.Equal("2026-08-03", (string)lines[0]["from"]);
        Assert.Equal("2026-08-03", (string)lines[0]["to"]);
        Assert.Equal(new long[] { 1, 2 }, Rows(lines, "executions").Select(line => (long)line["executionRowId"]).ToArray());
        Assert.Equal(new long[] { 1, 2, 3 }, Rows(lines, "orders").Select(line => (long)line["orderRowId"]).ToArray());
        JObject trade = Assert.Single(Rows(lines, "trades"));
        Assert.Equal(1, (long)trade["entryOrderRowId"]);
        Assert.Equal(3, Rows(lines, "strategies").Count);

        using TradingExportBuild later = await machine.Builder()
            .BuildAsync(TradingExportFixture.Plan(from: new DateOnly(2026, 9, 1)), CancellationToken.None);
        List<JObject> laterLines = TradingExportFixture.Lines(later.FilePath);
        Assert.Equal(new long[] { 3 }, Rows(laterLines, "executions").Select(line => (long)line["executionRowId"]).ToArray());
        Assert.Equal(new long[] { 4, 5 }, Rows(laterLines, "orders").Select(line => (long)line["orderRowId"]).ToArray());
        Assert.Equal(4, (long)Assert.Single(Rows(laterLines, "trades"))["entryOrderRowId"]);
    }

    [Fact]
    public async Task An_order_carries_what_the_analysis_needs_and_its_whole_id_history()
    {
        using TradingExportBuild build = await machine.Builder().BuildAsync(TradingExportFixture.Plan(), CancellationToken.None);

        List<JObject> lines = TradingExportFixture.Lines(build.FilePath);
        JObject entry = Rows(lines, "orders").Single(line => (long)line["orderRowId"] == 1);
        Assert.Equal("BROKER-SECOND", (string)entry["orderId"]);
        Assert.Equal(new[] { "BROKER-FIRST", "BROKER-SECOND" }, entry["orderIdHistory"].Values<string>().ToArray());
        // Exact to the tick, as text: a JSON number would round an 18-digit tick.
        Assert.Equal("2026-08-03T09:30:00.0000000", (string)entry["time"]);
        Assert.Equal(TradingExportFixture.Account, (string)entry["accountName"]);
        Assert.Equal("MES", (string)entry["instrument"]);
        Assert.Equal(0, (long)entry["action"]);
        Assert.Equal(1, (long)entry["orderType"]);
        Assert.Equal(2, (long)entry["quantity"]);
        Assert.Equal(2, (long)entry["filled"]);
        Assert.Equal(7650.0, (double)entry["averageFillPrice"]);
        Assert.Equal(6, (long)entry["state"]);
        Assert.Equal("Enter-Long", (string)entry["name"]);
        Assert.Equal(1, (long)entry["strategyId"]);
        Assert.Equal("G4M_PF", (string)entry["strategyName"]);

        JObject stop = Rows(lines, "orders").Single(line => (long)line["orderRowId"] == 2);
        Assert.Equal(7645.0, (double)stop["stopPrice"]);
        Assert.Equal("oco-a", (string)stop["oco"]);
        JObject unlinked = Rows(lines, "orders").Single(line => (long)line["orderRowId"] == 4);
        Assert.Equal(JTokenType.Null, unlinked["strategyName"].Type);

        JObject fill = Rows(lines, "executions").Single(line => (long)line["executionRowId"] == 2);
        Assert.Equal("EX-2", (string)fill["executionId"]);
        Assert.Equal(3, (long)fill["orderRowId"]);
        Assert.Equal("BROKER-PT1-A", (string)fill["orderId"]);
        Assert.Equal(7655.0, (double)fill["price"]);
        Assert.False((bool)fill["isEntry"]);
        Assert.True((bool)fill["isExit"]);
        Assert.Equal("PT1-Long", (string)fill["name"]);
        Assert.Equal("G4M_PF", (string)fill["strategyName"]);
    }

    [Fact]
    public async Task Trades_are_the_geometry_attribution_already_computes()
    {
        using TradingExportBuild build = await machine.Builder().BuildAsync(TradingExportFixture.Plan(), CancellationToken.None);

        JObject trade = Rows(TradingExportFixture.Lines(build.FilePath), "trades").Single(line => (long)line["entryOrderRowId"] == 1);
        Assert.Equal(TradingExportFixture.Account, (string)trade["accountName"]);
        Assert.Equal("MES", (string)trade["instrument"]);
        Assert.Equal("2026-08-03T09:30:00.0000000", (string)trade["entryTime"]);
        Assert.Equal(2, (long)trade["entryQuantity"]);
        Assert.Equal(2, (long)trade["exits"]);
        Assert.Equal("record", (string)trade["basis"]);
        Assert.Equal("G4M_PF", (string)trade["strategyName"]);
        Assert.False(string.IsNullOrEmpty((string)trade["geometry"]));
        // And the ledger AttributionExport keeps lives beside the queue, as it always has.
        Assert.True(File.Exists(Path.Combine(machine.AgentRoot, "attribution-ledger.jsonl")));
    }

    [Fact]
    public async Task A_strategy_carries_its_configuration_with_every_secret_masked()
    {
        using TradingExportBuild build = await machine.Builder().BuildAsync(TradingExportFixture.Plan(), CancellationToken.None);

        List<JObject> strategies = Rows(TradingExportFixture.Lines(build.FilePath), "strategies");
        JObject g4m = strategies.Single(line => (long)line["strategyId"] == 1);
        Assert.Equal("G4M_PF", (string)g4m["strategyName"]);
        Assert.Equal("G4M", (string)g4m["family"]);
        Assert.True((bool)g4m["propFirm"]);
        // The instance's own declared geometry, matched against the machine's template library.
        Assert.Equal("v1", (string)g4m["version"]);
        Assert.Equal("Low", (string)g4m["risk"]);
        Assert.Equal(TradingExportFixture.Account, (string)g4m["accountName"]);
        Assert.Equal("MES", (string)g4m["instrument"]);
        Assert.True((bool)g4m["enabled"]);
        Assert.Equal("read", (string)g4m["parameterStatus"]);

        JObject parameters = (JObject)g4m["parameters"];
        Assert.Equal("2", (string)parameters["PosSize1"]);
        Assert.Equal("40", (string)parameters["StopLossTicks"]);
        Assert.Equal("8", (string)parameters["TrailByTicks"]);
        // The licence key keeps its name and loses its value...
        Assert.Equal("***", (string)parameters["LicenseKey"]);
        // ...an empty secret stays empty, so "never configured" is still a fact...
        Assert.Equal(string.Empty, (string)parameters["ApiToken"]);
        // ...and the copy of it inside a value whose name is not secret is gone too.
        Assert.Equal("StopLossTicks=40;LicenseKey=***", (string)parameters["DisplayParameters"]);

        JObject broken = strategies.Single(line => (long)line["strategyId"] == 3);
        Assert.Equal("unreadable", (string)broken["parameterStatus"]);
        Assert.Equal(JTokenType.Null, broken["parameters"].Type);
        JObject unlinked = strategies.Single(line => (long)line["strategyId"] == 2);
        Assert.Equal("absent", (string)unlinked["parameterStatus"]);
        Assert.Equal(JTokenType.Null, unlinked["accountName"].Type);
    }

    [Fact]
    public async Task Nothing_that_authenticates_or_identifies_the_machine_is_in_the_file()
    {
        using TradingExportBuild build = await machine.Builder().BuildAsync(TradingExportFixture.Plan(), CancellationToken.None);

        string text = TradingExportFixture.Text(build.FilePath);
        List<JObject> lines = TradingExportFixture.Lines(build.FilePath);
        Assert.All(lines, line => Assert.Contains((string)line["dataset"], Allowed));
        // The licence, in every form it is stored in on the fixture: the blob,
        // the DisplayParameters string and the template library.
        Assert.DoesNotContain(TradingExportFixture.TestLicence, text);
        Assert.DoesNotContain("FIXTUREK", text);
        // The withheld tables and the connection credentials.
        Assert.DoesNotContain(TradingExportFixture.WithheldMarker, text);
        Assert.DoesNotContain(TradingExportFixture.Password, text);
        Assert.DoesNotContain("salt", text);
        // Where the machine keeps things, and whose profile it is.
        Assert.DoesNotContain(TradingExportFixture.ProfileName, text);
        Assert.DoesNotContain("NinjaTrader 8", text);
        Assert.DoesNotContain(machine.Root, text);
        Assert.DoesNotContain("ProgramData", text);
        // No logs, traces or workspaces.
        Assert.DoesNotContain("someoperator", text);
        Assert.DoesNotContain("Workspace", text);
    }

    [Fact]
    public async Task A_file_over_the_limit_is_refused_and_leaves_nothing_behind()
    {
        using TradingExportBuild build = await machine.Builder()
            .BuildAsync(TradingExportFixture.Plan(maxBytes: 300), CancellationToken.None);

        Assert.False(build.Ok);
        Assert.Equal("export_too_large", build.ErrorCode);
        Assert.Null(build.FilePath);
        Assert.Empty(Directory.EnumerateDirectories(machine.ExportsRoot, "work-*"));
    }

    [Fact]
    public async Task Disposing_the_build_deletes_the_file_and_its_folder()
    {
        TradingExportBuild build = await machine.Builder().BuildAsync(TradingExportFixture.Plan(), CancellationToken.None);
        Assert.True(File.Exists(build.FilePath));
        // The database copy was gone before the file was even written.
        Assert.Equal(new[] { TradingExportBuilder.FileName }, Directory.GetFiles(build.WorkDirectory).Select(Path.GetFileName).ToArray());

        build.Dispose();

        Assert.False(Directory.Exists(build.WorkDirectory));
        Assert.Empty(Directory.EnumerateDirectories(machine.ExportsRoot, "work-*"));
    }

    [Fact]
    public async Task Nothing_is_written_outside_the_agents_data_folder_with_NinjaTrader_closed()
    {
        Dictionary<string, string> before = machine.EverythingOutsideTheDataFolder();
        Assert.DoesNotContain(before.Keys, path => path.EndsWith("-wal", StringComparison.Ordinal) || path.EndsWith("-shm", StringComparison.Ordinal));

        using TradingExportBuild build = await machine.Builder().BuildAsync(TradingExportFixture.Plan(), CancellationToken.None);

        Assert.True(build.Ok, build.ErrorCode);
        Assert.StartsWith(Path.GetFullPath(machine.ExportsRoot) + Path.DirectorySeparatorChar, build.FilePath, StringComparison.Ordinal);
        // Not a byte changed and not a file added - in particular no -wal or -shm
        // beside the database, which a read-only SQLite open of a closed WAL
        // database would have left there.
        Assert.Equal(before, machine.EverythingOutsideTheDataFolder());
        Assert.Contains(machine.Security.Protected, path => Path.GetFullPath(path) == Path.GetFullPath(machine.ExportsRoot));
    }

    [Fact]
    public async Task With_NinjaTrader_holding_the_database_the_copy_is_consistent_and_its_folder_is_left_alone()
    {
        using SqliteConnection platform = machine.HoldLikeThePlatform("held-by-platform");
        Assert.True(File.Exists(machine.Database + "-wal"));
        Dictionary<string, string> before = machine.EverythingOutsideTheDataFolder(ignoreSharedMemoryContent: true);

        using TradingExportBuild build = await machine.Builder()
            .BuildAsync(TradingExportFixture.Plan(datasets: new[] { "executions" }), CancellationToken.None);

        Assert.True(build.Ok, build.ErrorCode);
        // The row the platform wrote is still only in its WAL, and the export has it.
        Assert.Contains(Rows(TradingExportFixture.Lines(build.FilePath), "executions"), line => (string)line["name"] == "held-by-platform");
        Assert.Equal(before, machine.EverythingOutsideTheDataFolder(ignoreSharedMemoryContent: true));
    }

    [Fact]
    public async Task Too_little_disk_is_refused_before_anything_is_copied()
    {
        machine.Disk.FreeBytes = TradingExportBuilder.DiskMargin;

        using TradingExportBuild build = await machine.Builder().BuildAsync(TradingExportFixture.Plan(), CancellationToken.None);

        Assert.Equal("disk_space", build.ErrorCode);
        Assert.Empty(Directory.EnumerateDirectories(machine.ExportsRoot, "work-*"));
    }

    [Fact]
    public async Task A_machine_whose_NinjaTrader_cannot_be_found_says_so_and_does_not_guess()
    {
        Directory.CreateDirectory(Path.Combine(machine.UsersRoot, "second-trader", "Documents", "NinjaTrader 8", "db"));
        File.Copy(machine.Database, Path.Combine(machine.UsersRoot, "second-trader", "Documents", "NinjaTrader 8", "db", "NinjaTrader.sqlite"));

        using TradingExportBuild build = await machine.Builder().BuildAsync(TradingExportFixture.Plan(), CancellationToken.None);

        Assert.Equal("ninjatrader_folder_ambiguous", build.ErrorCode);
        Assert.False(Directory.Exists(machine.ExportsRoot) && Directory.EnumerateDirectories(machine.ExportsRoot, "work-*").Any());
    }

    [Fact]
    public async Task Stale_work_from_an_interrupted_build_is_swept()
    {
        string stale = Path.Combine(machine.ExportsRoot, "work-stale");
        Directory.CreateDirectory(stale);
        File.WriteAllText(Path.Combine(stale, "NinjaTrader.sqlite"), "left by a crash");
        string other = Path.Combine(machine.ExportsRoot, "keep-me");
        Directory.CreateDirectory(other);

        using TradingExportBuild build = await machine.Builder().BuildAsync(TradingExportFixture.Plan(), CancellationToken.None);

        Assert.False(Directory.Exists(stale));
        Assert.True(Directory.Exists(other));
    }

    [Fact]
    public async Task A_cancelled_build_throws_and_leaves_no_work_folder()
    {
        using CancellationTokenSource cancelled = new();
        cancelled.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => machine.Builder().BuildAsync(TradingExportFixture.Plan(), cancelled.Token));

        Assert.Empty(Directory.EnumerateDirectories(machine.ExportsRoot, "work-*"));
    }

    [Fact]
    public async Task An_unknown_NinjaTrader_version_is_written_as_null()
    {
        using TradingExportBuild build = await machine.Builder(ninjaTraderVersion: null)
            .BuildAsync(TradingExportFixture.Plan(datasets: new[] { "strategies" }), CancellationToken.None);

        Assert.Equal(JTokenType.Null, TradingExportFixture.Lines(build.FilePath)[0]["ninjaTraderVersion"].Type);
    }

    private static List<JObject> Rows(IEnumerable<JObject> lines, string dataset)
        => lines.Where(line => (string)line["dataset"] == dataset).ToList();
}

public sealed class NinjaTraderProfileLocatorTests : IDisposable
{
    private readonly string users = Path.Combine(Path.GetTempPath(), "vincere-profiles-" + Guid.NewGuid().ToString("n"));

    public void Dispose()
    {
        try { Directory.Delete(users, recursive: true); } catch (IOException) { }
    }

    [Fact]
    public void One_profile_with_a_database_is_the_answer()
    {
        string folder = Profile("Trader", "Documents", database: true);

        NinjaTraderFolderLookup lookup = new ProfileNinjaTraderFolderLocator(users).Locate();

        Assert.Equal(Path.GetFullPath(folder), lookup.Folder);
    }

    [Fact]
    public void OneDrive_Documents_is_looked_in_too()
    {
        string folder = Profile("Trader", Path.Combine("OneDrive", "Documents"), database: true);

        Assert.Equal(Path.GetFullPath(folder), new ProfileNinjaTraderFolderLocator(users).Locate().Folder);
    }

    [Fact]
    public void An_empty_NinjaTrader_folder_elsewhere_does_not_make_it_ambiguous()
    {
        string trader = Profile("Trader", "Documents", database: true);
        Profile("Administrator", "Documents", database: false);

        Assert.Equal(Path.GetFullPath(trader), new ProfileNinjaTraderFolderLocator(users).Locate().Folder);
    }

    [Fact]
    public void Two_databases_are_refused_rather_than_picked()
    {
        Profile("TraderA", "Documents", database: true);
        Profile("TraderB", "Documents", database: true);

        NinjaTraderFolderLookup lookup = new ProfileNinjaTraderFolderLocator(users).Locate();

        Assert.False(lookup.Found);
        Assert.Equal("ninjatrader_folder_ambiguous", lookup.ErrorCode);
    }

    [Fact]
    public void No_NinjaTrader_anywhere_is_not_found()
    {
        Directory.CreateDirectory(Path.Combine(users, "Trader", "Documents"));

        Assert.Equal("ninjatrader_folder_not_found", new ProfileNinjaTraderFolderLocator(users).Locate().ErrorCode);
        Assert.Equal("ninjatrader_folder_not_found", new ProfileNinjaTraderFolderLocator(Path.Combine(users, "missing")).Locate().ErrorCode);
    }

    [Fact]
    public void A_folder_without_a_database_is_database_not_found()
    {
        Profile("Trader", "Documents", database: false);

        Assert.Equal("database_not_found", new ProfileNinjaTraderFolderLocator(users).Locate().ErrorCode);
    }

    [Fact]
    public void The_installers_excluded_profiles_are_never_candidates()
    {
        Profile("Public", "Documents", database: true);
        Profile("Default", "Documents", database: true);
        string trader = Profile("Trader", "Documents", database: true);

        Assert.Equal(Path.GetFullPath(trader), new ProfileNinjaTraderFolderLocator(users).Locate().Folder);
    }

    private string Profile(string name, string documents, bool database)
    {
        string folder = Path.Combine(users, name, documents, "NinjaTrader 8");
        Directory.CreateDirectory(Path.Combine(folder, "db"));
        if (database) File.WriteAllText(Path.Combine(folder, "db", "NinjaTrader.sqlite"), string.Empty);
        return folder;
    }
}
