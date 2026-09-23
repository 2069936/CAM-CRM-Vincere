using System;
using System.Collections.Generic;
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

    /* ITS OWN ENDPOINT, AND NOT A FIELD ON THE HEARTBEAT.
     *
     * The production heartbeat refuses any key it does not know with a 400,
     * and its record function refuses any error code outside its list. An
     * agent that put the quarantine on the heartbeat would ship weeks before
     * the CRM that accepts it and would silence every heartbeat on the fleet
     * until then. So the inventory goes to /api/ingest/quarantine, which the
     * CRM of today answers with 404, and 404 is reported here as Unsupported
     * rather than thrown: it is the expected answer for a while. */
    Task<QuarantineReportOutcome> ReportQuarantineAsync(
        QuarantineReport report,
        CancellationToken cancellationToken = default);
}

public enum QuarantineReportOutcome
{
    Accepted,

    /// <summary>The CRM has no such endpoint yet. Try again tomorrow, not sooner.</summary>
    Unsupported,
}

[JsonObject(MemberSerialization.OptIn)]
public sealed record QuarantineReportItem(
    [property: JsonProperty("tradingDate")] string TradingDate,
    [property: JsonProperty("captureId")] string CaptureId,
    [property: JsonProperty("code")] string Code,
    [property: JsonProperty("attempts")] int Attempts,
    [property: JsonProperty("quarantinedAt")] DateTimeOffset QuarantinedAt,
    [property: JsonProperty("lastAttemptAt")] DateTimeOffset? LastAttemptAt);

[JsonObject(MemberSerialization.OptIn)]
public sealed record QuarantineReport(
    [property: JsonProperty("schemaVersion")] int SchemaVersion,
    [property: JsonProperty("reportedAt")] DateTimeOffset ReportedAt,
    [property: JsonProperty("items")] IReadOnlyList<QuarantineReportItem> Items)
{
    public const int CurrentSchemaVersion = 1;

    /// <summary>The most a report carries. Newest trading dates first when there are more.</summary>
    public const int MaximumItems = 200;
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
