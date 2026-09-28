using System;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Configuration;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* The account classification the machine keeps for the day the CRM cannot be
 * reached. What matters is that it survives, that it carries its own date, and
 * that failing to write it never costs an upload. */
public sealed class RosterStoreTests : IDisposable
{
    private readonly string folder = Path.Combine(Path.GetTempPath(), "vincere-roster-" + Guid.NewGuid().ToString("n"));

    private RosterStore Store() => new(Path.Combine(folder, "roster.json"));

    public void Dispose()
    {
        try { if (Directory.Exists(folder)) Directory.Delete(folder, true); } catch (Exception) { }
    }

    [Fact]
    public async Task ReadsBackWhatTheCrmSent()
    {
        RosterStore store = Store();
        await store.SaveAsync(
            "{\"ACC1\":{\"accountType\":\"Funded\"}}",
            "v1",
            new DateTimeOffset(2026, 9, 25, 20, 30, 0, TimeSpan.Zero));

        CachedRoster roster = await store.LoadAsync();
        Assert.Equal("{\"ACC1\":{\"accountType\":\"Funded\"}}", roster.RegistryJson);
        Assert.Equal("v1", roster.Version);
        Assert.Equal(new DateTimeOffset(2026, 9, 25, 20, 30, 0, TimeSpan.Zero), roster.FetchedAt);
    }

    [Fact]
    public async Task AnswersNothingBeforeTheCrmHasEverSaidAnything()
    {
        // A freshly paired machine. The report will say it could not classify
        // anything and total nothing, which is the honest answer.
        Assert.Null(await Store().LoadAsync());
    }

    [Fact]
    public async Task KeepsTheDateInsideTheFile()
    {
        /* NOT THE FILE'S MODIFICATION TIME. That is changed by a backup, a
         * copy, a virus scanner and half of Windows, and this number decides
         * whether a figure is printed for a client or held back. */
        RosterStore store = Store();
        DateTimeOffset told = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);
        await store.SaveAsync("{\"A\":{}}", "v1", told);
        File.SetLastWriteTimeUtc(store.RosterPath, DateTime.UtcNow);

        CachedRoster roster = await store.LoadAsync();
        Assert.Equal(told, roster.FetchedAt);
    }

    [Theory]
    [InlineData("en-US")]
    [InlineData("es-CO")]
    [InlineData("de-DE")]
    [InlineData("en-GB")]
    public async Task ReadsTheSameDateWhateverTheMachineThinksDatesLookLike(string culture)
    {
        /* THIS IS HERE BECAUSE IT ALREADY HAPPENED. The bare TryParse reads the
         * machine's locale, and on a day-first one it read 2026-09-01 back as
         * 2026-01-09 - four months adrift, silently. The date decides whether
         * a figure is printed for a client or held back as too old to trust,
         * so it cannot depend on where the VPS happens to be configured.
         *
         * CI runs on one locale, so without forcing several here the fix would
         * be unpinned and the next person to simplify the parse would not find
         * out until a report was wrong on somebody's machine. */
        CultureInfo original = CultureInfo.CurrentCulture;
        try
        {
            CultureInfo.CurrentCulture = new CultureInfo(culture);
            Thread.CurrentThread.CurrentCulture = new CultureInfo(culture);

            RosterStore store = Store();
            DateTimeOffset told = new(2026, 9, 1, 12, 0, 0, TimeSpan.Zero);
            await store.SaveAsync("{\"A\":{}}", "v1", told);

            CachedRoster roster = await store.LoadAsync();
            Assert.Equal(told, roster.FetchedAt);
            Assert.Equal(9, roster.FetchedAt.Value.Month);
        }
        finally
        {
            CultureInfo.CurrentCulture = original;
            Thread.CurrentThread.CurrentCulture = original;
        }
    }

    [Fact]
    public async Task ASecondSaveReplacesTheFirst()
    {
        RosterStore store = Store();
        await store.SaveAsync("{\"A\":{\"accountType\":\"Funded\"}}", "v1", DateTimeOffset.UtcNow);
        await store.SaveAsync("{\"A\":{\"accountType\":\"Cash - Straight\"}}", "v2", DateTimeOffset.UtcNow);

        CachedRoster roster = await store.LoadAsync();
        Assert.Contains("Cash - Straight", roster.RegistryJson);
        Assert.Equal("v2", roster.Version);
    }

    [Fact]
    public async Task IgnoresAnEmptyPayloadRatherThanErasingWhatItHas()
    {
        // A server that has not deployed the change sends no registry at all,
        // and that must not wipe a roster the machine already holds.
        RosterStore store = Store();
        await store.SaveAsync("{\"A\":{\"accountType\":\"Funded\"}}", "v1", DateTimeOffset.UtcNow);
        await store.SaveAsync(null, null, DateTimeOffset.UtcNow);
        await store.SaveAsync("   ", null, DateTimeOffset.UtcNow);

        Assert.Contains("Funded", (await store.LoadAsync()).RegistryJson);
    }

    [Fact]
    public async Task AFileNobodyCanReadIsTheSameAsNoFile()
    {
        // Never throw on the read path: the report still runs, it just cannot
        // classify. Refusing to open would be worse than printing less.
        RosterStore store = Store();
        Directory.CreateDirectory(folder);
        await File.WriteAllTextAsync(store.RosterPath, "{ not json at all");
        Assert.Null(await store.LoadAsync());
    }

    [Fact]
    public async Task LeavesNoTemporaryFileBehind()
    {
        RosterStore store = Store();
        await store.SaveAsync("{\"A\":{}}", "v1", DateTimeOffset.UtcNow);
        Assert.False(File.Exists(store.RosterPath + ".tmp"));
    }

    [Fact]
    public async Task SurvivesAPathItCannotWrite()
    {
        /* A ROSTER THAT CANNOT BE WRITTEN NEVER COSTS AN UPLOAD. The capture
         * reaching the CRM is what the agent exists for; this is a convenience
         * for a day that may not come. */
        // A path whose parent is an existing FILE, so the directory cannot be
        // created. Combining onto a folder that does not exist yet would just
        // have been created, which proves nothing.
        Directory.CreateDirectory(folder);
        string blocker = Path.Combine(folder, "blocked");
        await File.WriteAllTextAsync(blocker, "not a directory");
        RosterStore store = new(Path.Combine(blocker, "roster.json"));
        await store.SaveAsync("{\"A\":{}}", "v1", DateTimeOffset.UtcNow);
        Assert.Null(await store.LoadAsync());
    }
}
