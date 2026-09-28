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

/* Mailing this machine's own close on a day the database cannot answer.
 *
 * The route this talks to is the only one that authenticates on something
 * other than the device token, because the device token is verified against
 * `ingest_devices` and that table is exactly what is unreachable on the day
 * this is for. What these assert is the shape of that difference. */
public sealed class CrmClientReportEmailTests
{
    private const string Capture = """
        {"schemaVersion":1,"tradingDate":"2026-09-28","accounts":[],"strategies":[]}
        """;

    [Fact]
    public async Task SendsTheCaptureWithTheRelaySecretAndNoDeviceToken()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.Accepted, """{"ok":true}"""));
        CrmClient client = CreateClient(handler);

        bool sent = await client.SendReportEmailAsync(
            Capture, "Joel Onafowokan", """{"A1":{"accountType":"Funded"}}""",
            new DateTimeOffset(2026, 9, 28, 0, 0, 0, TimeSpan.Zero), "a-long-shared-secret");

        Assert.True(sent);
        RecordedRequest request = Assert.Single(handler.Requests);
        Assert.Equal("a-long-shared-secret", request.RelaySecret);
        /* NOT DEVICE AUTHENTICATED, and that is the whole point: verifying the
         * device token needs the table that is down on the day this runs. */
        Assert.Null(request.Authorization);
        Assert.Contains("api/ingest/report-email", request.Path);
        Assert.Contains("\"clientName\":\"Joel Onafowokan\"", request.Body);
        Assert.Contains("\"tradingDate\":\"2026-09-28\"", request.Body);
        Assert.Contains("\"rosterFetchedAt\":\"2026-09-28T00:00:00.0000000+00:00\"", request.Body);
    }

    [Fact]
    public async Task PostsToTheAbsoluteAddressWhenTheCrmGaveOne()
    {
        /* The send happens in a Supabase Edge Function, because the mail key
         * cannot live on the CRM's own deployment: nobody on this desk can add
         * an environment variable to it, and the repository is public so a
         * committed ciphertext would be published for good. */
        RecordingHandler handler = new(_ => Json(HttpStatusCode.Accepted, """{"ok":true}"""));
        CrmClient client = CreateClient(handler);

        await client.SendReportEmailAsync(
            Capture, "X", null, null, "secret",
            "https://abc.supabase.co/functions/v1/daily-report-email/agent");

        Assert.Equal(
            "https://abc.supabase.co/functions/v1/daily-report-email/agent",
            Assert.Single(handler.Requests).Path);
    }

    [Fact]
    public async Task SendsAnEmptyRosterRatherThanNullWhenTheMachineHasNone()
    {
        // The report then classifies nothing and totals nothing, which is the
        // honest answer. A null would throw at the far end instead.
        RecordingHandler handler = new(_ => Json(HttpStatusCode.Accepted, """{"ok":true}"""));
        CrmClient client = CreateClient(handler);

        await client.SendReportEmailAsync(Capture, "X", null, null, "secret");

        Assert.Contains("\"roster\":{}", Assert.Single(handler.Requests).Body);
        Assert.Contains("\"rosterFetchedAt\":null", Assert.Single(handler.Requests).Body);
    }

    [Fact]
    public async Task DoesNotCallAtAllWithoutASecret()
    {
        /* No secret means this deployment has no relay, or this machine has
         * not heard from the CRM since one was configured. Posting anyway
         * would spend a request a day earning a 401 forever. */
        RecordingHandler handler = new(_ => Json(HttpStatusCode.Accepted, """{"ok":true}"""));
        CrmClient client = CreateClient(handler);

        Assert.False(await client.SendReportEmailAsync(Capture, "X", null, null, null));
        Assert.False(await client.SendReportEmailAsync(Capture, "X", null, null, "   "));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task DoesNotCallWithoutACapture()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.Accepted, """{"ok":true}"""));
        CrmClient client = CreateClient(handler);

        Assert.False(await client.SendReportEmailAsync(null, "X", null, null, "secret"));
        Assert.Empty(handler.Requests);
    }

    [Fact]
    public async Task ReportsFailureWithoutThrowingAndWithoutRetrying()
    {
        /* The queue's own upload is what must not be lost. This is a copy of
         * something the machine still holds on disk, so a refusal is reported
         * and the day moves on rather than a service spending its evening
         * retrying a courtesy. */
        RecordingHandler handler = new(_ => Json(HttpStatusCode.Unauthorized, """{"error":"unauthorized"}"""));
        CrmClient client = CreateClient(handler, maxAttempts: 5);

        Assert.False(await client.SendReportEmailAsync(Capture, "X", null, null, "wrong-secret"));
        Assert.Single(handler.Requests);
    }

    [Fact]
    public async Task ARelayThatIsNotConfiguredIsNotAnError()
    {
        // The route answers 503 until somebody sets the mail variables. Every
        // machine would hit that for as long as it takes, and none of them
        // should treat it as a fault of their own.
        RecordingHandler handler = new(_ => Json(HttpStatusCode.ServiceUnavailable, """{"error":"mail_not_configured"}"""));
        CrmClient client = CreateClient(handler);

        Assert.False(await client.SendReportEmailAsync(Capture, "X", null, null, "secret"));
    }

    private static CrmClient CreateClient(RecordingHandler handler, int maxAttempts = 1)
    {
        return new CrmClient(
            new Uri("https://crm.example.test/"),
            handler,
            new FixedTokenStore(),
            new FixedMachineGuidSource(),
            new RetryPolicy(maxAttempts: maxAttempts),
            new NoDelay());
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
                request.Headers.TryGetValues("x-agent-mail-secret", out IEnumerable<string> secret)
                    ? string.Join(',', secret)
                    : null,
                request.RequestUri?.ToString(),
                await request.Content.ReadAsStringAsync(cancellationToken)));
            return respond(request);
        }
    }

    private sealed record RecordedRequest(string Authorization, string RelaySecret, string Path, string Body);

    private sealed class FixedTokenStore : IDeviceTokenStore
    {
        public Task SaveTokenAsync(string token, CancellationToken cancellationToken = default) => Task.CompletedTask;

        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default)
            => Task.FromResult("DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD");

        public Task DeleteTokenAsync(CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private sealed class FixedMachineGuidSource : IMachineGuidSource
    {
        public string ReadMachineGuid() => "MACHINE-GUID";
    }

    private sealed class NoDelay : IRetryDelay
    {
        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken) => Task.CompletedTask;
    }
}
