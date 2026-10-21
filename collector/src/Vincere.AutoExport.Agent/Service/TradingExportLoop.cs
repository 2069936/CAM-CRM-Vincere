using System;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Diagnostics;
using Vincere.AutoExport.Agent.Exports;
using Vincere.AutoExport.Agent.Security;

namespace Vincere.AutoExport.Agent.Service;

/* "REQUEST A SLIM TRADING EXPORT FROM THE CRM", THE MACHINE'S HALF.
 *
 * Every five minutes a paired machine asks the CRM whether a Manager wants this
 * client's trading for a range of days. When one does:
 *
 *   1. the request is checked (an id, real dates in order, datasets from the
 *      four, a positive size limit capped at 25 MB);
 *   2. the file is built under ProgramData\Vincere\AutoExport\exports, at
 *      BelowNormal priority, from a copy of NinjaTrader's database - see
 *      TradingExportBuilder for what is in it and what never is;
 *   3. the CRM is asked where to put it, and the address must be HTTPS on the
 *      CRM's storage host;
 *   4. the bytes go there by PUT, carrying no credential of this machine;
 *   5. the CRM is told "ready", with the digest, the size and the row counts,
 *      and the work folder is deleted.
 *
 * Any failure is reported with export-complete as "failed" and one code from
 * TradingExportErrorCodes - never a message - and the Manager asks again. There
 * is no retry budget because there is nothing to retry: each request is
 * answered once. The one thing that is retried is the answer itself, when the
 * CRM could not be told: TradingExportStateStore holds it, and the next poll
 * that offers the same request sends the owed completion without building again.
 *
 * NINJATRADER IS NEVER TOUCHED and keeps running: nothing here stops, pauses or
 * writes to it, and its database is only ever read as a copy.
 *
 * NEVER THROWS for an ordinary failure, the rule every loop here keeps. Nothing
 * logged here carries client data or the upload address: request ids, sizes,
 * counts and codes. */
public sealed class TradingExportLoop : ICollectorLoop
{
    public static readonly TimeSpan PollInterval = TimeSpan.FromMinutes(5);

    /// <summary>A CRM without the route is asked again after this, not every five minutes.</summary>
    public static readonly TimeSpan UnsupportedBackoff = TimeSpan.FromHours(1);

    private readonly ICollectorCrmClient crm;
    private readonly IDeviceTokenStore tokenStore;
    private readonly ITradingExportBuilder builder;
    private readonly TradingExportStateStore stateStore;
    private readonly ICollectorClock clock;
    private readonly string agentVersion;
    private readonly IServiceReporter reporter;
    private readonly IRedactingLogger logger;

    private DateTimeOffset? unsupportedUntil;
    private bool unsupportedLogged;
    private string lastReportedCode;

    /* No optional parameters, on purpose: see AgentUpdateLoop. */
    public TradingExportLoop(
        ICollectorCrmClient crm,
        IDeviceTokenStore tokenStore,
        ITradingExportBuilder builder,
        TradingExportStateStore stateStore,
        ICollectorClock clock,
        string agentVersion,
        IServiceReporter reporter,
        IRedactingLogger logger)
    {
        this.crm = crm ?? throw new ArgumentNullException(nameof(crm));
        this.tokenStore = tokenStore ?? throw new ArgumentNullException(nameof(tokenStore));
        this.builder = builder ?? throw new ArgumentNullException(nameof(builder));
        this.stateStore = stateStore ?? throw new ArgumentNullException(nameof(stateStore));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.agentVersion = string.IsNullOrWhiteSpace(agentVersion)
            ? throw new ArgumentException("A version is required.", nameof(agentVersion))
            : agentVersion.Trim();
        this.reporter = reporter ?? throw new ArgumentNullException(nameof(reporter));
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public string Name => "trading-export";
    public TimeSpan Interval => PollInterval;

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        // The heartbeat's test: an unpaired machine has nobody to ask.
        if (string.IsNullOrWhiteSpace(await tokenStore.LoadTokenAsync(cancellationToken).ConfigureAwait(false)))
            return;
        if (unsupportedUntil is DateTimeOffset until && clock.GetCurrentDateTimeOffset() < until) return;
        try
        {
            await RunPassAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            ReportChange("trading_export_failed", exception);
        }
    }

    private async Task RunPassAsync(CancellationToken cancellationToken)
    {
        ExportRequestPollResult poll = await crm.PollExportRequestAsync(agentVersion, cancellationToken).ConfigureAwait(false);
        if (poll.Status == ExportRequestPollStatus.Unsupported)
        {
            unsupportedUntil = clock.GetCurrentDateTimeOffset() + UnsupportedBackoff;
            if (!unsupportedLogged)
            {
                unsupportedLogged = true;
                logger.Write(
                    "INFO",
                    "trading_export_unsupported",
                    "The CRM does not ask for trading exports yet. It will be asked again in an hour.");
            }
            return;
        }
        if (poll.Status == ExportRequestPollStatus.Failed)
        {
            // Including a 401: the heartbeat owns unpairing, never this loop.
            ReportChange(poll.Code ?? "export_request_failed", null);
            return;
        }
        unsupportedUntil = null;
        unsupportedLogged = false;
        if (poll.Request == null)
        {
            ReportChange(null, null);
            return;
        }

        TradingExportValidation validation = TradingExportRequestValidator.Validate(poll.Request);
        if (!validation.CanComplete)
        {
            // No id this machine can answer under: nothing to complete, nothing built.
            ReportChange("export_request_invalid", null);
            return;
        }

        TradingExportState state = stateStore.Load();
        if (state != null && string.Equals(state.RequestId, validation.RequestId, StringComparison.Ordinal))
        {
            // Answered already, or the answer is owed: never build the same request twice.
            if (state.CompletionOwed) await CompleteAsync(state, cancellationToken).ConfigureAwait(false);
            return;
        }

        TradingExportState outcome = validation.IsValid
            ? await ExportAsync(validation.Plan, cancellationToken).ConfigureAwait(false)
            : Failed(validation.RequestId, poll.Request.From, poll.Request.To, validation.ErrorCode);
        stateStore.Save(outcome);
        await CompleteAsync(outcome, cancellationToken).ConfigureAwait(false);
    }

    /// <summary>Build, ask where, upload. The work folder is gone when this returns, whatever happened.</summary>
    private async Task<TradingExportState> ExportAsync(TradingExportPlan plan, CancellationToken cancellationToken)
    {
        logger.Write(
            "INFO",
            "trading_export_started",
            $"Trading export {plan.RequestId} requested: {string.Join(",", plan.Datasets)} from {plan.FromText ?? "the start"} to {plan.ToText ?? "now"}.");

        using TradingExportBuild build = await builder.BuildAsync(plan, cancellationToken).ConfigureAwait(false);
        if (!build.Ok) return Failed(plan, build.ErrorCode);

        ExportUploadUrlResult target = await crm
            .RequestExportUploadUrlAsync(new ExportUploadUrlRequest(plan.RequestId, build.Sha256, build.ByteSize), cancellationToken)
            .ConfigureAwait(false);
        if (!target.Ok)
        {
            return Failed(plan, target.Code == TradingExportErrorCodes.UrlNotAllowed
                ? TradingExportErrorCodes.UrlNotAllowed
                : TradingExportErrorCodes.UploadUrlFailed);
        }

        ExportUploadResult upload = await crm
            .UploadExportAsync(target.Target.UploadUrl, build.FilePath, cancellationToken)
            .ConfigureAwait(false);
        if (!upload.Ok)
        {
            return Failed(plan, upload.Code switch
            {
                TradingExportErrorCodes.UrlNotAllowed => TradingExportErrorCodes.UrlNotAllowed,
                TradingExportErrorCodes.UploadTimeout => TradingExportErrorCodes.UploadTimeout,
                _ => TradingExportErrorCodes.UploadFailed,
            });
        }

        logger.Write(
            "INFO",
            "trading_export_uploaded",
            $"Trading export {plan.RequestId} uploaded: {build.ByteSize} bytes, {build.RowCounts.Executions} executions, "
                + $"{build.RowCounts.Orders} orders, {build.RowCounts.Strategies} strategies, {build.RowCounts.Trades} trades.");
        return new TradingExportState
        {
            RequestId = plan.RequestId,
            Phase = TradingExportState.Uploaded,
            Status = ExportCompleteRequest.Ready,
            Sha256 = build.Sha256,
            ByteSize = build.ByteSize,
            RowCounts = build.RowCounts,
            From = plan.FromText,
            To = plan.ToText,
            UpdatedAt = clock.GetCurrentDateTimeOffset(),
        };
    }

    /// <summary>Tell the CRM, once per pass. Not told is kept, and the next offer of the same request tells it.</summary>
    private async Task CompleteAsync(TradingExportState state, CancellationToken cancellationToken)
    {
        ExportCompleteResult result = await crm.CompleteExportAsync(state.ToCompletion(), cancellationToken).ConfigureAwait(false);
        if (!result.Ok)
        {
            ReportChange(result.Code ?? "export_complete_failed", null);
            return;
        }
        stateStore.Save(state with { Phase = TradingExportState.Completed, UpdatedAt = clock.GetCurrentDateTimeOffset() });
        if (state.Status == ExportCompleteRequest.Ready)
        {
            logger.Write("INFO", "trading_export_ready", $"Trading export {state.RequestId} is with the CRM.");
            ReportChange(null, null);
        }
        else
        {
            logger.Write("WARN", "trading_export_refused", $"Trading export {state.RequestId} failed: {state.ErrorCode}.");
            ReportChange(state.ErrorCode, null);
        }
    }

    private TradingExportState Failed(TradingExportPlan plan, string code)
        => Failed(plan.RequestId, plan.FromText, plan.ToText, code);

    private TradingExportState Failed(string requestId, string from, string to, string code) => new()
    {
        RequestId = requestId,
        Phase = TradingExportState.FailedPhase,
        Status = ExportCompleteRequest.Failed,
        ErrorCode = code ?? TradingExportErrorCodes.ExportFailed,
        From = from,
        To = to,
        UpdatedAt = clock.GetCurrentDateTimeOffset(),
    };

    // The rule every loop here follows: the first occurrence and every change,
    // never the repeats, and a success clears it so a returning fault is written.
    private void ReportChange(string code, Exception exception)
    {
        if (string.Equals(lastReportedCode, code, StringComparison.Ordinal)) return;
        lastReportedCode = code;
        if (code != null) reporter.LoopFailed(Name, code, exception);
    }
}
