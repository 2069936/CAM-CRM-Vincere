using System;
using System.Collections.Generic;
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

/* WHO THE EXPORT IS ABOUT IS NOT A SECRET, AND THAT IS WHY IT TRAVELLED.
 *
 * config/agent.config.redacted.json is eleven lines at the top of the ZIP and
 * its filename says redacted. Measured on both real exports on the operator's
 * machine, it carried clientName - a person's name, 11 characters on one export
 * and 13 on the other - straight through, because the rule applied to it was
 * SecretRedactor, a DENYLIST over key names that match
 * password|passwd|pwd|api_key|token|secret|credential|bearer|authorization|
 * licence. clientName matches none of them and is not a secret. It is IDENTITY,
 * a different question, and the denylist was never asked it.
 *
 * THE GATE IS THE POINT OF THIS FILE. RedactedAgentState in the Agent project is
 * already an opt-in projection of the same configuration, built carefully -
 * hasCredential rather than the credential, machineIdHash rather than the
 * machine id - and it carries clientName because its one consumer is the local
 * control pipe, where naming the client is right. Two destinations, two
 * policies, one shape. The two can only stay in step if a field added to that
 * class forces a decision here, so the gate reads its SOURCE as text and fails
 * when a JsonProperty is classified nowhere. Bound to the writer, not to a
 * fixture, the way scripts/deepExportManifestShape.js is bound to
 * DeepExportRunner and the way TheOperatorIsToldWhatTheExportActuallyCarries is
 * bound to MainWindow.xaml: a hand-written list of the thirteen names would have
 * been copied from the same reading and would agree with itself forever.
 *
 * READ AS TEXT AND NOT BY REFLECTION, because the UI project does not reference
 * the Agent project - Vincere.AutoExport.Agent.UI.csproj takes Contracts and
 * NinjaTrader.Core and nothing else - and a WPF project pulling in a service
 * project to get at one class would be a far larger change than this needs. */
public sealed class AgentConfigProjectionTests : IDisposable
{
    /// <summary>
    /// The client name the fixtures carry. INVENTED, and obviously so. No value
    /// from either real export is in this file; the two commits that closed
    /// earlier leaks in this repo each pasted a live value in to make an
    /// assertion concrete, which is how one reached git history.
    /// </summary>
    private const string FixtureClientName = "ZZ FAKE CLIENT ZZ";

    private readonly string root = Path.Combine(Path.GetTempPath(), "vincere-cfg-" + Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        try { Directory.Delete(root, recursive: true); } catch (Exception) { }
    }

    /* ------------------------------------------------------------------ *
     * THE GATE.                                                          *
     * ------------------------------------------------------------------ */

    [Fact]
    public void EveryFieldOfTheDiagnosticsProjectionIsClassifiedForTheExport()
    {
        string[] declared = JsonPropertyNamesOfRedactedAgentState();

        // The guard that stops this test passing by pointing at nothing. The
        // class carried thirteen JsonProperty names when this was written; the
        // number is not pinned, because adding a field there is allowed - being
        // silent about it is not.
        Assert.True(
            declared.Length >= 10,
            $"found only {declared.Length} JsonProperty names in RedactedAgentState.cs; the gate is reading the wrong file or the attribute shape moved");

        var classified = new List<string>();
        classified.AddRange(AgentConfigProjection.Keep);
        classified.AddRange(AgentConfigProjection.Masked);
        classified.AddRange(AgentConfigProjection.Derived);

        // Exactly one bucket each. A name in two buckets is a policy that
        // contradicts itself and the emitter would silently resolve it.
        string[] twice = classified
            .GroupBy(name => name, StringComparer.OrdinalIgnoreCase)
            .Where(group => group.Count() > 1)
            .Select(group => group.Key)
            .ToArray();
        Assert.True(twice.Length == 0, "classified in more than one bucket: " + string.Join(", ", twice));

        // THE FAILURE THIS EXISTS FOR. A field added to RedactedAgentState.cs and
        // classified nowhere would otherwise either ride out into the ZIP or
        // vanish from it, and which of the two depends on an accident.
        string[] unclassified = declared
            .Except(classified, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        Assert.True(
            unclassified.Length == 0,
            "RedactedAgentState.cs declares "
                + string.Join(", ", unclassified)
                + " and AgentConfigProjection classifies "
                + (unclassified.Length == 1 ? "it" : "them")
                + " nowhere. Put each name in Keep (a reader may see it), Masked (it names a human, or it opens a door) or Derived (the configuration file has no such field to read).");

        // AND THE MIRROR. A name left behind in a bucket after the field it
        // referred to was renamed or removed is a policy about nothing, and the
        // next reader takes it for a live decision. PR 59 is in the log because
        // a reader asked for two field names the writer had never written.
        string[] stale = classified
            .Except(declared, StringComparer.OrdinalIgnoreCase)
            .ToArray();
        Assert.True(
            stale.Length == 0,
            "AgentConfigProjection classifies "
                + string.Join(", ", stale)
                + ", which RedactedAgentState.cs no longer declares");
    }

    [Fact]
    public void TheThreeDecisionsThisChangeMadeArePinnedByName()
    {
        // Set equality above says every field was decided. It cannot say the
        // decisions were the right ones, so the three that were actually argued
        // are named here and a later edit has to come and change this test.

        // The one field that names a human.
        Assert.Contains("clientName", AgentConfigProjection.Masked);

        // A GUID names nobody, and it is how an analyst ties a package to a
        // device row in the CRM. Dropping it costs a real answer for no gain.
        Assert.Contains("deviceId", AgentConfigProjection.Keep);

        // A public deployment URL, and on both real exports it was 35 characters
        // - exactly the length of the value compiled into
        // AgentOptions.CreateDefault(), which is in this repository in plain
        // sight. It carries nothing about a client.
        Assert.Contains("crmBaseUrl", AgentConfigProjection.Keep);

        // The configuration file holds neither of these: RedactedAgentState
        // computes them for the diagnostics pipe. There is nothing to project.
        Assert.Contains("hasCredential", AgentConfigProjection.Derived);
        Assert.Contains("machineIdHash", AgentConfigProjection.Derived);
    }

    [Fact]
    public void TheIdentityRuleDidNotWidenTheSecretRule()
    {
        // D. Identity and credential are different questions and this repository
        // already paid once for answering them with one rule: SecretRedactor
        // grew a licence term because a device credential was named LicenseKey,
        // and the fix for THIS leak is not to teach it the word "client".
        Assert.False(SecretRedactor.IsSecretKey("clientName"));
        Assert.False(SecretRedactor.IsSecretKey("deviceId"));

        // The predicate still has to answer its own question, and the projection
        // asks it about every key it is about to emit, so a secret-named field
        // added to the Keep list is masked rather than kept.
        Assert.True(SecretRedactor.IsSecretKey("deviceToken"));
    }

    /* ------------------------------------------------------------------ *
     * THE PROJECTION.                                                    *
     * ------------------------------------------------------------------ */

    [Fact]
    public void TheClientNameIsMaskedAndNotDeleted()
    {
        JObject projected = Project(new JObject
        {
            ["clientName"] = FixtureClientName,
            ["timeZone"] = "America/New_York",
        });

        Assert.DoesNotContain(FixtureClientName, projected.ToString());

        // A. SecretRedactor's opinion, followed rather than argued with: the key
        // stays and the value is replaced, so "configured and hidden" and "never
        // configured" remain different facts. Deleting the key would make the
        // export unable to say which it was.
        Assert.Equal(SecretRedactor.Mask, (string)projected["clientName"]);
        Assert.Equal(
            new[] { "clientName" },
            projected["_projection"]["withheld"].Select(name => (string)name).ToArray());
    }

    [Fact]
    public void TheKeptFieldsSurviveIntact()
    {
        JObject projected = Project(new JObject
        {
            ["configurationVersion"] = 1,
            ["crmBaseUrl"] = "https://example.invalid/crm/",
            ["scheduleTime"] = "16:30",
            ["captureCutoffTime"] = "17:00",
            ["enabledTradingDays"] = new JArray("Monday", "Friday"),
            ["timeZone"] = "America/New_York",
            ["deviceId"] = "11111111-2222-3333-4444-555555555555",
            ["clientName"] = FixtureClientName,
            ["lastScheduledTradingDate"] = "2026-09-28",
            ["quarantineReviewTime"] = "12:00",
            ["lastQuarantineReviewDate"] = "2026-09-27",
        });

        // Named one at a time. A loop over AgentConfigProjection.Keep would
        // assert that the emitter agrees with the list it was built from, which
        // is true however wrong the list is.
        Assert.Equal(1, (int)projected["configurationVersion"]);
        Assert.Equal("https://example.invalid/crm/", (string)projected["crmBaseUrl"]);
        Assert.Equal("16:30", (string)projected["scheduleTime"]);
        Assert.Equal("17:00", (string)projected["captureCutoffTime"]);
        Assert.Equal(new[] { "Monday", "Friday" }, projected["enabledTradingDays"].Select(d => (string)d).ToArray());
        Assert.Equal("America/New_York", (string)projected["timeZone"]);
        Assert.Equal("11111111-2222-3333-4444-555555555555", (string)projected["deviceId"]);
        Assert.Equal("2026-09-28", (string)projected["lastScheduledTradingDate"]);
        Assert.Equal("12:00", (string)projected["quarantineReviewTime"]);
        Assert.Equal("2026-09-27", (string)projected["lastQuarantineReviewDate"]);

        // Eleven keys in, ten kept and one masked, and nothing invented.
        Assert.Empty(projected["_projection"]["notProjected"]);
    }

    [Fact]
    public void AFieldTheProjectionDoesNotNameIsAccountedForRatherThanVanishing()
    {
        // B, and not a hypothetical: AgentOptions declares reportEmailUrl and
        // lastReportEmailDate, RedactedAgentState carries neither, so neither is
        // on any list here. Vanishing is the failure mode an allowlist has, and
        // it is the exact mirror of the leak the denylist had. The file has to
        // say the field was there.
        JObject projected = Project(new JObject
        {
            ["timeZone"] = "America/New_York",
            ["reportEmailUrl"] = "https://example.invalid/report",
            ["lastReportEmailDate"] = "2026-09-28",
        });

        Assert.Null(projected["reportEmailUrl"]);
        Assert.DoesNotContain("example.invalid", projected.ToString());
        Assert.Equal(
            new[] { "reportEmailUrl", "lastReportEmailDate" },
            projected["_projection"]["notProjected"].Select(name => (string)name).ToArray());
    }

    [Fact]
    public void AnAbsentFieldAndAnEmptyFieldStayDistinguishable()
    {
        // deviceId is on the Keep list and is simply not in this configuration;
        // clientName is on the Masked list and is present and empty.
        JObject projected = Project(new JObject
        {
            ["clientName"] = string.Empty,
            ["lastScheduledTradingDate"] = string.Empty,
        });

        // Absent in, absent out. The projection does not invent a null to stand
        // for a field the machine never had.
        Assert.Null(projected["deviceId"]);
        Assert.False(projected.ContainsKey("deviceId"));

        // Present and empty stays present and empty, on both lists.
        Assert.Equal(string.Empty, (string)projected["lastScheduledTradingDate"]);
        Assert.Equal(string.Empty, (string)projected["clientName"]);

        // And an empty client name is not a withheld one. Nothing was hidden,
        // so nothing is claimed to have been.
        Assert.Empty(projected["_projection"]["withheld"]);
    }

    [Fact]
    public void AKeptFieldHidingASubtreeIsMaskedRatherThanCopiedWhole()
    {
        // The allowlist names KEYS. It does not name whatever a nested object
        // under one of those keys might hold, and copying an unexamined subtree
        // because its parent is on the list is the denylist's mistake wearing an
        // allowlist's clothes. config.json is flat today - AgentOptions is
        // twelve scalars and one string[] - so a container here means the file
        // was edited by hand.
        AgentConfigProjectionResult result = AgentConfigProjection.Project(new JObject
        {
            ["crmBaseUrl"] = new JObject { ["href"] = "https://example.invalid/", ["apiKey"] = "QQQQ" },
        }.ToString());
        JObject projected = JObject.Parse(result.Json);

        Assert.DoesNotContain("QQQQ", result.Json);
        Assert.DoesNotContain("example.invalid", result.Json);
        Assert.Equal(SecretRedactor.Mask, (string)projected["crmBaseUrl"]);
        Assert.Contains("crmBaseUrl", projected["_projection"]["withheld"].Select(name => (string)name));
        Assert.Contains(result.Warnings, warning => warning.Contains("crmBaseUrl", StringComparison.Ordinal));
    }

    [Fact]
    public void ASecretNamedFieldOnTheKeepListIsStillMasked()
    {
        // The two rules compose without either widening. The allowlist answers
        // "is this identity?"; SecretRedactor is still the single definition of
        // "named like a credential", and the projection asks it about every key
        // it is about to emit.
        //
        // There is no secret-named field on the Keep list today, and a guard
        // nobody has watched fire is a guess - so the policy is passed in here,
        // through the same code path Project uses, with a token on the keep list.
        Assert.All(AgentConfigProjection.Keep, name => Assert.False(SecretRedactor.IsSecretKey(name)));

        AgentConfigProjectionResult result = AgentConfigProjection.ProjectWith(
            new JObject { ["deviceToken"] = "QQQQ" }.ToString(),
            new[] { "deviceToken" },
            AgentConfigProjection.Masked);
        JObject kept = JObject.Parse(result.Json);

        Assert.DoesNotContain("QQQQ", result.Json);
        Assert.Equal(SecretRedactor.Mask, (string)kept["deviceToken"]);
        Assert.Contains("deviceToken", kept["_projection"]["withheld"].Select(name => (string)name));
        Assert.Contains(result.Warnings, warning => warning.Contains("deviceToken", StringComparison.Ordinal));

        // And under the real policy it is on no list at all, so it is dropped
        // and named rather than silently gone.
        JObject projected = Project(new JObject { ["deviceToken"] = "QQQQ" });
        Assert.DoesNotContain("QQQQ", projected.ToString());
        Assert.Contains("deviceToken", projected["_projection"]["notProjected"].Select(name => (string)name));
    }

    [Fact]
    public void AConfigurationThatIsNotJsonFailsLoudlyRatherThanShippingRaw()
    {
        const string broken = "{ \"clientName\": \"" + FixtureClientName + "\", oops";
        AgentConfigProjectionResult result = AgentConfigProjection.Project(broken);

        // Not one byte of it, which is the whole point: a file that cannot be
        // parsed cannot be projected, and shipping it raw would ship the name.
        Assert.DoesNotContain(FixtureClientName, result.Json);
        Assert.DoesNotContain("oops", result.Json);

        // Loudly: the file says so, and the run says so, so it reaches the
        // manifest's warnings as well as the reader of the package.
        JObject projected = JObject.Parse(result.Json);
        Assert.NotNull(projected["_projection"]["error"]);
        Assert.NotEmpty(result.Warnings);

        // A JSON document that parses but is not an object gets the same answer.
        Assert.NotEmpty(AgentConfigProjection.Project("[1,2,3]").Warnings);
        Assert.NotEmpty(AgentConfigProjection.Project(string.Empty).Warnings);
    }

    /* ------------------------------------------------------------------ *
     * THE PACKAGE.                                                       *
     * ------------------------------------------------------------------ */

    [Fact]
    public async Task TheProducedPackageCarriesNoClientName()
    {
        string extracted = await RunExportWithConfig(new JObject
        {
            ["configurationVersion"] = 1,
            ["crmBaseUrl"] = "https://example.invalid/crm/",
            ["timeZone"] = "America/New_York",
            ["deviceId"] = "11111111-2222-3333-4444-555555555555",
            ["clientName"] = FixtureClientName,
            ["reportEmailUrl"] = "https://example.invalid/report",
        }.ToString());

        // The whole unpacked package, not just the config file. The name is in
        // the configuration and nowhere else in the fixture, so a sweep of every
        // file is the statement worth making.
        foreach (string file in Directory.EnumerateFiles(extracted, "*", SearchOption.AllDirectories))
        {
            string text = System.Text.Encoding.Latin1.GetString(File.ReadAllBytes(file));
            Assert.DoesNotContain(FixtureClientName, text);
        }

        string config = File.ReadAllText(Path.Combine(extracted, "config", "agent.config.redacted.json"));
        JObject parsed = JObject.Parse(config);
        Assert.Equal(SecretRedactor.Mask, (string)parsed["clientName"]);
        Assert.Equal("11111111-2222-3333-4444-555555555555", (string)parsed["deviceId"]);

        // C. The manifest describes the file that is in the package. It hashes
        // whatever step 3 wrote, so a projection that changed those bytes has to
        // show up here or the two have drifted.
        JObject manifest = JObject.Parse(File.ReadAllText(Path.Combine(extracted, "manifest.json")));
        JToken entry = manifest["files"].Single(f => (string)f["path"] == "config/agent.config.redacted.json");
        Assert.Equal(new FileInfo(Path.Combine(extracted, "config", "agent.config.redacted.json")).Length, (long)entry["sizeBytes"]);
        Assert.Equal(DeepExportRunner.HashFile(Path.Combine(extracted, "config", "agent.config.redacted.json")), (string)entry["sha256"]);
    }

    [Fact]
    public async Task AnUnparseableConfigurationReachesTheManifestWarnings()
    {
        string extracted = await RunExportWithConfig("{ \"clientName\": \"" + FixtureClientName + "\", oops");
        JObject manifest = JObject.Parse(File.ReadAllText(Path.Combine(extracted, "manifest.json")));

        Assert.Contains(
            manifest["warnings"].Select(w => (string)w),
            warning => warning.Contains("configuration", StringComparison.OrdinalIgnoreCase));
        foreach (string file in Directory.EnumerateFiles(extracted, "*", SearchOption.AllDirectories))
            Assert.DoesNotContain(FixtureClientName, File.ReadAllText(file));
    }

    /* ------------------------------------------------------------------ *
     * Helpers.                                                           *
     * ------------------------------------------------------------------ */

    private static JObject Project(JObject configuration)
    {
        AgentConfigProjectionResult result = AgentConfigProjection.Project(configuration.ToString());
        Assert.Empty(result.Warnings);
        return JObject.Parse(result.Json);
    }

    /// <summary>
    /// A minimal export over an almost empty NinjaTrader folder; the configuration
    /// is the subject.
    ///
    /// ALMOST empty, and it used to be empty. The export now refuses outright when
    /// db/NinjaTrader.sqlite is absent rather than producing a package with no
    /// database in it, so a fixture with no database can no longer run one at all -
    /// which is the right way round: a machine that has an agent configuration has
    /// a NinjaTrader database too, and a tree without one was never a shape this
    /// test meant to assert on.
    /// </summary>
    private async Task<string> RunExportWithConfig(string configJson)
    {
        string nt = Path.Combine(root, "NinjaTrader 8");
        string agent = Path.Combine(root, "ProgramData", "Vincere", "AutoExport");
        string outDir = Path.Combine(nt, "AutoExport", "deep");
        Directory.CreateDirectory(nt);
        Directory.CreateDirectory(agent);
        Directory.CreateDirectory(Path.Combine(nt, "db"));
        using (var build = new SqliteConnection(
            new SqliteConnectionStringBuilder { DataSource = Path.Combine(nt, "db", "NinjaTrader.sqlite"), Pooling = false }.ConnectionString))
        {
            build.Open();
            using SqliteCommand create = build.CreateCommand();
            create.CommandText = "CREATE TABLE Accounts (Id INTEGER PRIMARY KEY, Name TEXT)";
            create.ExecuteNonQuery();
        }
        File.WriteAllText(Path.Combine(agent, "config.json"), configJson);

        DeepExportResult result = await new DeepExportRunner(
            nt, agent, outDir, null,
            new DeepExportEnvironment("eb205103-0805|host|inst", "SERVER", "1.0.5", "1.0.0", "8.1.6.2", false, "America/New_York"),
            () => new DateTimeOffset(2026, 9, 28, 7, 15, 0, TimeSpan.FromHours(-4))).RunAsync();

        string extracted = Path.Combine(root, "unpacked");
        ZipFile.ExtractToDirectory(result.ZipPath, extracted);
        return extracted;
    }

    /// <summary>
    /// Every JsonProperty name declared in RedactedAgentState.cs, read off the
    /// source text. Throws rather than returning nothing when the file is not
    /// where it is expected: an empty answer here would make the gate vacuous,
    /// which is the one way a gate fails without anybody noticing.
    /// </summary>
    private static string[] JsonPropertyNamesOfRedactedAgentState()
    {
        string path = Path.Combine(
            CollectorRoot(), "src", "Vincere.AutoExport.Agent", "Configuration", "RedactedAgentState.cs");
        if (!File.Exists(path))
            throw new FileNotFoundException("the gate cannot find the projection it is bound to", path);
        return Regex.Matches(File.ReadAllText(path), @"\[JsonProperty\(""([^""]+)""\)\]")
            .Select(match => match.Groups[1].Value)
            .ToArray();
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
