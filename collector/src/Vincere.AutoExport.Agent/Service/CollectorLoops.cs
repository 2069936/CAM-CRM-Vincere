using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
using NodaTime.Text;
using Vincere.AutoExport.Agent.Capture;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Diagnostics;
using Vincere.AutoExport.Agent.History;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Scheduling;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Contracts;

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
    private readonly IRosterStore roster;
    private string lastReportedCode;

    public UploadLoop(
        ICollectorQueue queue,
        ICollectorCrmClient crm,
        IDeviceTokenStore tokenStore,
        CollectorState state,
        ICaptureHistoryStore history,
        IServiceReporter reporter = null,
        ICollectorClock clock = null,
        IRosterStore roster = null)
    {
        this.queue = queue ?? throw new ArgumentNullException(nameof(queue));
        this.crm = crm ?? throw new ArgumentNullException(nameof(crm));
        this.tokenStore = tokenStore ?? throw new ArgumentNullException(nameof(tokenStore));
        // Optional: a machine that never records one still uploads, it just
        // cannot classify its own accounts if the CRM later goes away.
        this.roster = roster;
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
            /* KEEP THE CLASSIFICATION THE CRM JUST SENT.
             *
             * This is the only moment the machine is told what its accounts
             * are. On 2026-09-25 the database stopped answering for three days
             * while captures piled up on disk, and the reports nobody could
             * print were unprintable for exactly this one missing fact.
             *
             * After the queue is completed and the success recorded, so a
             * roster that cannot be written never costs an upload. */
            if (roster != null && !string.IsNullOrWhiteSpace(acknowledgement.RegistryJson))
            {
                await roster.SaveAsync(
                    acknowledgement.RegistryJson,
                    acknowledgement.RegistryVersion,
                    acknowledgement.AcknowledgedAt,
                    cancellationToken).ConfigureAwait(false);
            }
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
    /* WHERE THE RELAY SECRET IS KEPT.
     *
     * The same DPAPI store the device token uses, at its own path: it is a
     * credential, it belongs encrypted at rest under the ACL that folder
     * already carries, and there was no reason to invent a second way to hold
     * one. Optional, so every existing construction of this loop still
     * compiles and a deployment with no relay simply never writes a file. */
    private readonly IDeviceTokenStore relaySecretStore;
    private readonly IAgentOptionsStore optionsStore;
    private string lastReportedCode;

    public HeartbeatLoop(
        ICollectorQueue queue,
        ICollectorCrmClient crm,
        IDeviceTokenStore tokenStore,
        CollectorState state,
        string agentVersion,
        string addonVersion,
        string ninjaTraderVersion,
        IServiceReporter reporter = null,
        IDeviceTokenStore relaySecretStore = null,
        IAgentOptionsStore optionsStore = null)
    {
        this.reporter = reporter;
        this.relaySecretStore = relaySecretStore;
        this.optionsStore = optionsStore;
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
            await StoreRelaySecretAsync(result.ReportEmailSecret, cancellationToken).ConfigureAwait(false);
            await StoreRelayUrlAsync(result.ReportEmailUrl, cancellationToken).ConfigureAwait(false);
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

    /* WRITTEN ONLY WHEN IT CHANGES. The heartbeat runs every minute and this
     * value moves about once a year; rewriting config.json sixty times an hour
     * would put the file the whole agent depends on under a lock it has no
     * reason to be under. Same tolerance for failure as the secret below. */
    private async Task StoreRelayUrlAsync(string url, CancellationToken cancellationToken)
    {
        if (optionsStore == null || string.IsNullOrWhiteSpace(url)) return;
        try
        {
            AgentOptions current = (await optionsStore.LoadAsync(cancellationToken).ConfigureAwait(false)).Options;
            if (string.Equals(current.ReportEmailUrl, url, StringComparison.Ordinal)) return;
            await optionsStore.SaveAsync(
                current with { ReportEmailUrl = url },
                cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
        }
    }

    /* Kept on the day it arrives, because the day it is needed is the day the
     * CRM cannot hand it over. A failure to write is not allowed to fail the
     * heartbeat: the heartbeat is how the desk knows this machine is alive,
     * and a courtesy secret is not worth taking that down. */
    private async Task StoreRelaySecretAsync(string secret, CancellationToken cancellationToken)
    {
        if (relaySecretStore == null || string.IsNullOrWhiteSpace(secret)) return;
        try
        {
            await relaySecretStore.SaveTokenAsync(secret, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
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
 * This loop walks the folder once a trading day, at a configured New York
 * time, and again whenever the Setup window asks. Trading days are the days
 * the capture schedule is enabled for, because the cap is three attempts and a
 * fix on the CRM side lands on a working day: a capture refused on a Friday
 * close must not have spent its budget on Saturday and Sunday before the desk
 * has had one working day to look. What the review may send back is decided by
 * QuarantinePolicy in the queue, and the cap on attempts holds for the manual
 * press too: pressing the button is a way to not wait until midday, or until
 * Monday, not a way to retry forever.
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
            bool due = EnabledDays(options).Contains(local.Date.DayOfWeek)
                && local.TimeOfDay >= ParseReviewTime(options.QuarantineReviewTime)
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
            // A person is watching, and the report is not what they pressed
            // for. It is raised here and sent on the minute pass that follows,
            // never awaited under this gate: the client retries a 5xx for
            // minutes before it gives up, and the window would sit on the
            // button for all of it. A report held back by an earlier 5xx goes
            // on that pass; the day of silence after a 404 is kept, because the
            // answer has not changed.
            reportDue = true;
            reportRetryAt = null;
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

    // The same days the scheduler captures on. A schedule the scheduler cannot
    // read is already its failure to report every minute; the review falls
    // back to the default week rather than adding a second voice to it.
    private static IReadOnlyCollection<IsoDayOfWeek> EnabledDays(AgentOptions options)
    {
        try
        {
            return CaptureSchedule.FromOptions(options).EnabledDays;
        }
        catch (ArgumentException)
        {
            return CaptureSchedule.Default.EnabledDays;
        }
    }

    private static string FormatDate(LocalDate date)
    {
        return $"{date.Year:D4}-{date.Month:D2}-{date.Day:D2}";
    }
}

/* ---------------------------------------------------------------------------
 * Mailing this machine's own close, every trading day.
 *
 * WHY IT IS ITS OWN LOOP AND NOT PART OF THE CAPTURE. The capture must succeed
 * whether or not anything else does, and the upload must not be delayed by a
 * courtesy. This reads the capture back out of the queue and leaves it exactly
 * as it found it, so a failure here costs the day's email and nothing else.
 *
 * NOT CONDITIONAL ON THE UPLOAD FAILING, which was the obvious design and the
 * wrong one. The day the CRM is unreachable is the day nobody can tell this
 * machine anything, including that it should now start mailing. It sends every
 * day; on an ordinary day the desk gets a copy it did not strictly need, and on
 * the day of an outage it gets the only one that exists.
 *
 * ONCE A DAY. The loop runs every few minutes and records the date it mailed,
 * the same way the quarantine review does, so a machine that restarts at 17:05
 * does not mail the close again.
 * ------------------------------------------------------------------------- */
public sealed class ReportEmailLoop : ICollectorLoop
{
    private static readonly DateTimeZone NewYork = DateTimeZoneProviders.Tzdb["America/New_York"];
    private readonly ICaptureReader captures;
    private readonly ICollectorCrmClient crm;
    private readonly IRosterStore roster;
    private readonly IDeviceTokenStore relaySecretStore;
    private readonly IAgentOptionsStore optionsStore;
    private readonly ICollectorClock clock;
    private readonly IServiceReporter reporter;
    private readonly SemaphoreSlim gate = new(1, 1);
    private string lastReportedCode;

    public ReportEmailLoop(
        ICaptureReader captures,
        ICollectorCrmClient crm,
        IRosterStore roster,
        IDeviceTokenStore relaySecretStore,
        IAgentOptionsStore optionsStore,
        ICollectorClock clock,
        IServiceReporter reporter = null)
    {
        this.captures = captures ?? throw new ArgumentNullException(nameof(captures));
        this.crm = crm ?? throw new ArgumentNullException(nameof(crm));
        this.roster = roster ?? throw new ArgumentNullException(nameof(roster));
        this.relaySecretStore = relaySecretStore ?? throw new ArgumentNullException(nameof(relaySecretStore));
        this.optionsStore = optionsStore ?? throw new ArgumentNullException(nameof(optionsStore));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.reporter = reporter;
    }

    public string Name => "report-email";
    public TimeSpan Interval => TimeSpan.FromMinutes(5);

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            Instant now = clock.GetCurrentInstant();
            string today = FormatDate(now.InZone(NewYork).LocalDateTime.Date);
            AgentOptions options = (await optionsStore.LoadAsync(cancellationToken).ConfigureAwait(false)).Options;
            if (string.Equals(options.LastReportEmailDate, today, StringComparison.Ordinal)) return;

            /* No secret means this deployment has no relay, or this machine has
             * not heard from the CRM since one was configured. Silent on
             * purpose: every machine would be in this state until somebody
             * sets the variables, and it is not a fault of theirs. */
            string secret = await relaySecretStore.LoadTokenAsync(cancellationToken).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(secret)) return;

            // Nothing captured yet today. Not an error: the close has not
            // happened, or the scheduler is still inside its retry window.
            string capture = await captures.ReadNewestAsync(today, cancellationToken).ConfigureAwait(false);
            if (string.IsNullOrWhiteSpace(capture)) return;

            CachedRoster cached = await roster.LoadAsync(cancellationToken).ConfigureAwait(false);
            bool sent = await crm.SendReportEmailAsync(
                capture,
                options.ClientName,
                cached?.RegistryJson,
                cached?.FetchedAt,
                secret,
                options.ReportEmailUrl,
                cancellationToken).ConfigureAwait(false);

            /* Only a message that was accepted marks the day done. A refusal
             * leaves the date unwritten so the next pass tries again, which is
             * what makes a deployment that gets its mail configured at 18:00
             * still send that evening. */
            if (!sent)
            {
                ReportChange("report_email_refused", null);
                return;
            }

            await optionsStore.SaveAsync(
                options with { LastReportEmailDate = today },
                cancellationToken).ConfigureAwait(false);
            ReportChange(null, null);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            // The day's email is worth nothing next to the day's upload, and
            // this loop shares a process with it.
            ReportChange("report_email_failed", exception);
        }
        finally
        {
            gate.Release();
        }
    }

    private void ReportChange(string code, Exception exception)
    {
        if (string.Equals(lastReportedCode, code, StringComparison.Ordinal)) return;
        lastReportedCode = code;
        if (code != null) reporter?.LoopFailed(Name, code, exception);
    }

    private static string FormatDate(LocalDate date) =>
        date.ToString("yyyy-MM-dd", System.Globalization.CultureInfo.InvariantCulture);
}

/* ---------------------------------------------------------------------------
 * The account tracker: a traffic light, sampled every ten minutes.
 *
 * WHAT IT IS FOR. The desk wants to open the CRM mid-morning and see, per client
 * account, which are alive, which are running, and roughly how the day is going.
 * The big report already happens at the close. This is only the light.
 *
 * WHY IT IS ITS OWN LOOP, in the house's terms: the capture must succeed whether
 * or not anything else does, and nothing here may delay the upload. It is also
 * the only loop whose work is worthless the moment it is late, and that single
 * fact decides every design question below.
 *
 * IT NEVER CALLS CaptureAndQueueWorkflow, which is the reuse that would look like
 * good engineering and would corrupt the day's bookkeeping twice over. That
 * workflow refuses a capture with `positions_open` whenever any account carries a
 * non-zero unrealized P&L - correct for a 16:35 close and catastrophic at 10:15,
 * when it is true of essentially every sample during market hours. It also writes
 * the queue and the capture history. Read, post, forget.
 *
 * IT NEVER TOUCHES CollectorState'S ERROR FIELDS, exactly as the quarantine
 * review does not. Those feed the heartbeat, and the fleet view paints a machine
 * "Failed - the collector reported an operational error" for any code it finds
 * there. Both codes a tracker would naturally produce - a busy pipe, an
 * unavailable add-on - are inside the heartbeat's accepted vocabulary, so they
 * would be stored and rendered, and a CAM would be sent to look at a machine
 * whose close is perfect. The only call it makes is RecordUnpaired, which every
 * loop makes and which is about the device rather than the tracker.
 *
 * NOTHING IS QUEUED, PERSISTED OR RETRIED, ANYWHERE ON THIS PATH. The pipe client
 * answers an outcome instead of throwing, the CRM post has no retry loop, and the
 * two backoffs below are in memory. A failed sample is dropped and the next tick
 * carries a FRESH reading. The uploader has a durable queue because a close is
 * irreplaceable; the opposite is true here, and a stale sample is worse than a
 * missing one because the screen cannot tell that it is stale.
 *
 * TWO SEPARATE DAY-LONG SILENCES, because there are two independent reasons this
 * cannot work yet and the fleet will be in both states at once for a while:
 * an add-on too old to know the command, and a CRM that has not merged the route.
 * Each is a 404-shaped answer, each gets one INFO line and twenty-four hours of
 * quiet, and neither is a fault. Collapsing them into one timer would let a CRM
 * deploy be hidden behind an add-on's silence for a day.
 *
 * THE PER STRATEGY READING RIDES THE SAME TICK, AFTER THE ACCOUNTS AND APART FROM
 * THEM. Once the account post has been answered, whatever the answer, the loop
 * asks the add-on for each live strategy's Realized and Unrealized and posts them
 * to api/ingest/strategies. It runs only after a tick that read the accounts and
 * found at least one connected, and only for those connected accounts. Everything
 * about it is separate from the account half: its own pipe command, its own
 * route, its own two silences, its own log memory, and its own try. An add-on too
 * old for it, a CRM without the route or without migration 57, a timeout, a 400,
 * an exception in its own code: each of those costs the strategy reading and
 * nothing else, because by the time it runs the account rows are already posted.
 *
 * THE TICK IS ALIGNED TO THE CLOCK, because the desk compares a client's figure
 * with the desk's figure for the SAME ten minutes. Those figures are marked to
 * market and move with the price even when nobody trades, so two machines read at
 * different minutes are not comparable. Every machine therefore wakes two seconds
 * after the same UTC boundaries, floor(unix seconds / interval) * interval, and the
 * CRM files each reading under the boundary it was taken next to. See Interval.
 * ------------------------------------------------------------------------- */
public sealed class AccountSampleLoop : ICollectorLoop
{
    /* The add-on cannot be replaced while NinjaTrader is loaded, and the CRM is
     * deployed by a merge. Neither answer changes within the hour, and a day is
     * the right silence - the same number and the same reasoning as the quarantine
     * review's UnsupportedBackoff. */
    public static readonly TimeSpan UnsupportedBackoff = TimeSpan.FromHours(24);

    /* The cadence before the CRM has said otherwise, and the bounds it is held
     * to. These mirror step 55's own CHECK on sample_interval_seconds, because an
     * agent that honoured a value the table would not accept would be tuned to a
     * number nobody could see. The floor matters most: this asks a terminal
     * trading live prop-firm accounts to read its own state, and five minutes is
     * as often as that is reasonable however the column is edited. */
    public const int DefaultIntervalSeconds = 600;
    public const int MinimumIntervalSeconds = 300;
    public const int MaximumIntervalSeconds = 3600;

    /* How long after the boundary the loop wakes. A timer that fires a little
     * early must still land after the boundary, or its reading would be filed
     * under the previous cycle. The CRM accepts a reading as on cycle up to its
     * cycle_tolerance_seconds (90 by default) after the boundary. */
    public const int AlignmentLeadSeconds = 2;

    /* THE STRATEGY ROUTE'S SILENCE IS AN HOUR, NOT A DAY. Its usual cause is a CRM
     * that has merged the route before Pedro has applied migration 57 by hand, and
     * a day of silence would keep the feature dark until tomorrow after he does. An
     * hour is one post per machine per hour against a 404, which costs nothing. */
    public static readonly TimeSpan StrategyCrmUnsupportedBackoff = TimeSpan.FromHours(1);

    /* The route's own ceiling. A reading larger than this is not sent at all: the
     * CRM would refuse it, and a machine with more than a thousand live strategies
     * is something to look at, not to post. */
    public const int MaximumStrategyRows = 1000;

    private readonly INinjaTraderAccountSampleClient sampleClient;
    private readonly ICollectorCrmClient crm;
    private readonly IDeviceTokenStore tokenStore;
    private readonly ICollectorClock clock;
    private readonly CollectorState state;
    private readonly LiveAccountMemory liveAccounts;
    private readonly IServiceReporter reporter;
    private readonly IRedactingLogger logger;
    private readonly INinjaTraderStrategySampleClient strategyClient;
    private readonly StrategyRunMemory strategyRuns;
    private readonly SemaphoreSlim gate = new(1, 1);

    /* Read by the supervisor on every iteration, from a thread that is not this
     * one. See the Interval getter for why this is a plain int and not a lookup. */
    private volatile int intervalSeconds = DefaultIntervalSeconds;
    private Instant? addonUnsupportedUntil;
    private Instant? crmUnsupportedUntil;
    private bool addonUnsupportedLogged;
    private bool crmUnsupportedLogged;
    private string lastReportedCode;

    /* The strategy half's own state, deliberately never shared with the fields
     * above. Reusing addonUnsupportedUntil or crmUnsupportedUntil here would let a
     * strategies 404 silence the account tracker for a day. */
    private Instant? strategyAddonUnsupportedUntil;
    private Instant? strategyCrmUnsupportedUntil;
    private bool strategyAddonUnsupportedLogged;
    private bool strategyCrmUnsupportedLogged;
    private string lastReportedStrategyCode;
    private string lastStrategyDetailLogged;

    /* EVERY ARGUMENT IS REQUIRED, AND THAT IS THE POINT.
     *
     * The other loops here take their reporter and logger as optional trailing
     * arguments, which is how they avoided breaking existing constructions - and
     * also how one of them silently did nothing for want of a store a composition
     * root forgot to pass. That happened in Program.cs, it compiled, and nothing
     * would have failed. This loop is new, so it owes no caller that courtesy:
     * nothing is defaulted, which means the compiler refuses an incomplete
     * construction and the by-type registration in Program.cs cannot under-supply
     * it. The pattern and the test that pins it are the whole answer to "whatever
     * your loop needs, pin the wiring". */
    public AccountSampleLoop(
        INinjaTraderAccountSampleClient sampleClient,
        ICollectorCrmClient crm,
        IDeviceTokenStore tokenStore,
        ICollectorClock clock,
        CollectorState state,
        LiveAccountMemory liveAccounts,
        IServiceReporter reporter,
        IRedactingLogger logger,
        INinjaTraderStrategySampleClient strategyClient,
        StrategyRunMemory strategyRuns)
    {
        this.sampleClient = sampleClient ?? throw new ArgumentNullException(nameof(sampleClient));
        this.crm = crm ?? throw new ArgumentNullException(nameof(crm));
        this.tokenStore = tokenStore ?? throw new ArgumentNullException(nameof(tokenStore));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.state = state ?? throw new ArgumentNullException(nameof(state));
        this.liveAccounts = liveAccounts ?? throw new ArgumentNullException(nameof(liveAccounts));
        this.reporter = reporter ?? throw new ArgumentNullException(nameof(reporter));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
        this.strategyClient = strategyClient ?? throw new ArgumentNullException(nameof(strategyClient));
        this.strategyRuns = strategyRuns ?? throw new ArgumentNullException(nameof(strategyRuns));
    }

    public string Name => "account-sample";

    /// <summary>
    /// The cycle length the CRM asked for, clamped to the table's own bounds.
    /// What <see cref="Interval"/> aligns to; the delay until the next reading is
    /// at most this plus a few seconds.
    /// </summary>
    public TimeSpan Cadence => TimeSpan.FromSeconds(
        Math.Clamp(intervalSeconds, MinimumIntervalSeconds, MaximumIntervalSeconds));

    /* THIS GETTER CAN STOP THE ENTIRE SERVICE IF IT MISBEHAVES, so it is written
     * to be incapable of it.
     *
     * Worker.SuperviseAsync reads Interval after every run and hands it straight
     * to its delay, where a negative value throws outside any catch, and the
     * host's default behaviour for an unhandled exception in a BackgroundService
     * is to stop. So a getter that returned zero or a negative would not cost
     * this loop, it would take down the scheduler, the uploader and the heartbeat
     * with it. The heartbeat is the only thing that
     * says a machine is alive, so the failure mode is losing the whole fleet's
     * traffic light in order to build one.
     *
     * Hence: a volatile int clamped between two constants, and the clock. No I/O,
     * no parse, no options file, no allocation. The CRM's value is validated when
     * it arrives, and clamped AGAIN here, because the thing that must never be
     * wrong is what this returns. It is also what lets the cadence change without
     * a restart: the supervisor re-reads it every pass.
     *
     * IT ANSWERS "HOW LONG UNTIL TWO SECONDS AFTER THE NEXT BOUNDARY", not "how
     * long is the cycle". The boundaries are floor(unix seconds / interval) *
     * interval in UTC, the same grid on every machine for any interval, and the
     * next one is strictly after now: a reading that finishes exactly on a
     * boundary waits a whole cycle rather than reading the same cycle twice. A
     * boundary that was missed (a slow pipe, NinjaTrader closed) is not chased;
     * the loop simply waits for the next one. The supervisor reads this AFTER the
     * run, so a cadence the CRM changed during the run applies to the very next
     * wait, and an agent still on the old grid heals within one cycle.
     *
     * Clamped to [one second, cycle plus five seconds], so the supervisor can
     * neither spin nor sleep past a boundary, whatever the clock says. The catch
     * is the fallback for a clock that throws. The cost of being wrong about that
     * is the entire service, which is not a bet worth winning. */
    public TimeSpan Interval
    {
        get
        {
            try
            {
                long cycleTicks = Math.Clamp(intervalSeconds, MinimumIntervalSeconds, MaximumIntervalSeconds)
                    * TimeSpan.TicksPerSecond;
                long nowTicks = clock.GetCurrentInstant().ToUnixTimeTicks();
                long intoCycle = ((nowTicks % cycleTicks) + cycleTicks) % cycleTicks;
                long untilNext = cycleTicks - intoCycle + AlignmentLeadSeconds * TimeSpan.TicksPerSecond;
                return TimeSpan.FromTicks(Math.Clamp(
                    untilNext,
                    TimeSpan.TicksPerSecond,
                    cycleTicks + 5 * TimeSpan.TicksPerSecond));
            }
            catch
            {
                return TimeSpan.FromSeconds(DefaultIntervalSeconds);
            }
        }
    }

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            Instant now = clock.GetCurrentInstant();

            // Unpaired. Every loop asks first, and it is the ordinary state of a
            // machine between install and enrollment rather than a fault.
            if (string.IsNullOrWhiteSpace(await tokenStore.LoadTokenAsync(cancellationToken).ConfigureAwait(false)))
            {
                state.RecordUnpaired();
                return;
            }

            // Inside either day-long silence. Checked before the pipe is touched,
            // so a machine whose add-on predates the command does not disturb
            // NinjaTrader every ten minutes to be told so again.
            if (Waiting(addonUnsupportedUntil, now) || Waiting(crmUnsupportedUntil, now)) return;

            AccountSampleAttempt attempt = await sampleClient
                .SampleAccountsAsync(cancellationToken).ConfigureAwait(false);

            if (attempt.Outcome == AccountSampleOutcome.Unsupported)
            {
                addonUnsupportedUntil = now + Duration.FromTimeSpan(UnsupportedBackoff);
                if (!addonUnsupportedLogged)
                {
                    addonUnsupportedLogged = true;
                    logger.Write(
                        "INFO",
                        "account_sample_addon_unsupported",
                        "The NinjaTrader AddOn on this machine is older than the account tracker and "
                        + "cannot answer it. The daily close is unaffected. The tracker will ask again "
                        + "in 24 hours; replacing the AddOn needs NinjaTrader closed.");
                }
                return;
            }

            if (attempt.Outcome != AccountSampleOutcome.Sampled)
            {
                // NinjaTrader closed, the pipe busy with the day's close, a
                // timeout. One line when it changes, nothing when it repeats, and
                // the next tick tries again from scratch.
                ReportChange(attempt.Code ?? "account_sample_unavailable", null);
                return;
            }

            /* Which accounts are worth telling the CRM about. See LiveAccountMemory:
             * the add-on deliberately reports disconnected accounts, and this is
             * what keeps "this account has gone dark" without also forwarding the
             * forty leftovers from connections that no longer exist. */
            IList<AccountSampleRowV1> accounts = liveAccounts.Retain(attempt.Sample.Accounts);

            // The accounts the strategy half may speak about: the ones this tick
            // is reporting as connected. A strategy on a dark account is not news
            // the desk can compare.
            HashSet<string> connectedNames = new(StringComparer.OrdinalIgnoreCase);
            foreach (AccountSampleRowV1 account in accounts)
            {
                if (account.Connected) connectedNames.Add(account.AccountName.Trim());
            }

            /* Nothing to say. A machine whose only accounts are leftovers, or one
             * read before any connection came up. Silent rather than an empty
             * report: no row would be written either way, and an ordinary reason
             * not to act is a return and not a log. */
            if (accounts.Count == 0)
            {
                ReportChange(null, null);
                return;
            }

            AccountSampleReportResult result = await crm.PostAccountSampleAsync(
                new AccountSampleV1
                {
                    SchemaVersion = attempt.Sample.SchemaVersion,
                    // The machine's own clock at the moment it read, carried
                    // through untouched. Never re-stamped here: the CRM ages every
                    // row from this, and a reading delayed on its way must not
                    // arrive looking fresh.
                    SampledAt = attempt.Sample.SampledAt,
                    Accounts = accounts,
                },
                cancellationToken).ConfigureAwait(false);

            switch (result.Status)
            {
                case AccountSampleReportStatus.Accepted:
                    StoreInterval(result.SampleIntervalSeconds);
                    // A CRM that answers has been deployed, and an add-on that
                    // answered is not old. Both silences are forgotten so that a
                    // fault coming back is written again.
                    crmUnsupportedUntil = null;
                    crmUnsupportedLogged = false;
                    addonUnsupportedUntil = null;
                    addonUnsupportedLogged = false;
                    ReportChange(null, null);
                    break;

                case AccountSampleReportStatus.Unsupported:
                    crmUnsupportedUntil = now + Duration.FromTimeSpan(UnsupportedBackoff);
                    if (!crmUnsupportedLogged)
                    {
                        crmUnsupportedLogged = true;
                        logger.Write(
                            "INFO",
                            "account_sample_unsupported",
                            "The CRM does not accept account samples yet. The tracker will offer one "
                            + "again in 24 hours.");
                    }
                    break;

                default:
                    ReportChange(result.Code ?? "account_sample_failed", null);
                    break;
            }

            /* The account half is finished and its rows are posted, or refused, as
             * they would have been without this line. Only then the strategies. */
            if (connectedNames.Count > 0)
                await RunStrategyPartAsync(now, connectedNames, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            /* A tracker reading is worth nothing next to the day's close, and this
             * loop shares a process with the capture, the upload and the
             * heartbeat. Whatever happened, it dies here. */
            ReportChange("account_sample_failed", exception);
        }
        finally
        {
            gate.Release();
        }
    }

    private static bool Waiting(Instant? until, Instant now) => until.HasValue && now < until.Value;

    /* THE STRATEGY HALF. It never throws, short of the service stopping, and it
     * never writes to the account half's fields: every outcome is reported through
     * ReportStrategyChange under a strategy_ code. */
    private async Task RunStrategyPartAsync(
        Instant now,
        HashSet<string> connectedNames,
        CancellationToken cancellationToken)
    {
        try
        {
            if (Waiting(strategyAddonUnsupportedUntil, now) || Waiting(strategyCrmUnsupportedUntil, now)) return;

            StrategySampleAttempt attempt = await strategyClient
                .SampleStrategiesAsync(cancellationToken).ConfigureAwait(false);

            if (attempt.Outcome == StrategySampleOutcome.Unsupported)
            {
                strategyAddonUnsupportedUntil = now + Duration.FromTimeSpan(UnsupportedBackoff);
                if (!strategyAddonUnsupportedLogged)
                {
                    strategyAddonUnsupportedLogged = true;
                    logger.Write(
                        "INFO",
                        "strategy_sample_addon_unsupported",
                        "The NinjaTrader AddOn on this machine is older than the per strategy reading "
                        + "and cannot answer it. The account tracker is unaffected. It will ask again "
                        + "in 24 hours; replacing the AddOn needs NinjaTrader closed.");
                }
                return;
            }

            if (attempt.Outcome != StrategySampleOutcome.Sampled)
            {
                ReportStrategyChange(StrategyCode(attempt.Code, "strategy_sample_unavailable"), null);
                return;
            }

            /* Observed BEFORE the connected filter, from every live instance the
             * add-on reported, each with its run's trade count when the add-on read
             * one: a drop in that count is a restart no absence would show. Presence is about whether NinjaTrader still holds the
             * instance, and an account that drops its connection for one reading
             * keeps its strategies; observing the filtered list would mark every
             * one of them as restarted when the connection came back. */
            IList<StrategySampleRowV1> read = attempt.Sample.Strategies;
            IReadOnlyDictionary<StrategyInstanceKey, DateTimeOffset?> restarts = strategyRuns.Observe(
                attempt.Sample.SampledAt,
                read.Where(row => row != null)
                    .Select(row => new StrategyRunReading(
                        new StrategyInstanceKey(row.AccountName, row.StrategyId),
                        row.RealtimeTradeCount)));

            List<StrategySampleRowV1> rows = new();
            foreach (StrategySampleRowV1 row in read)
            {
                if (row == null || string.IsNullOrWhiteSpace(row.AccountName)) continue;
                if (!connectedNames.Contains(row.AccountName.Trim())) continue;
                restarts.TryGetValue(
                    new StrategyInstanceKey(row.AccountName, row.StrategyId),
                    out DateTimeOffset? restartedAt);
                rows.Add(new StrategySampleRowV1
                {
                    AccountName = row.AccountName,
                    StrategyId = row.StrategyId,
                    StrategyName = row.StrategyName,
                    Instrument = row.Instrument,
                    RealizedPnl = row.RealizedPnl,
                    UnrealizedPnl = row.UnrealizedPnl,
                    RestartedAt = restartedAt,
                    // RealtimeTradeCount stays behind: it is the add-on telling the
                    // agent about runs, and the restart time above is what it means.
                });
            }

            if (rows.Count == 0)
            {
                ReportStrategyChange(null, null);
                return;
            }

            if (rows.Count > MaximumStrategyRows)
            {
                ReportStrategyChange("strategy_sample_too_large", null);
                return;
            }

            StrategySampleReportResult result = await crm.PostStrategySampleAsync(
                new StrategySampleV1
                {
                    SchemaVersion = attempt.Sample.SchemaVersion,
                    // The machine's own clock at the moment it read, untouched: the
                    // CRM files the reading under the cycle this time falls in.
                    SampledAt = attempt.Sample.SampledAt,
                    Strategies = rows,
                },
                cancellationToken).ConfigureAwait(false);

            switch (result.Status)
            {
                case StrategySampleReportStatus.Accepted:
                    strategyCrmUnsupportedUntil = null;
                    strategyCrmUnsupportedLogged = false;
                    strategyAddonUnsupportedUntil = null;
                    strategyAddonUnsupportedLogged = false;
                    ReportStrategyChange(null, null);
                    return;

                case StrategySampleReportStatus.Unsupported:
                    strategyCrmUnsupportedUntil = now + Duration.FromTimeSpan(StrategyCrmUnsupportedBackoff);
                    if (!strategyCrmUnsupportedLogged)
                    {
                        strategyCrmUnsupportedLogged = true;
                        logger.Write(
                            "INFO",
                            "strategy_sample_unsupported",
                            "The CRM does not accept per strategy readings yet (route or migration 57 "
                            + "missing). The account tracker is unaffected. It will offer one again in an hour.");
                    }
                    return;

                default:
                    ReportStrategyChange(StrategyCode(result.Code, "strategy_sample_failed"), null);
                    // The CRM's own word, once per change, so a 400 says which
                    // rule it broke without the screen having to be opened.
                    if (!string.IsNullOrWhiteSpace(result.Detail)
                        && !string.Equals(lastStrategyDetailLogged, result.Detail, StringComparison.Ordinal))
                    {
                        lastStrategyDetailLogged = result.Detail;
                        logger.Write("INFO", "strategy_sample_refused", "The CRM answered: " + result.Detail);
                    }
                    return;
            }
        }
        catch (Exception exception) when (exception is not OperationCanceledException
            || !cancellationToken.IsCancellationRequested)
        {
            ReportStrategyChange("strategy_sample_failed", exception);
        }
    }

    // Every strategy code carries the strategy_ prefix, so a line in this machine's
    // log can never be read as the account reading having failed.
    private static string StrategyCode(string code, string fallback)
    {
        if (string.IsNullOrWhiteSpace(code)) return fallback;
        return code.StartsWith("strategy_", StringComparison.Ordinal) ? code : "strategy_" + code;
    }

    private void ReportStrategyChange(string code, Exception exception)
    {
        if (string.Equals(lastReportedStrategyCode, code, StringComparison.Ordinal)) return;
        lastReportedStrategyCode = code;
        if (code == null) lastStrategyDetailLogged = null;
        else reporter.LoopFailed(Name, code, exception);
    }

    /* THE ONE NUMBER THE CRM GETS TO CHANGE ON A TRADING MACHINE, so it is read
     * like something that arrived over a network. Out of range or absent and the
     * cadence simply does not move: the previous value stays, which is always
     * either the default or something the CRM said earlier. Nothing here can make
     * this machine sample faster than the floor. */
    private void StoreInterval(int? seconds)
    {
        if (!seconds.HasValue) return;
        if (seconds.Value < MinimumIntervalSeconds || seconds.Value > MaximumIntervalSeconds) return;
        intervalSeconds = seconds.Value;
    }

    // The same rule as the uploader, the heartbeat and the quarantine review: the
    // first occurrence and every change, never the repeats, and a success clears
    // the memory so the same fault is written again if it comes back.
    private void ReportChange(string code, Exception exception)
    {
        if (string.Equals(lastReportedCode, code, StringComparison.Ordinal)) return;
        lastReportedCode = code;
        if (code != null) reporter.LoopFailed(Name, code, exception);
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
