using System;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Contracts;
using Vincere.AutoExport.NinjaTrader.Core.Capture;

namespace Vincere.AutoExport.NinjaTrader.Core.Pipe
{
    public sealed class CaptureRequestProcessor
    {
        private readonly Func<CancellationToken, Task<AutoExportSnapshotV1>> capture;
        private readonly TimeSpan captureTimeout;
        private int captureInProgress;

        public CaptureRequestProcessor(
            Func<CancellationToken, Task<AutoExportSnapshotV1>> capture,
            TimeSpan captureTimeout)
        {
            this.capture = capture ?? throw new ArgumentNullException(nameof(capture));
            if (captureTimeout <= TimeSpan.Zero)
                throw new ArgumentOutOfRangeException(nameof(captureTimeout));
            this.captureTimeout = captureTimeout;
        }

        public async Task<CaptureResponse> ProcessAsync(
            CaptureRequest request,
            CancellationToken cancellationToken = default(CancellationToken))
        {
            Guid requestId = request == null ? Guid.Empty : request.RequestId;
            if (request == null
                || request.RequestId == Guid.Empty
                || !String.Equals(request.Command, "capture", StringComparison.Ordinal))
            {
                return Failure(requestId, "invalid_request", "The capture request is invalid.");
            }

            if (Interlocked.CompareExchange(ref captureInProgress, 1, 0) != 0)
                return Failure(requestId, "capture_busy", "A capture is already in progress.");

            try
            {
                using (CancellationTokenSource timeout =
                    CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
                {
                    timeout.CancelAfter(captureTimeout);
                    AutoExportSnapshotV1 snapshot;
                    try
                    {
                        snapshot = await capture(timeout.Token).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
                    {
                        return Failure(requestId, "capture_timeout", "The capture exceeded its time limit.");
                    }
                    catch (SnapshotCaptureException exception)
                    {
                        return Failure(
                            requestId,
                            exception.Code,
                            "NinjaTrader could not capture the " + exception.Section + " section.");
                    }
                    catch
                    {
                        return Failure(requestId, "capture_failed", "NinjaTrader could not complete the capture.");
                    }

                    if (snapshot == null)
                        return Failure(requestId, "capture_failed", "NinjaTrader returned no capture data.");

                    return new CaptureResponse
                    {
                        Ok = true,
                        RequestId = requestId,
                        Snapshot = snapshot,
                    };
                }
            }
            finally
            {
                Volatile.Write(ref captureInProgress, 0);
            }
        }

        private static CaptureResponse Failure(Guid requestId, string code, string message)
        {
            return new CaptureResponse
            {
                Ok = false,
                RequestId = requestId,
                ErrorCode = code,
                Message = message,
            };
        }
    }
}
