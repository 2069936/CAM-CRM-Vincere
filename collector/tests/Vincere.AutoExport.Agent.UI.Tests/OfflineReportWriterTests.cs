using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Vincere.AutoExport.Agent.UI;
using Xunit;

namespace Vincere.AutoExport.Agent.UI.Tests;

/* The file the Setup window writes when the CRM cannot be reached. This class
 * computes nothing - the bundle does - so what is tested here is the choosing
 * and the writing. */
public sealed class OfflineReportWriterTests : IDisposable
{
    private readonly string root = Path.Combine(Path.GetTempPath(), "vincere-offline-" + Guid.NewGuid().ToString("n"));

    public void Dispose()
    {
        try { if (Directory.Exists(root)) Directory.Delete(root, true); } catch (Exception) { }
    }

    private string Folder(string name)
    {
        string path = Path.Combine(root, name);
        Directory.CreateDirectory(path);
        return path;
    }

    private static string CaptureJson(string tradingDate, string capturedAt, int accounts = 1) =>
        "{\"schemaVersion\":1,\"captureId\":\"c\",\"capturedAt\":\"" + capturedAt + "\","
        + "\"tradingDate\":\"" + tradingDate + "\",\"timeZone\":\"America/New_York\","
        + "\"source\":{},\"accounts\":["
        + string.Join(",", Enumerable.Range(0, accounts).Select(i => "{\"accountName\":\"A" + i + "\"}"))
        + "],\"strategies\":[],\"orders\":[],\"executions\":[]}";

    private string WriteCapture(string folder, string file, string json)
    {
        string path = Path.Combine(folder, file);
        File.WriteAllText(path, json);
        return path;
    }

    [Fact]
    public void ReadsEveryQueueFolderIncludingPending()
    {
        /* PENDING IS THE POINT. A capture waits there until the CRM accepts it,
         * and on the one day this feature exists for - the day the CRM cannot
         * be reached - pending holds exactly the day that is missing while
         * every other folder holds history. */
        string pending = Folder("pending");
        string sent = Folder("sent");
        WriteCapture(pending, "today.json", CaptureJson("2026-09-25", "2026-09-25T20:30:00Z"));
        WriteCapture(sent, "older.json", CaptureJson("2026-09-24", "2026-09-24T20:30:00Z"));

        IReadOnlyList<CaptureFile> found = OfflineReportWriter.FindCaptures(new[] { pending, sent });
        Assert.Equal(2, found.Count);
        Assert.Equal("2026-09-25", found[0].TradingDate);
    }

    [Fact]
    public void PrefersTheLaterCaptureOfTheSameDayWhicheverFolderItIsIn()
    {
        /* A day is captured again when the first attempt found positions still
         * open, and the later one is the settled close. autoImport.js records
         * the cost of getting this wrong: on 2026-09-08 a capture at 16:30:00
         * reported -$2,064 for a day whose real number was -$1,319.
         *
         * Choosing by folder would prefer an unsent early capture in pending
         * over the corrected one already accepted into sent. */
        string pending = Folder("pending");
        string sent = Folder("sent");
        WriteCapture(pending, "early.json", CaptureJson("2026-09-08", "2026-09-08T20:30:00Z"));
        WriteCapture(sent, "late.json", CaptureJson("2026-09-08", "2026-09-08T22:28:00Z"));

        CaptureFile chosen = OfflineReportWriter.Newest(
            OfflineReportWriter.FindCaptures(new[] { pending, sent }), "2026-09-08");
        Assert.EndsWith("late.json", chosen.Path);
    }

    [Fact]
    public void OneUnreadableFileDoesNotHideTheRest()
    {
        // A queue folder can hold a file half-written by a machine that lost
        // power. Offering no report because of it would be the wrong trade.
        string pending = Folder("pending");
        WriteCapture(pending, "broken.json", "{ half writ");
        WriteCapture(pending, "good.json", CaptureJson("2026-09-25", "2026-09-25T20:30:00Z"));

        Assert.Single(OfflineReportWriter.FindCaptures(new[] { pending }));
    }

    [Fact]
    public void SkipsAFolderThatIsNotThere()
    {
        Assert.Empty(OfflineReportWriter.FindCaptures(new[] { Path.Combine(root, "never-created") }));
        Assert.Empty(OfflineReportWriter.FindCaptures(null));
    }

    [Fact]
    public void WritesOneFileNamedLikeTheCrmNamesIt()
    {
        // The desk already has folders of "<Client> - <date> daily report.pdf".
        // A file that sorts beside them is worth more than a prettier name.
        string pending = Folder("pending");
        WriteCapture(pending, "c.json", CaptureJson("2026-09-25", "2026-09-25T20:30:00Z"));
        CaptureFile capture = OfflineReportWriter.FindCaptures(new[] { pending })[0];

        string path = OfflineReportWriter.Write(
            capture, "{}", DateTimeOffset.UtcNow, "Corey Krupp", "/*bundle*/", Folder("out"));

        Assert.Equal("Corey Krupp - 2026-09-25 daily report.html", Path.GetFileName(path));
        Assert.Contains("/*bundle*/", File.ReadAllText(path));
    }

    [Fact]
    public void RefusesRatherThanWriteAPageThatCannotRender()
    {
        // Without the bundle the file opens blank, and a blank page a CAM
        // forwards to a client is worse than an error they can read.
        string pending = Folder("pending");
        WriteCapture(pending, "c.json", CaptureJson("2026-09-25", "2026-09-25T20:30:00Z"));
        CaptureFile capture = OfflineReportWriter.FindCaptures(new[] { pending })[0];

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => OfflineReportWriter.Write(capture, "{}", null, "X", "  ", Folder("out")));
        Assert.Contains("report-bundle.js", error.Message);
    }

    [Fact]
    public void AnAccountNamedLikeMarkupCannotCloseTheScriptTag()
    {
        /* AN ACCOUNT CAN BE NAMED ANYTHING. A name carrying a closing script
         * tag would end the data block early and put the rest of the payload on
         * the page as markup. */
        string payload = OfflineReportWriter.BuildPayload(
            CaptureJson("2026-09-25", "2026-09-25T20:30:00Z").Replace("\"A0\"", "\"</script><img src=x>\""),
            "{}",
            null,
            "</script>evil");

        Assert.DoesNotContain("</script>", payload, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("<", payload);
        Assert.Contains("\\u003c", payload);
    }

    [Fact]
    public void TheFileDoesNotCarryTheStrategyTuningOrTheLicenceKey()
    {
        /* THE SHEET WAS CLEAN AND THE FILE WAS NOT.
         *
         * renderOfflineReport reads four named fields off a strategy and never
         * spreads the row, and src/offline/offlineReport.test.js asserts the
         * rendered page carries no LicenseKey and no StopLossTicks. All true,
         * and all about the page. The file written to the Desktop is the raw
         * capture in a script tag plus a bundle that rewrites the document when
         * it opens, so everything the page refused to print was still in the
         * bytes a CAM attaches to a message.
         *
         * These field names and this shape are what a real machine's queue
         * carried, `extraValues` and all: 149 entries on one strategy row,
         * LicenseKey among them with a working value. */
        string capture = CaptureJson("2026-09-25", "2026-09-25T20:30:00Z")
            .TrimEnd('}')
            + ",\"strategies\":[{\"strategyId\":\"1\",\"strategyName\":\"0 - URGO-4.5\","
            + "\"accountName\":\"A0\",\"instrument\":\"MNQ DEC26\",\"state\":\"Realtime\","
            + "\"parameterCaptureStatus\":\"partial\","
            + "\"parameters\":{\"URGO1\":33,\"StopLossTicks\":300},"
            + "\"extraValues\":{\"LicenseKey\":\"V-9E2B00-SECRET\",\"URGO1\":33,"
            + "\"StopLossTicks\":300,\"ProfitTargetTicks1\":400,\"TradeStartTime\":\"2020-01-01T09:30:00\","
            + "\"EdgeLeverage\":false}}]}";

        string payload = OfflineReportWriter.BuildPayload(capture, "{}", null, "A Client");

        // The algorithm is still named: that is what the report is for.
        Assert.Contains("URGO-4.5", payload);
        Assert.Contains("MNQ DEC26", payload);
        // The licence and the tuning are not, from either map.
        Assert.DoesNotContain("V-9E2B00-SECRET", payload);
        Assert.DoesNotContain("LicenseKey", payload);
        Assert.DoesNotContain("StopLossTicks", payload);
        Assert.DoesNotContain("ProfitTargetTicks1", payload);
        Assert.DoesNotContain("TradeStartTime", payload);
        Assert.DoesNotContain("EdgeLeverage", payload);
        Assert.DoesNotContain("URGO1", payload);
        /* AND BOTH PROPERTIES ARE STILL THERE, EMPTY. autoExportContract.js
         * requires `parameters` to be an object; removing it made the page
         * render "strategies[0].parameters must be an object" instead of the
         * client's day. Caught by opening a real capture in a browser, not by
         * this suite, which is why the assertion is here now. */
        Assert.Contains("\"parameters\":{}", payload);
        Assert.Contains("\"extraValues\":{}", payload);
    }

    [Fact]
    public void TheClientsOwnAccountFiguresSurviveTheStrip()
    {
        /* accountValues is the other large map in a capture: BuyingPower,
         * NetLiquidation, the drawdown limits. It is the client's own account
         * and the subject of the report, so a strip aimed at the desk's tuning
         * must not take it. Only strategy rows are touched. */
        string capture = CaptureJson("2026-09-25", "2026-09-25T20:30:00Z")
            .Replace("\"accountName\":\"A0\"",
                "\"accountName\":\"A0\",\"accountValues\":{\"NetLiquidation\":52000,\"TrailingMaxDrawdown\":2500}");

        string payload = OfflineReportWriter.BuildPayload(capture, "{}", null, "A Client");

        Assert.Contains("NetLiquidation", payload);
        Assert.Contains("TrailingMaxDrawdown", payload);
    }

    [Fact]
    public void SendsNoRosterRatherThanNullWhenItHasNone()
    {
        // The bundle treats an empty roster as "classify nothing and total
        // nothing", which is the honest answer. A null would throw instead.
        string payload = OfflineReportWriter.BuildPayload(
            CaptureJson("2026-09-25", "2026-09-25T20:30:00Z"), null, null, "X");
        Assert.Contains("\"roster\":{}", payload);
        Assert.Contains("\"rosterFetchedAt\":null", payload);
    }

    [Fact]
    public void ReadsTheRosterTheServiceWrote()
    {
        string path = Path.Combine(Folder("data"), "roster.json");
        File.WriteAllText(path,
            "{\"version\":\"v1\",\"fetchedAt\":\"2026-09-25T20:30:00.0000000+00:00\","
            + "\"registry\":{\"ACC1\":{\"accountType\":\"Funded\"}}}");

        (string json, DateTimeOffset? fetchedAt) = OfflineReportWriter.ReadRoster(path);
        Assert.Contains("Funded", json);
        Assert.Equal(new DateTimeOffset(2026, 9, 25, 20, 30, 0, TimeSpan.Zero), fetchedAt);
    }

    [Fact]
    public void AnswersEmptyRatherThanThrowingWhenThereIsNoRoster()
    {
        // A machine that has never uploaded has none, and the report handles
        // that by classifying nothing and totalling nothing.
        Assert.Equal((null, null), OfflineReportWriter.ReadRoster(Path.Combine(root, "nope.json")));
        Assert.Equal((null, null), OfflineReportWriter.ReadRoster(null));

        string broken = Path.Combine(Folder("data2"), "roster.json");
        File.WriteAllText(broken, "{ not json");
        Assert.Equal((null, null), OfflineReportWriter.ReadRoster(broken));
    }

    [Fact]
    public void StampsTheRosterDateTheSameWayEverywhere()
    {
        // Round-tripped in UTC with the invariant culture: the bundle compares
        // it against the trading date to decide whether the roster is too old
        // to trust, and a locale-shifted stamp would move that answer.
        string payload = OfflineReportWriter.BuildPayload(
            CaptureJson("2026-09-25", "2026-09-25T20:30:00Z"),
            "{}",
            new DateTimeOffset(2026, 9, 1, 12, 0, 0, TimeSpan.FromHours(-5)),
            "X");
        Assert.Contains("\"rosterFetchedAt\":\"2026-09-01T17:00:00.0000000+00:00\"", payload);
    }
}
