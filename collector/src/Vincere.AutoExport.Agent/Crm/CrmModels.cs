using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Contracts;

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
    /* Mailing this machine's own close, on a day the database cannot answer.
     *
     * Answers false rather than throwing for every ordinary reason it cannot
     * go: no relay configured on the deployment, no secret on this machine
     * yet, nothing captured. The caller is a loop whose failure costs a
     * courtesy, and it must not learn to swallow exceptions to live with it.
     *
     * Defaulted so every existing test double of this interface still
     * compiles; a double that does not override it simply never sends. */
    Task<bool> SendReportEmailAsync(
        string captureJson,
        string clientName,
        string rosterJson,
        DateTimeOffset? rosterFetchedAt,
        string relaySecret,
        string relayUrl = null,
        CancellationToken cancellationToken = default) => Task.FromResult(false);

    Task<QuarantineReportOutcome> ReportQuarantineAsync(
        QuarantineReport report,
        CancellationToken cancellationToken = default);

    /* THE TRACKER READING, ON ITS OWN ROUTE. Never a key on the heartbeat: that
     * endpoint answers 400 for any key it does not know, so an agent that put
     * accounts on it would silence every heartbeat on the fleet until the CRM
     * caught up - and the heartbeat is the only thing that says a machine is
     * alive, which is the very traffic light this exists to build.
     *
     * NO RETRY, AND THAT IS NOT AN OVERSIGHT. See the implementation: a sample is
     * worthless five minutes later, so a failure returns and the next tick carries
     * a FRESH reading rather than a stale one that finally got through.
     *
     * Defaulted so every existing test double of this interface still compiles,
     * the way SendReportEmailAsync was added. A double that does not override it
     * reports Unsupported, which is the quietest possible default: the caller goes
     * silent for a day rather than claiming anything. */
    Task<AccountSampleReportResult> PostAccountSampleAsync(
        AccountSampleV1 sample,
        CancellationToken cancellationToken = default) =>
        Task.FromResult(AccountSampleReportResult.Unsupported("not_implemented"));
}

public enum AccountSampleReportStatus
{
    Accepted,

    /// <summary>
    /// This CRM has no such route. 404 today on every deployment that has not
    /// merged the tracker, and 405 on one that mounts the action for GET only.
    /// Neither is a reason to retry, to log an error, or to mark the device; the
    /// caller waits a day and offers again.
    /// </summary>
    Unsupported,

    /// <summary>
    /// Refused or unreachable this time. Nothing is kept and nothing is retried.
    /// </summary>
    Failed,
}

/// <param name="SampleIntervalSeconds">
/// How often the CRM wants to be sampled, straight from the settings table it
/// holds. This is the only channel for it, and it has to ride on a reply rather
/// than an environment variable because the one person who deploys this cannot
/// set one. Null when the CRM did not say.
/// </param>
public sealed record AccountSampleReportResult(
    AccountSampleReportStatus Status,
    int? SampleIntervalSeconds,
    string Code)
{
    public static AccountSampleReportResult Unsupported(string code) =>
        new(AccountSampleReportStatus.Unsupported, null, code);

    public static AccountSampleReportResult Failed(string code) =>
        new(AccountSampleReportStatus.Failed, null, code);
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
    DateTimeOffset AcknowledgedAt,
    /* THE ACCOUNT CLASSIFICATION, WHICH THE CAPTURE CANNOT SUPPLY.
     *
     * NinjaTrader knows balances; it does not know an account is an evaluation,
     * and a report that counts an evaluation's profit tells a client they made
     * money on capital they do not own. The CRM answers every upload with a
     * small projection of its registry so the machine can classify its own
     * accounts on a day the CRM cannot be reached.
     *
     * Optional, with a default, so every existing construction site compiles
     * unchanged and a server that has not deployed yet simply sends nothing. */
    string RegistryJson = null,
    string RegistryVersion = null);

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
    string TimeZone,
    /* THE SECRET THAT LETS THIS MACHINE MAIL ITS OWN REPORT.
     *
     * Null on every deployment that has no relay configured, and null on every
     * older CRM, which is why it is last and why nothing reads it without
     * checking. It buys one thing: asking api/ingest/report-email to send this
     * machine's report to an address that route reads from its own
     * environment and never from the request. It is not a mail credential and
     * it grants nothing in the database.
     *
     * It arrives here rather than at pairing because every machine in the
     * field is already paired, and it has to arrive on an ordinary day: the
     * day it is needed is the day the database cannot answer. */
    string ReportEmailSecret = null,
    /* Where to post it, which is not the CRM. The send happens in a Supabase
     * Edge Function because the mail key cannot live on the CRM's deployment.
     * Told rather than compiled in, so moving it later costs a heartbeat
     * instead of thirty machine visits. Null on an older CRM, and the agent
     * then posts to the CRM's own relay route as it always did. */
    string ReportEmailUrl = null);

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
