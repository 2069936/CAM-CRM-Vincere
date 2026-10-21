using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Security;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* THE TRADING EXPORT CONTRACT THE CRM HALF IS BUILT AGAINST.
 *
 * Three routes authenticated like the heartbeat, with exactly the keys the CRM
 * accepts, an older CRM's 404 as "not here yet", and an upload that goes only to
 * the CRM's storage host and carries none of this machine's credentials. */
public sealed class CrmClientTradingExportTests : IDisposable
{
    private const string Token = "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD";
    private const string Sha = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    private const string Storage = "https://abcdefgh.supabase.co/storage/v1/object/upload/sign/exports/req-1.jsonl.gz?token=signed";
    private readonly string temp = Path.Combine(Path.GetTempPath(), "vincere-crm-export-" + Guid.NewGuid().ToString("n"));

    public CrmClientTradingExportTests() => Directory.CreateDirectory(temp);

    public void Dispose()
    {
        try { Directory.Delete(temp, recursive: true); } catch (IOException) { }
    }

    [Fact]
    public async Task The_poll_carries_exactly_the_agent_version_with_the_heartbeats_credentials()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true,"request":null}"""));

        ExportRequestPollResult result = await Client(handler).PollExportRequestAsync("1.4.0");

        Assert.Equal(ExportRequestPollStatus.Accepted, result.Status);
        Assert.Null(result.Request);
        Recorded request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Post, request.Method);
        Assert.Equal("https://crm.example.test/api/ingest/export-request", request.Uri.ToString());
        Assert.Equal("Bearer " + Token, request.Authorization);
        Assert.StartsWith("machine-guid|", request.MachineId);
        Assert.Equal("""{"agentVersion":"1.4.0"}""", request.Body);
    }

    [Fact]
    public async Task A_request_comes_back_as_the_crm_wrote_it()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """
            {"ok":true,"request":{"id":"6f1c2b9e-1111-4222-8333-944455556666","from":"2026-08-03","to":null,
             "datasets":["orders","trades"],"maxBytes":10485760}}
            """));

        ExportRequestPollResult result = await Client(handler).PollExportRequestAsync("1.4.0");

        TradingExportRequest request = result.Request;
        Assert.Equal("6f1c2b9e-1111-4222-8333-944455556666", request.Id);
        // Text, never turned into a DateTime and back into this machine's culture.
        Assert.Equal("2026-08-03", request.From);
        Assert.Null(request.To);
        Assert.Equal(new[] { "orders", "trades" }, request.Datasets);
        Assert.Equal(10485760, request.MaxBytes);
        Assert.True(request.DatasetsWellFormed);
    }

    [Fact]
    public async Task Fields_of_the_wrong_type_reach_the_validator_as_missing()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK,
            """{"ok":true,"request":{"id":7,"from":20260803,"datasets":["orders",3],"maxBytes":"big"}}"""));

        TradingExportRequest request = (await Client(handler).PollExportRequestAsync("1.4.0")).Request;

        Assert.Null(request.Id);
        Assert.Null(request.From);
        Assert.Null(request.MaxBytes);
        Assert.False(request.DatasetsWellFormed);
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.MethodNotAllowed)]
    public async Task An_older_crm_without_the_route_is_unsupported_not_a_failure(HttpStatusCode status)
    {
        RecordingHandler handler = new(_ => Json(status, """{"error":"not_found"}"""));

        ExportRequestPollResult result = await Client(handler).PollExportRequestAsync("1.4.0");

        Assert.Equal(ExportRequestPollStatus.Unsupported, result.Status);
        Assert.Single(handler.Requests);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized, "device_credential_revoked", CrmFailureDisposition.RePair)]
    [InlineData(HttpStatusCode.ServiceUnavailable, "export_request_http_503", CrmFailureDisposition.Retry)]
    [InlineData(HttpStatusCode.BadRequest, "export_request_http_400", CrmFailureDisposition.Stop)]
    public async Task Refusals_are_one_attempt_and_a_code(HttpStatusCode status, string code, CrmFailureDisposition disposition)
    {
        RecordingHandler handler = new(_ => Json(status, """{"error":"x"}"""));

        ExportRequestPollResult result = await Client(handler).PollExportRequestAsync("1.4.0");

        Assert.Equal(ExportRequestPollStatus.Failed, result.Status);
        Assert.Equal(code, result.Code);
        Assert.Equal(disposition, result.Disposition);
        Assert.Single(handler.Requests);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("""{"ok":false,"request":null}""")]
    [InlineData("""{"request":null}""")]
    [InlineData("""{"ok":true,"request":"req-1"}""")]
    public async Task A_reply_that_is_not_the_contract_is_a_failure(string body)
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, body));

        ExportRequestPollResult result = await Client(handler).PollExportRequestAsync("1.4.0");

        Assert.Equal("export_request_response_invalid", result.Code);
    }

    [Fact]
    public async Task A_dropped_connection_or_an_unpaired_machine_is_a_failure_not_an_exception()
    {
        RecordingHandler dropped = new(_ => throw new HttpRequestException("reset"));
        Assert.Equal("export_request_unreachable", (await Client(dropped).PollExportRequestAsync("1.4.0")).Code);

        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true,"request":null}"""));
        CrmClient unpaired = new(new Uri("https://crm.example.test/"), handler, new Tokens(null), new MachineGuid(), new RetryPolicy(maxAttempts: 1), new NoDelay());
        Assert.Equal("device_not_paired", (await unpaired.PollExportRequestAsync("1.4.0")).Code);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task The_upload_url_request_carries_exactly_four_keys()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK,
            "{\"ok\":true,\"uploadUrl\":\"" + Storage + "\",\"path\":\"exports/req-1.jsonl.gz\",\"expiresAt\":\"2026-10-20T17:00:00Z\"}"));

        ExportUploadUrlResult result = await Client(handler).RequestExportUploadUrlAsync(new ExportUploadUrlRequest("req-1", Sha, 1234));

        Assert.True(result.Ok);
        Assert.Equal(new Uri(Storage), result.Target.UploadUrl);
        Assert.Equal("exports/req-1.jsonl.gz", result.Target.Path);
        Assert.Equal("2026-10-20T17:00:00Z", result.Target.ExpiresAt);
        Recorded request = Assert.Single(handler.Requests);
        Assert.Equal("https://crm.example.test/api/ingest/export-upload-url", request.Uri.ToString());
        Assert.Equal("Bearer " + Token, request.Authorization);
        JObject body = JObject.Parse(request.Body);
        Assert.Equal(new[] { "byteSize", "contentType", "requestId", "sha256" }, Keys(body));
        Assert.Equal("req-1", (string)body["requestId"]);
        Assert.Equal(Sha, (string)body["sha256"]);
        Assert.Equal(1234, (long)body["byteSize"]);
        Assert.Equal("application/gzip", (string)body["contentType"]);
    }

    [Theory]
    [InlineData("http://abcdefgh.supabase.co/storage/x")]
    [InlineData("https://supabase.co/storage/x")]
    [InlineData("https://abcdefgh.supabase.co.attacker.example/storage/x")]
    [InlineData("https://attacker.example/abcdefgh.supabase.co/x")]
    [InlineData("https://abcdefgh.supabase.com/storage/x")]
    [InlineData("https://abcdefgh.supabase.co:8443/storage/x")]
    [InlineData("https://user:pass@abcdefgh.supabase.co/storage/x")]
    [InlineData("https://crm.example.test/api/upload")]
    [InlineData("ftp://abcdefgh.supabase.co/x")]
    [InlineData("/storage/v1/object")]
    public async Task An_upload_address_off_the_crms_storage_host_is_refused(string address)
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK,
            "{\"ok\":true,\"uploadUrl\":\"" + address + "\",\"path\":\"p\",\"expiresAt\":\"e\"}"));

        ExportUploadUrlResult result = await Client(handler).RequestExportUploadUrlAsync(new ExportUploadUrlRequest("req-1", Sha, 1234));

        Assert.False(result.Ok);
        Assert.Equal("url_not_allowed", result.Code);
        Assert.False(CrmClient.TryAllowedUploadUrl(address, out _));
    }

    [Fact]
    public async Task The_bytes_go_by_PUT_as_gzip_with_none_of_this_machines_credentials()
    {
        string file = Path.Combine(temp, "export.jsonl.gz");
        byte[] bytes = Encoding.UTF8.GetBytes("pretend this is gzip");
        File.WriteAllBytes(file, bytes);
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"Key":"exports/req-1.jsonl.gz"}"""));

        ExportUploadResult result = await Client(handler).UploadExportAsync(new Uri(Storage), file);

        Assert.True(result.Ok);
        Recorded request = Assert.Single(handler.Requests);
        Assert.Equal(HttpMethod.Put, request.Method);
        Assert.Equal(new Uri(Storage), request.Uri);
        Assert.Equal("application/gzip", request.ContentType);
        Assert.Equal(bytes.LongLength, request.ContentLength);
        Assert.Equal(bytes, request.BodyBytes);
        Assert.Null(request.Authorization);
        Assert.Null(request.MachineId);
    }

    [Fact]
    public async Task A_refused_or_unreachable_upload_is_a_code()
    {
        string file = Path.Combine(temp, "export.jsonl.gz");
        File.WriteAllBytes(file, new byte[] { 1, 2, 3 });

        Assert.Equal("upload_http_400", (await Client(new RecordingHandler(_ => Json(HttpStatusCode.BadRequest, "{}"))).UploadExportAsync(new Uri(Storage), file)).Code);
        Assert.Equal("upload_unreachable", (await Client(new RecordingHandler(_ => throw new HttpRequestException("reset"))).UploadExportAsync(new Uri(Storage), file)).Code);
        Assert.Equal("upload_file_missing", (await Client(new RecordingHandler(_ => Json(HttpStatusCode.OK, "{}"))).UploadExportAsync(new Uri(Storage), Path.Combine(temp, "missing.gz"))).Code);
    }

    [Fact]
    public async Task The_upload_checks_the_address_again_and_sends_nothing_elsewhere()
    {
        string file = Path.Combine(temp, "export.jsonl.gz");
        File.WriteAllBytes(file, new byte[] { 1, 2, 3 });
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, "{}"));

        ExportUploadResult result = await Client(handler).UploadExportAsync(new Uri("https://crm.example.test/api/ingest/export"), file);

        Assert.Equal("url_not_allowed", result.Code);
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task Ready_is_sent_as_exactly_the_eight_keys()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true}"""));

        ExportCompleteResult result = await Client(handler).CompleteExportAsync(new ExportCompleteRequest(
            "req-1", "ready", Sha, 1234, new ExportRowCounts(3, 5, 3, 2), "2026-08-03", null, "ignored_on_ready"));

        Assert.True(result.Ok);
        Recorded request = Assert.Single(handler.Requests);
        Assert.Equal("https://crm.example.test/api/ingest/export-complete", request.Uri.ToString());
        Assert.Equal("Bearer " + Token, request.Authorization);
        JObject body = JObject.Parse(request.Body);
        Assert.Equal(new[] { "byteSize", "errorCode", "from", "requestId", "rowCounts", "sha256", "status", "to" }, Keys(body));
        Assert.Equal("ready", (string)body["status"]);
        Assert.Equal(Sha, (string)body["sha256"]);
        Assert.Equal(1234, (long)body["byteSize"]);
        Assert.Equal(new[] { "executions", "orders", "strategies", "trades" }, Keys((JObject)body["rowCounts"]));
        Assert.Equal(5, (long)body["rowCounts"]["orders"]);
        Assert.Equal("2026-08-03", (string)body["from"]);
        Assert.Equal(JTokenType.Null, body["to"].Type);
        Assert.Equal(JTokenType.Null, body["errorCode"].Type);
    }

    [Theory]
    [InlineData("failed", "upload_failed", "upload_failed")]
    [InlineData("failed", "Not A Code", "export_failed")]
    [InlineData("failed", null, "export_failed")]
    [InlineData("ready", null, "export_failed")] // ready without a digest is not ready
    public async Task Failed_carries_a_code_of_the_agreed_shape_and_nulls(string status, string code, string expected)
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true}"""));

        await Client(handler).CompleteExportAsync(new ExportCompleteRequest("req-1", status, null, null, null, "2026-08-03", "bad-date", code));

        JObject body = JObject.Parse(Assert.Single(handler.Requests).Body);
        Assert.Equal(8, body.Count);
        Assert.Equal("failed", (string)body["status"]);
        Assert.Equal(expected, (string)body["errorCode"]);
        Assert.Equal(JTokenType.Null, body["sha256"].Type);
        Assert.Equal(JTokenType.Null, body["byteSize"].Type);
        Assert.Equal(JTokenType.Null, body["rowCounts"].Type);
        Assert.Equal("2026-08-03", (string)body["from"]);
        Assert.Equal(JTokenType.Null, body["to"].Type);
    }

    [Fact]
    public async Task A_completion_the_crm_did_not_take_is_a_code_for_the_next_poll()
    {
        Assert.Equal("export_complete_http_503", (await Client(new RecordingHandler(_ => Json(HttpStatusCode.ServiceUnavailable, "{}")))
            .CompleteExportAsync(Failed())).Code);
        Assert.Equal("export_complete_unreachable", (await Client(new RecordingHandler(_ => throw new HttpRequestException("reset")))
            .CompleteExportAsync(Failed())).Code);
        Assert.Equal("export_complete_response_invalid", (await Client(new RecordingHandler(_ => Json(HttpStatusCode.OK, """{"ok":false}""")))
            .CompleteExportAsync(Failed())).Code);
    }

    [Fact]
    public async Task A_double_that_does_not_implement_the_export_never_builds_one()
    {
        ICollectorCrmClient minimal = new MinimalCrm();

        Assert.Equal(ExportRequestPollStatus.Unsupported, (await minimal.PollExportRequestAsync("1.4.0")).Status);
    }

    private static ExportCompleteRequest Failed() => new("req-1", "failed", null, null, null, null, null, "upload_failed");

    private static string[] Keys(JObject body) => body.Properties().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal).ToArray();

    private static CrmClient Client(RecordingHandler handler)
        => new(new Uri("https://crm.example.test/"), handler, new Tokens(Token), new MachineGuid(), new RetryPolicy(maxAttempts: 3), new NoDelay());

    private static HttpResponseMessage Json(HttpStatusCode status, string body) => new(status)
    {
        Content = new StringContent(body, Encoding.UTF8, "application/json"),
    };

    private sealed class RecordingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> respond;

        public RecordingHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) => this.respond = respond;

        public List<Recorded> Requests { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
        {
            byte[] body = request.Content == null ? Array.Empty<byte>() : await request.Content.ReadAsByteArrayAsync(cancellationToken);
            Requests.Add(new Recorded(
                request.Method,
                request.RequestUri,
                request.Headers.Authorization?.ToString(),
                request.Headers.TryGetValues("X-Machine-Id", out IEnumerable<string> machine) ? string.Join(',', machine) : null,
                request.Content?.Headers.ContentType?.MediaType,
                request.Content?.Headers.ContentLength,
                body));
            return respond(request);
        }
    }

    private sealed record Recorded(HttpMethod Method, Uri Uri, string Authorization, string MachineId, string ContentType, long? ContentLength, byte[] BodyBytes)
    {
        public string Body => Encoding.UTF8.GetString(BodyBytes);
    }

    private sealed class Tokens : IDeviceTokenStore
    {
        private readonly string token;

        public Tokens(string token) => this.token = token;

        public Task SaveTokenAsync(string value, CancellationToken cancellationToken = default) => Task.CompletedTask;
        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult(token);
        public Task DeleteTokenAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class MachineGuid : IMachineGuidSource
    {
        public string ReadMachineGuid() => "MACHINE-GUID";
    }

    private sealed class NoDelay : IRetryDelay
    {
        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken) => Task.CompletedTask;
    }

    private sealed class MinimalCrm : ICollectorCrmClient
    {
        public Task<PairingResult> PairAsync(string code, string agentVersion, string addonVersion, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<UploadAcknowledgement> UploadAsync(Vincere.AutoExport.Agent.Queue.QueueItem item, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<HeartbeatResult> SendHeartbeatAsync(HeartbeatPayload payload, CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public Task<QuarantineReportOutcome> ReportQuarantineAsync(QuarantineReport report, CancellationToken cancellationToken = default) => throw new NotSupportedException();
    }
}
