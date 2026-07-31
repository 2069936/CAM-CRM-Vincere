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

public sealed class CapturePipeClient : INinjaTraderCaptureClient
{
    public const string DefaultPipeName = "Vincere.AutoExport.v1";
    private static readonly UTF8Encoding Utf8WithoutBom = new(false, true);
    private readonly string pipeName;
    private readonly INinjaTraderProcessDetector processDetector;
    private readonly TimeSpan connectTimeout;
    private readonly TimeSpan captureTimeout;
    private readonly int maxResponseBytes;

    public CapturePipeClient(
        string pipeName = DefaultPipeName,
        INinjaTraderProcessDetector processDetector = null,
        TimeSpan? connectTimeout = null,
        TimeSpan? captureTimeout = null,
        int maxResponseBytes = 64 * 1024 * 1024)
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
