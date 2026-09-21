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
using Vincere.AutoExport.Agent.Security;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* THE INVENTORY GOES TO ITS OWN ENDPOINT, NEVER ONTO THE HEARTBEAT.
 *
 * The production heartbeat refuses any key it does not know and its record
 * function refuses any error code outside its list. This agent ships weeks
 * before the CRM that reads the inventory, so the report has to be a request
 * the CRM of today can refuse harmlessly: 404 is an answer, not a fault. */
public sealed class CrmClientQuarantineReportTests
{
    private static readonly DateTimeOffset ReportedAt = new(2026, 9, 21, 16, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task TheReportCarriesTheInventoryWithTheDeviceHeadersTheHeartbeatUses()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true}"""));
        CrmClient client = CreateClient(handler);

        QuarantineReportOutcome outcome = await client.ReportQuarantineAsync(Report(
            Item("2026-09-18", "00000000-0000-0000-0000-000000000001", "snapshot_processing_failed", 1, ReportedAt.AddDays(-1)),
            Item("2026-09-17", "00000000-0000-0000-0000-000000000002", "snapshot_rejected", 0, null)));

        Assert.Equal(QuarantineReportOutcome.Accepted, outcome);
        RecordedRequest request = Assert.Single(handler.Requests);
        Assert.Equal("https://crm.example.test/api/ingest/quarantine", request.Uri.ToString());
        Assert.Equal("Bearer DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", request.Authorization);
        Assert.StartsWith("machine-guid|", request.MachineId);

        JObject body = ParseBody(request.Body);
        Assert.Equal(1, body.Value<int>("schemaVersion"));
        Assert.Equal("2026-09-21T16:00:00+00:00", body.Value<string>("reportedAt"));
        JArray items = (JArray)body["items"];
        Assert.Equal(2, items.Count);
        JObject first = (JObject)items[0];
        Assert.Equal("2026-09-18", first.Value<string>("tradingDate"));
        Assert.Equal("00000000-0000-0000-0000-000000000001", first.Value<string>("captureId"));
        Assert.Equal("snapshot_processing_failed", first.Value<string>("code"));
        Assert.Equal(1, first.Value<int>("attempts"));
        Assert.Equal("2026-09-20T16:00:00+00:00", first.Value<string>("lastAttemptAt"));
        Assert.Equal("2026-09-19T16:00:00+00:00", first.Value<string>("quarantinedAt"));
        Assert.Equal(JTokenType.Null, ((JObject)items[1])["lastAttemptAt"].Type);
        // Exactly these keys and nothing else: the CRM side validates the body
        // by name, and a stray key is how the heartbeat came to be refused.
        Assert.Equal(
            new[] { "attempts", "captureId", "code", "lastAttemptAt", "quarantinedAt", "tradingDate" },
            first.Properties().Select(property => property.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray());
        Assert.DoesNotContain("machine-guid", request.Body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("DDDDDDDD", request.Body);
    }

    [Fact]
    public async Task TheReportIsCappedNewestFirst()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true}"""));
        CrmClient client = CreateClient(handler);
        QuarantineReportItem[] items = Enumerable.Range(0, QuarantineReport.MaximumItems + 25)
            .Select(index => Item(
                new DateTime(2025, 1, 1).AddDays(index).ToString("yyyy-MM-dd"),
                Guid.NewGuid().ToString("D"),
                "snapshot_processing_failed",
                0,
                null))
            .ToArray();

        await client.ReportQuarantineAsync(Report(items));

        JArray sent = (JArray)ParseBody(Assert.Single(handler.Requests).Body)["items"];
        Assert.Equal(QuarantineReport.MaximumItems, sent.Count);
        Assert.Equal(items[items.Length - 1].TradingDate, sent[0].Value<string>("tradingDate"));
        Assert.Equal(items[25].TradingDate, sent[sent.Count - 1].Value<string>("tradingDate"));
    }

    [Fact]
    public async Task AnItemThatDoesNotFitTheShapeIsDroppedNotSent()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true}"""));
        CrmClient client = CreateClient(handler);

        await client.ReportQuarantineAsync(Report(
            Item("2026-09-18", "not-a-guid", "snapshot_processing_failed", 0, null),
            Item("18/09/2026", "00000000-0000-0000-0000-000000000003", "snapshot_processing_failed", 0, null),
            Item("2026-09-18", "00000000-0000-0000-0000-000000000004", "Bearer secret", 0, null),
            Item("2026-09-18", "00000000-0000-0000-0000-000000000005", "snapshot_rejected", 0, null)));

        JArray sent = (JArray)ParseBody(Assert.Single(handler.Requests).Body)["items"];
        Assert.Equal("00000000-0000-0000-0000-000000000005", Assert.Single(sent).Value<string>("captureId"));
    }

    [Theory]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.MethodNotAllowed)]
    public async Task ACrmWithoutTheEndpointIsAnAnswerNotAFailure(HttpStatusCode status)
    {
        // What today's CRM says: api/ingest/[action].js has no handler for
        // this action and answers 404 not_found. No retry, no exception.
        RecordingHandler handler = new(_ => Json(status, """{"error":"not_found"}"""));
        RecordingDelay delay = new();
        CrmClient client = CreateClient(handler, maxAttempts: 3, delay);

        QuarantineReportOutcome outcome = await client.ReportQuarantineAsync(Report());

        Assert.Equal(QuarantineReportOutcome.Unsupported, outcome);
        Assert.Single(handler.Requests);
        Assert.Empty(delay.Delays);
    }

    [Theory]
    [InlineData(HttpStatusCode.Unauthorized)]
    [InlineData(HttpStatusCode.Forbidden)]
    public async Task ARevokedCredentialRequiresRepairLikeEveryOtherEndpoint(HttpStatusCode status)
    {
        RecordingHandler handler = new(_ => Json(status, """{"error":"invalid_device_credential"}"""));
        CrmClient client = CreateClient(handler);

        CrmClientException error = await Assert.ThrowsAsync<CrmClientException>(
            () => client.ReportQuarantineAsync(Report()));

        Assert.Equal("device_credential_revoked", error.Code);
        Assert.Equal(CrmFailureDisposition.RePair, error.Disposition);
    }

    [Theory]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    public async Task ServerTroubleRetriesLikeTheUploaderAndThenAsksToBeTriedLater(HttpStatusCode status)
    {
        RecordingHandler handler = new(_ => Json(status, """{"error":"quarantine_unavailable"}"""));
        RecordingDelay delay = new();
        CrmClient client = CreateClient(handler, maxAttempts: 3, delay);

        CrmClientException error = await Assert.ThrowsAsync<CrmClientException>(
            () => client.ReportQuarantineAsync(Report()));

        Assert.Equal("quarantine_report_failed", error.Code);
        Assert.True(error.Retryable);
        Assert.Equal(CrmFailureDisposition.Retry, error.Disposition);
        Assert.Equal(3, handler.Requests.Count);
        Assert.Equal(2, delay.Delays.Count);
    }

    [Fact]
    public async Task ABadRequestIsFinalForThisInventory()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.BadRequest, """{"error":"invalid_quarantine_report"}"""));
        CrmClient client = CreateClient(handler);

        CrmClientException error = await Assert.ThrowsAsync<CrmClientException>(
            () => client.ReportQuarantineAsync(Report()));

        Assert.Equal("quarantine_report_failed", error.Code);
        Assert.False(error.Retryable);
        Assert.Equal(CrmFailureDisposition.Stop, error.Disposition);
        Assert.Single(handler.Requests);
    }

    private static QuarantineReport Report(params QuarantineReportItem[] items)
        => new(QuarantineReport.CurrentSchemaVersion, ReportedAt, items);

    // Dates are asserted as the text on the wire. Left to itself the parser
    // turns them into DateTime values and the offset the CRM will read is
    // exactly the thing this test is about.
    private static JObject ParseBody(string body)
    {
        using JsonTextReader reader = new(new StringReader(body)) { DateParseHandling = DateParseHandling.None };
        return JObject.Load(reader);
    }

    private static QuarantineReportItem Item(
        string tradingDate,
        string captureId,
        string code,
        int attempts,
        DateTimeOffset? lastAttemptAt)
        => new(tradingDate, captureId, code, attempts, ReportedAt.AddDays(-2), lastAttemptAt);

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
                request.RequestUri,
                request.Headers.Authorization?.ToString(),
                request.Headers.TryGetValues("X-Machine-Id", out IEnumerable<string> machine)
                    ? string.Join(',', machine)
                    : null,
                await request.Content.ReadAsStringAsync(cancellationToken)));
            return respond(request);
        }
    }

    private sealed record RecordedRequest(Uri Uri, string Authorization, string MachineId, string Body);

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
