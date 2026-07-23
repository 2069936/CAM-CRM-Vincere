using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Security.Authentication;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Security;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class CrmClientPairingTests
{
    [Theory]
    [InlineData("http://crm.example.test/")]
    [InlineData("https://user:password@crm.example.test/")]
    [InlineData("https://crm.example.test/?tenant=one")]
    public void BaseUriRejectsUnsafeOrAmbiguousValues(string uri)
    {
        Assert.Throws<ArgumentException>(() => new CrmClient(
            new Uri(uri),
            new RecordingHandler(_ => Json(HttpStatusCode.OK, "{}")),
            new RecordingTokenStore(),
            new FixedMachineGuidSource("machine-guid")));
    }

    [Fact]
    public async Task BaseUriWithoutTrailingSlashPreservesItsConfiguredPath()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """
            {"deviceToken":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","deviceId":"33333333-3333-4333-8333-333333333333","clientName":"Acme Trading","schedule":{"time":"16:45","timeZone":"America/New_York"}}
            """));
        CrmClient client = new(
            new Uri("https://crm.example.test/collector"),
            handler,
            new RecordingTokenStore(),
            new FixedMachineGuidSource("machine-guid"));

        await client.PairAsync("ABCDEFGHJK", "1.2.3", "4.5.6");

        Assert.Equal(
            "https://crm.example.test/collector/api/ingest/pair",
            Assert.Single(handler.Requests).Uri.ToString());
    }

    [Fact]
    public async Task PairSendsCanonicalRequestAndStoresTokenWithoutReturningIt()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.OK, """
            {"deviceToken":"AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","deviceId":"33333333-3333-4333-8333-333333333333","clientName":"Acme Trading","schedule":{"time":"16:45","timeZone":"America/New_York"}}
            """));
        RecordingTokenStore tokenStore = new();
        CrmClient client = CreateClient(handler, tokenStore);

        PairingResult result = await client.PairAsync("abcd-efgh-jk", "1.2.3", "4.5.6");

        Assert.Equal("Acme Trading", result.ClientName);
        Assert.Equal("33333333-3333-4333-8333-333333333333", result.DeviceId);
        Assert.Equal("16:45", result.ScheduleTime);
        Assert.Equal("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", tokenStore.Token);
        Assert.DoesNotContain("Token", string.Join(',', result.GetType().GetProperties().Select(property => property.Name)));
        RecordedRequest request = Assert.Single(handler.Requests);
        Assert.Equal("https://crm.example.test/api/ingest/pair", request.Uri.ToString());
        Assert.Null(request.Authorization);
        Assert.Contains("\"enrollmentCode\":\"ABCDEFGHJK\"", request.Body);
        Assert.Contains("\"machineId\":\"machine-guid\"", request.Body);
        Assert.Matches("\\\"pairingNonce\\\":\\\"[A-Za-z0-9_-]{43}\\\"", request.Body);
    }

    [Fact]
    public async Task InvalidOrExpiredPairingCodeIsPermanentAndSanitized()
    {
        RecordingHandler handler = new(_ => Json(HttpStatusCode.BadRequest, """
            {"error":"invalid_or_expired_code","detail":"secret server detail"}
            """));
        RecordingTokenStore tokenStore = new();
        CrmClient client = CreateClient(handler, tokenStore);

        CrmClientException error = await Assert.ThrowsAsync<CrmClientException>(
            () => client.PairAsync("ABCD-EFGH-JK", "1.2.3", "4.5.6"));

        Assert.Equal("invalid_or_expired_code", error.Code);
        Assert.False(error.Retryable);
        Assert.Null(tokenStore.Token);
        Assert.DoesNotContain("secret server detail", error.Message);
        Assert.DoesNotContain("ABCDEFGHJK", error.Message);
    }

    [Fact]
    public async Task LostResponseRetryReusesPairingNonceAndEventuallyStoresToken()
    {
        int attempt = 0;
        RecordingHandler handler = new(_ =>
        {
            attempt++;
            if (attempt == 1) throw new HttpRequestException("network interrupted");
            return Json(HttpStatusCode.OK, """
                {"deviceToken":"BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB","deviceId":"33333333-3333-4333-8333-333333333333","clientName":"Acme","schedule":{"time":"16:45","timeZone":"America/New_York"}}
                """);
        });
        RecordingTokenStore tokenStore = new();
        CrmClient client = CreateClient(handler, tokenStore, maxAttempts: 2);

        await client.PairAsync("ABCDEFGHJK", "1.2.3", "4.5.6");

        Assert.Equal(2, handler.Requests.Count);
        Assert.Equal(handler.Requests[0].Body, handler.Requests[1].Body);
        Assert.Equal("BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB", tokenStore.Token);
    }

    [Fact]
    public async Task TlsValidationFailureIsNotRetried()
    {
        RecordingHandler handler = new(_ => throw new HttpRequestException(
            "certificate detail",
            new AuthenticationException("untrusted certificate")));
        CrmClient client = CreateClient(handler, new RecordingTokenStore(), maxAttempts: 3);

        CrmClientException error = await Assert.ThrowsAsync<CrmClientException>(
            () => client.PairAsync("ABCDEFGHJK", "1.2.3", "4.5.6"));

        Assert.Equal("tls_failure", error.Code);
        Assert.False(error.Retryable);
        Assert.Single(handler.Requests);
        Assert.DoesNotContain("untrusted", error.Message, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("detail", error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public async Task RequestTimeoutReturnsStableRetryableCode()
    {
        CrmClient client = new(
            new Uri("https://crm.example.test/"),
            new BlockingHandler(),
            new RecordingTokenStore(),
            new FixedMachineGuidSource("machine-guid"),
            new RetryPolicy(maxAttempts: 1),
            new ImmediateRetryDelay(),
            requestTimeout: TimeSpan.FromMilliseconds(50));

        CrmClientException error = await Assert.ThrowsAsync<CrmClientException>(
            () => client.PairAsync("ABCDEFGHJK", "1.2.3", "4.5.6"));

        Assert.Equal("crm_timeout", error.Code);
        Assert.True(error.Retryable);
        Assert.Equal(CrmFailureDisposition.Retry, error.Disposition);
    }

    private static CrmClient CreateClient(
        RecordingHandler handler,
        RecordingTokenStore tokenStore,
        int maxAttempts = 1)
    {
        return new CrmClient(
            new Uri("https://crm.example.test/"),
            handler,
            tokenStore,
            new FixedMachineGuidSource("  MACHINE-GUID  "),
            new RetryPolicy(maxAttempts: maxAttempts),
            new ImmediateRetryDelay());
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body)
    {
        return new HttpResponseMessage(status)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
    }

    private sealed class RecordingHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> respond;

        public RecordingHandler(Func<HttpRequestMessage, HttpResponseMessage> respond)
        {
            this.respond = respond;
        }

        public List<RecordedRequest> Requests { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            string body = request.Content == null
                ? string.Empty
                : await request.Content.ReadAsStringAsync(cancellationToken);
            Requests.Add(new RecordedRequest(
                request.RequestUri,
                request.Headers.Authorization?.ToString(),
                body));
            return respond(request);
        }
    }

    private sealed class BlockingHandler : HttpMessageHandler
    {
        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            throw new InvalidOperationException("unreachable");
        }
    }

    private sealed record RecordedRequest(Uri Uri, string Authorization, string Body);

    private sealed class RecordingTokenStore : IDeviceTokenStore
    {
        public string Token { get; private set; }

        public Task SaveTokenAsync(string token, CancellationToken cancellationToken = default)
        {
            Token = token;
            return Task.CompletedTask;
        }

        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default)
        {
            return Task.FromResult(Token);
        }

        public Task DeleteTokenAsync(CancellationToken cancellationToken = default)
        {
            Token = null;
            return Task.CompletedTask;
        }
    }

    private sealed class FixedMachineGuidSource : IMachineGuidSource
    {
        private readonly string value;

        public FixedMachineGuidSource(string value) => this.value = value;

        public string ReadMachineGuid() => value;
    }

    private sealed class ImmediateRetryDelay : IRetryDelay
    {
        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
        {
            return Task.CompletedTask;
        }
    }
}
