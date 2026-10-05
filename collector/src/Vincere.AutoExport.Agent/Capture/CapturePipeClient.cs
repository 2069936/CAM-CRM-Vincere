using System;
using System.Buffers.Binary;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Scheduling;
using Vincere.AutoExport.Contracts;

namespace Vincere.AutoExport.Agent.Capture;

public interface INinjaTraderProcessDetector
{
    bool IsRunning();
}

public interface INinjaTraderCaptureClient
{
    Task<AutoExportSnapshotV1> CaptureAsync(CancellationToken cancellationToken = default);
}

/// <summary>What asking the add-on for a tracker reading came to.</summary>
public enum AccountSampleOutcome
{
    /// <summary>A reading was taken.</summary>
    Sampled,

    /// <summary>
    /// This add-on does not know the command. It will not know it an hour from
    /// now either: the add-on cannot be replaced while NinjaTrader is loaded, so
    /// the answer changes when a person visits the machine and not before. Stop
    /// asking for a day.
    /// </summary>
    Unsupported,

    /// <summary>
    /// Could not be read this time - NinjaTrader closed, the pipe busy with the
    /// day's close, a timeout, a malformed reply. Nothing to do about it and
    /// nothing worth remembering: the next tick carries a fresh reading, which is
    /// the only kind worth having.
    /// </summary>
    Unavailable,
}

/// <param name="Outcome">What happened.</param>
/// <param name="Sample">The reading, present only when <see cref="AccountSampleOutcome.Sampled"/>.</param>
/// <param name="Code">
/// The add-on's own word for the refusal, or the client's for a transport fault.
/// For this machine's log only. It is deliberately never written to
/// CollectorState's error fields: those reach the heartbeat, whose vocabulary is
/// fixed on the server, and the fleet view paints a machine "Failed - the
/// collector reported an operational error" for any code it finds there. A
/// tracker hiccup must not do that to a machine whose daily close is working.
/// </param>
public sealed record AccountSampleAttempt(
    AccountSampleOutcome Outcome,
    AccountSampleV1 Sample,
    string Code);

/* IT ANSWERS INSTEAD OF THROWING, and that is the design rather than a
 * convenience.
 *
 * CaptureAsync throws CaptureAttemptException for every failure because a close
 * is irreplaceable: the scheduler has to catch the code, record it, quarantine
 * the attempt and decide about retrying. A tracker reading is the opposite kind
 * of thing - worthless five minutes later, never queued, never retried - so
 * every ordinary failure is a return value and the caller has no catch block to
 * get wrong. There is no code path here on which a sample can pile up. */
public interface INinjaTraderAccountSampleClient
{
    Task<AccountSampleAttempt> SampleAccountsAsync(CancellationToken cancellationToken = default);
}

public sealed class NinjaTraderProcessDetector : INinjaTraderProcessDetector
{
    public bool IsRunning()
    {
        Process[] processes = Process.GetProcessesByName("NinjaTrader");
        try
        {
            return processes.Length > 0;
        }
        finally
        {
            foreach (Process process in processes) process.Dispose();
        }
    }
}

public sealed class CapturePipeClient : INinjaTraderCaptureClient, INinjaTraderAccountSampleClient
{
    public const string DefaultPipeName = "Vincere.AutoExport.v1";
    private static readonly UTF8Encoding Utf8WithoutBom = new(false, true);
    private readonly string pipeName;
    private readonly INinjaTraderProcessDetector processDetector;
    private readonly TimeSpan connectTimeout;
    private readonly TimeSpan captureTimeout;
    private readonly TimeSpan sampleTimeout;
    private readonly int maxResponseBytes;

    /// <param name="sampleTimeout">
    /// How long to wait for a tracker reading. A third of the capture's by
    /// default, because the add-on abandons its own sample at five seconds and
    /// waiting much past that only delays the loop that is holding the answer.
    /// </param>
    public CapturePipeClient(
        string pipeName = DefaultPipeName,
        INinjaTraderProcessDetector processDetector = null,
        TimeSpan? connectTimeout = null,
        TimeSpan? captureTimeout = null,
        int maxResponseBytes = 64 * 1024 * 1024,
        TimeSpan? sampleTimeout = null)
    {
        if (string.IsNullOrWhiteSpace(pipeName))
            throw new ArgumentException("A capture pipe name is required.", nameof(pipeName));
        if (maxResponseBytes <= 0)
            throw new ArgumentOutOfRangeException(nameof(maxResponseBytes));
        this.pipeName = pipeName;
        this.processDetector = processDetector ?? new NinjaTraderProcessDetector();
        this.connectTimeout = connectTimeout ?? TimeSpan.FromSeconds(5);
        this.captureTimeout = captureTimeout ?? TimeSpan.FromSeconds(30);
        if (this.connectTimeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(connectTimeout));
        if (this.captureTimeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(captureTimeout));
        this.sampleTimeout = sampleTimeout ?? TimeSpan.FromSeconds(10);
        if (this.sampleTimeout <= TimeSpan.Zero)
            throw new ArgumentOutOfRangeException(nameof(sampleTimeout));
        this.maxResponseBytes = maxResponseBytes;
    }

    public async Task<AutoExportSnapshotV1> CaptureAsync(CancellationToken cancellationToken = default)
    {
        if (!processDetector.IsRunning())
            throw new CaptureAttemptException("ninjatrader_not_running", "NinjaTrader is not running.");

        using NamedPipeClientStream pipe = new(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous);
        using (CancellationTokenSource connectCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
        {
            connectCancellation.CancelAfter(connectTimeout);
            try
            {
                await pipe.ConnectAsync(connectCancellation.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                throw new CaptureAttemptException("addon_unavailable", "The NinjaTrader AddOn did not accept a connection.");
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or TimeoutException)
            {
                throw new CaptureAttemptException("addon_unavailable", "The NinjaTrader AddOn pipe is unavailable.");
            }
        }

        Guid requestId = Guid.NewGuid();
        CaptureRequest request = new() { Command = "capture", RequestId = requestId };
        using CancellationTokenSource captureCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        captureCancellation.CancelAfter(captureTimeout);
        try
        {
            await WriteFrameAsync(pipe, request, captureCancellation.Token).ConfigureAwait(false);
            CaptureResponse response = await ReadResponseAsync(pipe, captureCancellation.Token).ConfigureAwait(false);
            return ValidateResponse(response, requestId);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new CaptureAttemptException("capture_timeout", "NinjaTrader did not complete capture within the time limit.");
        }
        catch (CaptureAttemptException)
        {
            throw;
        }
        catch (Exception exception) when (exception is IOException or EndOfStreamException)
        {
            throw new CaptureAttemptException("capture_failed", "The NinjaTrader capture channel closed unexpectedly.");
        }
    }

    /* THE TRACKER READING, AND THE ONE THING IT MUST NOT DO IS REUSE
     * ValidateResponse.
     *
     * That method collapses every unsuccessful response into "capture_failed" and
     * throws the add-on's own ErrorCode away - there is a test locking that
     * behaviour in place, and for a close it is right: the agent cannot act on the
     * difference and a stable code is worth more than an accurate one.
     *
     * For the tracker the discarded field is the ENTIRE version negotiation. The
     * pipe has no handshake. An add-on that predates this command answers
     * "invalid_request", cleanly, writing the response and closing the connection
     * normally - and that is what every add-on in the field answers today, because
     * the add-on cannot be replaced while NinjaTrader is loaded and these are
     * thirty VPSs trading live accounts. Flatten it and three things follow, all
     * of which look fine in review: an old fleet is indistinguishable from a
     * broken fleet; "capture_failed" IS in the heartbeat's accepted vocabulary, so
     * the misdiagnosis flows onto the fleet view as an operational error on a
     * machine that is working perfectly; and anything keyed on that code retries,
     * every ten minutes, forever, a command the add-on will never accept.
     *
     * So this reads the code and sends it where it belongs: Unsupported, which
     * earns a day of silence, not a fault.
     *
     * THE TWO PIPE CONVERSATIONS, WHICH NOBODY HAD TO ANSWER BEFORE THIS.
     *
     * The pipe SERIALISES, and that is not an accident of timing: CapturePipeSecurity
     * creates it with maxNumberOfServerInstances 1, and CapturePipeServer's accept
     * loop creates the next pipe only after the previous handler has returned. So
     * two conversations can never overlap, and the loser waits on ConnectAsync.
     *
     * A sample arriving during the close is therefore not even refused by the
     * add-on's busy gate - it never gets that far. It waits, gives up at the connect
     * timeout, and lands here as Unavailable. The reading is dropped and the next
     * tick carries a fresh one.
     *
     * THE OTHER DIRECTION IS THE ONE THAT MATTERS, and it is bounded twice over. A
     * close arriving while a sample holds the pipe waits too, and the add-on
     * abandons its own sample after five seconds against the close's five-second
     * connect budget - so in the pathological case the close could be turned away
     * once. It does not lose the day: CaptureScheduler retries two minutes later,
     * repeatedly, until the cutoff, which is half an hour after the scheduled time.
     * A five-second hold once every ten minutes against fifteen retry attempts is
     * the margin, and it is why this needed no interlock with the schedule. */
    public async Task<AccountSampleAttempt> SampleAccountsAsync(CancellationToken cancellationToken = default)
    {
        // Asked first so a closed terminal costs nothing rather than the whole
        // connect timeout. NinjaTrader restarting is an ordinary event on these
        // machines and is not worth a word in a log.
        if (!processDetector.IsRunning())
            return Unavailable("ninjatrader_not_running");

        using NamedPipeClientStream pipe = new(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous);
        using (CancellationTokenSource connectCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
        {
            connectCancellation.CancelAfter(connectTimeout);
            try
            {
                await pipe.ConnectAsync(connectCancellation.Token).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return Unavailable("addon_unavailable");
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or TimeoutException)
            {
                return Unavailable("addon_unavailable");
            }
        }

        Guid requestId = Guid.NewGuid();
        CaptureRequest request = new() { Command = "sample_accounts", RequestId = requestId };
        using CancellationTokenSource sampleCancellation =
            CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        sampleCancellation.CancelAfter(sampleTimeout);
        try
        {
            await WriteFrameAsync(pipe, request, sampleCancellation.Token).ConfigureAwait(false);
            CaptureResponse response = await ReadResponseAsync(pipe, sampleCancellation.Token).ConfigureAwait(false);
            return ReadSample(response, requestId);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            return Unavailable("sample_timeout");
        }
        // ReadResponseAsync is shared with the close and signals a malformed
        // reply the only way that method knows how. Caught rather than allowed
        // out, because for the tracker a malformed reply is just another reading
        // that did not happen.
        catch (CaptureAttemptException exception)
        {
            return Unavailable(exception.Code);
        }
        catch (Exception exception) when (exception is IOException or EndOfStreamException)
        {
            return Unavailable("sample_failed");
        }
    }

    private static AccountSampleAttempt ReadSample(CaptureResponse response, Guid requestId)
    {
        if (response.RequestId != requestId)
            return Unavailable("contract_mismatch");

        if (!response.Ok)
        {
            /* THE WHOLE POINT OF THIS METHOD. "invalid_request" is an add-on that
             * has never heard of the command, which is the expected answer across
             * most of the fleet for as long as it takes a person to visit each
             * machine with NinjaTrader closed. It is not a fault and must not be
             * retried on the next tick. */
            return string.Equals(response.ErrorCode, "invalid_request", StringComparison.Ordinal)
                ? new AccountSampleAttempt(AccountSampleOutcome.Unsupported, null, response.ErrorCode)
                // Anything else - capture_busy, sample_timeout, sample_failed - is
                // this reading lost and the next one unaffected. The add-on's own
                // word is kept rather than replaced, so a log says what happened.
                : Unavailable(response.ErrorCode ?? "sample_failed");
        }

        /* VALIDATED AS A SAMPLE, NOT AS A SNAPSHOT. A reply whose shape is wrong
         * is a reading that did not happen; it is never a close, and there is no
         * path from here to the queue. */
        AccountSampleV1 sample = response.Sample;
        if (sample == null || sample.SchemaVersion != 1 || sample.Accounts == null)
            return Unavailable("contract_mismatch");

        return new AccountSampleAttempt(AccountSampleOutcome.Sampled, sample, null);
    }

    private static AccountSampleAttempt Unavailable(string code)
    {
        return new AccountSampleAttempt(AccountSampleOutcome.Unavailable, null, code);
    }

    private async Task<CaptureResponse> ReadResponseAsync(
        Stream stream,
        CancellationToken cancellationToken)
    {
        byte[] lengthBytes = new byte[4];
        await stream.ReadExactlyAsync(lengthBytes, cancellationToken).ConfigureAwait(false);
        int length = BinaryPrimitives.ReadInt32LittleEndian(lengthBytes);
        if (length <= 0 || length > maxResponseBytes)
            throw new CaptureAttemptException("contract_mismatch", "The AddOn response size is invalid.");

        byte[] payload = new byte[length];
        await stream.ReadExactlyAsync(payload, cancellationToken).ConfigureAwait(false);
        try
        {
            CaptureResponse response = JsonConvert.DeserializeObject<CaptureResponse>(
                Utf8WithoutBom.GetString(payload));
            return response ?? throw new CaptureAttemptException(
                "contract_mismatch",
                "The AddOn returned an empty response.");
        }
        catch (JsonException)
        {
            throw new CaptureAttemptException("contract_mismatch", "The AddOn response is not valid JSON.");
        }
    }

    private static AutoExportSnapshotV1 ValidateResponse(CaptureResponse response, Guid requestId)
    {
        if (response.RequestId != requestId)
            throw new CaptureAttemptException("contract_mismatch", "The AddOn response request ID does not match.");
        if (!response.Ok)
            throw new CaptureAttemptException("capture_failed", "The AddOn could not capture the NinjaTrader datasets.");

        AutoExportSnapshotV1 snapshot = response.Snapshot;
        if (snapshot == null
            || snapshot.SchemaVersion != 1
            || snapshot.CaptureId == Guid.Empty
            || !DateTime.TryParseExact(
                snapshot.TradingDate,
                "yyyy-MM-dd",
                CultureInfo.InvariantCulture,
                DateTimeStyles.None,
                out _)
            || snapshot.TimeZone != CaptureSchedule.TimeZoneId
            || snapshot.Source == null
            || string.IsNullOrWhiteSpace(snapshot.Source.AddonVersion)
            || string.IsNullOrWhiteSpace(snapshot.Source.NinjaTraderVersion)
            || snapshot.Accounts == null
            || snapshot.Strategies == null
            || snapshot.Orders == null
            || snapshot.Executions == null)
        {
            throw new CaptureAttemptException("contract_mismatch", "The AddOn snapshot does not match contract version 1.");
        }
        return snapshot;
    }

    private static async Task WriteFrameAsync<T>(
        Stream stream,
        T value,
        CancellationToken cancellationToken)
    {
        byte[] payload = Utf8WithoutBom.GetBytes(JsonConvert.SerializeObject(value, Formatting.None));
        byte[] length = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(length, payload.Length);
        await stream.WriteAsync(length, cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }
}
