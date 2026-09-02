using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.UI;
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
        ReleaseCheckResult result = ReleaseCheck.Evaluate("1.0.0", "1.0.1");
        Assert.Contains("1.0.1", result.Message);
        Assert.Contains("install line", result.Message);
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
}
