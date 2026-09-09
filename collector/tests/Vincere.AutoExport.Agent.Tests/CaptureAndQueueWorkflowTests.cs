using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Capture;
using Vincere.AutoExport.Agent.History;
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
        // Two real accounts, so the recorded count below proves the snapshot's
        // contents reached the history rather than matching an empty default.
        snapshot.Accounts.Add(new AccountRowV1 { AccountName = "APEX-1" });
        snapshot.Accounts.Add(new AccountRowV1 { AccountName = "APEX-2" });
        FakeQueueWriter queue = new();
        FakeCaptureHistory history = new();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(snapshot),
            queue,
            new FixedMachineGuidSource("  MACHINE-GUID  "),
            history,
            "1.2.3");
        CaptureRequestContext context = new(
            "2026-07-23",
            snapshot.CapturedAt,
            "America/New_York",
            IsManual: false);

        await workflow.CaptureAndQueueAsync(context);

        Assert.Same(snapshot, queue.Snapshot);
        // The machine id is "guid|name|installId" now: neither the Windows
        // MachineGuid nor the computer name is unique on this fleet. Two VPSes
        // for different clients both report guid 67731bcc... and both are named
        // SERVER. What this test cares about is that the guid this source
        // supplies is the one that goes on the wire.
        Assert.StartsWith("machine-guid|", queue.Snapshot.Source.MachineId);
        Assert.Equal("1.2.3", queue.Snapshot.Source.AgentVersion);
        Assert.Equal("0.4.0", queue.Snapshot.Source.AddonVersion);
        Assert.Equal("8.1.5.2", queue.Snapshot.Source.NinjaTraderVersion);

        // The queued day is recorded with what it actually held, so the setup
        // window can report "3 accounts" instead of just "something happened".
        CaptureHistoryEntry recorded = Assert.Single(history.Entries);
        Assert.Equal("2026-07-23", recorded.TradingDate);
        Assert.Equal(2, recorded.AccountCount);
        Assert.Null(recorded.ErrorCode);
    }

    [Fact]
    public async Task TradingDateMismatchIsRejectedBeforeQueueing()
    {
        FakeQueueWriter queue = new();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(Snapshot()),
            queue,
            new FixedMachineGuidSource("machine-guid"),
            new FakeCaptureHistory(),
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


    /// <summary>A snapshot carrying accounts with the unrealized values given.</summary>
    private static AutoExportSnapshotV1 SnapshotWithUnrealized(params decimal?[] unrealized)
    {
        AutoExportSnapshotV1 snapshot = Snapshot();
        for (int index = 0; index < unrealized.Length; index++)
        {
            snapshot.Accounts.Add(new AccountRowV1
            {
                AccountName = $"ACC{index}",
                UnrealizedPnl = unrealized[index],
            });
        }
        return snapshot;
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

    /* THE HEARTBEAT USED TO INVENT THE NinjaTrader VERSION.
     *
     * Program.cs passed the literal "8.1.0" for every machine on the desk, so
     * the CRM displayed a version nobody was running. A real one on this desk
     * reads 8.1.6.0, and it is in every capture already: the add-on reports it
     * and CapturePipeClient refuses a snapshot without one. */

    [Fact]
    public async Task HandsOverWhatTheAddOnSaysNinjaTraderIs()
    {
        AutoExportSnapshotV1 snapshot = Snapshot();
        var seen = new List<(string NinjaTrader, string AddOn)>();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(snapshot),
            new FakeQueueWriter(),
            new FixedMachineGuidSource("machine-guid"),
            new FakeCaptureHistory(),
            "1.2.3",
            (ninjaTrader, addOn) => seen.Add((ninjaTrader, addOn)));

        await workflow.CaptureAndQueueAsync(
            new CaptureRequestContext("2026-07-23", snapshot.CapturedAt, "America/New_York", IsManual: false));

        Assert.Equal(("8.1.5.2", "0.4.0"), Assert.Single(seen));
    }

    [Fact]
    public async Task ReportingTheEnvironmentNeverCostsTheCapture()
    {
        // The snapshot is the point. A listener that throws must not turn a
        // successful capture into a failed one, which would make the scheduler
        // retry a day it already collected.
        AutoExportSnapshotV1 snapshot = Snapshot();
        FakeQueueWriter queue = new();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(snapshot),
            queue,
            new FixedMachineGuidSource("machine-guid"),
            new FakeCaptureHistory(),
            "1.2.3",
            (_, _) => throw new InvalidOperationException("listener exploded"));

        await workflow.CaptureAndQueueAsync(
            new CaptureRequestContext("2026-07-23", snapshot.CapturedAt, "America/New_York", IsManual: false));

        Assert.Same(snapshot, queue.Snapshot);
    }

    [Fact]
    public async Task WorksWithNoListenerAtAll()
    {
        AutoExportSnapshotV1 snapshot = Snapshot();
        FakeQueueWriter queue = new();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(snapshot),
            queue,
            new FixedMachineGuidSource("machine-guid"),
            new FakeCaptureHistory(),
            "1.2.3");

        await workflow.CaptureAndQueueAsync(
            new CaptureRequestContext("2026-07-23", snapshot.CapturedAt, "America/New_York", IsManual: false));

        Assert.Same(snapshot, queue.Snapshot);
    }

    /* A CLOSE TAKEN WHILE THE TRADES WERE STILL OPEN IS NOT A CLOSE.
     *
     * 2026-09-08: the scheduled capture fired at 16:30:00 and reported -$2,064
     * for the day. The real number was -$1,319. The $745 difference was
     * unrealized PnL on three accounts whose closing fills landed at 16:32. A
     * capture from the same machine at 18:28 matched the manual export exactly,
     * and a CAM rebuilt the day by hand. */

    [Fact]
    public async Task QueuesTheSnapshotBeforeAskingForAnotherAttempt()
    {
        // THE ORDER IS THE WHOLE DESIGN. The snapshot reaches the queue first,
        // so nothing is lost and the day is never missed. The throw only leaves
        // the day unmarked so the scheduler tries again and the later, settled
        // capture supersedes this one.
        AutoExportSnapshotV1 snapshot = SnapshotWithUnrealized(235m, 0m);
        FakeQueueWriter queue = new();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(snapshot),
            queue,
            new FixedMachineGuidSource("machine-guid"),
            new FakeCaptureHistory(),
            "1.2.3");

        await Assert.ThrowsAsync<CaptureAttemptException>(() => workflow.CaptureAndQueueAsync(
            new CaptureRequestContext("2026-07-23", snapshot.CapturedAt, "America/New_York", IsManual: false)));

        Assert.Same(snapshot, queue.Snapshot);
    }

    [Fact]
    public async Task NamesTheReasonSoTheSchedulerAndTheLogAgree()
    {
        AutoExportSnapshotV1 snapshot = SnapshotWithUnrealized(-120m);
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(snapshot),
            new FakeQueueWriter(),
            new FixedMachineGuidSource("machine-guid"),
            new FakeCaptureHistory(),
            "1.2.3");

        CaptureAttemptException error = await Assert.ThrowsAsync<CaptureAttemptException>(
            () => workflow.CaptureAndQueueAsync(
                new CaptureRequestContext("2026-07-23", snapshot.CapturedAt, "America/New_York", IsManual: false)));

        Assert.Equal("positions_open", error.Code);
    }

    [Fact]
    public async Task AcceptsACaptureWhereEverythingHasSettled()
    {
        AutoExportSnapshotV1 snapshot = SnapshotWithUnrealized(0m, 0m);
        FakeQueueWriter queue = new();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(snapshot),
            queue,
            new FixedMachineGuidSource("machine-guid"),
            new FakeCaptureHistory(),
            "1.2.3");

        await workflow.CaptureAndQueueAsync(
            new CaptureRequestContext("2026-07-23", snapshot.CapturedAt, "America/New_York", IsManual: false));

        Assert.Same(snapshot, queue.Snapshot);
    }

    [Fact]
    public async Task TreatsAMissingUnrealizedValueAsSettledRatherThanOpen()
    {
        // A client whose export omits the field must not have every clean close
        // retried until the cutoff and then flagged.
        AutoExportSnapshotV1 snapshot = SnapshotWithUnrealized(null, null);
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(snapshot),
            new FakeQueueWriter(),
            new FixedMachineGuidSource("machine-guid"),
            new FakeCaptureHistory(),
            "1.2.3");

        await workflow.CaptureAndQueueAsync(
            new CaptureRequestContext("2026-07-23", snapshot.CapturedAt, "America/New_York", IsManual: false));
    }

    /* ONE CAPTURE CANNOT ANSWER BOTH QUESTIONS.
     *
     * The day's realized PnL is only right after the desk flattens, around
     * 16:32. The strategies are only visible before NinjaTrader disables them,
     * around 16:30, and disabling removes them from the account rather than
     * marking them off. Measured on one machine in one day: 14 strategies at
     * 09:21, 9 at 16:30, 0 at 18:28, every one Realtime and not one stopped.
     *
     * So moving the capture later to fix the money is exactly what emptied the
     * strategies column on every report. */

    private sealed class FakeObservations : IStrategyObservationStore
    {
        public StrategyObservation Saved { get; private set; }
        public StrategyObservation Stored { get; init; }

        public Task SaveAsync(StrategyObservation observation, CancellationToken cancellationToken = default)
        {
            if (observation?.Strategies is { Count: > 0 }) Saved = observation;
            return Task.CompletedTask;
        }

        public Task<StrategyObservation> LoadAsync(string tradingDate, CancellationToken cancellationToken = default)
        {
            return Task.FromResult(
                Stored != null && Stored.TradingDate == tradingDate ? Stored : null);
        }
    }

    private static StrategyRowV1 Strategy(string name) => new()
    {
        StrategyId = name,
        StrategyName = name,
        AccountName = "ACC0",
        Instrument = "MES SEP26",
        State = "Realtime",
        ParameterCaptureStatus = "captured",
    };

    [Fact]
    public async Task ACloseWithNoStrategiesCarriesTheOnesTheSessionSaw()
    {
        AutoExportSnapshotV1 snapshot = Snapshot();
        FakeQueueWriter queue = new();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(snapshot),
            queue,
            new FixedMachineGuidSource("machine-guid"),
            new FakeCaptureHistory(),
            "1.2.3",
            null,
            new FakeObservations
            {
                Stored = new StrategyObservation(
                    "2026-07-23",
                    snapshot.CapturedAt,
                    new[] { Strategy("0 - G4M-3.4"), Strategy("0 - URGO-4.5") }),
            });

        await workflow.CaptureAndQueueAsync(
            new CaptureRequestContext("2026-07-23", snapshot.CapturedAt, "America/New_York", IsManual: false));

        Assert.Equal(2, queue.Snapshot.Strategies.Count);
    }

    [Fact]
    public async Task NeverCarriesAnotherDaysStrategies()
    {
        // Yesterday's algos are not evidence about today, and a stale carry
        // forward is worse than an empty column because it looks right.
        AutoExportSnapshotV1 snapshot = Snapshot();
        FakeQueueWriter queue = new();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(snapshot),
            queue,
            new FixedMachineGuidSource("machine-guid"),
            new FakeCaptureHistory(),
            "1.2.3",
            null,
            new FakeObservations
            {
                Stored = new StrategyObservation(
                    "2026-07-22", snapshot.CapturedAt, new[] { Strategy("0 - G4M-3.4") }),
            });

        await workflow.CaptureAndQueueAsync(
            new CaptureRequestContext("2026-07-23", snapshot.CapturedAt, "America/New_York", IsManual: false));

        Assert.Empty(queue.Snapshot.Strategies);
    }

    [Fact]
    public async Task ACloseThatHasItsOwnStrategiesKeepsThemAndRefreshesTheStore()
    {
        AutoExportSnapshotV1 snapshot = Snapshot();
        snapshot.Strategies.Add(Strategy("0 - SYFY-1.4"));
        FakeObservations observations = new();
        FakeQueueWriter queue = new();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(snapshot),
            queue,
            new FixedMachineGuidSource("machine-guid"),
            new FakeCaptureHistory(),
            "1.2.3",
            null,
            observations);

        await workflow.CaptureAndQueueAsync(
            new CaptureRequestContext("2026-07-23", snapshot.CapturedAt, "America/New_York", IsManual: false));

        Assert.Single(queue.Snapshot.Strategies);
        Assert.Equal("2026-07-23", observations.Saved.TradingDate);
    }

    [Fact]
    public async Task ObservingQueuesNothingAndRecordsNoHistory()
    {
        // It runs on a machine that is trading. A convenience read must not
        // write a snapshot, mark a day, or disturb anything.
        AutoExportSnapshotV1 snapshot = Snapshot();
        snapshot.Strategies.Add(Strategy("0 - OGX-2.4"));
        FakeQueueWriter queue = new();
        FakeCaptureHistory history = new();
        FakeObservations observations = new();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(snapshot),
            queue,
            new FixedMachineGuidSource("machine-guid"),
            history,
            "1.2.3",
            null,
            observations);

        await workflow.ObserveStrategiesAsync("2026-07-23");

        Assert.Null(queue.Snapshot);
        Assert.Empty(history.Entries);
        Assert.Single(observations.Saved.Strategies);
    }

    [Fact]
    public async Task AnObservationThatSawNothingIsNotRecorded()
    {
        // Seeing none is not evidence that none were running, and writing it
        // would overwrite a real observation taken earlier the same day.
        FakeObservations observations = new();
        CaptureAndQueueWorkflow workflow = new(
            new FakeCaptureClient(Snapshot()),
            new FakeQueueWriter(),
            new FixedMachineGuidSource("machine-guid"),
            new FakeCaptureHistory(),
            "1.2.3",
            null,
            observations);

        await workflow.ObserveStrategiesAsync("2026-07-23");

        Assert.Null(observations.Saved);
    }
}
