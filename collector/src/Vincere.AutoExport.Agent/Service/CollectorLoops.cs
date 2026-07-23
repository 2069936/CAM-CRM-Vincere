using System;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Scheduling;
using Vincere.AutoExport.Agent.Security;

namespace Vincere.AutoExport.Agent.Service;

public interface ICollectorClock
{
    Instant GetCurrentInstant();
    DateTimeOffset GetCurrentDateTimeOffset();
}

public sealed class SystemCollectorClock : ICollectorClock
{
    public Instant GetCurrentInstant() => SystemClock.Instance.GetCurrentInstant();
    public DateTimeOffset GetCurrentDateTimeOffset() => DateTimeOffset.UtcNow;
}

public sealed record CollectorStatusSnapshot(
    DateTimeOffset? LastCaptureAt,
    DateTimeOffset? LastSuccessAt,
    string LastErrorCode,
    string LastErrorMessage,
    bool? AddonAvailable,
    bool UpdateRequired,
    string DeviceStatus);

public sealed class CollectorState
{
    private readonly object gate = new();
    private CollectorStatusSnapshot value = new(null, null, null, null, null, false, "unpaired");

    public CollectorStatusSnapshot Snapshot()
    {
        lock (gate) return value;
    }

    public void RecordCapture(CaptureRunResult result, DateTimeOffset attemptedAt)
    {
        ArgumentNullException.ThrowIfNull(result);
        lock (gate)
        {
            bool? addonAvailable = result.ErrorCode == "addon_unavailable"
                ? false
                : result.CaptureQueued ? true : value.AddonAvailable;
            value = value with
            {
                LastCaptureAt = result.Decision.Kind == CaptureScheduleDecisionKind.Due
                    ? attemptedAt
                    : value.LastCaptureAt,
                LastErrorCode = result.CaptureQueued ? null : result.ErrorCode ?? value.LastErrorCode,
                LastErrorMessage = result.CaptureQueued
                    ? null
                    : result.ErrorCode == null ? value.LastErrorMessage : "The scheduled capture did not complete.",
                AddonAvailable = addonAvailable,
            };
        }
    }

    public void RecordUploadSuccess(DateTimeOffset acknowledgedAt)
    {
        lock (gate) value = value with { LastSuccessAt = acknowledgedAt };
    }

    public void RecordError(string code, string safeMessage)
    {
        lock (gate) value = value with { LastErrorCode = code, LastErrorMessage = safeMessage };
    }

    public void RecordHeartbeat(HeartbeatResult heartbeat)
    {
        ArgumentNullException.ThrowIfNull(heartbeat);
        lock (gate) value = value with { DeviceStatus = heartbeat.Status, UpdateRequired = heartbeat.UpdateRequired };
    }

    public void RecordUnpaired()
    {
        lock (gate) value = value with { DeviceStatus = "unpaired" };
    }
}

public sealed class ScheduledCaptureLoop : ICollectorLoop
{
    private readonly ICaptureScheduler scheduler;
    private readonly ICollectorClock clock;
    private readonly CollectorState state;

    public ScheduledCaptureLoop(ICaptureScheduler scheduler, ICollectorClock clock, CollectorState state)
    {
        this.scheduler = scheduler ?? throw new ArgumentNullException(nameof(scheduler));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.state = state ?? throw new ArgumentNullException(nameof(state));
    }

    public string Name => "scheduler";
    public TimeSpan Interval => TimeSpan.FromSeconds(15);

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        Instant now = clock.GetCurrentInstant();
        CaptureRunResult result = await scheduler.RunScheduledAsync(now, cancellationToken).ConfigureAwait(false);
        state.RecordCapture(result, now.ToDateTimeOffset());
    }
}

public sealed class UploadLoop : ICollectorLoop
{
    private readonly ICollectorQueue queue;
    private readonly ICollectorCrmClient crm;
    private readonly IDeviceTokenStore tokenStore;
    private readonly CollectorState state;

    public UploadLoop(ICollectorQueue queue, ICollectorCrmClient crm, IDeviceTokenStore tokenStore, CollectorState state)
    {
        this.queue = queue ?? throw new ArgumentNullException(nameof(queue));
        this.crm = crm ?? throw new ArgumentNullException(nameof(crm));
        this.tokenStore = tokenStore ?? throw new ArgumentNullException(nameof(tokenStore));
        this.state = state ?? throw new ArgumentNullException(nameof(state));
    }

    public string Name => "uploader";
    public TimeSpan Interval => TimeSpan.FromSeconds(10);

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(await tokenStore.LoadTokenAsync(cancellationToken).ConfigureAwait(false)))
        {
            state.RecordUnpaired();
            return;
        }

        QueueItem item = await queue.ClaimNextAsync(cancellationToken).ConfigureAwait(false);
        if (item == null) return;
        try
        {
            UploadAcknowledgement acknowledgement = await crm.UploadAsync(item, cancellationToken).ConfigureAwait(false);
            await queue.CompleteAsync(
                item,
                acknowledgement.BatchId,
                acknowledgement.ContentSha256,
                acknowledgement.AcknowledgedAt,
                cancellationToken).ConfigureAwait(false);
            state.RecordUploadSuccess(acknowledgement.AcknowledgedAt);
        }
        catch (CrmClientException exception)
        {
            if (exception.Disposition == CrmFailureDisposition.RePair)
            {
                await queue.RetryAsync(item, cancellationToken).ConfigureAwait(false);
                await tokenStore.DeleteTokenAsync(cancellationToken).ConfigureAwait(false);
                state.RecordUnpaired();
            }
            else if (exception.Disposition == CrmFailureDisposition.Retry)
            {
                await queue.RetryAsync(item, cancellationToken).ConfigureAwait(false);
            }
            else
            {
                await queue.QuarantineAsync(item, exception.Code, cancellationToken).ConfigureAwait(false);
            }
            state.RecordError(exception.Code, exception.Message);
        }
    }
}

public sealed class HeartbeatLoop : ICollectorLoop
{
    private readonly ICollectorQueue queue;
    private readonly ICollectorCrmClient crm;
    private readonly IDeviceTokenStore tokenStore;
    private readonly CollectorState state;
    private readonly string agentVersion;
    private readonly string addonVersion;
    private readonly string ninjaTraderVersion;

    public HeartbeatLoop(
        ICollectorQueue queue,
        ICollectorCrmClient crm,
        IDeviceTokenStore tokenStore,
        CollectorState state,
        string agentVersion,
        string addonVersion,
        string ninjaTraderVersion)
    {
        this.queue = queue ?? throw new ArgumentNullException(nameof(queue));
        this.crm = crm ?? throw new ArgumentNullException(nameof(crm));
        this.tokenStore = tokenStore ?? throw new ArgumentNullException(nameof(tokenStore));
        this.state = state ?? throw new ArgumentNullException(nameof(state));
        this.agentVersion = agentVersion;
        this.addonVersion = addonVersion;
        this.ninjaTraderVersion = ninjaTraderVersion;
    }

    public string Name => "heartbeat";
    public TimeSpan Interval => TimeSpan.FromMinutes(1);

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(await tokenStore.LoadTokenAsync(cancellationToken).ConfigureAwait(false)))
        {
            state.RecordUnpaired();
            return;
        }
        QueueStatus queueStatus = await queue.GetStatusAsync(cancellationToken).ConfigureAwait(false);
        CollectorStatusSnapshot current = state.Snapshot();
        HeartbeatPayload payload = new(
            agentVersion,
            addonVersion,
            ninjaTraderVersion,
            current.LastCaptureAt,
            current.LastSuccessAt,
            current.LastErrorCode,
            current.LastErrorMessage,
            queueStatus.PendingCount + queueStatus.UploadingCount,
            queueStatus.TotalBytes,
            current.AddonAvailable);
        try
        {
            HeartbeatResult result = await crm.SendHeartbeatAsync(payload, cancellationToken).ConfigureAwait(false);
            state.RecordHeartbeat(result);
        }
        catch (CrmClientException exception) when (exception.Disposition == CrmFailureDisposition.RePair)
        {
            await tokenStore.DeleteTokenAsync(cancellationToken).ConfigureAwait(false);
            state.RecordUnpaired();
            state.RecordError(exception.Code, exception.Message);
        }
        catch (CrmClientException exception)
        {
            state.RecordError(exception.Code, exception.Message);
        }
    }
}

public sealed class QueueRecoveryLoop : ICollectorLoop
{
    private readonly ICollectorQueue queue;
    private int recovered;

    public QueueRecoveryLoop(ICollectorQueue queue) => this.queue = queue ?? throw new ArgumentNullException(nameof(queue));

    public string Name => "queue-recovery";
    public TimeSpan Interval => TimeSpan.FromHours(24);

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        if (Interlocked.Exchange(ref recovered, 1) != 0) return;
        try
        {
            await queue.RecoverAsync(cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            Interlocked.Exchange(ref recovered, 0);
            throw;
        }
    }
}
