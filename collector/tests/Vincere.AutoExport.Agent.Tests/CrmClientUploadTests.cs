using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Security;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class CrmClientUploadTests : IDisposable
{
    private readonly string directory = Path.Combine(
        Path.GetTempPath(), "vincere-crm-upload-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task UploadSendsAuthenticatedGzipAndReturnsDurableAcknowledgementData()
    {
        SequenceHandler handler = new(_ => Json(HttpStatusCode.Created, """
            {"ok":true,"duplicate":false,"batchId":"55555555-5555-4555-8555-555555555555","dailyImportId":"66666666-6666-4666-8666-666666666666","status":"processed"}
            """));
        CrmClient client = CreateClient(handler);
        QueueItem item = await QueueItemAsync();

        UploadAcknowledgement acknowledgement = await client.UploadAsync(item);

        Assert.Equal("55555555-5555-4555-8555-555555555555", acknowledgement.BatchId);
        Assert.Equal(item.ContentSha256, acknowledgement.ContentSha256);
        Assert.False(acknowledgement.Duplicate);
        RecordedRequest request = Assert.Single(handler.Requests);
        Assert.Equal("https://crm.example.test/api/ingest/daily", request.Uri.ToString());
        Assert.Equal("Bearer CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC", request.Authorization);
        Assert.Equal("machine-guid", request.MachineId);
        Assert.Equal("gzip", request.ContentEncoding);
        Assert.Equal(await File.ReadAllTextAsync(item.PayloadPath), Gunzip(request.Body));
    }

    [Fact]
    public async Task BusyCaptureHonorsRetryAfterThenAcceptsDuplicateAcknowledgement()
    {
        int attempt = 0;
        SequenceHandler handler = new(_ =>
        {
            attempt++;
            if (attempt == 1)
            {
                HttpResponseMessage busy = Json(HttpStatusCode.Conflict, """
                    {"error":"capture_processing","batchId":"55555555-5555-4555-8555-555555555555","status":"processing"}
                    """);
                busy.Headers.RetryAfter = new System.Net.Http.Headers.RetryConditionHeaderValue(TimeSpan.FromSeconds(12));
                return busy;
            }
            return Json(HttpStatusCode.OK, """
                {"ok":true,"duplicate":true,"batchId":"55555555-5555-4555-8555-555555555555","dailyImportId":"66666666-6666-4666-8666-666666666666","status":"processed"}
                """);
        });
        RecordingDelay delay = new();
        CrmClient client = CreateClient(handler, delay, maxAttempts: 2);

        UploadAcknowledgement acknowledgement = await client.UploadAsync(await QueueItemAsync());

        Assert.True(acknowledgement.Duplicate);
        Assert.Equal(new[] { TimeSpan.FromSeconds(12) }, delay.Delays);
        Assert.Equal(2, handler.Requests.Count);
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest, "invalid_snapshot_envelope", "snapshot_rejected", CrmFailureDisposition.Quarantine)]
    [InlineData(HttpStatusCode.Unauthorized, "invalid_device_credential", "device_credential_revoked", CrmFailureDisposition.RePair)]
    [InlineData(HttpStatusCode.Forbidden, "forbidden", "device_credential_revoked", CrmFailureDisposition.RePair)]
    [InlineData(HttpStatusCode.RequestEntityTooLarge, "compressed_payload_too_large", "payload_too_large", CrmFailureDisposition.Quarantine)]
    [InlineData(HttpStatusCode.UnprocessableEntity, "unsupported_schema_version", "unsupported_schema_version", CrmFailureDisposition.Quarantine)]
    public async Task PermanentUploadErrorsHaveActionableDisposition(
        HttpStatusCode status,
        string serverCode,
        string expectedCode,
        CrmFailureDisposition expectedDisposition)
    {
        SequenceHandler handler = new(_ => Json(status, $"{{\"error\":\"{serverCode}\"}}"));
        CrmClient client = CreateClient(handler);
        QueueItem item = await QueueItemAsync();

        CrmClientException error = await Assert.ThrowsAsync<CrmClientException>(
            () => client.UploadAsync(item));

        Assert.Equal(expectedCode, error.Code);
        Assert.Equal(expectedDisposition, error.Disposition);
        Assert.False(error.Retryable);
    }

    [Fact]
    public async Task ServerFailuresRetryWithBoundedBackoffAndKeepPayloadAvailable()
    {
        SequenceHandler handler = new(_ => Json(HttpStatusCode.ServiceUnavailable, """
            {"error":"snapshot_ingest_failed"}
            """));
        RecordingDelay delay = new();
        CrmClient client = CreateClient(handler, delay, maxAttempts: 3);
        QueueItem item = await QueueItemAsync();

        CrmClientException error = await Assert.ThrowsAsync<CrmClientException>(
            () => client.UploadAsync(item));

        Assert.Equal("upload_failed", error.Code);
        Assert.True(error.Retryable);
        Assert.Equal(CrmFailureDisposition.Retry, error.Disposition);
        Assert.Equal(3, handler.Requests.Count);
        Assert.Equal(2, delay.Delays.Count);
        Assert.True(File.Exists(item.PayloadPath));
    }

    [Fact]
    public async Task RedirectIsNotFollowedAndAuthorizationNeverLeavesConfiguredOrigin()
    {
        SequenceHandler handler = new(_ =>
        {
            HttpResponseMessage redirect = Json(HttpStatusCode.Redirect, "{}");
            redirect.Headers.Location = new Uri("https://evil.example.test/steal");
            return redirect;
        });
        CrmClient client = CreateClient(handler);
        QueueItem item = await QueueItemAsync();

        CrmClientException error = await Assert.ThrowsAsync<CrmClientException>(
            () => client.UploadAsync(item));

        Assert.Equal("unexpected_redirect", error.Code);
        Assert.Single(handler.Requests);
        Assert.All(handler.Requests, request => Assert.Equal("crm.example.test", request.Uri.Host));
    }

    [Theory]
    [InlineData(32, 32 * 1024)]
    [InlineData(32 * 1024, 8)]
    public async Task LocalPayloadLimitsQuarantineBeforeSending(
        int maxUncompressedUploadBytes,
        int maxCompressedUploadBytes)
    {
        SequenceHandler handler = new(_ => throw new InvalidOperationException("Request must not be sent."));
        CrmClient client = CreateClient(
            handler,
            maxUncompressedUploadBytes: maxUncompressedUploadBytes,
            maxCompressedUploadBytes: maxCompressedUploadBytes);
        QueueItem item = await QueueItemAsync();

        CrmClientException error = await Assert.ThrowsAsync<CrmClientException>(
            () => client.UploadAsync(item));

        Assert.Equal("payload_too_large", error.Code);
        Assert.Equal(CrmFailureDisposition.Quarantine, error.Disposition);
        Assert.Empty(handler.Requests);
    }

    public void Dispose()
    {
        if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
    }

    private CrmClient CreateClient(
        SequenceHandler handler,
        RecordingDelay delay = null,
        int maxAttempts = 1,
        int maxUncompressedUploadBytes = 128 * 1024 * 1024,
        int maxCompressedUploadBytes = 32 * 1024 * 1024)
    {
        return new CrmClient(
            new Uri("https://crm.example.test/"),
            handler,
            new FixedTokenStore("CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"),
            new FixedMachineGuidSource("MACHINE-GUID"),
            new RetryPolicy(maxAttempts: maxAttempts),
            delay ?? new RecordingDelay(),
            utcNow: () => new DateTimeOffset(2026, 7, 23, 21, 0, 0, TimeSpan.Zero),
            maxUncompressedUploadBytes: maxUncompressedUploadBytes,
            maxCompressedUploadBytes: maxCompressedUploadBytes);
    }

    private async Task<QueueItem> QueueItemAsync()
    {
        Directory.CreateDirectory(directory);
        string path = Path.Combine(directory, Guid.NewGuid().ToString("N") + ".json");
        await File.WriteAllTextAsync(path, "{\"schemaVersion\":1,\"captureId\":\"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\"}");
        using System.Security.Cryptography.SHA256 sha = System.Security.Cryptography.SHA256.Create();
        await using FileStream stream = File.OpenRead(path);
        string hash = Convert.ToHexString(await sha.ComputeHashAsync(stream)).ToLowerInvariant();
        return new QueueItem(
            Guid.Parse("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
            "2026-07-23",
            path,
            hash,
            QueueState.Uploading);
    }

    private static string Gunzip(byte[] bytes)
    {
        using MemoryStream input = new(bytes);
        using GZipStream gzip = new(input, CompressionMode.Decompress);
        using StreamReader reader = new(gzip, Encoding.UTF8);
        return reader.ReadToEnd();
    }

    private static HttpResponseMessage Json(HttpStatusCode status, string body)
    {
        return new HttpResponseMessage(status)
        {
            Content = new StringContent(body, Encoding.UTF8, "application/json"),
        };
    }

    private sealed class SequenceHandler : HttpMessageHandler
    {
        private readonly Func<HttpRequestMessage, HttpResponseMessage> respond;

        public SequenceHandler(Func<HttpRequestMessage, HttpResponseMessage> respond) => this.respond = respond;

        public List<RecordedRequest> Requests { get; } = new();

        protected override async Task<HttpResponseMessage> SendAsync(
            HttpRequestMessage request,
            CancellationToken cancellationToken)
        {
            byte[] body = request.Content == null
                ? Array.Empty<byte>()
                : await request.Content.ReadAsByteArrayAsync(cancellationToken);
            Requests.Add(new RecordedRequest(
                request.RequestUri,
                request.Headers.Authorization?.ToString(),
                request.Headers.TryGetValues("X-Machine-Id", out IEnumerable<string> values)
                    ? string.Join(',', values)
                    : null,
                request.Content?.Headers.ContentEncoding.ToString(),
                body));
            return respond(request);
        }
    }

    private sealed record RecordedRequest(
        Uri Uri,
        string Authorization,
        string MachineId,
        string ContentEncoding,
        byte[] Body);

    private sealed class RecordingDelay : IRetryDelay
    {
        public List<TimeSpan> Delays { get; } = new();

        public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
        {
            Delays.Add(delay);
            return Task.CompletedTask;
        }
    }

    private sealed class FixedTokenStore : IDeviceTokenStore
    {
        private string token;

        public FixedTokenStore(string token) => this.token = token;

        public Task SaveTokenAsync(string value, CancellationToken cancellationToken = default)
        {
            token = value;
            return Task.CompletedTask;
        }

        public Task<string> LoadTokenAsync(CancellationToken cancellationToken = default) => Task.FromResult(token);

        public Task DeleteTokenAsync(CancellationToken cancellationToken = default)
        {
            token = null;
            return Task.CompletedTask;
        }
    }

    private sealed class FixedMachineGuidSource : IMachineGuidSource
    {
        private readonly string value;

        public FixedMachineGuidSource(string value) => this.value = value;

        public string ReadMachineGuid() => value;
    }
}
