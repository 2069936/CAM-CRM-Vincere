using System;
using System.Collections.Generic;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Input;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.UI;
using Vincere.AutoExport.Agent.UI.DeepExport;
using Xunit;

namespace Vincere.AutoExport.Agent.UI.Tests;

public sealed class MainViewModelTests
{
    [Fact]
    public async Task ServiceUnavailableShowsOneActionableInstruction()
    {
        FakeClient client = new() { Error = new ControlPipeUnavailableException("offline") };
        MainViewModel viewModel = new(client);

        await viewModel.InitializeAsync();

        Assert.False(viewModel.ServiceAvailable);
        Assert.Contains("administrator", viewModel.StatusMessage, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(1, viewModel.CurrentStep);
    }

    [Fact]
    public async Task PairCanonicalizesCodeAndShowsReturnedClientWithoutTokenMaterial()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "paired", "ok", new
        {
            ClientName = "Acme Trading",
            DeviceId = "device-id",
            ScheduleTime = "16:45",
        }));
        MainViewModel viewModel = new(client) { EnrollmentCode = "abcd-efgh-jk" };

        await viewModel.PairAsync();

        Assert.Equal("ABCDEFGHJK", Assert.Single(client.Calls).EnrollmentCode);
        Assert.Equal("Acme Trading", viewModel.ClientName);
        Assert.True(viewModel.RequiresRestart);
        Assert.Equal(3, viewModel.CurrentStep);
        Assert.DoesNotContain("token", viewModel.StatusMessage, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task ExpiredPairingCodeDirectsOperatorBackToCrm()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(false, "invalid_or_expired_code", "invalid"));
        MainViewModel viewModel = new(client) { EnrollmentCode = "ABCDEFGHJK" };

        await viewModel.PairAsync();

        Assert.Contains("Generate a new code", viewModel.StatusMessage);
        Assert.Equal(1, viewModel.CurrentStep);
    }

    [Theory]
    [InlineData("addon_unavailable")]
    [InlineData("ninjatrader_not_running")]
    public async Task MissingAddonOrNinjaTraderExplainsRestartAndRetry(string code)
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(false, code, "failed"));
        MainViewModel viewModel = new(client);

        await viewModel.TestCaptureAsync();

        Assert.True(viewModel.RequiresRestart);
        Assert.Contains("restart NinjaTrader", viewModel.StatusMessage, StringComparison.OrdinalIgnoreCase);
        Assert.False(viewModel.IsComplete);
    }

    [Fact]
    public async Task SuccessfulTestCaptureCompletesWizard()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "capture_queued", "ok"));
        MainViewModel viewModel = new(client);

        await viewModel.TestCaptureAsync();

        Assert.True(viewModel.IsComplete);
        Assert.Equal(4, viewModel.CurrentStep);
        Assert.Equal("testCapture", Assert.Single(client.Calls).Command);
    }

    [Fact]
    public async Task ScheduleAllowsOnlyApprovedFiveMinuteNewYorkChoices()
    {
        FakeClient client = new();
        MainViewModel viewModel = new(client) { ScheduleTime = "17:00" };

        await viewModel.SaveScheduleAsync();

        Assert.Empty(client.Calls);
        Assert.Contains("4:30 PM", viewModel.StatusMessage);

        client.Responses.Enqueue(Response(true, "schedule_updated", "ok"));
        viewModel.ScheduleTime = "16:50";
        await viewModel.SaveScheduleAsync();
        Assert.Equal("16:50", Assert.Single(client.Calls).ScheduleTime);
    }

    [Fact]
    public async Task StatusSurfacesOfflineQueueAndRequiredUpdateWithoutExposingRows()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "status_ok", "ok", new
        {
            Paired = true,
            ClientName = "Acme",
            ScheduleTime = "16:45",
            Runtime = new { UpdateRequired = true },
            Queue = new { PendingCount = 7 },
        }));
        MainViewModel viewModel = new(client);

        await viewModel.InitializeAsync();

        Assert.True(viewModel.UpdateRequired);
        Assert.Equal("7 uploads waiting", viewModel.QueueSummary);
        Assert.Equal(3, viewModel.CurrentStep);
        Assert.DoesNotContain("Accounts", viewModel.StatusMessage);

        // The badge used to read UPDATE REQUIRED and stop there, which names a
        // state and leaves the reader to ask what to run.
        Assert.Contains("install line", viewModel.UpdateHint);
    }

    [Fact]
    public async Task NoUpdateHintWhenNothingIsOutOfDate()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "status_ok", "ok", new
        {
            Paired = true,
            ClientName = "Acme",
            ScheduleTime = "16:45",
            Runtime = new { UpdateRequired = false },
            Queue = new { PendingCount = 0 },
        }));
        MainViewModel viewModel = new(client);

        await viewModel.InitializeAsync();

        Assert.False(viewModel.UpdateRequired);
        Assert.Equal(string.Empty, viewModel.UpdateHint);
    }

    [Theory]
    [InlineData("1.0.0", "1.0.1", true)]
    [InlineData("1.0.1", "1.0.1", false)]
    [InlineData("1.0.2", "1.0.1", false)]
    [InlineData("1.0", "1.0.1", true)]
    [InlineData("1.10.0", "1.9.0", false)]
    public void AnUpdateIsOfferedOnlyWhenTheresActuallyANewerOne(string installed, string latest, bool expected)
    {
        // 1.10 is newer than 1.9, which a string comparison gets backwards.
        Assert.Equal(expected, ReleaseCheck.Evaluate(installed, latest).UpdateAvailable);
    }

    [Fact]
    public void AnUnreadableVersionIsNotTreatedAsUpToDate()
    {
        // Saying "you are current" because the manifest could not be parsed is
        // the one wrong answer here: it is confidently wrong.
        ReleaseCheckResult result = ReleaseCheck.Evaluate("1.0.0", "not-a-version");
        Assert.False(result.Checked);
        Assert.False(result.UpdateAvailable);
    }

    [Fact]
    public void TheAnswerSaysWhatToDoAboutIt()
    {
        // The manifest fallback hands over no command, so it names the step
        // that has one: the CRM's install line, checked against a pinned digest.
        ReleaseCheckResult result = ReleaseCheck.Evaluate("1.0.0", "1.0.1");
        Assert.Contains("1.0.1", result.Message);
        Assert.Contains("Show install line", result.Message);
        Assert.Null(result.InstallCommand);
        Assert.False(result.CanInstall);
    }

    /* THE COMMAND A PERSON COPIES CHECKS THE BYTES FIRST.
     *
     * It is pasted into an elevated PowerShell on a machine holding live client
     * accounts. A person reading it can no more tell what arrived than the
     * Install button can, so the line itself compares the download with the
     * published SHA-256 before anything out of it expands or runs, and without
     * a usable digest there is no line at all. */

    private const string Sha121 = "32c76ddb1dcfc010c3b444504e73e79499fa925cddb765c51997395c026a1109";
    private const string Url121 = "https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.2.1/Vincere-AutoExport-Agent.zip";

    [Fact]
    public void TheCommandIsTheOneTheCrmBuilds()
    {
        // Byte for byte buildInstallCommand in src/domain/autoCollectionViewModel.js,
        // for the same 1.2.1 release its own test pins. Two spellings of the
        // same install would be two things to keep working.
        Assert.Equal(
            "$d=\"$env:TEMP\\vincere-agent\"; "
            + "Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue; "
            + "Invoke-WebRequest 'https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.2.1/Vincere-AutoExport-Agent.zip' -OutFile \"$d.zip\" -UseBasicParsing; "
            + "$hash=(Get-FileHash -LiteralPath \"$d.zip\" -Algorithm SHA256).Hash; "
            + "if ($hash -ne '32c76ddb1dcfc010c3b444504e73e79499fa925cddb765c51997395c026a1109') { Remove-Item -LiteralPath \"$d.zip\" -Force -ErrorAction SilentlyContinue; throw \"SHA256 mismatch, nothing was installed: $hash\" }; "
            + "Expand-Archive \"$d.zip\" $d -Force; "
            + "& \"$d\\install-agent.ps1\" -PackagePath $d",
            ReleaseCheck.BuildInstallCommand(Url121, Sha121));
    }

    [Fact]
    public void ComparesTheHashAfterTheDownloadAndBeforeAnythingExpandsOrRuns()
    {
        string command = ReleaseCheck.BuildInstallCommand(Url121, Sha121);
        int download = command.IndexOf("Invoke-WebRequest", StringComparison.Ordinal);
        int hash = command.IndexOf("Get-FileHash", StringComparison.Ordinal);
        int compare = command.IndexOf("-ne '" + Sha121 + "'", StringComparison.Ordinal);
        int thrown = command.IndexOf("throw ", StringComparison.Ordinal);
        int expand = command.IndexOf("Expand-Archive", StringComparison.Ordinal);
        int run = command.IndexOf("install-agent.ps1", StringComparison.Ordinal);
        Assert.True(download > -1);
        Assert.True(hash > download);
        Assert.True(compare > hash);
        Assert.True(thrown > compare);
        Assert.True(expand > thrown);
        Assert.True(run > expand);
        // Each appears exactly once, so nothing can run from the zip on a path
        // that skipped the comparison.
        Assert.Equal(2, command.Split("Expand-Archive").Length);
        Assert.Equal(2, command.Split("install-agent.ps1").Length);
        Assert.DoesNotContain("\n", command);
    }

    [Fact]
    public void AcceptsAnUpperCaseDigestAndWritesItLowerCase()
    {
        Assert.Contains("-ne '" + Sha121 + "'",
            ReleaseCheck.BuildInstallCommand(Url121, Sha121.ToUpperInvariant()));
    }

    [Fact]
    public void HandsOverNoCommandWithoutAUsableChecksum()
    {
        Assert.Null(ReleaseCheck.BuildInstallCommand(Url121, null));
        Assert.Null(ReleaseCheck.BuildInstallCommand(Url121, string.Empty));
        Assert.Null(ReleaseCheck.BuildInstallCommand(Url121, Sha121.Substring(1)));
        Assert.Null(ReleaseCheck.BuildInstallCommand(Url121, Sha121 + "0"));
        Assert.Null(ReleaseCheck.BuildInstallCommand(Url121, Sha121.Substring(1) + "g"));
        // A quote would break out of the single quoted literal the hash sits in.
        Assert.Null(ReleaseCheck.BuildInstallCommand(Url121, Sha121.Substring(2) + "'x"));
        Assert.Null(ReleaseCheck.BuildInstallCommand(Url121, " " + Sha121));
        // .NET's $ would let this through and split the one line in two.
        Assert.Null(ReleaseCheck.BuildInstallCommand(Url121, Sha121 + "\n"));
    }

    [Fact]
    public void RefusesToBuildACommandFromAnUrlItShouldNotRun()
    {
        // This string is going to be pasted into an elevated PowerShell. A
        // release naming anything but an https artifact does not get to
        // compose that, checksum or not.
        Assert.Null(ReleaseCheck.BuildInstallCommand(null, Sha121));
        Assert.Null(ReleaseCheck.BuildInstallCommand("   ", Sha121));
        Assert.Null(ReleaseCheck.BuildInstallCommand("http://example.test/a.zip", Sha121));
        Assert.Null(ReleaseCheck.BuildInstallCommand("file://C:/a.zip", Sha121));
        Assert.Null(ReleaseCheck.BuildInstallCommand("not a url", Sha121));
    }

    [Fact]
    public void EscapesASingleQuoteRatherThanEndingTheQuotedString()
    {
        Assert.Contains("'https://example.test/a''b.zip'",
            ReleaseCheck.BuildInstallCommand("https://example.test/a'b.zip", Sha121));
    }

    [Fact]
    public void TheDescriptorHandsOverTheVerifiedCommand()
    {
        ReleaseCheckResult result = ReleaseCheck.EvaluateDescriptor("1.2.0", JObject.Parse(
            "{\"version\":\"1.2.1\",\"sha256\":\"" + Sha121.ToUpperInvariant() + "\",\"url\":\"" + Url121 + "\"}"));

        Assert.True(result.UpdateAvailable);
        Assert.True(result.CanInstall);
        Assert.Equal(ReleaseCheck.BuildInstallCommand(Url121, Sha121), result.InstallCommand);
    }

    [Fact]
    public async Task TheManifestFallbackHandsOverNoCommandEvenWithAChecksum()
    {
        // The manifest this reads by default is frozen and its digest names a
        // package replaced long ago. A line checked against it would refuse the
        // real package every time, and a line checked against nothing is never
        // handed over. So the fallback says the version and points at the CRM.
        ReleaseCheckResult result = await new ReleaseCheck(
            new StubManifest("1.0.3", "https://example.test/a.zip", Sha121)).CheckAsync("1.0.0");

        Assert.True(result.Checked);
        Assert.True(result.UpdateAvailable);
        Assert.Null(result.InstallCommand);
        Assert.False(result.CanInstall);
        Assert.Contains("install line", result.Message);
    }

    [Fact]
    public void SaysNothingAboutACommandWhenAlreadyUpToDate()
    {
        ReleaseCheckResult fromManifest = ReleaseCheck.Evaluate("1.0.3", "1.0.3");
        Assert.False(fromManifest.UpdateAvailable);
        Assert.Null(fromManifest.InstallCommand);

        ReleaseCheckResult fromDescriptor = ReleaseCheck.EvaluateDescriptor("1.2.1", JObject.Parse(
            "{\"version\":\"1.2.1\",\"sha256\":\"" + Sha121 + "\",\"url\":\"" + Url121 + "\"}"));
        Assert.False(fromDescriptor.UpdateAvailable);
        Assert.Null(fromDescriptor.InstallCommand);
    }

    [Fact]
    public async Task CopyPutsTheCommandOnTheClipboardAndSaysSo()
    {
        string copied = null;
        MainViewModel viewModel = new(
            PairedAt("1.0.0"),
            new ReleaseCheck(new StubDescriptor()),
            text => copied = text);

        await viewModel.InitializeAsync();
        await viewModel.CheckForUpdateAsync();
        await viewModel.CopyInstallCommandAsync();

        Assert.True(viewModel.HasUpdateInstallCommand);
        Assert.Contains("Get-FileHash", copied);
        Assert.Contains("install-agent.ps1", copied);
        Assert.Contains("Copied", viewModel.CopyConfirmation);
    }

    [Fact]
    public async Task TellsTheReaderToSelectItWhenTheClipboardIsUnreachable()
    {
        // Another process holding the clipboard is ordinary, and the command is
        // on screen either way. Claiming it was copied would be worse.
        MainViewModel viewModel = new(
            PairedAt("1.0.0"),
            new ReleaseCheck(new StubDescriptor()),
            text => throw new InvalidOperationException("clipboard busy"));

        await viewModel.InitializeAsync();
        await viewModel.CheckForUpdateAsync();
        await viewModel.CopyInstallCommandAsync();

        Assert.Contains("Select the command above", viewModel.CopyConfirmation);
    }

    [Fact]
    public async Task OffersNoCommandWhenThereIsNoUpdate()
    {
        MainViewModel viewModel = new(
            PairedAt("1.0.0"),
            new ReleaseCheck(new StubManifest("1.0.0", "https://example.test/a.zip")));

        await viewModel.InitializeAsync();
        await viewModel.CheckForUpdateAsync();

        Assert.False(viewModel.HasUpdateInstallCommand);
        Assert.False(viewModel.CopyInstallCommandCommand.CanExecute(null));
    }

    /// <summary>A service that answers status with the version it is running.</summary>
    private static FakeClient PairedAt(string agentVersion)
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "status_ok", "ok", new
        {
            Paired = true,
            ClientName = "Acme",
            ScheduleTime = "16:45",
            AgentVersion = agentVersion,
            Queue = new { PendingCount = 0 },
        }));
        return client;
    }

    /// <summary>Answers the manifest fetch without a network.</summary>
    private sealed class StubManifest : HttpMessageHandler
    {
        private readonly string version;
        private readonly string url;
        private readonly string sha256;

        public StubManifest(string version, string url, string sha256 = null)
        {
            this.version = version;
            this.url = url;
            this.sha256 = sha256;
        }

        protected override Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            string sha = sha256 == null ? string.Empty : ",\"sha256\":\"" + sha256 + "\"";
            string body = "{\"version\":\"" + version + "\",\"artifacts\":[{\"name\":\"Vincere-AutoExport-Agent.zip\",\"url\":\"" + url + "\"" + sha + "}]}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK)
            {
                Content = new StringContent(body),
            });
        }
    }

    [Fact]
    public void ItAsksTheReleaseDirectlySoItWorksWhileTheCrmDoesNot()
    {
        // The point of this button. The old notice only lit up from a heartbeat
        // response, and heartbeats were the thing that was failing.
        Assert.Contains("releases/download", ReleaseCheck.DefaultManifestUrl);
        Assert.StartsWith("https://", ReleaseCheck.DefaultManifestUrl);
    }

    [Fact]
    public void TheQueueFolderCanBeOpenedWithoutKnowingWhereItIs()
    {
        // It lives under ProgramData, which is hidden, inside a tree restricted
        // to SYSTEM and Administrators. Copying a capture out by hand is the
        // fallback whenever uploads are failing, and it required pasting a path
        // into the address bar.
        MainViewModel viewModel = new(new FakeClient());

        Assert.NotNull(viewModel.OpenQueueFolderCommand);
        // Available even before a status arrives: a queue that cannot upload is
        // exactly when nothing else on this window is working either.
        Assert.True(viewModel.OpenQueueFolderCommand.CanExecute(null));
    }

    [Fact]
    public async Task DiagnosticsShowsReturnedRedactedPackagePath()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "diagnostics_ready", "ok", new { path = @"C:\ProgramData\Vincere\diagnostics.zip" }));
        MainViewModel viewModel = new(client);

        await viewModel.CollectDiagnosticsAsync();

        Assert.EndsWith("diagnostics.zip", viewModel.DiagnosticsPath);
        Assert.Contains("Redacted diagnostics", viewModel.StatusMessage);
    }

    /* THE WINDOW WAS REPORTING ITS OWN VERSION.
     *
     * Only the service project declares a <Version>, so the Setup window read
     * 1.0.0 off its own assembly while the service beside it was 1.0.2. Someone
     * who had just reinstalled was told the update had not taken, and the update
     * check compared that 1.0.0 against the published manifest and announced an
     * update that was already installed. */

    [Fact]
    public async Task InstalledVersionComesFromTheServiceNotFromThisAssembly()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "status_ok", "ok", new
        {
            Paired = true,
            ClientName = "Acme",
            ScheduleTime = "16:45",
            AgentVersion = "1.0.2",
            Queue = new { PendingCount = 0 },
        }));
        MainViewModel viewModel = new(client);

        await viewModel.InitializeAsync();

        Assert.Equal("1.0.2", viewModel.InstalledVersion);
        Assert.True(viewModel.InstalledVersionIsFromService);
    }

    [Fact]
    public async Task AcceptsTheCamelCaseSpellingTheWireActuallyUses()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "status_ok", "ok", new
        {
            Paired = true,
            agentVersion = "1.1.0",
            Queue = new { PendingCount = 0 },
        }));
        MainViewModel viewModel = new(client);

        await viewModel.InitializeAsync();

        Assert.Equal("1.1.0", viewModel.InstalledVersion);
    }

    [Fact]
    public async Task KeepsTheFallbackWhenTheServiceReportsNoVersion()
    {
        // An older service that predates this field. Showing nothing would be
        // worse than showing the assembly value.
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "status_ok", "ok", new
        {
            Paired = true,
            Queue = new { PendingCount = 0 },
        }));
        MainViewModel viewModel = new(client);
        string before = viewModel.InstalledVersion;

        await viewModel.InitializeAsync();

        Assert.Equal(before, viewModel.InstalledVersion);
        Assert.False(viewModel.InstalledVersionIsFromService);
    }

    [Fact]
    public async Task WillNotAnnounceAnUpdateAgainstAVersionItIsGuessingAt()
    {
        // THE FAILURE THIS PREVENTS. Comparing the window's own assembly against
        // the manifest reported an available update on a machine that was
        // already current, permanently.
        FakeClient client = new();
        client.Responses.Enqueue(Response(false, "unavailable", "The collector service is not running."));
        MainViewModel viewModel = new(client);

        await viewModel.InitializeAsync();
        await viewModel.CheckForUpdateAsync();

        Assert.False(viewModel.InstalledVersionIsFromService);
        Assert.Contains("has not reported its version", viewModel.LatestVersionMessage);
    }

    /* QUARANTINE, ON THE SCREEN THAT CAN DO SOMETHING ABOUT IT.
     *
     * The folder used to be invisible from here. The status reply now carries
     * it, the card lists it, and the button runs the service's review at once
     * rather than at midday. */

    private static object QuarantinedStatus(params object[] items) => new
    {
        Paired = true,
        ClientName = "Acme",
        ScheduleTime = "16:45",
        Queue = new { PendingCount = 0 },
        Quarantine = new { Count = items.Length, Items = items, ReviewTime = "12:00" },
    };

    private static object Quarantined(string date, string code, int attempts, bool willRetry) => new
    {
        TradingDate = date,
        CaptureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        Code = code,
        Attempts = attempts,
        WillRetry = willRetry,
    };

    [Fact]
    public async Task StatusShowsTheQuarantineAndOffersTheRetry()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "status_ok", "ok", QuarantinedStatus(
            Quarantined("2026-07-22", "snapshot_processing_failed", 1, true),
            Quarantined("2026-07-21", "snapshot_rejected", 0, false))));
        MainViewModel viewModel = new(client);

        await viewModel.InitializeAsync();

        Assert.True(viewModel.HasQuarantine);
        Assert.Equal(2, viewModel.QuarantineItems.Count);
        Assert.Contains("2 captures in quarantine", viewModel.QuarantineSummary);
        Assert.Contains("12:00 PM", viewModel.QuarantineSummary);
        Assert.True(viewModel.RetryQuarantineCommand.CanExecute(null));
    }

    [Fact]
    public async Task AServiceWithoutAQuarantineFieldShowsNoCard()
    {
        // An older service, or an empty folder. The card is hidden and the
        // button is not offered, because there is nothing it could do.
        MainViewModel viewModel = new(PairedAt("1.0.6"));

        await viewModel.InitializeAsync();

        Assert.False(viewModel.HasQuarantine);
        Assert.False(viewModel.RetryQuarantineCommand.CanExecute(null));
    }

    [Fact]
    public async Task RetryRunsTheReviewSaysWhatMovedAndReadsTheFolderAgain()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "status_ok", "ok", QuarantinedStatus(
            Quarantined("2026-07-22", "snapshot_processing_failed", 0, true))));
        client.Responses.Enqueue(Response(true, "quarantine_reviewed", "1 capture sent back for upload.", new { requeued = 1, remaining = 0 }));
        client.Responses.Enqueue(Response(true, "status_ok", "ok", QuarantinedStatus()));
        MainViewModel viewModel = new(client);
        await viewModel.InitializeAsync();

        await viewModel.RetryQuarantineAsync();

        Assert.Equal(new[] { "status", "retryQuarantine", "status" }, client.Calls.Select(call => call.Command).ToArray());
        Assert.Equal("1 capture sent back for upload.", viewModel.StatusMessage);
        Assert.False(viewModel.HasQuarantine);
    }

    [Fact]
    public async Task ARefusedRetryShowsTheServicesSentence()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(false, "administrator_required", "Administrator approval is required."));
        MainViewModel viewModel = new(client);

        await viewModel.RetryQuarantineAsync();

        Assert.Equal("Administrator approval is required.", viewModel.StatusMessage);
        Assert.Equal("retryQuarantine", Assert.Single(client.Calls).Command);
    }

    /* THE ROWS, STACKED.
     *
     * The window binds to these and nothing else decides what it shows: one
     * capture is one row as before, more are grouped, more than three groups
     * are three until the toggle asks for all of them. */

    [Fact]
    public async Task OneQuarantinedCaptureIsOneRowAsBefore()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "status_ok", "ok", QuarantinedStatus(
            Quarantined("2026-07-22", "snapshot_processing_failed", 1, true))));
        MainViewModel viewModel = new(client);

        await viewModel.InitializeAsync();

        Assert.True(viewModel.QuarantineIsFlat);
        Assert.False(viewModel.QuarantineIsGrouped);
        Assert.Single(viewModel.QuarantineItems);
        Assert.False(viewModel.HasMoreQuarantineGroups);
    }

    [Fact]
    public async Task SeveralQuarantinedCapturesAreGroupedAndThreeGroupsShowUntilAskedForAll()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "status_ok", "ok", QuarantinedStatus(
            Quarantined("2026-07-22", "snapshot_processing_failed", 1, true),
            Quarantined("2026-07-21", "snapshot_processing_failed", 1, true),
            Quarantined("2026-07-20", "capture_requires_replay", 0, true),
            Quarantined("2026-07-17", "snapshot_rejected", 0, false),
            Quarantined("2026-07-16", "capture_conflict", 0, false),
            Quarantined("2026-07-15", "payload_too_large", 0, false),
            Quarantined("2026-07-14", "payload_too_large", 0, false))));
        MainViewModel viewModel = new(client);
        await viewModel.InitializeAsync();
        List<string> changed = new();
        viewModel.PropertyChanged += (_, e) => changed.Add(e.PropertyName);

        Assert.True(viewModel.QuarantineIsGrouped);
        Assert.False(viewModel.QuarantineIsFlat);
        Assert.Equal(7, viewModel.QuarantineItems.Count);
        Assert.Equal(3, viewModel.QuarantineGroups.Count);
        Assert.True(viewModel.HasMoreQuarantineGroups);
        Assert.False(viewModel.ShowAllQuarantineGroups);
        Assert.Equal("Show all 5", viewModel.ShowAllQuarantineGroupsLabel);
        Assert.Equal(
            new[] { "snapshot_processing_failed", "capture_requires_replay", "snapshot_rejected" },
            viewModel.QuarantineGroups.Select(group => group.Code).ToArray());

        viewModel.ShowAllQuarantineGroups = true;

        Assert.Equal(5, viewModel.QuarantineGroups.Count);
        Assert.Equal("Show fewer", viewModel.ShowAllQuarantineGroupsLabel);
        Assert.Contains(nameof(MainViewModel.QuarantineGroups), changed);
        Assert.Contains(nameof(MainViewModel.ShowAllQuarantineGroupsLabel), changed);
        Assert.Contains(nameof(MainViewModel.ShowAllQuarantineGroups), changed);

        viewModel.ShowAllQuarantineGroups = false;

        Assert.Equal(3, viewModel.QuarantineGroups.Count);
        Assert.Equal("Show all 5", viewModel.ShowAllQuarantineGroupsLabel);
    }

    [Fact]
    public async Task ThreeGroupsOrFewerAreAllShownAndNeedNoToggle()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "status_ok", "ok", QuarantinedStatus(
            Quarantined("2026-07-22", "snapshot_processing_failed", 1, true),
            Quarantined("2026-07-21", "snapshot_rejected", 0, false),
            Quarantined("2026-07-20", "capture_conflict", 0, false))));
        MainViewModel viewModel = new(client);

        await viewModel.InitializeAsync();

        Assert.True(viewModel.QuarantineIsGrouped);
        Assert.Equal(3, viewModel.QuarantineGroups.Count);
        Assert.False(viewModel.HasMoreQuarantineGroups);
        Assert.Contains("3 captures in quarantine", viewModel.QuarantineSummary);
    }

    [Fact]
    public async Task ANewStatusRaisesEveryGroupedPropertyTheWindowBindsTo()
    {
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "status_ok", "ok", QuarantinedStatus(
            Quarantined("2026-07-22", "snapshot_processing_failed", 1, true),
            Quarantined("2026-07-21", "snapshot_rejected", 0, false))));
        MainViewModel viewModel = new(client);
        List<string> changed = new();
        viewModel.PropertyChanged += (_, e) => changed.Add(e.PropertyName);

        await viewModel.InitializeAsync();

        foreach (string name in new[]
        {
            nameof(MainViewModel.QuarantineIsFlat),
            nameof(MainViewModel.QuarantineIsGrouped),
            nameof(MainViewModel.QuarantineGroups),
            nameof(MainViewModel.HasMoreQuarantineGroups),
            nameof(MainViewModel.ShowAllQuarantineGroupsLabel),
            nameof(MainViewModel.QuarantineItems),
            nameof(MainViewModel.QuarantineSummary),
        })
        {
            Assert.Contains(name, changed);
        }
    }

    /* THE REPORT WAS WRITTEN AND THE BUTTON STAYED GREY.
     *
     * AsyncCommand does not hook CommandManager.RequerySuggested, so nothing
     * re-asks CanExecute on its own. 1.1.1 went to the fleet with the local
     * report landing on the Desktop and Open report disabled beside it. These
     * two pin the wiring rather than the symptom. */
    [Fact]
    public void WritingTheLocalReportEnablesTheButtonThatOpensIt()
    {
        MainViewModel viewModel = new(new FakeClient());
        AsyncCommand open = (AsyncCommand)viewModel.OpenLocalReportCommand;
        int raised = 0;
        open.CanExecuteChanged += (_, _) => raised++;

        Assert.False(open.CanExecute(null));

        SetLocalReportPath(viewModel, @"C:\Users\Administrator\Desktop\Joel Onafowokan - 2026-09-28 daily report.html");

        Assert.True(viewModel.HasLocalReport);
        Assert.True(open.CanExecute(null));
        Assert.True(raised > 0, "Open report was never told its answer changed, so WPF never re-asked and the button stayed disabled.");
    }

    [Fact]
    public void EveryCommandOnTheWindowFollowsTheBusyFlag()
    {
        MainViewModel viewModel = new(new FakeClient());
        List<string> quiet = new();

        foreach (PropertyInfo property in typeof(MainViewModel)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Where(property => typeof(ICommand).IsAssignableFrom(property.PropertyType)))
        {
            if (property.GetValue(viewModel) is not AsyncCommand command) continue;
            string name = property.Name;
            bool heard = false;
            command.CanExecuteChanged += (_, _) => heard = true;
            quiet.Add(name);
            command.CanExecuteChanged += (_, _) => quiet.Remove(name);
            _ = heard;
        }

        typeof(MainViewModel)
            .GetMethod("RaiseCommands", BindingFlags.NonPublic | BindingFlags.Instance)
            .Invoke(viewModel, null);

        Assert.True(quiet.Count == 0, "These commands are never re-queried when the window becomes busy or idle: " + string.Join(", ", quiet));
    }

    private static void SetLocalReportPath(MainViewModel viewModel, string path)
        => typeof(MainViewModel)
            .GetProperty(nameof(MainViewModel.LocalReportPath))
            .SetValue(viewModel, path);

    private static UiControlResponse Response(bool ok, string code, string message, object data = null)
        => new(Guid.NewGuid(), ok, code, message, data == null ? null : JObject.FromObject(data));

    private sealed class FakeClient : IControlPipeClient
    {
        public Queue<UiControlResponse> Responses { get; } = new();
        public List<Call> Calls { get; } = new();
        public Exception Error { get; init; }

        public Task<UiControlResponse> SendAsync(
            string command,
            string enrollmentCode = null,
            string scheduleTime = null,
            bool confirmed = false,
            CancellationToken cancellationToken = default)
        {
            Calls.Add(new Call(command, enrollmentCode, scheduleTime, confirmed));
            if (Error != null) throw Error;
            return Task.FromResult(Responses.Dequeue());
        }
    }

    private sealed record Call(string Command, string EnrollmentCode, string ScheduleTime, bool Confirmed);

    /* ONE BUTTON, NOT AN ERRAND, AND NOT AN AUTO-UPDATE.
     *
     * Copying a command still meant finding a PowerShell, pasting, and knowing
     * what you were looking at. This installs from the window the reader is
     * already in. A person presses it, Windows asks them to elevate, a console
     * shows them what happens. Software that replaces itself unattended on a
     * machine carrying live client prop-firm accounts is a different decision. */

    private sealed class StubDescriptor : HttpMessageHandler
    {
        public string Version { get; init; } = "1.0.4";
        public string Sha { get; init; } = new string('a', 64);
        public string Url { get; init; } = "https://example.test/agent.zip";

        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            string body = "{\"version\":\"" + Version + "\",\"sha256\":\"" + Sha + "\",\"url\":\"" + Url + "\"}";
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(body) });
        }
    }

    [Fact]
    public async Task OffersToInstallWhenThePublishedChecksumIsKnown()
    {
        MainViewModel viewModel = new(PairedAt("1.0.0"), new ReleaseCheck(new StubDescriptor()));
        await viewModel.InitializeAsync();
        await viewModel.CheckForUpdateAsync();
        Assert.True(viewModel.CanInstallUpdate);
    }

    [Fact]
    public async Task RefusesToOfferAnInstallWithoutAChecksum()
    {
        // THE LINE. The script downloads a package and runs it as
        // administrator. Without knowing what arrived there is no button and
        // no command to copy either: a person pasting it cannot tell what
        // arrived any better. The notice points at the CRM's install line.
        MainViewModel viewModel = new(
            PairedAt("1.0.0"),
            new ReleaseCheck(new StubManifest("1.0.3", "https://example.test/a.zip")));
        await viewModel.InitializeAsync();
        await viewModel.CheckForUpdateAsync();
        Assert.False(viewModel.CanInstallUpdate);
        Assert.False(viewModel.InstallUpdateCommand.CanExecute(null));
        Assert.False(viewModel.HasUpdateInstallCommand);
        Assert.False(viewModel.CopyInstallCommandCommand.CanExecute(null));
        Assert.Contains("install line", viewModel.LatestVersionMessage);
    }

    [Fact]
    public async Task TheScriptItRunsVerifiesTheDownloadBeforeExecutingAnything()
    {
        string launched = null;
        MainViewModel viewModel = new(
            PairedAt("1.0.0"),
            new ReleaseCheck(new StubDescriptor()),
            null,
            script => { launched = script; return true; });

        await viewModel.InitializeAsync();
        await viewModel.CheckForUpdateAsync();
        await viewModel.InstallUpdateAsync();

        Assert.Contains("Get-FileHash", launched);
        Assert.Contains("does not match the published checksum", launched);
        // The order is the point: the check and its exit come before the script
        // ever expands or runs anything out of the archive.
        Assert.True(launched.IndexOf("exit 1", StringComparison.Ordinal)
            < launched.IndexOf("install-agent.ps1", StringComparison.Ordinal));
    }

    [Fact]
    public async Task SaysNothingChangedWhenTheElevationPromptIsDeclined()
    {
        MainViewModel viewModel = new(
            PairedAt("1.0.0"),
            new ReleaseCheck(new StubDescriptor()),
            null,
            _ => false);

        await viewModel.InitializeAsync();
        await viewModel.CheckForUpdateAsync();
        await viewModel.InstallUpdateAsync();

        Assert.Contains("Nothing has changed", viewModel.StatusMessage);
    }

    [Fact]
    public async Task DoesNotInstallAnUpdateItWasNeverToldAbout()
    {
        string launched = null;
        MainViewModel viewModel = new(PairedAt("1.0.0"), null, null, script => { launched = script; return true; });
        await viewModel.InitializeAsync();
        await viewModel.InstallUpdateAsync();
        Assert.Null(launched);
        Assert.Contains("Check for updates first", viewModel.StatusMessage);
    }

    [Fact]
    public void RefusesToBuildAnInstallScriptFromAnythingUnverifiable()
    {
        Assert.Null(ReleaseCheck.BuildVerifiedInstallScript("https://example.test/a.zip", "not-a-hash"));
        Assert.Null(ReleaseCheck.BuildVerifiedInstallScript("https://example.test/a.zip", null));
        Assert.Null(ReleaseCheck.BuildVerifiedInstallScript("http://example.test/a.zip", new string('a', 64)));
        Assert.NotNull(ReleaseCheck.BuildVerifiedInstallScript("https://example.test/a.zip", new string('A', 64)));
    }

    [Fact]
    public void ReadsTheDescriptorAndIgnoresOneItCannotTrust()
    {
        Assert.Null(ReleaseCheck.EvaluateDescriptor("1.0.0", JObject.Parse("{\"version\":\"1.0.4\"}")));
        Assert.Null(ReleaseCheck.EvaluateDescriptor("1.0.0",
            JObject.Parse("{\"version\":\"1.0.4\",\"sha256\":\"short\",\"url\":\"https://e.test/a.zip\"}")));
        Assert.Null(ReleaseCheck.EvaluateDescriptor("1.0.0",
            JObject.Parse("{\"version\":\"1.0.4\",\"sha256\":\"" + new string('a', 64) + "\",\"url\":\"http://e.test/a.zip\"}")));
    }

    /* DEEP EXPORT FROM THE WINDOW.
     *
     * The runner is tested against a real folder in DeepExportTests. Here the
     * question is what the window does with the outcome: which environment it
     * hands over, what it shows when the package is ready, and that a failure
     * lands on screen instead of in an unobserved async void. */

    [Fact]
    public async Task DeepExportHandsOverWhatTheServiceReportedAboutThisMachine()
    {
        DeepExportEnvironment seen = null;
        FakeClient client = new();
        client.Responses.Enqueue(Response(true, "status_ok", "ok", new
        {
            Paired = true,
            DeviceId = "dev-1234567890",
            ClientName = "Todd",
            TimeZone = "America/Chicago",
            AgentVersion = "1.0.5",
            AddonVersion = "1.0.0",
            Runtime = new { UpdateRequired = false, NinjaTraderVersion = "8.1.6.2" },
            Queue = new { PendingCount = 0 },
        }));
        MainViewModel viewModel = new(client, deepExport: (environment, progress, token) =>
        {
            seen = environment;
            return Task.FromResult(new DeepExportResult("C:\\x\\deep_dev-1234_1.zip", new string('b', 64), 2_500_000, Array.Empty<string>(), TimeSpan.FromSeconds(3)));
        });
        await viewModel.InitializeAsync();
        await viewModel.DeepExportAsync();

        Assert.Equal("dev-1234567890", seen.MachineId);
        Assert.Equal("1.0.5", seen.AgentVersion);
        Assert.Equal("1.0.0", seen.AddonVersion);
        Assert.Equal("8.1.6.2", seen.NinjaTraderVersion);
        Assert.Equal("America/Chicago", seen.TimeZone);
        Assert.Equal(Environment.MachineName, seen.Hostname);
    }

    [Fact]
    public async Task DeepExportShowsThePackageItsChecksumAndTheSize()
    {
        MainViewModel viewModel = new(PairedAt("1.0.5"), deepExport: (environment, progress, token) =>
            Task.FromResult(new DeepExportResult("C:\\x\\deep.zip", new string('c', 64), 2_500_000, Array.Empty<string>(), TimeSpan.FromSeconds(3))));
        await viewModel.InitializeAsync();
        await viewModel.DeepExportAsync();

        Assert.True(viewModel.HasDeepExport);
        Assert.Equal("C:\\x\\deep.zip", viewModel.DeepExportPath);
        Assert.Equal(new string('c', 64), viewModel.DeepExportSha256);
        Assert.Contains("2.4 MB", viewModel.DeepExportMessage);
        Assert.Contains("Desktop", viewModel.DeepExportMessage);
        Assert.Equal(100, viewModel.DeepExportPercent);
        Assert.False(viewModel.IsBusy);
        Assert.True(viewModel.OpenDeepExportFolderCommand.CanExecute(null));
        Assert.True(viewModel.CopyDeepExportShaCommand.CanExecute(null));
    }

    [Fact]
    public async Task DeepExportNamesItsWarnings()
    {
        // A thin package must say why it is thin, on the screen the person is
        // looking at, not in a log they will not open.
        MainViewModel viewModel = new(PairedAt("1.0.5"), deepExport: (environment, progress, token) =>
            Task.FromResult(new DeepExportResult("C:\\x\\deep.zip", new string('c', 64), 900, new[] { "trace folder missing" }, TimeSpan.Zero)));
        await viewModel.InitializeAsync();
        await viewModel.DeepExportAsync();
        Assert.Contains("1 warning", viewModel.DeepExportMessage);
        Assert.Contains("trace folder missing", viewModel.DeepExportMessage);
    }

    [Fact]
    public async Task DeepExportFailurePutsTheReasonOnScreen()
    {
        MainViewModel viewModel = new(PairedAt("1.0.5"), deepExport: (environment, progress, token) =>
            throw new DeepExportUnavailableException("NinjaTrader 8 was not found under this user's Documents."));
        await viewModel.InitializeAsync();
        await viewModel.DeepExportAsync();
        Assert.False(viewModel.HasDeepExport);
        Assert.Contains("not found", viewModel.DeepExportMessage);
        Assert.False(viewModel.IsBusy);
        Assert.True(viewModel.DeepExportCommand.CanExecute(null));
    }

    [Fact]
    public async Task DeepExportChecksumCopiesToTheClipboardWhenThereIsOne()
    {
        string copied = null;
        MainViewModel viewModel = new(PairedAt("1.0.5"), copyToClipboard: text => copied = text, deepExport: (environment, progress, token) =>
            Task.FromResult(new DeepExportResult("C:\\x\\deep.zip", new string('d', 64), 900, Array.Empty<string>(), TimeSpan.Zero)));
        await viewModel.InitializeAsync();
        await viewModel.DeepExportAsync();
        await viewModel.CopyDeepExportShaAsync();
        Assert.Equal(new string('d', 64), copied);
        Assert.Equal("Checksum copied.", viewModel.DeepExportCopyConfirmation);
    }
}
