using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Security;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* POST api/ingest/agent-update: THE CONTRACT THE CRM HALF WAS BUILT AGAINST.
 *
 * Exactly four keys, authenticated like the heartbeat, and an older CRM's 404 is
 * "no updates here", quietly. */
public sealed class CrmClientAgentUpdateTests
{
    [Fact]
    public async Task The_poll_carries_exactly_the_four_keys_with_the_heartbeats_credentials()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true,"update":null}"""));
        CrmClient client = CreateClient(handler);

        AgentUpdatePollResult result = await client.PollAgentUpdateAsync(
            new AgentUpdatePollRequest("1.3.0", "failed", "package_hash_mismatch", "1.3.1"));

        Assert.Equal(AgentUpdatePollStatus.Accepted, result.Status);
        Assert.Null(result.Update);
        RecordedRequest request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("https://crm.example.test/api/ingest/agent-update", request.Uri.ToString());
        Assert.Equal("Bearer DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", request.Authorization);
        Assert.StartsWith("machine-guid|", request.MachineId);

        JObject body = JObject.Parse(request.Body);
        Assert.Equal(
            new[] { "agentVersion", "errorCode", "state", "targetVersion" },
            body.Properties().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray());
        Assert.Equal("1.3.0", body.Value<string>("agentVersion"));
        Assert.Equal("failed", body.Value<string>("state"));
        Assert.Equal("package_hash_mismatch", body.Value<string>("errorCode"));
        Assert.Equal("1.3.1", body.Value<string>("targetVersion"));
    }

    [Fact]
    public async Task Nothing_in_progress_is_sent_as_three_explicit_nulls()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true,"update":null}"""));

        await CreateClient(handler).PollAgentUpdateAsync(new AgentUpdatePollRequest("1.3.0", null, null, null));

        JObject body = JObject.Parse(Assert.Single(handler.Requests).Body);
        Assert.Equal(4, body.Count);
        Assert.Equal(JTokenType.Null, body["state"].Type);
        Assert.Equal(JTokenType.Null, body["errorCode"].Type);
        Assert.Equal(JTokenType.Null, body["targetVersion"].Type);
    }

    [Theory]
    [InlineData("staged", "disk_space", null)]          // a code goes only with "failed"
    [InlineData("failed", null, "update_failed")]        // and "failed" always has one
    [InlineData("failed", "Not A Code", "update_failed")]
    [InlineData("failed", "C:\\Users\\x", "update_failed")]
    public async Task The_error_code_is_sent_only_with_failed_and_only_as_a_code(
        string state,
        string code,
        string expected)
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true,"update":null}"""));

        await CreateClient(handler).PollAgentUpdateAsync(new AgentUpdatePollRequest("1.3.0", state, code, "1.3.1"));

        JObject body = JObject.Parse(Assert.Single(handler.Requests).Body);
        Assert.Equal(expected, body.Value<string>("errorCode"));
    }

    [Fact]
    public async Task A_state_outside_the_four_is_sent_as_null_with_no_target()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true,"update":null}"""));

        await CreateClient(handler).PollAgentUpdateAsync(new AgentUpdatePollRequest("1.3.0", "exploded", "x", "1.3.1"));

        JObject body = JObject.Parse(Assert.Single(handler.Requests).Body);
        Assert.Equal(JTokenType.Null, body["state"].Type);
        Assert.Equal(JTokenType.Null, body["targetVersion"].Type);
    }

    [Fact]
    public async Task A_directive_is_returned_as_the_crm_wrote_it()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """
            {"ok":true,"update":{
              "version":"1.3.1",
              "manifestUrl":"https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.3.1/release-manifest.json",
              "manifestSha256":"43dacd04aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa282c",
              "requestedAt":"2026-10-19T14:00:00.000Z"}}
            """));

        AgentUpdatePollResult result = await CreateClient(handler)
            .PollAgentUpdateAsync(new AgentUpdatePollRequest("1.3.0", null, null, null));

        Assert.Equal(AgentUpdatePollStatus.Accepted, result.Status);
        Assert.Equal("1.3.1", result.Update.Version);
        Assert.Equal(
            "https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.3.1/release-manifest.json",
            result.Update.ManifestUrl);
        Assert.Equal("43dacd04aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa282c", result.Update.ManifestSha256);
        // Not turned into a DateTime and back into this machine's culture: the
        // budget is keyed on this exact text.
        Assert.Equal("2026-10-19T14:00:00.000Z", result.Update.RequestedAt);
    }

    [Fact]
    public async Task A_field_of_the_wrong_type_is_passed_on_as_missing_for_the_validator_to_refuse()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK,
            """{"ok":true,"update":{"version":131,"manifestUrl":"x","manifestSha256":"y","requestedAt":"z"}}"""));

        AgentUpdatePollResult result = await CreateClient(handler)
            .PollAgentUpdateAsync(new AgentUpdatePollRequest("1.3.0", null, null, null));

        Assert.Null(result.Update.Version);
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.MethodNotAllowed)]
    public async Task An_older_crm_without_the_route_is_unsupported_not_a_failure(HttpStatusCode status)
    {
        RecordingHandler handler = new(_ => Json(status, """{"error":"not_found"}"""));
        RecordingDelay delay = new();

        AgentUpdatePollResult result = await CreateClient(handler, delay)
            .PollAgentUpdateAsync(new AgentUpdatePollRequest("1.3.0", null, null, null));

        Assert.Equal(AgentUpdatePollStatus.Unsupported, result.Status);
        Assert.Null(result.Update);
        Assert.Single(handler.Requests);
        Assert.Empty(delay.Delays);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    public async Task A_revoked_credential_is_reported_not_thrown(HttpStatusCode status)
    {
        RecordingHandler handler = new(_ => Json(status, """{"error":"invalid_device_credential"}"""));

        AgentUpdatePollResult result = await CreateClient(handler)
            .PollAgentUpdateAsync(new AgentUpdatePollRequest("1.3.0", null, null, null));

        Assert.Equal(AgentUpdatePollStatus.Failed, result.Status);
        Assert.Equal("device_credential_revoked", result.Code);
        Assert.Equal(CrmFailureDisposition.RePair, result.Disposition);
    }

    [Fact]
    public async Task Server_trouble_is_one_attempt_and_a_failure_for_the_next_poll()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.ServiceUnavailable, """{"error":"unavailable"}"""));
        RecordingDelay delay = new();

        AgentUpdatePollResult result = await CreateClient(handler, delay)
            .PollAgentUpdateAsync(new AgentUpdatePollRequest("1.3.0", null, null, null));

        Assert.Equal(AgentUpdatePollStatus.Failed, result.Status);
        Assert.Equal("agent_update_http_503", result.Code);
        Assert.Equal(CrmFailureDisposition.Retry, result.Disposition);
        Assert.Single(handler.Requests);
        Assert.Empty(delay.Delays);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("""{"ok":false,"update":null}""")]
    [InlineData("""{"update":null}""")]
    [InlineData("""{"ok":true,"update":"1.3.1"}""")]
    public async Task A_reply_that_is_not_the_contract_is_a_failure(string body)
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, body));

        AgentUpdatePollResult result = await CreateClient(handler)
            .PollAgentUpdateAsync(new AgentUpdatePollRequest("1.3.0", null, null, null));

        Assert.Equal(AgentUpdatePollStatus.Failed, result.Status);
        Assert.Equal("agent_update_response_invalid", result.Code);
    }

    [Fact]
    public async Task A_dropped_connection_is_a_failure_not_an_exception()
    {
        RecordingHandler handler = new(_ => throw new HttpRequestException("reset"));

        AgentUpdatePollResult result = await CreateClient(handler)
            .PollAgentUpdateAsync(new AgentUpdatePollRequest("1.3.0", null, null, null));

        Assert.Equal(AgentUpdatePollStatus.Failed, result.Status);
        Assert.Equal("agent_update_unreachable", result.Code);
    }

    [Fact]
    public async Task An_unpaired_machine_is_a_failure_not_an_exception()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true,"update":null}"""));
        CrmClient client = new(
            new Uri("https://crm.example.test/"),
            handler,
            new EmptyTokenStore(),
            new FixedMachineGuidSource(),
            new RetryPolicy(maxAttempts: 1),
            new RecordingDelay());

        AgentUpdatePollResult result = await client.PollAgentUpdateAsync(new AgentUpdatePollRequest("1.3.0", null, null, null));

        Assert.Equal("device_not_paired", result.Code);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task A_double_that_does_not_implement_the_poll_never_asks_for_an_update()
    {
        ICollectorCrmClient minimal = new MinimalCrm();

        AgentUpdatePollResult result = await minimal.PollAgentUpdateAsync(new AgentUpdatePollRequest("1.3.0", null, null, null));

        Assert.Equal(AgentUpdatePollStatus.Unsupported, result.Status);
    }

    private static CrmClient CreateClient(RecordingHandler handler, RecordingDelay delay = null)
    {
        return new CrmClient(
            new Uri("https://crm.example.test/"),
            handler,
            new FixedTokenStore(),
            new FixedMachineGuidSource(),
            new RetryPolicy(maxAttempts: 3),
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
                request.Method,
                request.RequestUri,
                request.Headers.Authorization?.ToString(),
                request.Headers.TryGetValues("X-Machine-Id", out IEnumerable<string> machine)
                    ? string.Join(',', machine)
                    : null,
                await request.Content.ReadAsStringAsync(cancellationToken)));
            return respond(request);
        }
    }

    private sealed record RecordedRequest(HttpMethod Method, Uri Uri, string Authorization, string MachineId, string Body);

    private sealed class FixedTokenStore : IDeviceTokenStore
    {
        public Task SaveTokenAsync(string token, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) =>
            Task.FromResult("DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD");
        public Task DeleteTokenAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class EmptyTokenStore : IDeviceTokenStore
    {
        public Task SaveTokenAsync(string token, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult<string>(null);
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

    private sealed class MinimalCrm : ICollectorCrmClient
    {
        public Task<PairingResult> PairAsync(string code, string agentVersion, string addonVersion, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<UploadAcknowledgement> UploadAsync(QueueItem item, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<HeartbeatResult> SendHeartbeatAsync(HeartbeatPayload payload, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QuarantineReportOutcome> ReportQuarantineAsync(QuarantineReport report, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }
}
