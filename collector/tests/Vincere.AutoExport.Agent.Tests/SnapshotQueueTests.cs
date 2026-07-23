using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Contracts;
using Vincere.AutoExport.Queue.CrashHost;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class SnapshotQueueTests : IDisposable
{
    private readonly string directory = Path.Combine(
        Path.GetTempPath(), "vincere-queue-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task EnqueueFlushesOneValidatedSnapshotIntoPendingWithDeterministicName()
    {
        SnapshotQueue queue = CreateQueue();
        AutoExportSnapshotV1 snapshot = Snapshot();

        QueueEnqueueResult result = await queue.EnqueueAsync(snapshot);

        string expectedName = $"2026-07-23_{snapshot.CaptureId:D}.json";
        Assert.False(result.Duplicate);
        Assert.Equal(QueueState.Pending, result.Item.State);
        Assert.Equal(expectedName, Path.GetFileName(result.Item.PayloadPath));
        Assert.True(File.Exists(Path.Combine(queue.PendingDirectory, expectedName)));
        Assert.Empty(Directory.EnumerateFiles(queue.PendingDirectory, "*.tmp"));
        Assert.Equal(64, result.Item.ContentSha256.Length);
    }

    [Fact]
    public async Task ExactCaptureRetryIsDuplicateButChangedPayloadWithSameIdIsConflict()
    {
        SnapshotQueue queue = CreateQueue();
        AutoExportSnapshotV1 snapshot = Snapshot();
        QueueEnqueueResult first = await queue.EnqueueAsync(snapshot);

        QueueEnqueueResult duplicate = await queue.EnqueueAsync(snapshot);
        snapshot.CapturedAt = snapshot.CapturedAt.AddSeconds(1);
        SnapshotQueueException conflict = await Assert.ThrowsAsync<SnapshotQueueException>(
            () => queue.EnqueueAsync(snapshot));

        Assert.True(duplicate.Duplicate);
        Assert.Equal(first.Item.ContentSha256, duplicate.Item.ContentSha256);
        Assert.Equal("capture_id_conflict", conflict.Code);
    }

    [Fact]
    public async Task ClaimMovesPendingToUploadingAndRetryReturnsTheSameItem()
    {
        SnapshotQueue queue = CreateQueue();
        QueueEnqueueResult enqueued = await queue.EnqueueAsync(Snapshot());

        QueueItem claimed = await queue.ClaimNextAsync();

        Assert.NotNull(claimed);
        Assert.Equal(QueueState.Uploading, claimed.State);
        Assert.False(File.Exists(enqueued.Item.PayloadPath));
        Assert.True(File.Exists(claimed.PayloadPath));
        Assert.Null(await queue.ClaimNextAsync());

        QueueItem retried = await queue.RetryAsync(claimed);
        Assert.Equal(QueueState.Pending, retried.State);
        Assert.True(File.Exists(retried.PayloadPath));
    }

    [Fact]
    public async Task CompleteWritesDurableReceiptBeforeMovingPayloadToSent()
    {
        SnapshotQueue queue = CreateQueue();
        await queue.EnqueueAsync(Snapshot());
        QueueItem claimed = await queue.ClaimNextAsync();
        DateTimeOffset acknowledgedAt = new(2026, 7, 23, 16, 46, 0, TimeSpan.FromHours(-4));

        QueueItem sent = await queue.CompleteAsync(
            claimed,
            "batch-123",
            claimed.ContentSha256,
            acknowledgedAt);

        Assert.Equal(QueueState.Sent, sent.State);
        Assert.True(File.Exists(sent.PayloadPath));
        Assert.False(File.Exists(claimed.PayloadPath));
        string receiptPath = sent.PayloadPath + ".receipt";
        Assert.True(File.Exists(receiptPath));
        QueueReceipt receipt = queue.ReadReceipt(receiptPath);
        Assert.Equal(claimed.CaptureId, receipt.CaptureId);
        Assert.Equal("batch-123", receipt.BatchId);
        Assert.Equal(claimed.ContentSha256, receipt.ContentSha256);
        Assert.Equal(acknowledgedAt, receipt.AcknowledgedAt);
    }

    [Fact]
    public async Task RejectedUploadIsQuarantinedWithItsStableReasonAndPayloadIntact()
    {
        SnapshotQueue queue = CreateQueue();
        await queue.EnqueueAsync(Snapshot());
        QueueItem claimed = await queue.ClaimNextAsync();

        QueueItem quarantined = await queue.QuarantineAsync(claimed, "unsupported_schema_version");

        Assert.Equal(QueueState.Quarantine, quarantined.State);
        Assert.True(File.Exists(quarantined.PayloadPath));
        Assert.False(File.Exists(claimed.PayloadPath));
        Assert.Equal(
            "unsupported_schema_version",
            queue.ReadQuarantineReason(quarantined.PayloadPath + ".reason").Code);
    }

    [Fact]
    public async Task RecoveryReturnsUnacknowledgedUploadToPending()
    {
        SnapshotQueue queue = CreateQueue();
        await queue.EnqueueAsync(Snapshot());
        QueueItem claimed = await queue.ClaimNextAsync();

        QueueRecoveryResult recovery = await queue.RecoverAsync();

        Assert.Equal(1, recovery.ReturnedToPending);
        Assert.Equal(0, recovery.CompletedFromReceipt);
        Assert.False(File.Exists(claimed.PayloadPath));
        Assert.Single(Directory.EnumerateFiles(queue.PendingDirectory, "*.json"));
    }

    [Fact]
    public async Task RecoveryCompletesAcknowledgedUploadAndFinishesInterruptedEnqueue()
    {
        SnapshotQueue queue = CreateQueue();
        AutoExportSnapshotV1 firstSnapshot = Snapshot();
        await queue.EnqueueAsync(firstSnapshot);
        QueueItem claimed = await queue.ClaimNextAsync();
        QueueReceipt receipt = new(
            1,
            claimed.CaptureId,
            "batch-recovered",
            claimed.ContentSha256,
            new DateTimeOffset(2026, 7, 23, 16, 47, 0, TimeSpan.FromHours(-4)));
        await File.WriteAllTextAsync(
            claimed.PayloadPath + ".receipt",
            Newtonsoft.Json.JsonConvert.SerializeObject(receipt));

        AutoExportSnapshotV1 secondSnapshot = Snapshot();
        QueueEnqueueResult second = await queue.EnqueueAsync(secondSnapshot);
        string interruptedTemporaryPath = second.Item.PayloadPath + ".tmp";
        File.Move(second.Item.PayloadPath, interruptedTemporaryPath);

        QueueRecoveryResult recovery = await queue.RecoverAsync();

        Assert.Equal(1, recovery.CompletedFromReceipt);
        Assert.Equal(1, recovery.CompletedTemporaryEnqueues);
        Assert.True(File.Exists(Path.Combine(queue.SentDirectory, Path.GetFileName(claimed.PayloadPath))));
        Assert.True(File.Exists(Path.Combine(queue.SentDirectory, Path.GetFileName(claimed.PayloadPath)) + ".receipt"));
        Assert.True(File.Exists(second.Item.PayloadPath));
        Assert.False(File.Exists(interruptedTemporaryPath));
    }

    [Fact]
    public async Task ClaimQuarantinesCorruptPayloadWithReasonAndContinues()
    {
        SnapshotQueue queue = CreateQueue();
        Guid corruptId = Guid.Parse("00000000-0000-0000-0000-000000000001");
        Guid validId = Guid.Parse("00000000-0000-0000-0000-000000000002");
        QueueEnqueueResult corrupt = await queue.EnqueueAsync(Snapshot(corruptId));
        await File.WriteAllTextAsync(corrupt.Item.PayloadPath, "{not-json");
        await queue.EnqueueAsync(Snapshot(validId));

        QueueItem claimed = await queue.ClaimNextAsync();

        Assert.Equal(validId, claimed.CaptureId);
        string quarantinedPath = Path.Combine(queue.QuarantineDirectory, Path.GetFileName(corrupt.Item.PayloadPath));
        Assert.True(File.Exists(quarantinedPath));
        Assert.True(File.Exists(quarantinedPath + ".reason"));
        QueueQuarantineReason reason = queue.ReadQuarantineReason(quarantinedPath + ".reason");
        Assert.Equal("queue_payload_corrupt", reason.Code);
        Assert.Equal(Path.GetFileName(corrupt.Item.PayloadPath), reason.OriginalFileName);
    }

    [Fact]
    public async Task EnqueueDetectsDuplicatesAndConflictsAcrossUploadingAndSent()
    {
        SnapshotQueue queue = CreateQueue();
        AutoExportSnapshotV1 snapshot = Snapshot();
        await queue.EnqueueAsync(snapshot);
        QueueItem uploading = await queue.ClaimNextAsync();

        QueueEnqueueResult uploadingDuplicate = await queue.EnqueueAsync(snapshot);
        await queue.CompleteAsync(
            uploading,
            "batch-duplicate",
            uploading.ContentSha256,
            new DateTimeOffset(2026, 7, 23, 16, 48, 0, TimeSpan.FromHours(-4)));
        QueueEnqueueResult sentDuplicate = await queue.EnqueueAsync(snapshot);
        snapshot.CapturedAt = snapshot.CapturedAt.AddMinutes(1);
        SnapshotQueueException conflict = await Assert.ThrowsAsync<SnapshotQueueException>(
            () => queue.EnqueueAsync(snapshot));

        Assert.True(uploadingDuplicate.Duplicate);
        Assert.Equal(QueueState.Uploading, uploadingDuplicate.Item.State);
        Assert.True(sentDuplicate.Duplicate);
        Assert.Equal(QueueState.Sent, sentDuplicate.Item.State);
        Assert.Equal("capture_id_conflict", conflict.Code);
    }

    [Fact]
    public async Task ConcurrentQueueInstancesClaimEachCaptureAtMostOnce()
    {
        SnapshotQueue firstWorker = CreateQueue();
        SnapshotQueue secondWorker = CreateQueue();
        for (int index = 1; index <= 12; index++)
        {
            Guid captureId = Guid.Parse($"00000000-0000-0000-0000-{index:D12}");
            await firstWorker.EnqueueAsync(Snapshot(captureId));
        }

        Task<QueueItem>[] claims = Enumerable.Range(0, 20)
            .Select(index => (index % 2 == 0 ? firstWorker : secondWorker).ClaimNextAsync())
            .ToArray();
        QueueItem[] results = await Task.WhenAll(claims);
        QueueItem[] claimed = results.Where(item => item != null).ToArray();

        Assert.Equal(12, claimed.Length);
        Assert.Equal(12, claimed.Select(item => item.CaptureId).Distinct().Count());
        Assert.Empty(Directory.EnumerateFiles(firstWorker.PendingDirectory, "*.json"));
        Assert.Equal(12, Directory.EnumerateFiles(firstWorker.UploadingDirectory, "*.json").Count());
    }

    [Fact]
    public async Task CleanupDeletesExpiredSentDataButRetainsUnsentAndReportsCapacityWarning()
    {
        SnapshotQueue queue = new(
            Path.Combine(directory, "queue"),
            new TestDirectorySecurity(),
            new SnapshotQueueOptions(
                MaximumBytes: 10_000_000,
                WarningBytes: 1,
                SentRetention: TimeSpan.FromDays(7)));
        QueueEnqueueResult sentEnqueue = await queue.EnqueueAsync(Snapshot());
        QueueItem uploading = await queue.ClaimNextAsync();
        QueueItem sent = await queue.CompleteAsync(
            uploading,
            "batch-old",
            uploading.ContentSha256,
            new DateTimeOffset(2026, 7, 1, 16, 45, 0, TimeSpan.FromHours(-4)));
        QueueEnqueueResult pending = await queue.EnqueueAsync(Snapshot());
        DateTime oldTimestamp = new DateTime(2026, 7, 1, 20, 45, 0, DateTimeKind.Utc);
        File.SetLastWriteTimeUtc(sent.PayloadPath, oldTimestamp);
        File.SetLastWriteTimeUtc(sent.PayloadPath + ".receipt", oldTimestamp);

        QueueStatus before = await queue.GetStatusAsync();
        QueueCleanupResult cleanup = await queue.CleanupAsync(
            new DateTimeOffset(2026, 7, 23, 20, 45, 0, TimeSpan.Zero));

        Assert.True(before.CapacityWarning);
        Assert.Equal(1, before.PendingCount);
        Assert.Equal(1, before.SentCount);
        Assert.Equal(1, cleanup.DeletedSentItems);
        Assert.False(File.Exists(sent.PayloadPath));
        Assert.False(File.Exists(sent.PayloadPath + ".receipt"));
        Assert.True(File.Exists(pending.Item.PayloadPath));
        Assert.False(sentEnqueue.Duplicate);
    }

    [Fact]
    public async Task EnqueueStopsBeforeExceedingHardCapacityLimit()
    {
        SnapshotQueue queue = new(
            Path.Combine(directory, "queue"),
            new TestDirectorySecurity(),
            new SnapshotQueueOptions(
                MaximumBytes: 1,
                WarningBytes: 1,
                SentRetention: TimeSpan.FromDays(30)));

        SnapshotQueueException error = await Assert.ThrowsAsync<SnapshotQueueException>(
            () => queue.EnqueueAsync(Snapshot()));

        Assert.Equal("queue_capacity_exceeded", error.Code);
        Assert.Empty(Directory.EnumerateFiles(queue.PendingDirectory));
    }

    [Fact]
    public async Task RecoveryQuarantinesCorruptTemporaryAndUploadingPayloadsWithoutBlockingValidWork()
    {
        SnapshotQueue queue = CreateQueue();
        QueueEnqueueResult interrupted = await queue.EnqueueAsync(Snapshot());
        string corruptTemporaryPath = interrupted.Item.PayloadPath + ".tmp";
        File.Move(interrupted.Item.PayloadPath, corruptTemporaryPath);
        await File.WriteAllTextAsync(corruptTemporaryPath, "bad temporary payload");

        await queue.EnqueueAsync(Snapshot());
        QueueItem corruptUploading = await queue.ClaimNextAsync();
        await File.WriteAllTextAsync(corruptUploading.PayloadPath, "bad uploading payload");
        QueueEnqueueResult valid = await queue.EnqueueAsync(Snapshot());

        QueueRecoveryResult recovery = await queue.RecoverAsync();

        Assert.Equal(2, recovery.QuarantinedItems);
        Assert.True(File.Exists(valid.Item.PayloadPath));
        Assert.Equal(2, Directory.EnumerateFiles(queue.QuarantineDirectory)
            .Count(path => !path.EndsWith(".reason", StringComparison.Ordinal)));
    }

    [Fact]
    public async Task RecoveryQuarantinesPayloadWhoseAcknowledgementReceiptIsInvalid()
    {
        SnapshotQueue queue = CreateQueue();
        await queue.EnqueueAsync(Snapshot());
        QueueItem uploading = await queue.ClaimNextAsync();
        await File.WriteAllTextAsync(uploading.PayloadPath + ".receipt", "{invalid-receipt");
        QueueEnqueueResult valid = await queue.EnqueueAsync(Snapshot());

        QueueRecoveryResult recovery = await queue.RecoverAsync();

        Assert.Equal(1, recovery.QuarantinedItems);
        string quarantinedPath = Path.Combine(queue.QuarantineDirectory, Path.GetFileName(uploading.PayloadPath));
        Assert.True(File.Exists(quarantinedPath));
        Assert.True(File.Exists(quarantinedPath + ".receipt"));
        Assert.Equal(
            "receipt_invalid",
            queue.ReadQuarantineReason(quarantinedPath + ".reason").Code);
        Assert.True(File.Exists(valid.Item.PayloadPath));
    }

    [Fact]
    public async Task EnqueueFlushesPendingDirectoryMetadataAfterAtomicRename()
    {
        RecordingQueueDurability durability = new();
        SnapshotQueue queue = new(
            Path.Combine(directory, "queue"),
            new TestDirectorySecurity(),
            durability: durability);

        await queue.EnqueueAsync(Snapshot());

        Assert.Contains(queue.PendingDirectory, durability.FlushedDirectories);
    }

    [Fact]
    public async Task QueueRemainsRecoverableWhenAgentProcessIsKilledAfterAtomicRename()
    {
        string queueRoot = Path.Combine(directory, "process-kill-queue");
        string readyPath = Path.Combine(directory, "kill.ready");
        string dotnetHost = Environment.GetEnvironmentVariable("DOTNET_HOST_PATH")
            ?? Environment.ProcessPath
            ?? throw new InvalidOperationException("Unable to locate the dotnet host.");
        ProcessStartInfo startInfo = new()
        {
            FileName = dotnetHost,
            UseShellExecute = false,
        };
        startInfo.ArgumentList.Add(typeof(CrashHostMarker).Assembly.Location);
        startInfo.ArgumentList.Add(queueRoot);
        startInfo.ArgumentList.Add(readyPath);
        using Process process = Process.Start(startInfo)
            ?? throw new InvalidOperationException("Unable to start the queue crash host.");
        try
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(15);
            while (!File.Exists(readyPath) && !process.HasExited && DateTime.UtcNow < deadline)
                await Task.Delay(20);
            Assert.True(File.Exists(readyPath), "Crash host did not reach the post-rename fault point.");
        }
        finally
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
            await process.WaitForExitAsync();
        }

        SnapshotQueue recoveredQueue = new(queueRoot, new TestDirectorySecurity());
        QueueRecoveryResult recovery = await recoveredQueue.RecoverAsync();
        QueueItem claimed = await recoveredQueue.ClaimNextAsync();

        Assert.Equal(0, recovery.QuarantinedItems);
        Assert.NotNull(claimed);
        Assert.Equal(QueueState.Uploading, claimed.State);
    }

    public void Dispose()
    {
        if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
    }

    private SnapshotQueue CreateQueue()
    {
        return new SnapshotQueue(Path.Combine(directory, "queue"), new TestDirectorySecurity());
    }

    private static AutoExportSnapshotV1 Snapshot(Guid? captureId = null)
    {
        return new AutoExportSnapshotV1
        {
            SchemaVersion = 1,
            CaptureId = captureId ?? Guid.NewGuid(),
            CapturedAt = new DateTimeOffset(2026, 7, 23, 16, 45, 0, TimeSpan.FromHours(-4)),
            TradingDate = "2026-07-23",
            TimeZone = "America/New_York",
            Source = new SourceMetadataV1
            {
                MachineId = "machine-redacted",
                AgentVersion = "0.1.0",
                AddonVersion = "0.1.0",
                NinjaTraderVersion = "8.1.5.2",
            },
            Accounts = new List<AccountRowV1>(),
            Strategies = new List<StrategyRowV1>(),
            Orders = new List<OrderRowV1>(),
            Executions = new List<ExecutionRowV1>(),
        };
    }

    private sealed class TestDirectorySecurity : IAgentDirectorySecurity
    {
        public void EnsureProtected(string path) => Directory.CreateDirectory(path);
    }

    private sealed class RecordingQueueDurability : IQueueDurability
    {
        public List<string> FlushedDirectories { get; } = new();

        public void FlushDirectoryMetadata(string directoryPath)
        {
            FlushedDirectories.Add(directoryPath);
        }
    }
}
