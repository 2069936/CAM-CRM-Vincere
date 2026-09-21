using System;
using System.Collections.Generic;

namespace Vincere.AutoExport.Agent.Queue;

public enum QueueState
{
    Pending,
    Uploading,
    Sent,
    Quarantine,
}

public sealed record QueueItem(
    Guid CaptureId,
    string TradingDate,
    string PayloadPath,
    string ContentSha256,
    QueueState State);

public sealed record QueueEnqueueResult(QueueItem Item, bool Duplicate);

public sealed record QueueReceipt(
    int SchemaVersion,
    Guid CaptureId,
    string BatchId,
    string ContentSha256,
    DateTimeOffset AcknowledgedAt);

public sealed record QueueRecoveryResult(
    int CompletedTemporaryEnqueues,
    int ReturnedToPending,
    int CompletedFromReceipt,
    int QuarantinedItems);

/// <summary>One landing in quarantine, or one trip back out of it.</summary>
public sealed record QueueQuarantineAttempt(DateTimeOffset At, string Code);

/* SCHEMA 2 IS WHAT MAKES QUARANTINE A PLACE THINGS CAN LEAVE.
 *
 * Schema 1 recorded why a capture landed here and nothing else, which was
 * right when landing here was terminal. It is not any more: a 422 is the CRM
 * reading the snapshot and refusing it, and a fix on that side makes the same
 * bytes acceptable, which is exactly what happened this month. The daily
 * review sends such a capture back to pending, and if it bounces the count has
 * to survive the trip or the review would retry it forever.
 *
 * Attempts is how many times the review has sent this capture back out.
 * LastAttemptAt is when it last did. History is every landing and every trip
 * out, oldest first, so the file on disk tells the whole story without a log.
 * A schema 1 file reads as zero attempts and an empty history. */
public sealed record QueueQuarantineReason(
    int SchemaVersion,
    string Code,
    string OriginalFileName,
    DateTimeOffset QuarantinedAt,
    int Attempts,
    DateTimeOffset? LastAttemptAt,
    IReadOnlyList<QueueQuarantineAttempt> History)
{
    public const int CurrentSchemaVersion = 2;

    /// <summary>The history code written when the review sends a capture back to pending.</summary>
    public const string RequeuedCode = "requeued";
}

/* WHICH CODES THE REVIEW MAY SEND BACK, AND HOW MANY TIMES.
 *
 * Only a 422 is worth a second try: the CRM read the capture and could not
 * process it, and the fix for that lives on the server. A 400 and a 413 are
 * deterministic and the same bytes will be refused the same way tomorrow; a
 * 409 means the CRM already holds the batch and wants an operator, so a
 * resend is noise; a corrupt or mismatched queue file cannot be sent at all.
 * Three attempts is one a day for three days, which is longer than any fix
 * has taken, and after that the capture waits for the desk. */
public static class QuarantinePolicy
{
    public const int MaximumAttempts = 3;

    public static bool IsRetryable(string code)
    {
        return code is "snapshot_processing_failed" or "unsupported_schema_version";
    }

    public static bool WillRetry(string code, int attempts)
    {
        return IsRetryable(code) && attempts < MaximumAttempts;
    }
}

/// <summary>
/// One capture in the quarantine folder, read from its filename and its reason
/// file. Never from the payload, which may be the corrupt thing that put it here.
/// </summary>
public sealed record QueueQuarantineEntry(
    Guid CaptureId,
    string TradingDate,
    string Code,
    int Attempts,
    DateTimeOffset QuarantinedAt,
    DateTimeOffset? LastAttemptAt,
    bool WillRetry);

/// <summary>What one review did: the captures it sent back to pending, and the ones it left where they were.</summary>
public sealed record QueueQuarantineReviewResult(
    IReadOnlyList<QueueQuarantineEntry> Requeued,
    IReadOnlyList<QueueQuarantineEntry> Remaining);

public sealed record SnapshotQueueOptions(
    long MaximumBytes,
    long WarningBytes,
    TimeSpan SentRetention)
{
    public static SnapshotQueueOptions Default { get; } = new(
        MaximumBytes: 2L * 1024 * 1024 * 1024,
        WarningBytes: 1536L * 1024 * 1024,
        SentRetention: TimeSpan.FromDays(30));
}

public sealed record QueueStatus(
    int PendingCount,
    int UploadingCount,
    int SentCount,
    int QuarantineCount,
    long TotalBytes,
    bool CapacityWarning);

public sealed record QueueCleanupResult(int DeletedSentItems, long BytesFreed);

public sealed class SnapshotQueueException : Exception
{
    public SnapshotQueueException(string code, string message) : base(message)
    {
        Code = code;
    }

    public string Code { get; }
}
