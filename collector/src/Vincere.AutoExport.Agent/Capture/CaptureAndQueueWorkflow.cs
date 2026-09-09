using System;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
using Vincere.AutoExport.Agent.History;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Scheduling;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Contracts;

namespace Vincere.AutoExport.Agent.Capture;

public sealed class CaptureAndQueueWorkflow : ICaptureWorkflow
{
    private static readonly DateTimeZone NewYork =
        DateTimeZoneProviders.Tzdb[CaptureSchedule.TimeZoneId];
    private readonly INinjaTraderCaptureClient captureClient;
    private readonly ISnapshotQueueWriter queue;
    private readonly IMachineGuidSource machineGuidSource;
    private readonly ICaptureHistoryStore history;
    private readonly string agentVersion;

    /* WHERE THE REAL NinjaTrader VERSION COMES FROM.
     *
     * The heartbeat used to send the literal "8.1.0" for every machine on the
     * desk, so the CRM displayed a version nobody was running. The true one is
     * in every capture: the add-on reports it and CapturePipeClient refuses a
     * snapshot without one. This is the only place that both holds a snapshot
     * and runs on a schedule, so it is where the value is handed over.
     *
     * A callback rather than a reference to the state object, because this
     * class has no other reason to know the service exists. */
    private readonly Action<string, string> onEnvironmentObserved;

    public CaptureAndQueueWorkflow(
        INinjaTraderCaptureClient captureClient,
        ISnapshotQueueWriter queue,
        IMachineGuidSource machineGuidSource,
        ICaptureHistoryStore history,
        string agentVersion,
        Action<string, string> onEnvironmentObserved = null)
    {
        this.onEnvironmentObserved = onEnvironmentObserved;
        this.history = history ?? throw new ArgumentNullException(nameof(history));
        this.captureClient = captureClient ?? throw new ArgumentNullException(nameof(captureClient));
        this.queue = queue ?? throw new ArgumentNullException(nameof(queue));
        this.machineGuidSource = machineGuidSource ?? throw new ArgumentNullException(nameof(machineGuidSource));
        if (string.IsNullOrWhiteSpace(agentVersion))
            throw new ArgumentException("An agent version is required.", nameof(agentVersion));
        this.agentVersion = agentVersion;
    }

    public async Task CaptureAndQueueAsync(
        CaptureRequestContext context,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(context);
        AutoExportSnapshotV1 snapshot = await captureClient.CaptureAsync(cancellationToken)
            .ConfigureAwait(false);
        string capturedTradingDate = FormatDate(
            Instant.FromDateTimeOffset(snapshot.CapturedAt).InZone(NewYork).Date);
        if (!string.Equals(snapshot.TradingDate, context.TradingDate, StringComparison.Ordinal)
            || !string.Equals(capturedTradingDate, context.TradingDate, StringComparison.Ordinal)
            || !string.Equals(snapshot.TimeZone, context.TimeZone, StringComparison.Ordinal))
        {
            throw new CaptureAttemptException(
                "contract_mismatch",
                "The captured snapshot does not match the requested New York trading date.");
        }

        snapshot.Source.MachineId = MachineIdentity.ReadNormalized(machineGuidSource);
        snapshot.Source.AgentVersion = agentVersion;
        try
        {
            onEnvironmentObserved?.Invoke(
                snapshot.Source.NinjaTraderVersion,
                snapshot.Source.AddonVersion);
        }
        catch (Exception)
        {
            // Reporting what NinjaTrader is must never cost the capture. The
            // snapshot is what matters and it is about to be queued.
        }
        await queue.EnqueueAsync(snapshot, cancellationToken).ConfigureAwait(false);

        // The snapshot is queued, so the day is collected whatever happens next.
        // Recording it is a reporting nicety and must never undo that: a failure
        // to write the history file cannot be allowed to surface as a capture
        // error, which would make the scheduler retry an already-queued day.
        try
        {
            await history.RecordCapturedAsync(
                context.TradingDate,
                snapshot.CapturedAt,
                snapshot.Accounts?.Count ?? 0,
                cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
        }
    }

    private static string FormatDate(LocalDate date)
    {
        return $"{date.Year:D4}-{date.Month:D2}-{date.Day:D2}";
    }
}
