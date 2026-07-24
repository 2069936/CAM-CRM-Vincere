using System;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
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
    private readonly string agentVersion;

    public CaptureAndQueueWorkflow(
        INinjaTraderCaptureClient captureClient,
        ISnapshotQueueWriter queue,
        IMachineGuidSource machineGuidSource,
        string agentVersion)
    {
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
        await queue.EnqueueAsync(snapshot, cancellationToken).ConfigureAwait(false);
    }

    private static string FormatDate(LocalDate date)
    {
        return $"{date.Year:D4}-{date.Month:D2}-{date.Day:D2}";
    }
}
