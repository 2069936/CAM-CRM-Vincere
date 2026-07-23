using System;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.IO;
using System.IO.Compression;
using System.Security.Authentication;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Diagnostics;

namespace Vincere.AutoExport.Agent.Crm;

public sealed class CrmClient : IDisposable
{
    private static readonly Regex EnrollmentCodePattern = new(
        "^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$",
        RegexOptions.CultureInvariant);
    private static readonly Regex VersionPattern = new(
        @"^\d{1,5}(?:\.\d{1,5}){1,3}$",
        RegexOptions.CultureInvariant);
    private static readonly Regex DeviceTokenPattern = new(
        "^[A-Za-z0-9_-]{43}$",
        RegexOptions.CultureInvariant);
    private readonly Uri baseUri;
    private readonly HttpClient httpClient;
    private readonly IDeviceTokenStore tokenStore;
    private readonly IMachineGuidSource machineGuidSource;
    private readonly RetryPolicy retryPolicy;
    private readonly IRetryDelay retryDelay;
    private readonly TimeSpan requestTimeout;
    private readonly Func<DateTimeOffset> utcNow;
    private readonly int maxUncompressedUploadBytes;
    private readonly int maxCompressedUploadBytes;

    public CrmClient(
        Uri baseUri,
        HttpMessageHandler handler,
        IDeviceTokenStore tokenStore,
        IMachineGuidSource machineGuidSource,
        RetryPolicy retryPolicy = null,
        IRetryDelay retryDelay = null,
        TimeSpan? requestTimeout = null,
        bool allowInsecureLocalhost = false,
        Func<DateTimeOffset> utcNow = null,
        bool disposeHandler = false,
        int maxUncompressedUploadBytes = 128 * 1024 * 1024,
        int maxCompressedUploadBytes = 32 * 1024 * 1024)
    {
        this.baseUri = ValidateBaseUri(baseUri, allowInsecureLocalhost);
        this.tokenStore = tokenStore ?? throw new ArgumentNullException(nameof(tokenStore));
        this.machineGuidSource = machineGuidSource ?? throw new ArgumentNullException(nameof(machineGuidSource));
        this.retryPolicy = retryPolicy ?? new RetryPolicy();
        this.retryDelay = retryDelay ?? new SystemRetryDelay();
        this.requestTimeout = requestTimeout ?? TimeSpan.FromSeconds(30);
        if (this.requestTimeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(requestTimeout));
        if (maxUncompressedUploadBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(maxUncompressedUploadBytes));
        if (maxCompressedUploadBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(maxCompressedUploadBytes));
        this.utcNow = utcNow ?? (() => DateTimeOffset.UtcNow);
        this.maxUncompressedUploadBytes = maxUncompressedUploadBytes;
        this.maxCompressedUploadBytes = maxCompressedUploadBytes;
        httpClient = new HttpClient(
            handler ?? throw new ArgumentNullException(nameof(handler)),
            disposeHandler: disposeHandler)
        {
            MaxResponseContentBufferSize = 64 * 1024,
            Timeout = Timeout.InfiniteTimeSpan,
        };
    }

    public static CrmClient CreateProduction(
        Uri baseUri,
        IDeviceTokenStore tokenStore,
        IMachineGuidSource machineGuidSource)
    {
        HttpClientHandler handler = new()
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = DecompressionMethods.GZip | DecompressionMethods.Deflate,
        };
        return new CrmClient(
            baseUri,
            handler,
            tokenStore,
            machineGuidSource,
            disposeHandler: true);
    }

    public async Task<PairingResult> PairAsync(
        string enrollmentCode,
        string agentVersion,
        string addonVersion,
        CancellationToken cancellationToken = default)
    {
        string code = NormalizeEnrollmentCode(enrollmentCode);
        string machineId = MachineIdentity.ReadNormalized(machineGuidSource);
        agentVersion = NormalizeVersion(agentVersion, nameof(agentVersion));
        addonVersion = NormalizeVersion(addonVersion, nameof(addonVersion));
        byte[] nonceBytes = RandomNumberGenerator.GetBytes(32);
        string nonce = Base64Url(nonceBytes);
        byte[] requestBytes = null;
        try
        {
            requestBytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(new PairRequest
            {
                EnrollmentCode = code,
                MachineId = machineId,
                PairingNonce = nonce,
                AgentVersion = agentVersion,
                AddonVersion = addonVersion,
            }, Formatting.None));
            for (int attempt = 1; ; attempt++)
            {
                try
                {
                    using HttpResponseMessage response = await SendAsync(
                        HttpMethod.Post,
                        "api/ingest/pair",
                        requestBytes,
                        authenticated: false,
                        contentEncoding: null,
                        cancellationToken).ConfigureAwait(false);
                    byte[] responseBytes = await ReadResponseBytesAsync(response, cancellationToken)
                        .ConfigureAwait(false);
                    try
                    {
                        string errorCode = ReadErrorCode(responseBytes);
                        if (response.IsSuccessStatusCode)
                        {
                            PairResponse paired = Deserialize<PairResponse>(responseBytes, "pairing_response_invalid");
                            ValidatePairResponse(paired);
                            await tokenStore.SaveTokenAsync(paired.DeviceToken, cancellationToken).ConfigureAwait(false);
                            return new PairingResult(
                                paired.DeviceId,
                                paired.ClientName.Trim(),
                                paired.Schedule.Time,
                                paired.Schedule.TimeZone);
                        }

                        TimeSpan? retryAfter = ParseRetryAfter(response.Headers.RetryAfter);
                        TimeSpan? delay = retryPolicy.GetRetryDelay(
                            attempt,
                            response.StatusCode,
                            errorCode,
                            retryAfter);
                        if (delay.HasValue)
                        {
                            await retryDelay.DelayAsync(delay.Value, cancellationToken).ConfigureAwait(false);
                            continue;
                        }
                        throw PairingFailure(response.StatusCode, errorCode, retryAfter);
                    }
                    finally
                    {
                        CryptographicOperations.ZeroMemory(responseBytes);
                    }
                }
                catch (HttpRequestException exception) when (IsTlsFailure(exception))
                {
                    throw new CrmClientException(
                        "tls_failure",
                        "The CRM certificate could not be validated.",
                        retryable: false);
                }
                catch (HttpRequestException)
                {
                    TimeSpan? delay = retryPolicy.GetRetryDelay(attempt, transportFailure: true);
                    if (!delay.HasValue)
                        throw new CrmClientException(
                            "network_unavailable",
                            "The CRM could not be reached.",
                            retryable: true,
                            disposition: CrmFailureDisposition.Retry);
                    await retryDelay.DelayAsync(delay.Value, cancellationToken).ConfigureAwait(false);
                }
                catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    TimeSpan? delay = retryPolicy.GetRetryDelay(attempt, transportFailure: true);
                    if (!delay.HasValue)
                        throw new CrmClientException(
                            "crm_timeout",
                            "The CRM request timed out.",
                            retryable: true,
                            disposition: CrmFailureDisposition.Retry);
                    await retryDelay.DelayAsync(delay.Value, cancellationToken).ConfigureAwait(false);
                }
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(nonceBytes);
            if (requestBytes != null) CryptographicOperations.ZeroMemory(requestBytes);
        }
    }

    public async Task<UploadAcknowledgement> UploadAsync(
        QueueItem item,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(item);
        if (item.State != QueueState.Uploading || !File.Exists(item.PayloadPath))
            throw new CrmClientException(
                "queue_item_invalid",
                "The queued snapshot is not ready for upload.",
                false,
                disposition: CrmFailureDisposition.Quarantine);

        if (new FileInfo(item.PayloadPath).Length > maxUncompressedUploadBytes)
            throw PayloadTooLarge();

        byte[] payload = await File.ReadAllBytesAsync(item.PayloadPath, cancellationToken).ConfigureAwait(false);
        byte[] compressed = null;
        try
        {
            if (payload.Length > maxUncompressedUploadBytes)
                throw PayloadTooLarge();
            string actualHash = Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant();
            if (!string.Equals(actualHash, item.ContentSha256, StringComparison.Ordinal))
                throw new CrmClientException(
                    "queue_payload_changed",
                    "The queued snapshot changed before upload.",
                    false,
                    disposition: CrmFailureDisposition.Quarantine);
            compressed = Gzip(payload);
            if (compressed.Length > maxCompressedUploadBytes)
                throw PayloadTooLarge();

            for (int attempt = 1; ; attempt++)
            {
                try
                {
                    using HttpResponseMessage response = await SendAsync(
                        HttpMethod.Post,
                        "api/ingest/daily",
                        compressed,
                        authenticated: true,
                        contentEncoding: "gzip",
                        cancellationToken).ConfigureAwait(false);
                    byte[] responseBytes = await ReadResponseBytesAsync(response, cancellationToken)
                        .ConfigureAwait(false);
                    string errorCode = ReadErrorCode(responseBytes);
                    if (response.IsSuccessStatusCode)
                    {
                        UploadResponse uploaded = Deserialize<UploadResponse>(
                            responseBytes,
                            "upload_response_invalid");
                        ValidateUploadResponse(uploaded);
                        return new UploadAcknowledgement(
                            uploaded.BatchId,
                            uploaded.DailyImportId,
                            uploaded.Duplicate,
                            uploaded.Status,
                            item.ContentSha256,
                            utcNow());
                    }

                    TimeSpan? retryAfter = ParseRetryAfter(response.Headers.RetryAfter);
                    TimeSpan? delay = retryPolicy.GetRetryDelay(
                        attempt,
                        response.StatusCode,
                        errorCode,
                        retryAfter);
                    if (delay.HasValue)
                    {
                        await retryDelay.DelayAsync(delay.Value, cancellationToken).ConfigureAwait(false);
                        continue;
                    }
                    throw UploadFailure(response.StatusCode, errorCode, retryAfter);
                }
                catch (HttpRequestException exception) when (IsTlsFailure(exception))
                {
                    throw new CrmClientException(
                        "tls_failure",
                        "The CRM certificate could not be validated.",
                        false);
                }
                catch (HttpRequestException)
                {
                    TimeSpan? delay = retryPolicy.GetRetryDelay(attempt, transportFailure: true);
                    if (!delay.HasValue)
                        throw new CrmClientException(
                            "upload_failed",
                            "The snapshot upload could not reach the CRM.",
                            true,
                            disposition: CrmFailureDisposition.Retry);
                    await retryDelay.DelayAsync(delay.Value, cancellationToken).ConfigureAwait(false);
                }
                catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    TimeSpan? delay = retryPolicy.GetRetryDelay(attempt, transportFailure: true);
                    if (!delay.HasValue)
                        throw new CrmClientException(
                            "upload_failed",
                            "The snapshot upload timed out.",
                            true,
                            disposition: CrmFailureDisposition.Retry);
                    await retryDelay.DelayAsync(delay.Value, cancellationToken).ConfigureAwait(false);
                }
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(payload);
            if (compressed != null) CryptographicOperations.ZeroMemory(compressed);
        }
    }

    public async Task<HeartbeatResult> SendHeartbeatAsync(
        HeartbeatPayload payload,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(payload);
        string deviceToken = await tokenStore.LoadTokenAsync(cancellationToken).ConfigureAwait(false);
        string machineId = MachineIdentity.ReadNormalized(machineGuidSource);
        HeartbeatPayload normalized = NormalizeHeartbeat(
            payload,
            new[] { deviceToken, machineId });
        byte[] requestBytes = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(normalized, Formatting.None));
        try
        {
            for (int attempt = 1; ; attempt++)
            {
                try
                {
                    using HttpResponseMessage response = await SendAsync(
                        HttpMethod.Post,
                        "api/ingest/heartbeat",
                        requestBytes,
                        authenticated: true,
                        contentEncoding: null,
                        cancellationToken).ConfigureAwait(false);
                    byte[] responseBytes = await ReadResponseBytesAsync(response, cancellationToken)
                        .ConfigureAwait(false);
                    string errorCode = ReadErrorCode(responseBytes);
                    if (response.IsSuccessStatusCode)
                    {
                        HeartbeatResponse heartbeat = Deserialize<HeartbeatResponse>(
                            responseBytes,
                            "heartbeat_response_invalid");
                        ValidateHeartbeatResponse(heartbeat);
                        return new HeartbeatResult(
                            heartbeat.DeviceId,
                            heartbeat.Status,
                            heartbeat.UpdateRequired,
                            heartbeat.Throttled,
                            heartbeat.Schedule.Time,
                            heartbeat.Schedule.TimeZone);
                    }

                    TimeSpan? retryAfter = ParseRetryAfter(response.Headers.RetryAfter);
                    TimeSpan? delay = retryPolicy.GetRetryDelay(
                        attempt,
                        response.StatusCode,
                        errorCode,
                        retryAfter);
                    if (delay.HasValue)
                    {
                        await retryDelay.DelayAsync(delay.Value, cancellationToken).ConfigureAwait(false);
                        continue;
                    }
                    throw HeartbeatFailure(response.StatusCode, retryAfter);
                }
                catch (HttpRequestException exception) when (IsTlsFailure(exception))
                {
                    throw new CrmClientException(
                        "tls_failure",
                        "The CRM certificate could not be validated.",
                        false);
                }
                catch (HttpRequestException)
                {
                    TimeSpan? delay = retryPolicy.GetRetryDelay(attempt, transportFailure: true);
                    if (!delay.HasValue)
                        throw new CrmClientException(
                            "heartbeat_failed",
                            "The heartbeat could not reach the CRM.",
                            true,
                            disposition: CrmFailureDisposition.Retry);
                    await retryDelay.DelayAsync(delay.Value, cancellationToken).ConfigureAwait(false);
                }
                catch (TaskCanceledException) when (!cancellationToken.IsCancellationRequested)
                {
                    TimeSpan? delay = retryPolicy.GetRetryDelay(attempt, transportFailure: true);
                    if (!delay.HasValue)
                        throw new CrmClientException(
                            "heartbeat_failed",
                            "The heartbeat timed out.",
                            true,
                            disposition: CrmFailureDisposition.Retry);
                    await retryDelay.DelayAsync(delay.Value, cancellationToken).ConfigureAwait(false);
                }
            }
        }
        finally
        {
            CryptographicOperations.ZeroMemory(requestBytes);
        }
    }

    public void Dispose()
    {
        httpClient.Dispose();
    }

    private async Task<HttpResponseMessage> SendAsync(
        HttpMethod method,
        string relativePath,
        byte[] body,
        bool authenticated,
        string contentEncoding,
        CancellationToken cancellationToken)
    {
        using HttpRequestMessage request = new(method, new Uri(baseUri, relativePath));
        request.Headers.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));
        if (authenticated)
        {
            string token = await tokenStore.LoadTokenAsync(cancellationToken).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(token))
                throw new CrmClientException("device_not_paired", "The collector is not paired.", false);
            request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", token);
            request.Headers.Add("X-Machine-Id", MachineIdentity.ReadNormalized(machineGuidSource));
        }
        request.Content = new ByteArrayContent(body);
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
        if (!string.IsNullOrEmpty(contentEncoding))
            request.Content.Headers.ContentEncoding.Add(contentEncoding);
        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(requestTimeout);
        return await httpClient.SendAsync(
            request,
            HttpCompletionOption.ResponseContentRead,
            timeout.Token).ConfigureAwait(false);
    }

    private static Uri ValidateBaseUri(Uri value, bool allowInsecureLocalhost)
    {
        if (value == null
            || !value.IsAbsoluteUri
            || !string.IsNullOrEmpty(value.Query)
            || !string.IsNullOrEmpty(value.Fragment)
            || !string.IsNullOrEmpty(value.UserInfo))
            throw new ArgumentException("An absolute CRM base URI is required.", nameof(value));
        bool allowedHttp = allowInsecureLocalhost
            && value.Scheme == Uri.UriSchemeHttp
            && value.IsLoopback;
        if (value.Scheme != Uri.UriSchemeHttps && !allowedHttp)
            throw new ArgumentException("The CRM base URI must use HTTPS.", nameof(value));
        UriBuilder normalized = new(value)
        {
            Path = value.AbsolutePath.EndsWith("/", StringComparison.Ordinal)
                ? value.AbsolutePath
                : value.AbsolutePath + "/",
        };
        return normalized.Uri;
    }

    private static CrmClientException PayloadTooLarge()
    {
        return new CrmClientException(
            "payload_too_large",
            "The snapshot exceeds the CRM upload limit.",
            false,
            disposition: CrmFailureDisposition.Quarantine);
    }

    private static string NormalizeEnrollmentCode(string value)
    {
        string normalized = Regex.Replace((value ?? string.Empty).ToUpperInvariant(), @"[\s-]+", string.Empty);
        if (!EnrollmentCodePattern.IsMatch(normalized))
            throw new CrmClientException("invalid_enrollment_code", "The pairing code format is invalid.", false);
        return normalized;
    }

    private static string NormalizeVersion(string value, string parameterName)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (!VersionPattern.IsMatch(normalized))
            throw new ArgumentException("A numeric dotted version is required.", parameterName);
        return normalized;
    }

    private static string Base64Url(byte[] bytes)
    {
        return Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
    }

    private static byte[] Gzip(byte[] payload)
    {
        using MemoryStream output = new();
        using (GZipStream gzip = new(output, CompressionLevel.SmallestSize, leaveOpen: true))
            gzip.Write(payload, 0, payload.Length);
        return output.ToArray();
    }

    private static HeartbeatPayload NormalizeHeartbeat(
        HeartbeatPayload payload,
        string[] knownSecrets)
    {
        string[] allowedErrorCodes =
        {
            "ninjatrader_not_running",
            "addon_unavailable",
            "capture_timeout",
            "capture_failed",
            "contract_mismatch",
            "queue_capacity_warning",
            "upload_failed",
            "configuration_error",
        };
        if (payload.QueueDepth < 0
            || payload.QueueBytes < 0
            || (!string.IsNullOrEmpty(payload.LastErrorCode)
                && !allowedErrorCodes.Contains(payload.LastErrorCode, StringComparer.Ordinal))
            || (payload.LastCaptureAt.HasValue
                && payload.LastSuccessAt.HasValue
                && payload.LastSuccessAt > payload.LastCaptureAt))
        {
            throw new ArgumentException("Heartbeat metadata is invalid.", nameof(payload));
        }
        string redactedMessage = payload.LastErrorMessage == null
            ? null
            : SensitiveDataRedactor.Redact(payload.LastErrorMessage, knownSecrets);
        string safeMessage = redactedMessage == null
            ? null
            : new string(redactedMessage.Where(character => !char.IsControl(character)).Take(256).ToArray());
        return payload with
        {
            AgentVersion = NormalizeVersion(payload.AgentVersion, nameof(payload.AgentVersion)),
            AddonVersion = NormalizeVersion(payload.AddonVersion, nameof(payload.AddonVersion)),
            NinjaTraderVersion = NormalizeVersion(payload.NinjaTraderVersion, nameof(payload.NinjaTraderVersion)),
            LastErrorCode = string.IsNullOrEmpty(payload.LastErrorCode) ? null : payload.LastErrorCode,
            LastErrorMessage = string.IsNullOrEmpty(safeMessage) ? null : safeMessage,
        };
    }

    private static bool IsTlsFailure(HttpRequestException exception)
    {
        for (Exception current = exception; current != null; current = current.InnerException)
        {
            if (current is AuthenticationException) return true;
        }
        return false;
    }

    private static async Task<byte[]> ReadResponseBytesAsync(
        HttpResponseMessage response,
        CancellationToken cancellationToken)
    {
        byte[] bytes = await response.Content.ReadAsByteArrayAsync(cancellationToken).ConfigureAwait(false);
        if (bytes.Length > 64 * 1024)
            throw new CrmClientException("crm_response_invalid", "The CRM response is too large.", false);
        return bytes;
    }

    private static string ReadErrorCode(byte[] responseBytes)
    {
        try
        {
            return JsonConvert.DeserializeObject<ErrorResponse>(Encoding.UTF8.GetString(responseBytes))?.Error;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    private static T Deserialize<T>(byte[] bytes, string code)
    {
        try
        {
            T value = JsonConvert.DeserializeObject<T>(Encoding.UTF8.GetString(bytes));
            return value ?? throw new CrmClientException(code, "The CRM response is invalid.", false);
        }
        catch (JsonException)
        {
            throw new CrmClientException(code, "The CRM response is invalid.", false);
        }
    }

    private static void ValidatePairResponse(PairResponse response)
    {
        byte[] tokenBytes = null;
        try
        {
            tokenBytes = Convert.FromBase64String(
                response.DeviceToken.Replace('-', '+').Replace('_', '/') + "=");
            if (!DeviceTokenPattern.IsMatch(response.DeviceToken)
                || tokenBytes.Length != 32
                || !Guid.TryParse(response.DeviceId, out _)
                || string.IsNullOrWhiteSpace(response.ClientName)
                || response.Schedule == null
                || !Regex.IsMatch(response.Schedule.Time ?? string.Empty, @"^\d{2}:\d{2}$")
                || response.Schedule.TimeZone != "America/New_York")
            {
                throw new CrmClientException("pairing_response_invalid", "The CRM pairing response is invalid.", false);
            }
        }
        catch (Exception exception) when (exception is FormatException or NullReferenceException)
        {
            throw new CrmClientException("pairing_response_invalid", "The CRM pairing response is invalid.", false);
        }
        finally
        {
            if (tokenBytes != null) CryptographicOperations.ZeroMemory(tokenBytes);
        }
    }

    private static TimeSpan? ParseRetryAfter(RetryConditionHeaderValue value)
    {
        if (value?.Delta is TimeSpan delta) return delta < TimeSpan.Zero ? TimeSpan.Zero : delta;
        if (value?.Date is DateTimeOffset date)
        {
            TimeSpan delay = date - DateTimeOffset.UtcNow;
            return delay < TimeSpan.Zero ? TimeSpan.Zero : delay;
        }
        return null;
    }

    private static CrmClientException PairingFailure(
        HttpStatusCode status,
        string errorCode,
        TimeSpan? retryAfter)
    {
        if (status == HttpStatusCode.BadRequest && errorCode == "invalid_or_expired_code")
            return new CrmClientException("invalid_or_expired_code", "The pairing code is invalid or expired.", false);
        if (status == HttpStatusCode.TooManyRequests)
            return new CrmClientException("pairing_rate_limited", "Pairing is temporarily rate limited.", true, retryAfter);
        bool retryable = (int)status >= 500;
        return new CrmClientException(
            "pairing_unavailable",
            "The CRM pairing service is unavailable.",
            retryable,
            retryAfter,
            disposition: retryable ? CrmFailureDisposition.Retry : CrmFailureDisposition.Stop);
    }

    private static CrmClientException UploadFailure(
        HttpStatusCode status,
        string errorCode,
        TimeSpan? retryAfter)
    {
        if ((int)status is >= 300 and < 400)
            return new CrmClientException("unexpected_redirect", "The CRM returned an unexpected redirect.", false);
        if (status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            return new CrmClientException(
                "device_credential_revoked",
                "The collector credential is invalid or revoked.",
                false,
                disposition: CrmFailureDisposition.RePair);
        if (status == HttpStatusCode.RequestEntityTooLarge)
            return new CrmClientException(
                "payload_too_large",
                "The snapshot exceeds the CRM upload limit.",
                false,
                disposition: CrmFailureDisposition.Quarantine);
        if (status == HttpStatusCode.BadRequest)
            return new CrmClientException(
                "snapshot_rejected",
                "The CRM rejected the snapshot envelope.",
                false,
                disposition: CrmFailureDisposition.Quarantine);
        if (status == HttpStatusCode.UnprocessableEntity)
        {
            string code = errorCode == "unsupported_schema_version"
                ? "unsupported_schema_version"
                : "snapshot_processing_failed";
            return new CrmClientException(
                code,
                "The CRM could not process the snapshot.",
                false,
                disposition: CrmFailureDisposition.Quarantine);
        }
        if (status == HttpStatusCode.Conflict)
        {
            string code = errorCode == "capture_requires_replay"
                ? "capture_requires_replay"
                : "capture_conflict";
            return new CrmClientException(
                code,
                "The CRM requires operator action for this capture.",
                false,
                retryAfter,
                disposition: CrmFailureDisposition.OperatorAction);
        }
        bool retryable = status == HttpStatusCode.RequestTimeout
            || status == HttpStatusCode.TooManyRequests
            || (int)status >= 500;
        return new CrmClientException(
            "upload_failed",
            "The CRM did not accept the snapshot.",
            retryable,
            retryAfter,
            disposition: retryable ? CrmFailureDisposition.Retry : CrmFailureDisposition.Stop);
    }

    private static CrmClientException HeartbeatFailure(
        HttpStatusCode status,
        TimeSpan? retryAfter)
    {
        if (status is HttpStatusCode.Unauthorized or HttpStatusCode.Forbidden)
            return new CrmClientException(
                "device_credential_revoked",
                "The collector credential is invalid or revoked.",
                false,
                disposition: CrmFailureDisposition.RePair);
        bool retryable = status == HttpStatusCode.RequestTimeout
            || status == HttpStatusCode.TooManyRequests
            || (int)status >= 500;
        return new CrmClientException(
            "heartbeat_failed",
            "The CRM did not accept the heartbeat.",
            retryable,
            retryAfter,
            disposition: retryable ? CrmFailureDisposition.Retry : CrmFailureDisposition.Stop);
    }

    [JsonObject(MemberSerialization.OptIn)]
    private sealed class PairRequest
    {
        [JsonProperty("enrollmentCode")]
        public string EnrollmentCode { get; init; }

        [JsonProperty("machineId")]
        public string MachineId { get; init; }

        [JsonProperty("pairingNonce")]
        public string PairingNonce { get; init; }

        [JsonProperty("agentVersion")]
        public string AgentVersion { get; init; }

        [JsonProperty("addonVersion")]
        public string AddonVersion { get; init; }
    }

    private sealed class PairResponse
    {
        [JsonProperty("deviceToken")]
        public string DeviceToken { get; set; }

        [JsonProperty("deviceId")]
        public string DeviceId { get; set; }

        [JsonProperty("clientName")]
        public string ClientName { get; set; }

        [JsonProperty("schedule")]
        public ScheduleResponse Schedule { get; set; }
    }

    private sealed class ScheduleResponse
    {
        [JsonProperty("time")]
        public string Time { get; set; }

        [JsonProperty("timeZone")]
        public string TimeZone { get; set; }
    }

    private sealed class ErrorResponse
    {
        [JsonProperty("error")]
        public string Error { get; set; }
    }

    private sealed class UploadResponse
    {
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        [JsonProperty("duplicate")]
        public bool Duplicate { get; set; }

        [JsonProperty("batchId")]
        public string BatchId { get; set; }

        [JsonProperty("dailyImportId")]
        public string DailyImportId { get; set; }

        [JsonProperty("status")]
        public string Status { get; set; }
    }

    private sealed class HeartbeatResponse
    {
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        [JsonProperty("deviceId")]
        public string DeviceId { get; set; }

        [JsonProperty("status")]
        public string Status { get; set; }

        [JsonProperty("updateRequired")]
        public bool UpdateRequired { get; set; }

        [JsonProperty("throttled")]
        public bool Throttled { get; set; }

        [JsonProperty("schedule")]
        public ScheduleResponse Schedule { get; set; }
    }

    private static void ValidateUploadResponse(UploadResponse response)
    {
        if (!response.Ok
            || !Guid.TryParse(response.BatchId, out _)
            || (!string.IsNullOrEmpty(response.DailyImportId) && !Guid.TryParse(response.DailyImportId, out _))
            || response.Status is not ("processed" or "incomplete" or "late_closed_day" or "replaced"))
        {
            throw new CrmClientException("upload_response_invalid", "The CRM upload response is invalid.", false);
        }
    }

    private static void ValidateHeartbeatResponse(HeartbeatResponse response)
    {
        if (!response.Ok
            || !Guid.TryParse(response.DeviceId, out _)
            || response.Status is not ("online" or "error" or "update_required")
            || response.Schedule == null
            || !Regex.IsMatch(response.Schedule.Time ?? string.Empty, @"^\d{2}:\d{2}$")
            || response.Schedule.TimeZone != "America/New_York")
        {
            throw new CrmClientException("heartbeat_response_invalid", "The CRM heartbeat response is invalid.", false);
        }
    }
}
