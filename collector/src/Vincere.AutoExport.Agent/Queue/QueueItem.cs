using System;

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

public sealed record QueueQuarantineReason(
    int SchemaVersion,
    string Code,
    string OriginalFileName,
    DateTimeOffset QuarantinedAt);

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
