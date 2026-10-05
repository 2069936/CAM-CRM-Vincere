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
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* THE TRACKER'S OWN ROUTE, ASKED OVER A REAL CLIENT.
 *
 * The loop's tests use a fake CRM, which proves what the loop does with an answer
 * and nothing about how the answer is arrived at. Measured by mutation: with only
 * those tests, deleting the 404 handling from CrmClient left the whole suite green
 * - and "harmless against a CRM that has not merged the route yet" is the single
 * most important deployment property of this half. These tests are that property.
 *
 * NEVER THE HEARTBEAT. That endpoint answers 400 for any key it does not know, so
 * an agent that put accounts on it would silence every heartbeat on the fleet until
 * the CRM caught up - and the heartbeat is the only thing that says a machine is
 * alive, which is the very traffic light this exists to build. */
public sealed class CrmClientAccountSampleTests
{
    private static readonly DateTimeOffset SampledAt = new(2026, 10, 5, 10, 15, 0, TimeSpan.FromHours(-4));

    [Fact]
    public async Task The_sample_goes_to_its_own_route_with_the_device_headers_every_route_uses()
    {
        RecordingHandler handler = new(_ => Json(
            HttpStatusCode.OK,
            """{"ok":true,"recorded":1,"throttled":false,"sampleIntervalSeconds":900}"""));

        AccountSampleReportResult result = await CreateClient(handler).PostAccountSampleAsync(Sample());

        Assert.Equal(AccountSampleReportStatus.Accepted, result.Status);
        Assert.Equal(900, result.SampleIntervalSeconds);
        RecordedRequest request = Assert.Single(handler.Requests);
        Assert.Equal("https://crm.example.test/api/ingest/accounts", request.Uri.ToString());
        // Its OWN path. Asserted literally, because the one thing this must never
        // be is a key on the heartbeat.
        Assert.DoesNotContain("heartbeat", request.Uri.ToString(), StringComparison.Ordinal);
        Assert.Equal("Bearer DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD", request.Authorization);
        Assert.StartsWith("machine-guid|", request.MachineId);
        Assert.Null(request.ContentEncoding);
        Assert.DoesNotContain("machine-guid", request.Body, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("DDDDDDDD", request.Body, StringComparison.Ordinal);
    }

    /* EXACTLY THE KEYS THE ROUTE KNOWS, AT BOTH LEVELS, because that route refuses
     * a body carrying any key outside its set rather than ignoring it - on purpose,
     * so an agent that starts sending the whole snapshot learns immediately. A stray
     * key here is a 400 on every sample from every machine. */
    [Fact]
    public async Task The_body_carries_the_keys_the_route_accepts_and_no_others()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true}"""));

        await CreateClient(handler).PostAccountSampleAsync(Sample());

        JObject body = ParseBody(Assert.Single(handler.Requests).Body);
        Assert.Equal(
            new[] { "accounts", "sampledAt", "schemaVersion" },
            body.Properties().Select(p => p.Name).OrderBy(name => name, StringComparer.Ordinal));
        Assert.Equal(1, body.Value<int>("schemaVersion"));
        // The text on the wire, not a re-parsed DateTime: the route matches this
        // against an ISO pattern that requires an offset, and the offset is exactly
        // what a round trip through DateTime would lose.
        Assert.Equal("2026-10-05T10:15:00-04:00", body.Value<string>("sampledAt"));

        JObject account = (JObject)((JArray)body["accounts"])[0];
        Assert.Equal(
            new[]
            {
                "accountName", "connected", "connectionName", "enabledStrategyCount",
                "realizedPnl", "status", "strategyCount", "totalPnl", "unrealizedPnl",
            },
            account.Properties().Select(p => p.Name).OrderBy(name => name, StringComparer.Ordinal));
        Assert.Equal("APEX-1111", account.Value<string>("accountName"));
        Assert.True(account.Value<bool>("connected"));
        Assert.Equal(2, account.Value<int>("strategyCount"));
        Assert.Equal(1, account.Value<int>("enabledStrategyCount"));
    }

    /* AND NONE OF THE CLOSE'S PAYLOAD. The desk asked for the least data, the close
     * already stores every one of these, and the route refuses a body carrying them.
     * Named one at a time so that adding a field to the contract fails here. */
    [Theory]
    [InlineData("netLiquidation")]
    [InlineData("cashValue")]
    [InlineData("weeklyPnl")]
    [InlineData("trailingMaxDrawdown")]
    [InlineData("buyingPower")]
    [InlineData("initialMargin")]
    [InlineData("maintenanceMargin")]
    [InlineData("excessIntradayMargin")]
    [InlineData("grossRealizedPnl")]
    [InlineData("accountValues")]
    [InlineData("displayName")]
    [InlineData("currency")]
    public async Task Nothing_the_close_already_stores_rides_along(string forbidden)
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true}"""));

        await CreateClient(handler).PostAccountSampleAsync(Sample());

        Assert.DoesNotContain(
            forbidden,
            Assert.Single(handler.Requests).Body,
            StringComparison.OrdinalIgnoreCase);
    }

    /* NOT DEPLOYED YET IS AN ANSWER, NOT A FAULT, and this is what makes the two
     * halves mergeable in either order. Today's CRM has no handler for this action
     * and answers 404; one that mounts it for GET only would answer 405. Neither is
     * retried, neither throws, and neither marks the device. */
    [Theory]
    [InlineData(HttpStatusCode.NotFound)]
    [InlineData(HttpStatusCode.MethodNotAllowed)]
    public async Task A_crm_without_the_route_is_unsupported_rather_than_a_failure(HttpStatusCode status)
    {
        RecordingHandler handler = new(_ => Json(status, """{"error":"not_found"}"""));
        RecordingDelay delay = new();

        AccountSampleReportResult result = await CreateClient(handler, delay).PostAccountSampleAsync(Sample());

        Assert.Equal(AccountSampleReportStatus.Unsupported, result.Status);
        Assert.Single(handler.Requests);
        Assert.Empty(delay.Delays);
    }

    /* ONE ATTEMPT, EVER, WHATEVER THE ANSWER - and this is the only method on this
     * client without a retry loop.
     *
     * Every other route walks the retry policy: six attempts, backoff capped at two
     * minutes, on top of a thirty-second request timeout. Against a CRM answering
     * 5xx that is up to about thirteen minutes inside one call, and the supervisor
     * then waits the whole interval ON TOP, because it measures the interval from
     * when the body returns. Samples would land twenty-odd minutes apart, every one
     * stale on arrival, and a trading machine would spend its evening delivering
     * readings nobody can use. A stale sample is worse than a missing one, because
     * the screen cannot tell that it is stale. */
    [Theory]
    [InlineData(HttpStatusCode.InternalServerError)]
    [InlineData(HttpStatusCode.ServiceUnavailable)]
    [InlineData(HttpStatusCode.TooManyRequests)]
    [InlineData(HttpStatusCode.RequestTimeout)]
    [InlineData(HttpStatusCode.BadRequest)]
    [InlineData(HttpStatusCode.Unauthorized)]
    public async Task A_refusal_is_never_retried_however_retryable_it_looks(HttpStatusCode status)
    {
        RecordingHandler handler = new(_ => Json(status, """{"error":"account_sample_unavailable"}"""));
        RecordingDelay delay = new();

        // maxAttempts 6 is the production policy. The point is that it is not
        // consulted at all, so the number cannot matter.
        AccountSampleReportResult result = await CreateClient(handler, delay, maxAttempts: 6)
            .PostAccountSampleAsync(Sample());

        Assert.Equal(AccountSampleReportStatus.Failed, result.Status);
        Assert.Equal("account_sample_unavailable", result.Code);
        Assert.Single(handler.Requests);
        Assert.Empty(delay.Delays);
    }

    /* A REFUSAL NEVER THROWS, which is what keeps the caller from needing a catch
     * block it could get wrong. Including the 401 that every other route turns into
     * a re-pair: a tracker has no business unpairing a machine, and a sample is not
     * evidence worth deleting a device token over. */
    [Fact]
    public async Task An_unpaired_machine_answers_rather_than_throwing()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """{"ok":true}"""));
        CrmClient client = new(
            new Uri("https://crm.example.test/"),
            handler,
            new EmptyTokenStore(),
            new FixedMachineGuidSource(),
            new RetryPolicy(maxAttempts: 1),
            new RecordingDelay());

        AccountSampleReportResult result = await client.PostAccountSampleAsync(Sample());

        Assert.Equal(AccountSampleReportStatus.Failed, result.Status);
        Assert.Equal("device_not_paired", result.Code);
        // Nothing was sent, so an unpaired machine costs the CRM nothing either.
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task A_crm_that_cannot_be_reached_answers_rather_than_throwing()
    {
        RecordingHandler handler = new(_ => throw new HttpRequestException("no route to host"));

        AccountSampleReportResult result = await CreateClient(handler).PostAccountSampleAsync(Sample());

        Assert.Equal(AccountSampleReportStatus.Failed, result.Status);
        Assert.Equal("account_sample_unreachable", result.Code);
    }

    /* AN ACCEPTED SAMPLE WITH AN UNREADABLE REPLY IS STILL ACCEPTED, and the cadence
     * does not move. The reading was almost certainly stored; standing the tracker
     * down over a field we could not parse would be the wrong way round. */
    [Theory]
    [InlineData("not json at all")]
    [InlineData("""{"ok":true}""")]
    [InlineData("""{"ok":true,"sampleIntervalSeconds":null}""")]
    public async Task An_accepted_sample_with_no_usable_interval_leaves_the_cadence_alone(string body)
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, body));

        AccountSampleReportResult result = await CreateClient(handler).PostAccountSampleAsync(Sample());

        Assert.Equal(AccountSampleReportStatus.Accepted, result.Status);
        Assert.Null(result.SampleIntervalSeconds);
    }

    /* NEWTONSOFT COERCES A QUOTED NUMBER, AND THAT IS LEFT ALONE DELIBERATELY.
     *
     * Measured, not assumed: this test first asserted null for a quoted "600" and
     * failed, because the deserializer converts it. Tightening the type would be
     * strictness for its own sake, because it is not the type that protects this
     * machine - it is the range check the loop applies before the value can change
     * anything, which no reply of any shape can get past. Asserted so the behaviour
     * is on the record rather than a surprise to the next reader. */
    [Fact]
    public async Task A_quoted_interval_is_read_as_the_number_it_is()
    {
        RecordingHandler handler = new(_ => Json(
            HttpStatusCode.OK,
            """{"ok":true,"sampleIntervalSeconds":"600"}"""));

        AccountSampleReportResult result = await CreateClient(handler).PostAccountSampleAsync(Sample());

        Assert.Equal(600, result.SampleIntervalSeconds);
    }

    // Unknown keys on the reply are ignored, so the CRM can add one without every
    // deployed agent having to understand it first.
    [Fact]
    public async Task A_reply_carrying_fields_this_agent_does_not_know_is_still_read()
    {
        RecordingHandler handler = new(_ => Json(
            HttpStatusCode.OK,
            """{"ok":true,"recorded":3,"removed":1,"throttled":true,"sampleIntervalSeconds":1200,"somethingNew":"x"}"""));

        AccountSampleReportResult result = await CreateClient(handler).PostAccountSampleAsync(Sample());

        Assert.Equal(AccountSampleReportStatus.Accepted, result.Status);
        Assert.Equal(1200, result.SampleIntervalSeconds);
    }

    private static AccountSampleV1 Sample()
    {
        return new AccountSampleV1
        {
            SchemaVersion = 1,
            SampledAt = SampledAt,
            Accounts = new List<AccountSampleRowV1>
            {
                new()
                {
                    AccountName = "APEX-1111",
                    ConnectionName = "Rithmic",
                    Connected = true,
                    Status = "Connected",
                    RealizedPnl = 125.50m,
                    UnrealizedPnl = -12.25m,
                    TotalPnl = 113.25m,
                    StrategyCount = 2,
                    EnabledStrategyCount = 1,
                },
            },
        };
    }

    private static JObject ParseBody(string body)
    {
        using JsonTextReader reader = new(new StringReader(body)) { DateParseHandling = DateParseHandling.None };
        return JObject.Load(reader);
    }

    private static CrmClient CreateClient(
        RecordingHandler handler,
        RecordingDelay delay = null,
        int maxAttempts = 1)
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
                request.Content.Headers.ContentEncoding.Count == 0
                    ? null
                    : string.Join(',', request.Content.Headers.ContentEncoding),
                await request.Content.ReadAsStringAsync(cancellationToken)));
            return respond(request);
        }
    }

    private sealed record RecordedRequest(
        Uri Uri,
        string Authorization,
        string MachineId,
        string ContentEncoding,
        string Body);

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
