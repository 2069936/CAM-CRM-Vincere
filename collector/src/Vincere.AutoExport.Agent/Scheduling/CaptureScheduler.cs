using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
using Vincere.AutoExport.Agent.Configuration;

namespace Vincere.AutoExport.Agent.Scheduling;

public sealed record CaptureRequestContext(
    string TradingDate,
    DateTimeOffset CapturedAt,
    string TimeZone,
    bool IsManual);

public sealed record CaptureRunResult(
    CaptureScheduleDecision Decision,
    bool CaptureQueued,
    string ErrorCode,
    Instant? RetryAt);

public interface ICaptureWorkflow
{
    Task CaptureAndQueueAsync(
        CaptureRequestContext context,
        CancellationToken cancellationToken = default);

    /* Read the strategies while they are still running and keep them.
     *
     * NinjaTrader disables them around 16:30 and a disabled strategy leaves the
     * account's collection entirely, so the capture that gets the money right
     * gets no strategies at all. This queues nothing and records no history: it
     * exists only so the close has something true to carry. */
    Task ObserveStrategiesAsync(
        string tradingDate,
        CancellationToken cancellationToken = default);
}

public interface ICaptureScheduler
{
    Task<CaptureRunResult> RunScheduledAsync(
        Instant now,
        CancellationToken cancellationToken = default);

    Task<CaptureRunResult> RunManualAsync(
        Instant now,
        CancellationToken cancellationToken = default);
}

public sealed class CaptureAttemptException : Exception
{
    public CaptureAttemptException(string code, string message) : base(message)
    {
        if (string.IsNullOrWhiteSpace(code))
            throw new ArgumentException("A stable capture error code is required.", nameof(code));
        Code = code;
    }

    public string Code { get; }
}

public sealed class CaptureScheduler : ICaptureScheduler
{
    private static readonly Duration RetryDelay = Duration.FromMinutes(2);
    private readonly IAgentOptionsStore optionsStore;
    private readonly ICaptureWorkflow captureWorkflow;
    private readonly SemaphoreSlim gate = new(1, 1);

    public CaptureScheduler(
        IAgentOptionsStore optionsStore,
        ICaptureWorkflow captureWorkflow)
    {
        this.optionsStore = optionsStore ?? throw new ArgumentNullException(nameof(optionsStore));
        this.captureWorkflow = captureWorkflow ?? throw new ArgumentNullException(nameof(captureWorkflow));
    }

    public async Task<CaptureRunResult> RunScheduledAsync(
        Instant now,
        CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ConfigurationLoadResult configuration = await optionsStore.LoadAsync(cancellationToken)
                .ConfigureAwait(false);
            CaptureSchedule schedule = CaptureSchedule.FromOptions(configuration.Options);
            CaptureScheduleDecision decision = schedule.Evaluate(
                now,
                configuration.Options.LastScheduledTradingDate);
            if (decision.Kind != CaptureScheduleDecisionKind.Due)
            {
                await MaybeObserveStrategiesAsync(schedule, now, cancellationToken).ConfigureAwait(false);
                return new CaptureRunResult(decision, false, null, null);
            }

            CaptureRequestContext context = CreateContext(schedule, now, isManual: false);
            try
            {
                await captureWorkflow.CaptureAndQueueAsync(context, cancellationToken).ConfigureAwait(false);
            }
            catch (CaptureAttemptException exception)
            {
                Instant candidateRetry = now + RetryDelay;
                LocalDate tradingDate = now.InZone(DateTimeZoneProviders.Tzdb[CaptureSchedule.TimeZoneId]).Date;
                Instant? retryAt = candidateRetry < schedule.GetCutoffInstant(tradingDate)
                    ? candidateRetry
                    : null;
                return new CaptureRunResult(decision, false, exception.Code, retryAt);
            }

            AgentOptions saved = configuration.Options with
            {
                LastScheduledTradingDate = decision.TradingDate,
            };
            await optionsStore.SaveAsync(saved, cancellationToken).ConfigureAwait(false);
            return new CaptureRunResult(decision, true, null, null);
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task<CaptureRunResult> RunManualAsync(
        Instant now,
        CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ConfigurationLoadResult configuration = await optionsStore.LoadAsync(cancellationToken)
                .ConfigureAwait(false);
            CaptureSchedule schedule = CaptureSchedule.FromOptions(configuration.Options);
            CaptureRequestContext context = CreateContext(schedule, now, isManual: true);
            CaptureScheduleDecision decision = new(
                CaptureScheduleDecisionKind.Due,
                context.TradingDate,
                null);
            try
            {
                await captureWorkflow.CaptureAndQueueAsync(context, cancellationToken).ConfigureAwait(false);
                return new CaptureRunResult(decision, true, null, null);
            }
            catch (CaptureAttemptException exception)
            {
                return new CaptureRunResult(decision, false, exception.Code, null);
            }
        }
        finally
        {
            gate.Release();
        }
    }

    /* ONE READ A DAY, WHILE THE STRATEGIES ARE STILL THERE.
     *
     * NinjaTrader disables them around 16:30 and a disabled strategy leaves the
     * account's collection, so the capture timed to get the money right finds
     * none. This runs in the half hour before the scheduled capture, once per
     * trading date, and stores what it saw for the close to carry.
     *
     * It is deliberately small: no queue write, no history entry, no retry, and
     * a failure is swallowed. This runs on a machine that is trading, and a
     * convenience read must never be able to disturb that or to fail a day.
     */
    private static readonly Duration ObservationLead = Duration.FromMinutes(30);
    private static readonly Duration ObservationLatest = Duration.FromMinutes(5);
    private string lastObservedTradingDate;

    private async Task MaybeObserveStrategiesAsync(
        CaptureSchedule schedule,
        Instant now,
        CancellationToken cancellationToken)
    {
        LocalDate tradingDate = now.InZone(DateTimeZoneProviders.Tzdb[CaptureSchedule.TimeZoneId]).Date;
        if (!schedule.EnabledDays.Contains(tradingDate.DayOfWeek)) return;
        string key = $"{tradingDate.Year:D4}-{tradingDate.Month:D2}-{tradingDate.Day:D2}";
        if (string.Equals(lastObservedTradingDate, key, StringComparison.Ordinal)) return;

        Instant scheduled = schedule.GetScheduledInstant(tradingDate);
        if (now < scheduled - ObservationLead || now > scheduled - ObservationLatest) return;

        try
        {
            await captureWorkflow.ObserveStrategiesAsync(key, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            // Nothing about the day depends on this succeeding.
        }
        // Marked either way. One attempt a day is the budget; retrying a read
        // against a trading platform to fill a reporting column is not a trade
        // worth making.
        lastObservedTradingDate = key;
    }

    private static CaptureRequestContext CreateContext(
        CaptureSchedule schedule,
        Instant now,
        bool isManual)
    {
        ManualCaptureContext local = schedule.CreateManualCaptureContext(now);
        return new CaptureRequestContext(local.TradingDate, local.CapturedAt, local.TimeZone, isManual);
    }
}
