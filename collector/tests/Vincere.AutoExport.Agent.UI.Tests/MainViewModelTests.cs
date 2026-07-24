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
