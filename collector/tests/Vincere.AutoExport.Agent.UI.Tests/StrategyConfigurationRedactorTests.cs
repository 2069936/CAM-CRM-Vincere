using System;
using System.IO;
using Newtonsoft.Json.Linq;
using Xunit;

namespace Vincere.AutoExport.Agent.UI.Tests;

/* ONE RULE, TWO DOORS, AND THESE ARE ITS OWN TESTS.
 *
 * The rule was a private method inside OfflineReportWriter while the Deep Export
 * was copying the very same queue snapshots into a package raw. Its measurements
 * are in StrategyConfigurationRedactor's header. These tests cover the rule
 * itself; the Deep Export's use of it is asserted end to end over a produced
 * package in DeepExportTests, and the Desktop report's in OfflineReportWriter's
 * own suite.
 *
 * Real temporary files, not mocks: the queue snapshot path reads and writes one. */
public sealed class StrategyConfigurationRedactorTests : IDisposable
{
    private const string Licence = "V-ZZQQ77-FIXTUREK-TESTKEY";

    private readonly string root = Path.Combine(Path.GetTempPath(), "vincere-cfg-" + Guid.NewGuid().ToString("N"));

    public StrategyConfigurationRedactorTests() => Directory.CreateDirectory(root);

    public void Dispose()
    {
        try { Directory.Delete(root, recursive: true); } catch (Exception) { }
    }

    private static string Capture() =>
        "{\"tradingDate\":\"2026-09-15\","
        + "\"accounts\":[{\"accountName\":\"LTATAGREH509159302022\","
        + "\"accountValues\":{\"NetLiquidation\":51234.5}}],"
        + "\"strategies\":[{\"strategyName\":\"G4M\",\"realizedPnl\":312.5,"
        + "\"parameterCaptureStatus\":\"captured\","
        + "\"parameters\":{\"PosSize1\":2,\"StopLossTicks\":40},"
        + "\"parametersRaw\":\"PosSize1=2\","
        + "\"extraValues\":{\"TrailByTicks\":\"8\",\"LicenseKey\":\"" + Licence + "\","
        + "\"DisplayParameters\":\"LicenseKey=" + Licence + "\"}}]}";

    [Fact]
    public void TheMapsAreEmptiedAndNotRemoved()
    {
        // EMPTIED, NOT REMOVED: src/domain/autoExportContract.js lists
        // `parameters` among the objects a strategy row must have, and the first
        // version of this rule deleted it and broke every capture with a strategy.
        JObject capture = (JObject)StrategyConfigurationRedactor.Strip(JToken.Parse(Capture()));
        JObject strategy = (JObject)capture["strategies"][0];

        Assert.NotNull(strategy["parameters"]);
        Assert.NotNull(strategy["extraValues"]);
        Assert.Empty((JObject)strategy["parameters"]);
        Assert.Empty((JObject)strategy["extraValues"]);
        Assert.Null(strategy["parametersRaw"]);
    }

    [Fact]
    public void TheDaySurvivesAndTheAccountMapIsNotAStrategyRow()
    {
        // accounts[].accountValues is the client's own account and is the whole
        // subject of both artefacts. It is the rule's one deliberate exception and
        // the reason a strategy row is recognised rather than every map emptied.
        JObject capture = (JObject)StrategyConfigurationRedactor.Strip(JToken.Parse(Capture()));

        Assert.Equal(51234.5, (double)capture["accounts"][0]["accountValues"]["NetLiquidation"]);
        Assert.Equal("2026-09-15", (string)capture["tradingDate"]);
        Assert.Equal("G4M", (string)capture["strategies"][0]["strategyName"]);
        Assert.Equal(312.5, (double)capture["strategies"][0]["realizedPnl"]);
    }

    [Fact]
    public void TheKeyGoesWithTheMapThatHeldItInBothPlacesItSat()
    {
        // Measured on a real export: the key sits in extraValues TWICE, once as
        // LicenseKey and once inside the DisplayParameters string. A rule that
        // masked only the named field would leave the second.
        string redacted = StrategyConfigurationRedactor.RedactCaptureJsonText(Capture());

        Assert.DoesNotContain(Licence, redacted);
        Assert.DoesNotContain("DisplayParameters", redacted);
        Assert.DoesNotContain("TrailByTicks", redacted);
        Assert.Contains("\"parameterCaptureStatus\": \"captured\"", redacted);
    }

    [Fact]
    public void AStrategyRowWithoutTheMapsIsLeftAlone()
    {
        // A row recognised only by parameterCaptureStatus, which nothing else in a
        // capture carries. Nothing to empty is not an error.
        string redacted = StrategyConfigurationRedactor.RedactCaptureJsonText(
            "{\"strategies\":[{\"strategyName\":\"G4M\",\"parameterCaptureStatus\":\"unavailable\"}]}");

        Assert.Contains("\"unavailable\"", redacted);
        Assert.Contains("G4M", redacted);
    }

    [Fact]
    public void ACaptureThatDoesNotParseIsWithheldRatherThanShipped()
    {
        // FAILS CLOSED, as SecretRedactor does for the agent config: a capture
        // this cannot parse is one it cannot inspect, and the only two places the
        // key was measured are inside it. Measured cost: 16 of 16 queue .json
        // files on two real exports parse, the two quarantined ones included.
        string redacted = StrategyConfigurationRedactor.RedactCaptureJsonText(
            "{\"strategies\":[{\"extraValues\":{\"LicenseKey\":\"" + Licence + "\"}");

        Assert.DoesNotContain(Licence, redacted);
        Assert.Contains("withheld", redacted);
        Assert.NotNull(JToken.Parse(redacted));
    }

    [Fact]
    public void WhichFilesInThePackageItRewrites()
    {
        // The queue captures and nothing else. A .receipt is not a capture and
        // withholding it would be a loss for nothing; the trace has its own rule.
        Assert.True(StrategyConfigurationRedactor.AppliesTo("autoexport/sent/2026-09-15_abc.json"));
        Assert.True(StrategyConfigurationRedactor.AppliesTo("autoexport/pending/a.JSON"));
        Assert.True(StrategyConfigurationRedactor.AppliesTo("autoexport\\quarantine\\a.json"));
        Assert.False(StrategyConfigurationRedactor.AppliesTo("autoexport/sent/a.json.receipt"));
        Assert.False(StrategyConfigurationRedactor.AppliesTo("config/agent.config.redacted.json"));
        Assert.False(StrategyConfigurationRedactor.AppliesTo("attribution/catalog.jsonl"));
        Assert.False(StrategyConfigurationRedactor.AppliesTo("manifest.json"));
        Assert.False(StrategyConfigurationRedactor.AppliesTo(""));
        Assert.False(StrategyConfigurationRedactor.AppliesTo(null));
    }

    [Fact]
    public void ThroughARealFileTheWayTheExportWritesIt()
    {
        // The export reads a queue file and writes the redacted text to staging.
        // Over real files, because that is what it does.
        string from = Path.Combine(root, "2026-09-15_abc.json");
        string to = Path.Combine(root, "staged.json");
        File.WriteAllText(from, Capture());

        File.WriteAllText(to, StrategyConfigurationRedactor.RedactCaptureJsonText(File.ReadAllText(from)));

        Assert.DoesNotContain(Licence, File.ReadAllText(to));
        Assert.Empty((JObject)JObject.Parse(File.ReadAllText(to))["strategies"][0]["extraValues"]);
        // THE SOURCE IS NEVER MODIFIED. The agent's real queue is the machine's,
        // and the export only ever redacts its own copy.
        Assert.Contains(Licence, File.ReadAllText(from));
    }
}
