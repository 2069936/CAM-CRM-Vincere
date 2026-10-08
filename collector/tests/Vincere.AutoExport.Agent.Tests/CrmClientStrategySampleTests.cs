using System;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* THE STRATEGY ROUTE, ASKED OVER A REAL CLIENT. The loop's tests use a fake CRM
 * and prove what the loop does with an answer; these prove how the answer is
 * arrived at, which is where "harmless against a CRM that has not merged the
 * route, or has not applied migration 57" actually lives. */
public sealed class CrmClientStrategySampleTests
{
    // The shared fixture from the wire contract, the same text the CRM route's
    // test embeds.
    private const string Fixture = """
        {
          "schemaVersion": 1,
          "sampledAt": "2026-10-06T10:10:02.5-04:00",
          "strategies": [
            { "accountName": "SIM-FIXTURE-1", "strategyId": "123456789", "strategyName": "0 - OGX-PF-2.4", "instrument": "MNQ 12-26", "realizedPnl": -412.5, "unrealizedPnl": 37.5, "restartedAt": null, "marketPosition": "long", "positionQuantity": 2, "tradesThisRun": 7 },
            { "accountName": "SIM-FIXTURE-1", "strategyId": "123456790", "strategyName": "1 - ALPHA-1.2", "instrument": "NQ 12-26", "realizedPnl": null, "unrealizedPnl": null, "restartedAt": "2026-10-06T09:50:01-04:00", "marketPosition": null, "positionQuantity": null, "tradesThisRun": null }
          ]
        }
        """;

    [Fact]
    public async Task The_reading_goes_to_its_own_route_as_the_fixture_with_the_device_headers()
    {
        RecordingHandler handler = new(_ => Json(
            HttpStatusCode.OK,
            """{"ok":true,"recorded":2,"throttled":false,"cycleStart":"2026-10-06T14:10:00.000Z","skipped":0}"""));

        StrategySampleReportResult result = await CreateClient(handler)
            .PostStrategySampleAsync(JsonConvert.DeserializeObject<StrategySampleV1>(Fixture));

        Assert.Equal(StrategySampleReportStatus.Accepted, result.Status);
        RecordedRequest request = Assert.Single(handler.Requests);
        Assert.Equal("https://crm.example.test/api/ingest/strategies", request.Uri.ToString());
        Assert.Equal("Bearer DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", request.Authorization);
        Assert.StartsWith("machine-guid|", request.MachineId);
        Assert.Null(request.ContentEncoding);
        Assert.True(
            JToken.DeepEquals(Parse(Fixture), Parse(request.Body)),
            "Posted: " + request.Body);
    }

    /* 404 AND 405 ARE "NOT YET", NOT A FAULT. 404 not_found is a CRM without the
     * route; 404 strategy_sample_not_deployed is a CRM with the route before
     * migration 57. One request, no retry, and the CRM's word kept for the log. */
    [Theory]
    [InlineData(HttpStatusCode.NotFound, "not_found")]
    [InlineData(HttpStatusCode.NotFound, "strategy_sample_not_deployed")]
    [InlineData(HttpStatusCode.MethodNotAllowed, "method_not_allowed")]
    public async Task A_crm_without_the_route_or_the_migration_is_unsupported(HttpStatusCode status, string error)
    {
        RecordingHandler handler = new(_ => Json(status, "{\"error\":\"" + error + "\"}"));
        RecordingDelay delay = new();

        StrategySampleReportResult result = await CreateClient(handler, delay, maxAttempts: 6)
            .PostStrategySampleAsync(Sample());

        Assert.Equal(StrategySampleReportStatus.Unsupported, result.Status);
        Assert.Equal(error, result.Detail);
        Assert.Single(handler.Requests);
        Assert.Empty(delay.Delays);
    }

    /* EVERY OTHER STATUS IS FAILED UNDER ITS OWN NUMBER, AND NEVER RETRIED. A
     * reading is worth nothing ten minutes later; the next cycle carries a fresh
     * one. */
    [Theory]
    [InlineData(HttpStatusCode.BadRequest, "strategy_sample_http_400")]
    [InlineData(HttpStatusCode.Unauthorized, "strategy_sample_http_401")]
    [InlineData(HttpStatusCode.RequestEntityTooLarge, "strategy_sample_http_413")]
    [InlineData(HttpStatusCode.TooManyRequests, "strategy_sample_http_429")]
    [InlineData(HttpStatusCode.InternalServerError, "strategy_sample_http_500")]
    [InlineData(HttpStatusCode.ServiceUnavailable, "strategy_sample_http_503")]
    public async Task Any_other_status_fails_once_under_its_number(HttpStatusCode status, string code)
    {
        RecordingHandler handler = new(_ => Json(status, """{"error":"invalid_strategy_sample"}"""));
        RecordingDelay delay = new();

        StrategySampleReportResult result = await CreateClient(handler, delay, maxAttempts: 6)
            .PostStrategySampleAsync(Sample());

        Assert.Equal(StrategySampleReportStatus.Failed, result.Status);
        Assert.Equal(code, result.Code);
        Assert.Equal("invalid_strategy_sample", result.Detail);
        Assert.Single(handler.Requests);
        Assert.Empty(delay.Delays);
    }

    [Fact]
    public async Task A_crm_that_cannot_be_reached_or_answers_too_late_is_failed_and_not_thrown()
    {
        RecordingHandler unreachable = new(_ => throw new HttpRequestException("no route to host"));
        RecordingHandler late = new(_ => throw new TaskCanceledException("timed out"));

        StrategySampleReportResult noRoute = await CreateClient(unreachable).PostStrategySampleAsync(Sample());
        StrategySampleReportResult timedOut = await CreateClient(late).PostStrategySampleAsync(Sample());

        Assert.Equal("strategy_sample_unreachable", noRoute.Code);
        Assert.Equal(StrategySampleReportStatus.Failed, timedOut.Status);
        Assert.Equal("strategy_sample_timeout", timedOut.Code);
    }

    [Fact]
    public async Task An_unpaired_machine_sends_nothing_and_answers_rather_than_throwing()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true}"""));
        CrmClient client = new(
            new Uri("https://crm.example.test/"),
            handler,
            new EmptyTokenStore(),
            new FixedMachineGuidSource(),
            new RetryPolicy(maxAttempts: 1),
            new RecordingDelay());

        StrategySampleReportResult result = await client.PostStrategySampleAsync(Sample());

        Assert.Equal(StrategySampleReportStatus.Failed, result.Status);
        Assert.Equal("device_not_paired", result.Code);
        Assert.Empty(handler.Requests);
    }

    private static StrategySampleV1 Sample() => JsonConvert.DeserializeObject<StrategySampleV1>(Fixture);

    private static JToken Parse(string json)
    {
        using JsonTextReader reader = new(new StringReader(json)) { DateParseHandling = DateParseHandling.None };
        return JToken.Load(reader);
    }

    private static CrmClient CreateClient(RecordingHandler handler, RecordingDelay delay = null, int maxAttempts = 1) => new(
        new Uri("https://crm.example.test/"),
        handler,
        new FixedTokenStore(),
        new FixedMachineGuidSource(),
        new RetryPolicy(maxAttempts: maxAttempts),
        delay ?? new RecordingDelay());

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
                request.Content.Headers.ContentEncoding.Count == 0
                    ? null
                    : string.Join(',', request.Content.Headers.ContentEncoding),
                await request.Content.ReadAsStringAsync(cancellationToken)));
            return respond(request);
        }
    }

    private sealed record RecordedRequest(Uri Uri, string Authorization, string MachineId, string ContentEncoding, string Body);

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
}
