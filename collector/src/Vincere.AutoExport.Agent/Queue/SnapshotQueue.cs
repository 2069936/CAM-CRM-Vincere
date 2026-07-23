using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Contracts;

namespace Vincere.AutoExport.Agent.Queue;

public interface ISnapshotQueueWriter
{
    Task<QueueEnqueueResult> EnqueueAsync(
        AutoExportSnapshotV1 snapshot,
        CancellationToken cancellationToken = default);
}

public sealed class SnapshotQueue : ISnapshotQueueWriter
{
    private static readonly UTF8Encoding Utf8WithoutBom = new(false);
    private readonly IAgentDirectorySecurity directorySecurity;
    private readonly SnapshotQueueOptions options;
    private readonly IQueueDurability durability;
    private readonly SemaphoreSlim gate = new(1, 1);

    public SnapshotQueue(
        string queueRoot,
        IAgentDirectorySecurity directorySecurity,
        SnapshotQueueOptions options = null,
        IQueueDurability durability = null)
    {
        if (string.IsNullOrWhiteSpace(queueRoot))
            throw new ArgumentException("A queue root is required.", nameof(queueRoot));
        this.directorySecurity = directorySecurity ?? throw new ArgumentNullException(nameof(directorySecurity));
        this.options = options ?? SnapshotQueueOptions.Default;
        this.durability = durability ?? WindowsQueueDurability.Instance;
        if (this.options.WarningBytes <= 0
            || this.options.MaximumBytes < this.options.WarningBytes
            || this.options.SentRetention < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(options), "Queue size and retention limits are invalid.");
        }
        RootDirectory = Path.GetFullPath(queueRoot);
        PendingDirectory = Path.Combine(RootDirectory, "pending");
        UploadingDirectory = Path.Combine(RootDirectory, "uploading");
        SentDirectory = Path.Combine(RootDirectory, "sent");
        QuarantineDirectory = Path.Combine(RootDirectory, "quarantine");
    }

    public string RootDirectory { get; }
    public string PendingDirectory { get; }
    public string UploadingDirectory { get; }
    public string SentDirectory { get; }
    public string QuarantineDirectory { get; }

    public async Task<QueueEnqueueResult> EnqueueAsync(
        AutoExportSnapshotV1 snapshot,
        CancellationToken cancellationToken = default)
    {
        ValidateSnapshot(snapshot);
        byte[] payload = Utf8WithoutBom.GetBytes(JsonConvert.SerializeObject(
            snapshot,
            Formatting.None,
            new JsonSerializerSettings
            {
                DateFormatHandling = DateFormatHandling.IsoDateFormat,
                NullValueHandling = NullValueHandling.Include,
            }));
        string hash = Convert.ToHexString(SHA256.HashData(payload)).ToLowerInvariant();
        string fileName = FileName(snapshot.TradingDate, snapshot.CaptureId);

        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            EnsureDirectories();
            string finalPath = Path.Combine(PendingDirectory, fileName);
            string temporaryPath = finalPath + ".tmp";
            foreach ((string directory, QueueState state) in new[]
            {
                (PendingDirectory, QueueState.Pending),
                (UploadingDirectory, QueueState.Uploading),
                (SentDirectory, QueueState.Sent),
            })
            {
                string existingPath = Path.Combine(directory, fileName);
                if (!File.Exists(existingPath)) continue;
                string existingHash = HashFile(existingPath);
                if (!string.Equals(existingHash, hash, StringComparison.Ordinal))
                    throw new SnapshotQueueException(
                        "capture_id_conflict",
                        "The capture ID already exists with different payload bytes.");
                return new QueueEnqueueResult(
                    new QueueItem(snapshot.CaptureId, snapshot.TradingDate, existingPath, existingHash, state),
                    true);
            }

            MakeCapacityFor(payload.LongLength);

            DeleteIfPresent(temporaryPath);
            try
            {
                await WriteThroughAsync(temporaryPath, payload, cancellationToken).ConfigureAwait(false);
                MoveDurably(temporaryPath, finalPath);
            }
            finally
            {
                DeleteIfPresent(temporaryPath);
            }
            return new QueueEnqueueResult(
                new QueueItem(snapshot.CaptureId, snapshot.TradingDate, finalPath, hash, QueueState.Pending),
                false);
        }
        finally
        {
            CryptographicOperations.ZeroMemory(payload);
            gate.Release();
        }
    }

    public async Task<QueueItem> ClaimNextAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            EnsureDirectories();
            foreach (string pendingPath in Directory.EnumerateFiles(PendingDirectory, "*.json")
                .OrderBy(path => path, StringComparer.Ordinal))
            {
                QueueItem pending;
                try
                {
                    pending = ReadQueueItem(pendingPath, QueueState.Pending);
                }
                catch (SnapshotQueueException exception)
                    when (exception.Code is "queue_payload_corrupt" or "queue_payload_mismatch")
                {
                    await QuarantineAsync(pendingPath, exception.Code, cancellationToken).ConfigureAwait(false);
                    continue;
                }
                string uploadingPath = Path.Combine(UploadingDirectory, Path.GetFileName(pendingPath));
                try
                {
                    MoveDurably(pendingPath, uploadingPath);
                }
                catch (IOException) when (!File.Exists(pendingPath) || File.Exists(uploadingPath))
                {
                    continue;
                }
                return pending with { PayloadPath = uploadingPath, State = QueueState.Uploading };
            }
            return null;
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<QueueItem> RetryAsync(
        QueueItem item,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(item);
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            EnsureDirectories();
            RequireStatePath(item, QueueState.Uploading, UploadingDirectory);
            QueueItem current = ReadQueueItem(item.PayloadPath, QueueState.Uploading);
            string pendingPath = Path.Combine(PendingDirectory, Path.GetFileName(item.PayloadPath));
            if (File.Exists(pendingPath))
            {
                if (!string.Equals(HashFile(pendingPath), current.ContentSha256, StringComparison.Ordinal))
                    throw new SnapshotQueueException("capture_id_conflict", "Pending capture bytes conflict with the retry.");
                File.Delete(item.PayloadPath);
            }
            else
            {
                MoveDurably(item.PayloadPath, pendingPath);
            }
            return current with { PayloadPath = pendingPath, State = QueueState.Pending };
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<QueueItem> CompleteAsync(
        QueueItem item,
        string batchId,
        string acknowledgedContentSha256,
        DateTimeOffset acknowledgedAt,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(item);
        if (string.IsNullOrWhiteSpace(batchId))
            throw new SnapshotQueueException("receipt_invalid", "A CRM batch ID is required.");
        if (!string.Equals(item.ContentSha256, acknowledgedContentSha256, StringComparison.Ordinal))
            throw new SnapshotQueueException("receipt_hash_mismatch", "The CRM acknowledgement hash does not match the queued payload.");

        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            EnsureDirectories();
            RequireStatePath(item, QueueState.Uploading, UploadingDirectory);
            QueueItem current = ReadQueueItem(item.PayloadPath, QueueState.Uploading);
            if (!string.Equals(current.ContentSha256, acknowledgedContentSha256, StringComparison.Ordinal))
                throw new SnapshotQueueException("receipt_hash_mismatch", "The queued payload changed after it was claimed.");

            QueueReceipt receipt = new(1, current.CaptureId, batchId, current.ContentSha256, acknowledgedAt);
            string uploadingReceiptPath = item.PayloadPath + ".receipt";
            string temporaryReceiptPath = uploadingReceiptPath + ".tmp";
            byte[] receiptBytes = Utf8WithoutBom.GetBytes(JsonConvert.SerializeObject(receipt, Formatting.None));
            DeleteIfPresent(temporaryReceiptPath);
            try
            {
                await WriteThroughAsync(temporaryReceiptPath, receiptBytes, cancellationToken).ConfigureAwait(false);
                MoveDurably(temporaryReceiptPath, uploadingReceiptPath);
            }
            finally
            {
                DeleteIfPresent(temporaryReceiptPath);
            }

            string sentPath = Path.Combine(SentDirectory, Path.GetFileName(item.PayloadPath));
            string sentReceiptPath = sentPath + ".receipt";
            MoveDurably(item.PayloadPath, sentPath);
            MoveDurably(uploadingReceiptPath, sentReceiptPath);
            return current with { PayloadPath = sentPath, State = QueueState.Sent };
        }
        finally
        {
            gate.Release();
        }
    }

    public QueueReceipt ReadReceipt(string path)
    {
        QueueReceipt receipt;
        try
        {
            receipt = JsonConvert.DeserializeObject<QueueReceipt>(File.ReadAllText(path, Utf8WithoutBom));
        }
        catch (JsonException)
        {
            throw new SnapshotQueueException("receipt_invalid", "The queue receipt is invalid.");
        }
        if (receipt == null
            || receipt.SchemaVersion != 1
            || receipt.CaptureId == Guid.Empty
            || string.IsNullOrWhiteSpace(receipt.BatchId)
            || receipt.ContentSha256?.Length != 64)
        {
            throw new SnapshotQueueException("receipt_invalid", "The queue receipt is incomplete.");
        }
        return receipt;
    }

    public QueueQuarantineReason ReadQuarantineReason(string path)
    {
        QueueQuarantineReason reason;
        try
        {
            reason = JsonConvert.DeserializeObject<QueueQuarantineReason>(File.ReadAllText(path, Utf8WithoutBom));
        }
        catch (JsonException)
        {
            throw new SnapshotQueueException("quarantine_reason_invalid", "The quarantine reason is invalid.");
        }
        if (reason == null
            || reason.SchemaVersion != 1
            || string.IsNullOrWhiteSpace(reason.Code)
            || string.IsNullOrWhiteSpace(reason.OriginalFileName))
        {
            throw new SnapshotQueueException("quarantine_reason_invalid", "The quarantine reason is incomplete.");
        }
        return reason;
    }

    public async Task<QueueRecoveryResult> RecoverAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            EnsureDirectories();
            int completedTemporaryEnqueues = 0;
            int returnedToPending = 0;
            int completedFromReceipt = 0;
            int quarantinedItems = 0;

            foreach (string temporaryPath in Directory.EnumerateFiles(PendingDirectory, "*.json.tmp"))
            {
                try
                {
                    AutoExportSnapshotV1 snapshot = ReadSnapshot(temporaryPath);
                    string finalPath = temporaryPath[..^4];
                    if (!string.Equals(Path.GetFileName(finalPath), FileName(snapshot.TradingDate, snapshot.CaptureId), StringComparison.Ordinal))
                        throw new SnapshotQueueException("queue_payload_mismatch", "Queued snapshot identifiers do not match its filename.");
                    if (File.Exists(finalPath))
                    {
                        if (!string.Equals(HashFile(finalPath), HashFile(temporaryPath), StringComparison.Ordinal))
                            throw new SnapshotQueueException("capture_id_conflict", "Interrupted enqueue conflicts with an existing capture.");
                        File.Delete(temporaryPath);
                    }
                    else
                    {
                        MoveDurably(temporaryPath, finalPath);
                    }
                    completedTemporaryEnqueues++;
                }
                catch (SnapshotQueueException exception)
                    when (exception.Code is "queue_payload_corrupt" or "queue_payload_mismatch" or "capture_id_conflict")
                {
                    await QuarantineAsync(temporaryPath, exception.Code, cancellationToken).ConfigureAwait(false);
                    quarantinedItems++;
                }
            }

            foreach (string uploadingPath in Directory.EnumerateFiles(UploadingDirectory, "*.json"))
            {
                try
                {
                    QueueItem uploading = ReadQueueItem(uploadingPath, QueueState.Uploading);
                    string receiptPath = uploadingPath + ".receipt";
                    if (File.Exists(receiptPath))
                    {
                        QueueReceipt receipt = ReadReceipt(receiptPath);
                        ValidateReceipt(receipt, uploading);
                        string sentPath = Path.Combine(SentDirectory, Path.GetFileName(uploadingPath));
                        MoveDurably(uploadingPath, sentPath);
                        MoveDurably(receiptPath, sentPath + ".receipt");
                        completedFromReceipt++;
                    }
                    else
                    {
                        string pendingPath = Path.Combine(PendingDirectory, Path.GetFileName(uploadingPath));
                        MoveDurably(uploadingPath, pendingPath);
                        returnedToPending++;
                    }
                }
                catch (SnapshotQueueException exception)
                    when (exception.Code is "queue_payload_corrupt"
                        or "queue_payload_mismatch"
                        or "receipt_invalid"
                        or "receipt_hash_mismatch")
                {
                    await QuarantineAsync(uploadingPath, exception.Code, cancellationToken).ConfigureAwait(false);
                    string receiptPath = uploadingPath + ".receipt";
                    if (File.Exists(receiptPath))
                    {
                        MoveDurably(
                            receiptPath,
                            Path.Combine(QuarantineDirectory, Path.GetFileName(uploadingPath)) + ".receipt");
                    }
                    quarantinedItems++;
                }
            }

            foreach (string receiptPath in Directory.EnumerateFiles(UploadingDirectory, "*.receipt"))
            {
                string uploadingPayloadPath = receiptPath[..^".receipt".Length];
                string sentPayloadPath = Path.Combine(SentDirectory, Path.GetFileName(uploadingPayloadPath));
                if (!File.Exists(uploadingPayloadPath) && File.Exists(sentPayloadPath))
                    MoveDurably(receiptPath, sentPayloadPath + ".receipt");
            }

            return new QueueRecoveryResult(
                completedTemporaryEnqueues,
                returnedToPending,
                completedFromReceipt,
                quarantinedItems);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<QueueStatus> GetStatusAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            EnsureDirectories();
            long totalBytes = QueueBytes();
            return new QueueStatus(
                CountPayloads(PendingDirectory),
                CountPayloads(UploadingDirectory),
                CountPayloads(SentDirectory),
                CountPayloads(QuarantineDirectory),
                totalBytes,
                totalBytes >= options.WarningBytes);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<QueueCleanupResult> CleanupAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            EnsureDirectories();
            int deleted = 0;
            long bytesFreed = 0;
            long totalBytes = QueueBytes();
            DateTime retentionCutoff = (now - options.SentRetention).UtcDateTime;
            foreach (string sentPath in Directory.EnumerateFiles(SentDirectory, "*.json")
                .OrderBy(path => File.GetLastWriteTimeUtc(path)))
            {
                bool expired = File.GetLastWriteTimeUtc(sentPath) <= retentionCutoff;
                if (!expired && totalBytes <= options.MaximumBytes) continue;
                long itemBytes = FileSize(sentPath) + FileSize(sentPath + ".receipt");
                DeleteIfPresent(sentPath + ".receipt");
                DeleteIfPresent(sentPath);
                totalBytes -= itemBytes;
                bytesFreed += itemBytes;
                deleted++;
            }
            return new QueueCleanupResult(deleted, bytesFreed);
        }
        finally
        {
            gate.Release();
        }
    }

    private void EnsureDirectories()
    {
        directorySecurity.EnsureProtected(RootDirectory);
        Directory.CreateDirectory(PendingDirectory);
        Directory.CreateDirectory(UploadingDirectory);
        Directory.CreateDirectory(SentDirectory);
        Directory.CreateDirectory(QuarantineDirectory);
    }

    private async Task QuarantineAsync(string payloadPath, string code, CancellationToken cancellationToken)
    {
        string quarantinedPath = Path.Combine(QuarantineDirectory, Path.GetFileName(payloadPath));
        string reasonPath = quarantinedPath + ".reason";
        string temporaryReasonPath = reasonPath + ".tmp";
        QueueQuarantineReason reason = new(1, code, Path.GetFileName(payloadPath), DateTimeOffset.UtcNow);
        byte[] bytes = Utf8WithoutBom.GetBytes(JsonConvert.SerializeObject(reason, Formatting.None));
        DeleteIfPresent(temporaryReasonPath);
        try
        {
            await WriteThroughAsync(temporaryReasonPath, bytes, cancellationToken).ConfigureAwait(false);
            MoveDurably(temporaryReasonPath, reasonPath);
        }
        finally
        {
            DeleteIfPresent(temporaryReasonPath);
        }
        MoveDurably(payloadPath, quarantinedPath);
    }

    private static void ValidateSnapshot(AutoExportSnapshotV1 snapshot)
    {
        if (snapshot == null)
            throw new SnapshotQueueException("snapshot_missing", "A snapshot is required.");
        if (snapshot.SchemaVersion != 1)
            throw new SnapshotQueueException("contract_mismatch", "Only snapshot schema version 1 can be queued.");
        if (snapshot.CaptureId == Guid.Empty)
            throw new SnapshotQueueException("capture_id_invalid", "A non-empty capture ID is required.");
        if (!DateTime.TryParseExact(
            snapshot.TradingDate,
            "yyyy-MM-dd",
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out _))
        {
            throw new SnapshotQueueException("trading_date_invalid", "Trading date must use yyyy-MM-dd.");
        }
        if (snapshot.TimeZone != "America/New_York")
            throw new SnapshotQueueException("contract_mismatch", "Snapshot time zone must be America/New_York.");
        if (snapshot.Source == null
            || snapshot.Accounts == null
            || snapshot.Strategies == null
            || snapshot.Orders == null
            || snapshot.Executions == null)
        {
            throw new SnapshotQueueException("snapshot_incomplete", "Snapshot envelope sections cannot be null.");
        }
    }

    private static QueueItem ReadQueueItem(string path, QueueState state)
    {
        AutoExportSnapshotV1 snapshot = ReadSnapshot(path);
        string expectedName = FileName(snapshot.TradingDate, snapshot.CaptureId);
        if (!string.Equals(Path.GetFileName(path), expectedName, StringComparison.Ordinal))
            throw new SnapshotQueueException("queue_payload_mismatch", "Queued snapshot identifiers do not match its filename.");
        return new QueueItem(snapshot.CaptureId, snapshot.TradingDate, path, HashFile(path), state);
    }

    private static AutoExportSnapshotV1 ReadSnapshot(string path)
    {
        AutoExportSnapshotV1 snapshot;
        try
        {
            snapshot = JsonConvert.DeserializeObject<AutoExportSnapshotV1>(File.ReadAllText(path, Utf8WithoutBom));
            ValidateSnapshot(snapshot);
        }
        catch (Exception exception) when (exception is JsonException or SnapshotQueueException)
        {
            throw new SnapshotQueueException("queue_payload_corrupt", "A queued snapshot is invalid.");
        }
        return snapshot;
    }

    private static void ValidateReceipt(QueueReceipt receipt, QueueItem item)
    {
        if (receipt.CaptureId != item.CaptureId
            || !string.Equals(receipt.ContentSha256, item.ContentSha256, StringComparison.Ordinal))
        {
            throw new SnapshotQueueException("receipt_hash_mismatch", "The acknowledgement receipt does not match its queued payload.");
        }
    }

    private static void RequireStatePath(QueueItem item, QueueState expectedState, string expectedDirectory)
    {
        string itemDirectory = Path.GetDirectoryName(Path.GetFullPath(item.PayloadPath));
        if (item.State != expectedState
            || !string.Equals(itemDirectory, Path.GetFullPath(expectedDirectory), StringComparison.OrdinalIgnoreCase))
        {
            throw new SnapshotQueueException("queue_state_invalid", "Queue item is not in the expected state directory.");
        }
    }

    private static string FileName(string tradingDate, Guid captureId)
    {
        return $"{tradingDate}_{captureId:D}.json";
    }

    private static string HashFile(string path)
    {
        using FileStream stream = File.OpenRead(path);
        return Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
    }

    private long QueueBytes()
    {
        return Directory.EnumerateFiles(RootDirectory, "*", SearchOption.AllDirectories)
            .Sum(FileSize);
    }

    private void MakeCapacityFor(long requiredBytes)
    {
        if (requiredBytes > options.MaximumBytes)
            throw new SnapshotQueueException("queue_capacity_exceeded", "The snapshot is larger than the queue capacity limit.");

        long totalBytes = QueueBytes();
        foreach (string sentPath in Directory.EnumerateFiles(SentDirectory, "*.json")
            .OrderBy(path => File.GetLastWriteTimeUtc(path)))
        {
            if (totalBytes + requiredBytes <= options.MaximumBytes) break;
            long itemBytes = FileSize(sentPath) + FileSize(sentPath + ".receipt");
            DeleteIfPresent(sentPath + ".receipt");
            DeleteIfPresent(sentPath);
            totalBytes -= itemBytes;
        }

        if (totalBytes + requiredBytes > options.MaximumBytes)
        {
            throw new SnapshotQueueException(
                "queue_capacity_exceeded",
                "The queue is full of unsent data and cannot accept another snapshot.");
        }
    }

    private static int CountPayloads(string directory)
    {
        return Directory.EnumerateFiles(directory, "*.json").Count();
    }

    private static long FileSize(string path)
    {
        return File.Exists(path) ? new FileInfo(path).Length : 0;
    }

    private static async Task WriteThroughAsync(string path, byte[] bytes, CancellationToken cancellationToken)
    {
        await using FileStream stream = new(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            4096,
            FileOptions.Asynchronous | FileOptions.WriteThrough);
        await stream.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        stream.Flush(true);
    }

    private static void DeleteIfPresent(string path)
    {
        if (File.Exists(path)) File.Delete(path);
    }

    private void MoveDurably(string sourcePath, string destinationPath)
    {
        File.Move(sourcePath, destinationPath);
        string sourceDirectory = Path.GetDirectoryName(Path.GetFullPath(sourcePath));
        string destinationDirectory = Path.GetDirectoryName(Path.GetFullPath(destinationPath));
        durability.FlushDirectoryMetadata(sourceDirectory);
        if (!string.Equals(sourceDirectory, destinationDirectory, StringComparison.OrdinalIgnoreCase))
            durability.FlushDirectoryMetadata(destinationDirectory);
    }
}
