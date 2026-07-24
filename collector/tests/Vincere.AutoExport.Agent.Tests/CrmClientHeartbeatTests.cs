using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Security;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class CrmClientHeartbeatTests
{
    [Fact]
    public async Task HeartbeatSendsOnlyAllowlistedHealthMetadataAndReadsSchedule()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """
            {"ok":true,"deviceId":"33333333-3333-4333-8333-333333333333","status":"online","updateRequired":false,"throttled":false,"schedule":{"time":"16:45","timeZone":"America/New_York"}}
            """));
        CrmClient client = CreateClient(handler);
        HeartbeatPayload payload = new(
            AgentVersion: "1.2.3",
            AddonVersion: "4.5.6",
            NinjaTraderVersion: "8.1.5.2",
            LastCaptureAt: new DateTimeOffset(2026, 7, 23, 16, 45, 0, TimeSpan.FromHours(-4)),
            LastSuccessAt: new DateTimeOffset(2026, 7, 23, 16, 45, 0, TimeSpan.FromHours(-4)),
            LastErrorCode: null,
            LastErrorMessage: null,
            QueueDepth: 3,
            QueueBytes: 4096,
            AddonAvailable: true);

        HeartbeatResult result = await client.SendHeartbeatAsync(payload);

        Assert.Equal("online", result.Status);
        Assert.Equal("16:45", result.ScheduleTime);
        RecordedRequest request = Assert.Single(handler.Requests);
        Assert.Equal("Bearer DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", request.Authorization);
        Assert.Equal("machine-guid", request.MachineId);
        Assert.Contains("\"queueDepth\":3", request.Body);
        Assert.DoesNotContain("machine-guid", request.Body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("DDDDDDDD", request.Body);
        Assert.DoesNotContain("accounts", request.Body, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task RevokedHeartbeatCredentialRequiresRepair()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.Unauthorized, """
            {"error":"invalid_device_credential"}
            """));
        CrmClient client = CreateClient(handler);

        CrmClientException error = await Assert.ThrowsAsync<CrmClientException>(() =>
            client.SendHeartbeatAsync(Payload()));

        Assert.Equal("device_credential_revoked", error.Code);
        Assert.Equal(CrmFailureDisposition.RePair, error.Disposition);
    }

    [Fact]
    public async Task HeartbeatServerFailureRetriesWithoutIncludingSnapshotRows()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.InternalServerError, """
            {"error":"heartbeat_unavailable"}
            """));
        RecordingDelay delay = new();
        CrmClient client = CreateClient(handler, maxAttempts: 2, delay);

        CrmClientException error = await Assert.ThrowsAsync<CrmClientException>(() =>
            client.SendHeartbeatAsync(Payload()));

        Assert.Equal("heartbeat_failed", error.Code);
        Assert.True(error.Retryable);
        Assert.Equal(2, handler.Requests.Count);
        Assert.Single(delay.Delays);
        Assert.All(handler.Requests, request => Assert.DoesNotContain("accounts", request.Body));
    }

    [Fact]
    public async Task HeartbeatRedactsKnownCredentialAndMachineIdFromErrorMessage()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """
            {"ok":true,"deviceId":"33333333-3333-4333-8333-333333333333","status":"error","updateRequired":false,"throttled":false,"schedule":{"time":"16:45","timeZone":"America/New_York"}}
            """));
        CrmClient client = CreateClient(handler);
        HeartbeatPayload payload = Payload() with
        {
            LastErrorMessage = "machine-guid Authorization: Bearer DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD",
        };

        await client.SendHeartbeatAsync(payload);

        string body = Assert.Single(handler.Requests).Body;
        Assert.DoesNotContain("machine-guid", body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("DDDDDDDD", body);
        Assert.Contains("[REDACTED]", body);
    }

    private static HeartbeatPayload Payload() => new(
        "1.2.3",
        "4.5.6",
        "8.1.5.2",
        null,
        null,
        "addon_unavailable",
        "AddOn unavailable",
        2,
        2048,
        false);

    private static CrmClient CreateClient(
        RecordingHandler handler,
        int maxAttempts = 1,
        RecordingDelay delay = null)
    {
        return new CrmClient(
            new Uri("https://crm.example.test/"),
            handler,
            new FixedTokenStore(),
            new FixedMachineGuidSource(),
            new RetryPolicy(maxAttempts: maxAttempts),
            delay ?? new RecordingDelay());
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private sealed class RecordingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> respond;

        public RecordingHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) => this.respond = respond;

        public List<RecordedRequest> Requests { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            Requests.Add(new RecordedRequest(
                request.Headers.Authorization?.ToString(),
                request.Headers.TryGetValues("X-Machine-Id", out IEnumerable<string> machine)
                    ? string.Join(',', machine)
                    : null,
                await request.Content.ReadAsStringAsync(cancellationToken)));
            return respond(request);
        }
    }

    private sealed record RecordedRequest(string Authorization, string MachineId, string Body);

    private sealed class FixedTokenStore : IDeviceTokenStore
    {
        public Task SaveTokenAsync(string token, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult("DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD");
        public Task DeleteTokenAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class FixedMachineGuidSource : IMachineGuidSource
    {
        public string ReadMachineGuid() => "MACHINE-GUID";
    }

    private sealed class RecordingDelay : IRetryDelay
    {
        public List<TimeSpan> Delays { get; } = new();

        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
        {
            Delays.Add(delay);
            return Task.CompletedTask;
        }
    }
}
