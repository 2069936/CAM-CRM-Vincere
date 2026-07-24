using System;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Queue;

namespace Vincere.AutoExport.Agent.Crm;

public interface ICollectorCrmClient
{
    Task<PairingResult> PairAsync(
        string enrollmentCode,
        string agentVersion,
        string addonVersion,
        CancellationToken cancellationToken = default);

    Task<UploadAcknowledgement> UploadAsync(
        QueueItem item,
        CancellationToken cancellationToken = default);

    Task<HeartbeatResult> SendHeartbeatAsync(
        HeartbeatPayload payload,
        CancellationToken cancellationToken = default);
}

public enum CrmFailureDisposition
{
    Stop,
    Retry,
    RePair,
    Quarantine,
    OperatorAction,
}

public sealed record PairingResult(
    string DeviceId,
    string ClientName,
    string ScheduleTime,
    string TimeZone);

public sealed record UploadAcknowledgement(
    string BatchId,
    string DailyImportId,
    bool Duplicate,
    string Status,
    string ContentSha256,
    DateTimeOffset AcknowledgedAt);

[JsonObject(MemberSerialization.OptIn)]
public sealed record HeartbeatPayload(
    [property: JsonProperty("agentVersion")] string AgentVersion,
    [property: JsonProperty("addonVersion")] string AddonVersion,
    [property: JsonProperty("ninjaTraderVersion")] string NinjaTraderVersion,
    [property: JsonProperty("lastCaptureAt")] DateTimeOffset? LastCaptureAt,
    [property: JsonProperty("lastSuccessAt")] DateTimeOffset? LastSuccessAt,
    [property: JsonProperty("lastErrorCode")] string LastErrorCode,
    [property: JsonProperty("lastErrorMessage")] string LastErrorMessage,
    [property: JsonProperty("queueDepth")] int QueueDepth,
    [property: JsonProperty("queueBytes")] long QueueBytes,
    [property: JsonProperty("addonAvailable")] bool? AddonAvailable);

public sealed record HeartbeatResult(
    string DeviceId,
    string Status,
    bool UpdateRequired,
    bool Throttled,
    string ScheduleTime,
    string TimeZone);

public sealed class CrmClientException : Exception
{
    public CrmClientException(
        string code,
        string message,
        bool retryable,
        TimeSpan? retryAfter = null,
        Exception innerException = null,
        CrmFailureDisposition disposition = CrmFailureDisposition.Stop)
        : base(message, innerException)
    {
        Code = code;
        Retryable = retryable;
        RetryAfter = retryAfter;
        Disposition = disposition;
    }

    public string Code { get; }
    public bool Retryable { get; }
    public TimeSpan? RetryAfter { get; }
    public CrmFailureDisposition Disposition { get; }
}
