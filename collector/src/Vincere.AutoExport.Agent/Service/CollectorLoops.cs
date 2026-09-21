using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
using NodaTime.Text;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Diagnostics;
using Vincere.AutoExport.Agent.History;
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

/* NinjaTraderVersion is here because the heartbeat used to invent it.
 *
 * Program.cs passed the literal "8.1.0" for every machine on the desk, so the
 * CRM showed a NinjaTrader version nobody was running. The real one arrives in
 * every capture: the add-on reports it, CapturePipeClient refuses a snapshot
 * without it, and a real one on this desk reads 8.1.6.0. It is recorded here
 * when a capture succeeds and reported from here afterwards. */
public sealed record CollectorStatusSnapshot(
    DateTimeOffset? LastCaptureAt,
    DateTimeOffset? LastSuccessAt,
    string LastErrorCode,
    string LastErrorMessage,
    bool? AddonAvailable,
    bool UpdateRequired,
    string DeviceStatus,
    string NinjaTraderVersion = null,
    string AddonVersion = null);

public sealed class CollectorState
{
    private readonly object gate = new();
    private CollectorStatusSnapshot value = new(null, null, null, null, null, false, "unpaired");

    /* THE SPREAD'S HOLD, WHICH IS A FACT ABOUT ONE DAY AND NOT ABOUT THE QUEUE.
     *
     * The scheduled capture sets it; the uploader reads it; a manual capture
     * clears it. It names the trading date as well as the instant so that only
     * the capture that was just taken waits. A day still sitting in the queue
     * from last week is a retry of work that has already waited hours, and
     * making it wait four more minutes would be a delay with nothing to gain. */
    private Instant? uploadHoldUntil;
    private string uploadHoldTradingDate;

    public CollectorStatusSnapshot Snapshot()
    {
        lock (gate) return value;
    }

    /// <summary>What the add-on says it and NinjaTrader are, seen at capture.</summary>
    public void RecordEnvironment(string ninjaTraderVersion, string addonVersion)
    {
        lock (gate)
        {
            value = value with
            {
                // Only overwrite with something. An add-on that stops reporting
                // must not erase the last version we actually saw.
                NinjaTraderVersion = string.IsNullOrWhiteSpace(ninjaTraderVersion)
                    ? value.NinjaTraderVersion
                    : ninjaTraderVersion.Trim(),
                AddonVersion = string.IsNullOrWhiteSpace(addonVersion)
                    ? value.AddonVersion
                    : addonVersion.Trim(),
            };
        }
    }

    public void RecordCapture(CaptureRunResult result, DateTimeOffset attemptedAt)
    {
        ArgumentNullException.ThrowIfNull(result);
        lock (gate)
        {
            // Only a capture that actually reached the queue moves the hold.
            // This runs every fifteen seconds and most passes are a weekend or
            // an already-collected day, neither of which has anything to say
            // about when the next upload should start.
            if (result.CaptureQueued)
            {
                uploadHoldUntil = result.UploadNotBefore;
                uploadHoldTradingDate = result.UploadNotBefore is null ? null : result.Decision?.TradingDate;
            }

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

    /* A SUCCESSFUL UPLOAD IS THE END OF AN UPLOAD ERROR.
     *
     * This used to set LastSuccessAt and leave LastErrorCode where it was, so
     * a machine that had been turned away or had met a 500 stayed red on the
     * fleet view until the next day's capture cleared it, hours after the
     * snapshot had landed. The heartbeat carries the code and the fleet view
     * reads it before it reads the batch, so the desk saw a failure that was
     * already over. Only upload errors are cleared here: a capture error is
     * the capture's to clear. */
    public void RecordUploadSuccess(DateTimeOffset acknowledgedAt)
    {
        lock (gate)
        {
            bool uploadError = value.LastErrorCode is "upload_failed" or "ingest_at_capacity"
                or "capture_requires_replay" or "capture_conflict";
            value = uploadError
                ? value with { LastSuccessAt = acknowledgedAt, LastErrorCode = null, LastErrorMessage = null }
                : value with { LastSuccessAt = acknowledgedAt };
        }
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

    /// <summary>
    /// Whether this machine's own spread offset still has this day's first
    /// upload waiting. Expiry clears the hold, so it is asked once and never
    /// has to be cleaned up.
    /// </summary>
    public bool IsUploadHeld(string tradingDate, Instant now)
    {
        lock (gate)
        {
            if (uploadHoldUntil is null) return false;
            if (now >= uploadHoldUntil.Value)
            {
                uploadHoldUntil = null;
                uploadHoldTradingDate = null;
                return false;
            }
            return string.Equals(uploadHoldTradingDate, tradingDate, StringComparison.Ordinal);
        }
    }
}

public sealed class ScheduledCaptureLoop : ICollectorLoop
{
    private readonly ICaptureScheduler scheduler;
    private readonly ICollectorClock clock;
    private readonly CollectorState state;
    private readonly ICaptureHistoryStore history;

    public ScheduledCaptureLoop(
        ICaptureScheduler scheduler,
        ICollectorClock clock,
        CollectorState state,
        ICaptureHistoryStore history)
    {
        this.scheduler = scheduler ?? throw new ArgumentNullException(nameof(scheduler));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.state = state ?? throw new ArgumentNullException(nameof(state));
        this.history = history ?? throw new ArgumentNullException(nameof(history));
    }

    public string Name => "scheduler";
    public TimeSpan Interval => TimeSpan.FromSeconds(15);

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        Instant now = clock.GetCurrentInstant();
        CaptureRunResult result = await scheduler.RunScheduledAsync(now, cancellationToken).ConfigureAwait(false);
        state.RecordCapture(result, now.ToDateTimeOffset());

        // Only a due day that produced an error is worth a red cell. A weekend or
        // an already-captured day reports no error, and the scheduler keeps
        // retrying inside the window, so a later success clears this.
        if (result.ErrorCode != null && !string.IsNullOrWhiteSpace(result.Decision?.TradingDate))
        {
            try
            {
                await history.RecordFailureAsync(
                    result.Decision.TradingDate,
                    result.ErrorCode,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception exception) when (exception is not OperationCanceledException)
            {
            }
        }
    }
}

public sealed class UploadLoop : ICollectorLoop
{
    private readonly ICollectorQueue queue;
    private readonly ICollectorCrmClient crm;
    private readonly IDeviceTokenStore tokenStore;
    private readonly CollectorState state;
    private readonly ICaptureHistoryStore history;
    private readonly IServiceReporter reporter;
    private readonly ICollectorClock clock;
    private string lastReportedCode;

    public UploadLoop(
        ICollectorQueue queue,
        ICollectorCrmClient crm,
        IDeviceTokenStore tokenStore,
        CollectorState state,
        ICaptureHistoryStore history,
        IServiceReporter reporter = null,
        ICollectorClock clock = null)
    {
        this.queue = queue ?? throw new ArgumentNullException(nameof(queue));
        this.crm = crm ?? throw new ArgumentNullException(nameof(crm));
        this.tokenStore = tokenStore ?? throw new ArgumentNullException(nameof(tokenStore));
        this.state = state ?? throw new ArgumentNullException(nameof(state));
        this.history = history ?? throw new ArgumentNullException(nameof(history));
        this.reporter = reporter;
        this.clock = clock ?? new SystemCollectorClock();
    }

    // A REJECTION THE CRM SENDS BACK IS NOT A SILENT EVENT ANY MORE.
    //
    // Every failure here is a handled CrmClientException, so it never reached
    // the supervisor and the supervisor is the only thing that wrote to the log.
    // A VPS spent a full afternoon retrying uploads that the CRM was refusing
    // with a 5xx, and the log for that afternoon says nothing about it at all:
    // the only way to learn there was a problem was to read the queue depth in a
    // diagnostics bundle and infer the status code from which retry disposition
    // the agent had chosen. That is not a diagnosis, it is an inference.
    //
    // ONLY ON CHANGE, because this loop runs every ten seconds and a stuck
    // upload would otherwise write eight thousand identical lines a day and bury
    // the one line that matters. The first occurrence is written and identical
    // repeats are not. A success clears the remembered code rather than writing
    // a line of its own: this reporter's one verb is LoopFailed, and sending a
    // recovery through it would put a line in the log that reads as a failure.
    // Clearing is what matters, because it is what lets the same fault be
    // written again if it comes back after a good pass.
    private void ReportChange(string code, Exception exception)
    {
        if (string.Equals(lastReportedCode, code, StringComparison.Ordinal)) return;
        lastReportedCode = code;
        if (code != null) reporter?.LoopFailed(Name, code, exception);
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

        /* THE SPREAD, AND IT HOLDS ONE DAY RATHER THAN THE QUEUE.
         *
         * Only the capture this machine has just taken waits, and only until
         * its own offset has passed. A day left over from an earlier failure is
         * a retry and goes straight out; so does a manual test capture, which
         * clears the hold as it is queued. The item goes back to pending
         * untouched, so the next pass ten seconds later claims it again with
         * nothing lost and no attempt counted. */
        if (state.IsUploadHeld(item.TradingDate, clock.GetCurrentInstant()))
        {
            await queue.RetryAsync(item, cancellationToken).ConfigureAwait(false);
            return;
        }

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
            ReportChange(null, null);
            await RecordHistoryAsync(
                () => history.RecordUploadedAsync(
                    item.TradingDate,
                    acknowledgement.AcknowledgedAt,
                    cancellationToken)).ConfigureAwait(false);
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

                // Only a quarantine is terminal. A retry leaves the day pending,
                // and marking it failed would flash red for a blip that the next
                // pass fixes on its own.
                await RecordHistoryAsync(
                    () => history.RecordFailureAsync(
                        item.TradingDate,
                        exception.Code,
                        cancellationToken)).ConfigureAwait(false);
            }
            // Being held at the door is flow control, not a fault: the CRM
            // said come back, the item is queued, and the next pass goes. It
            // reaches the log through ReportChange but never the heartbeat,
            // because a red row for a machine doing exactly what it was asked
            // is the wrong picture, and the heartbeat's own vocabulary would
            // refuse the code anyway.
            if (exception.Code != "ingest_at_capacity")
                state.RecordError(exception.Code, exception.Message);
            ReportChange(exception.Code, exception);
        }
    }

    private static async Task RecordHistoryAsync(Func<Task> record)
    {
        try
        {
            await record().ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
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
    private readonly IServiceReporter reporter;
    private string lastReportedCode;

    public HeartbeatLoop(
        ICollectorQueue queue,
        ICollectorCrmClient crm,
        IDeviceTokenStore tokenStore,
        CollectorState state,
        string agentVersion,
        string addonVersion,
        string ninjaTraderVersion,
        IServiceReporter reporter = null)
    {
        this.reporter = reporter;
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
            // Observed beats configured. The constructor values are the answer
            // before the first capture, and for NinjaTrader there is no honest
            // constructor value, so it is null until the add-on says otherwise.
            string.IsNullOrWhiteSpace(current.AddonVersion) ? addonVersion : current.AddonVersion,
            string.IsNullOrWhiteSpace(current.NinjaTraderVersion) ? ninjaTraderVersion : current.NinjaTraderVersion,
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
            ReportChange(null, null);
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
            ReportChange(exception.Code, exception);
        }
    }

    // Same rule as the uploader: the first occurrence and every change, never
    // the repeats. A rejected heartbeat left no trace at all until now, so the
    // status said heartbeat_failed and the log had nothing to say about it.
    private void ReportChange(string code, Exception exception)
    {
        if (string.Equals(lastReportedCode, code, StringComparison.Ordinal)) return;
        lastReportedCode = code;
        if (code != null) reporter?.LoopFailed(Name, code, exception);
    }
}

/// <summary>What the Setup window calls when someone presses Retry quarantine now.</summary>
public interface IQuarantineReviewer
{
    Task<QueueQuarantineReviewResult> ReviewNowAsync(CancellationToken cancellationToken = default);
}

/* QUARANTINE WAS TERMINAL. NOTHING LOOKED AT THE FOLDER AGAIN.
 *
 * A 422 from the CRM put the capture there and the desk found out, if at all,
 * from a failed batch on the fleet view. This month a server side fix made
 * the refused bytes acceptable and the four captures sat on the VPS anyway,
 * because the only thing that could resend them was a person with the path.
 *
 * This loop walks the folder once a day, at a configured New York time, and
 * again whenever the Setup window asks. What it may send back is decided by
 * QuarantinePolicy in the queue, and the cap on attempts holds for the manual
 * press too: pressing the button is a way to not wait until midday, not a way
 * to retry forever.
 *
 * It also tells the CRM what is in the folder, through its own endpoint and
 * never through the heartbeat. Nothing here writes to CollectorState's error
 * fields: the heartbeat's vocabulary is fixed on the server, and a code it
 * does not know would be dropped by the client and refused by the CRM. */
public sealed class QuarantineReviewLoop : ICollectorLoop, IQuarantineReviewer
{
    /* A 404 means the CRM has not been deployed with the endpoint yet, and it
     * will not have been an hour later either. A day is the right silence: one
     * INFO line, one attempt a day, until it answers. */
    public static readonly TimeSpan UnsupportedBackoff = TimeSpan.FromHours(24);

    /* A 5xx or a dropped connection after the client's own retries. The queue
     * is unaffected by a late report, so this waits rather than hammering. */
    public static readonly TimeSpan FailedReportBackoff = TimeSpan.FromMinutes(15);

    private static readonly DateTimeZone NewYork = DateTimeZoneProviders.Tzdb[CaptureSchedule.TimeZoneId];
    private static readonly LocalTime DefaultReviewTime = new(12, 0);
    private readonly ICollectorQueue queue;
    private readonly ICollectorCrmClient crm;
    private readonly IDeviceTokenStore tokenStore;
    private readonly IAgentOptionsStore optionsStore;
    private readonly ICollectorClock clock;
    private readonly CollectorState state;
    private readonly IServiceReporter reporter;
    private readonly IRedactingLogger logger;
    private readonly SemaphoreSlim gate = new(1, 1);

    // Once on service start, then after every review. Stays raised until a
    // report is accepted or refused for good, so an unpaired machine sends its
    // first report on the first pass after pairing.
    private bool reportDue = true;
    private Instant? unsupportedUntil;
    private Instant? reportRetryAt;
    private bool unsupportedLogged;
    private string lastReportedCode;

    public QuarantineReviewLoop(
        ICollectorQueue queue,
        ICollectorCrmClient crm,
        IDeviceTokenStore tokenStore,
        IAgentOptionsStore optionsStore,
        ICollectorClock clock,
        CollectorState state,
        IServiceReporter reporter = null,
        IRedactingLogger logger = null)
    {
        this.queue = queue ?? throw new ArgumentNullException(nameof(queue));
        this.crm = crm ?? throw new ArgumentNullException(nameof(crm));
        this.tokenStore = tokenStore ?? throw new ArgumentNullException(nameof(tokenStore));
        this.optionsStore = optionsStore ?? throw new ArgumentNullException(nameof(optionsStore));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.state = state ?? throw new ArgumentNullException(nameof(state));
        this.reporter = reporter;
        this.logger = logger;
    }

    public string Name => "quarantine-review";
    public TimeSpan Interval => TimeSpan.FromMinutes(1);

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            Instant now = clock.GetCurrentInstant();
            AgentOptions options = (await optionsStore.LoadAsync(cancellationToken).ConfigureAwait(false)).Options;
            LocalDateTime local = now.InZone(NewYork).LocalDateTime;
            string today = FormatDate(local.Date);
            bool due = local.TimeOfDay >= ParseReviewTime(options.QuarantineReviewTime)
                && !string.Equals(options.LastQuarantineReviewDate, today, StringComparison.Ordinal);
            if (due)
            {
                await queue.ReviewQuarantineAsync(now.ToDateTimeOffset(), cancellationToken).ConfigureAwait(false);
                // Reloaded right before the save rather than reusing the copy
                // read above. The scheduler saves lastScheduledTradingDate the
                // same way, and writing a stale copy over its save would make it
                // capture the day twice. The window between this load and this
                // save is as small as it can be made.
                AgentOptions latest = (await optionsStore.LoadAsync(cancellationToken).ConfigureAwait(false)).Options;
                await optionsStore.SaveAsync(latest with { LastQuarantineReviewDate = today }, cancellationToken)
                    .ConfigureAwait(false);
                reportDue = true;
                reportRetryAt = null;
            }
            await MaybeReportAsync(now, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<QueueQuarantineReviewResult> ReviewNowAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            Instant now = clock.GetCurrentInstant();
            QueueQuarantineReviewResult result = await queue.ReviewQuarantineAsync(now.ToDateTimeOffset(), cancellationToken)
                .ConfigureAwait(false);
            // A person is watching. A report held back by an earlier 5xx goes
            // now; the day of silence after a 404 is kept, because the answer
            // has not changed.
            reportDue = true;
            reportRetryAt = null;
            await MaybeReportAsync(now, cancellationToken).ConfigureAwait(false);
            return result;
        }
        finally
        {
            gate.Release();
        }
    }

    private async Task MaybeReportAsync(Instant now, CancellationToken cancellationToken)
    {
        if (!reportDue) return;
        if (unsupportedUntil is Instant silentUntil && now < silentUntil) return;
        if (reportRetryAt is Instant retryAt && now < retryAt) return;
        if (string.IsNullOrWhiteSpace(await tokenStore.LoadTokenAsync(cancellationToken).ConfigureAwait(false)))
        {
            state.RecordUnpaired();
            return;
        }

        IReadOnlyList<QueueQuarantineEntry> entries = await queue.ListQuarantineAsync(cancellationToken)
            .ConfigureAwait(false);
        QuarantineReport report = new(
            QuarantineReport.CurrentSchemaVersion,
            now.ToDateTimeOffset(),
            entries.Select(entry => new QuarantineReportItem(
                entry.TradingDate,
                entry.CaptureId.ToString("D"),
                entry.Code,
                entry.Attempts,
                entry.QuarantinedAt,
                entry.LastAttemptAt)).ToArray());
        try
        {
            QuarantineReportOutcome outcome = await crm.ReportQuarantineAsync(report, cancellationToken)
                .ConfigureAwait(false);
            if (outcome == QuarantineReportOutcome.Unsupported)
            {
                unsupportedUntil = now + Duration.FromTimeSpan(UnsupportedBackoff);
                if (!unsupportedLogged)
                {
                    unsupportedLogged = true;
                    logger?.Write(
                        "INFO",
                        "quarantine_report_unsupported",
                        "The CRM does not accept quarantine reports yet. The inventory will be offered again in 24 hours.");
                }
                return;
            }
            reportDue = false;
            unsupportedUntil = null;
            unsupportedLogged = false;
            ReportChange(null, null);
        }
        catch (CrmClientException exception) when (exception.Disposition == CrmFailureDisposition.RePair)
        {
            await tokenStore.DeleteTokenAsync(cancellationToken).ConfigureAwait(false);
            state.RecordUnpaired();
        }
        catch (CrmClientException exception)
        {
            if (exception.Disposition == CrmFailureDisposition.Retry)
                reportRetryAt = now + Duration.FromTimeSpan(FailedReportBackoff);
            else
                reportDue = false;
            ReportChange(exception.Code, exception);
        }
    }

    // The same rule as the uploader and the heartbeat: the first occurrence
    // and every change, never the repeats, and a success clears the memory so
    // the same fault is written again if it comes back.
    private void ReportChange(string code, Exception exception)
    {
        if (string.Equals(lastReportedCode, code, StringComparison.Ordinal)) return;
        lastReportedCode = code;
        if (code != null) reporter?.LoopFailed(Name, code, exception);
    }

    private static LocalTime ParseReviewTime(string value)
    {
        ParseResult<LocalTime> parsed = LocalTimePattern.CreateWithInvariantCulture("HH:mm").Parse(value ?? string.Empty);
        return parsed.Success ? parsed.Value : DefaultReviewTime;
    }

    private static string FormatDate(LocalDate date)
    {
        return $"{date.Year:D4}-{date.Month:D2}-{date.Day:D2}";
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
