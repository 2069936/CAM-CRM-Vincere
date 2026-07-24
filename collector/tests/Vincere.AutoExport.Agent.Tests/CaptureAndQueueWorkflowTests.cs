using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Capture;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Scheduling;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class CaptureAndQueueWorkflowTests
{
    [Fact]
    public async Task AgentAddsMachineAndAgentMetadataBeforeDurableEnqueue()
    {
        AutoExportSnapshotV1 snapshot = Snapshot();
        FakeQueueWriter queue = new();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(snapshot),
            queue,
            new FixedMachineGuidSource("  MACHINE-GUID  "),
            "1.2.3");
        CaptureRequestContext context = new(
            "2026-07-23",
            snapshot.CapturedAt,
            "America/New_York",
            IsManual: false);

        await workflow.CaptureAndQueueAsync(context);

        Assert.Same(snapshot, queue.Snapshot);
        Assert.Equal("machine-guid", queue.Snapshot.Source.MachineId);
        Assert.Equal("1.2.3", queue.Snapshot.Source.AgentVersion);
        Assert.Equal("0.4.0", queue.Snapshot.Source.AddonVersion);
        Assert.Equal("8.1.5.2", queue.Snapshot.Source.NinjaTraderVersion);
    }

    [Fact]
    public async Task TradingDateMismatchIsRejectedBeforeQueueing()
    {
        FakeQueueWriter queue = new();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(Snapshot()),
            queue,
            new FixedMachineGuidSource("machine-guid"),
            "1.2.3");
        CaptureRequestContext context = new(
            "2026-07-24",
            new DateTimeOffset(2026, 7, 24, 16, 45, 0, TimeSpan.FromHours(-4)),
            "America/New_York",
            IsManual: false);

        CaptureAttemptException error = await Assert.ThrowsAsync<CaptureAttemptException>(
            () => workflow.CaptureAndQueueAsync(context));

        Assert.Equal("contract_mismatch", error.Code);
        Assert.Null(queue.Snapshot);
    }

    private static AutoExportSnapshotV1 Snapshot()
    {
        return new AutoExportSnapshotV1
        {
            SchemaVersion = 1,
            CaptureId = Guid.NewGuid(),
            CapturedAt = new DateTimeOffset(2026, 7, 23, 16, 45, 2, TimeSpan.FromHours(-4)),
            TradingDate = "2026-07-23",
            TimeZone = "America/New_York",
            Source = new SourceMetadataV1
            {
                MachineId = null,
                AgentVersion = null,
                AddonVersion = "0.4.0",
                NinjaTraderVersion = "8.1.5.2",
            },
            Accounts = new List<AccountRowV1>(),
            Strategies = new List<StrategyRowV1>(),
            Orders = new List<OrderRowV1>(),
            Executions = new List<ExecutionRowV1>(),
        };
    }

    private sealed class FakeCaptureClient : INinjaTraderCaptureClient
    {
        private readonly AutoExportSnapshotV1 snapshot;

        public FakeCaptureClient(AutoExportSnapshotV1 snapshot) => this.snapshot = snapshot;

        public Task<AutoExportSnapshotV1> CaptureAsync(CancellationToken cancellationToken = default)
        {
            return Task.FromResult(snapshot);
        }
    }

    private sealed class FakeQueueWriter : ISnapshotQueueWriter
    {
        public AutoExportSnapshotV1 Snapshot { get; private set; }

        public Task<QueueEnqueueResult> EnqueueAsync(
            AutoExportSnapshotV1 snapshot,
            CancellationToken cancellationToken = default)
        {
            Snapshot = snapshot;
            QueueItem item = new(
                snapshot.CaptureId,
                snapshot.TradingDate,
                "pending.json",
                new string('0', 64),
                QueueState.Pending);
            return Task.FromResult(new QueueEnqueueResult(item, false));
        }
    }

    private sealed class FixedMachineGuidSource : IMachineGuidSource
    {
        private readonly string value;

        public FixedMachineGuidSource(string value) => this.value = value;

        public string ReadMachineGuid() => value;
    }
}
