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
 * A 422 is the CRM reading the capture and failing to process it, and the
 * fix for that lives on the server. Every resend of it the CRM takes in is a
 * full processing pass there, so three is the budget: one a trading day for
 * three trading days, longer than any fix has taken, and after that the
 * capture waits for the desk.
 *
 * capture_requires_replay is what the CRM answers when a capture it already
 * holds as a failed close is sent again: refused at the door, before storage
 * or processing, because the desk replays the stored copy from the Auto
 * Collection screen. That is the answer every 422 gets on its first resend
 * today. It is sent again at every review and never capped, because the
 * resend costs the CRM one claim, the answer changes only when the desk acts,
 * and once it has the resend is what clears the folder: the CRM then answers
 * duplicate and the queue completes the capture. Attempts keeps counting so
 * the window and the fleet view can say how long it has waited.
 *
 * A 400 and a 413 are deterministic and the same bytes will be refused the
 * same way tomorrow; capture_conflict means the CRM holds a different close
 * for the day; a corrupt or mismatched queue file cannot be sent at all. */
public static class QuarantinePolicy
{
    public const int MaximumAttempts = 3;

    /// <summary>The 409 the CRM answers a resend of a failed close with, until the desk replays it there.</summary>
    public const string AwaitingReplayCode = "capture_requires_replay";

    /// <summary>The two 422 codes: a resend is a processing pass on the CRM, and the cap counts it.</summary>
    public static bool IsCapped(string code)
    {
        return code is "snapshot_processing_failed" or "unsupported_schema_version";
    }

    public static bool IsRetryable(string code)
    {
        return IsCapped(code) || code == AwaitingReplayCode;
    }

    public static bool WillRetry(string code, int attempts)
    {
        return IsCapped(code) ? attempts < MaximumAttempts : code == AwaitingReplayCode;
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
