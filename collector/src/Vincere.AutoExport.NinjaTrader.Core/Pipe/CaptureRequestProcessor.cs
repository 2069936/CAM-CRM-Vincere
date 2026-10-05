using System;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Contracts;
using Vincere.AutoExport.NinjaTrader.Core.Capture;

namespace Vincere.AutoExport.NinjaTrader.Core.Pipe
{
    /* TWO COMMANDS NOW, AND THE SECOND ONE IS CHEAP ON PURPOSE.
     *
     * "capture" is the day's close: four sections, every order and every fill,
     * and the two platform collections the trading thread writes on every single
     * trade. The repo's own budget for it is ONE extra intraday run per day,
     * never retried, and CaptureScheduler says why in its own words: "This runs
     * on a machine that is trading, and a convenience read must never be able to
     * disturb that."
     *
     * "sample_accounts" is the tracker reading, taken every ten minutes during
     * market hours, which is why it had to be a new command rather than a
     * schedule. Thirty-nine closes a session against live prop-firm accounts is
     * not a trade worth making, and the saving is NOT the response size - a real
     * machine-day is around a hundred orders, not the tens of thousands a careless
     * reading of the deep-export history suggests. What it saves is the work:
     * lock (account.Orders) and lock (account.Executions), the two collections the
     * trading path mutates on every fill, plus the per-row TypeDescriptor walk
     * NinjaTraderFacade.ReadExtraValues runs once for every order and once for
     * every execution, on NinjaTrader's own UI thread.
     *
     * ONE GATE FOR BOTH. captureInProgress is shared rather than split, so a
     * sample and a close can never both be on the dispatcher. Today that is belt
     * and braces - CapturePipeServer serves one connection at a time and creates
     * the next pipe only after the previous handler returns, so the two cannot
     * overlap anyway - but it means the invariant is stated in the code that
     * depends on it rather than inferred from the server's accept loop.
     *
     * WHICH OF THE TWO WAITS, STATED HONESTLY. A sample is normally tens of
     * milliseconds, and the sample timeout below is the hard ceiling on how long it
     * can hold the dispatcher. In the pathological case - a terminal busy enough to
     * take the whole five seconds - a close arriving in that window could be turned
     * away once on its own five-second connect budget. It does not lose the day:
     * CaptureScheduler retries two minutes later, repeatedly, until a cutoff half an
     * hour after the scheduled time. Fifteen retry attempts against a five-second
     * hold once every ten minutes is the margin, and it is why the sample needs no
     * interlock with the schedule. The ceiling is the thing doing the work here, so
     * raising it is not a free change.
     *
     * AN OLD ADD-ON STILL ANSWERS CLEANLY. Everything in the field today falls
     * through to invalid_request, writes the response and closes the connection
     * normally. That clean refusal IS the version negotiation: there is no
     * handshake, and none is needed, as long as the agent reads the error code
     * instead of flattening it. */
    public sealed class CaptureRequestProcessor
    {
        private readonly Func<CancellationToken, Task<AutoExportSnapshotV1>> capture;
        private readonly Func<CancellationToken, Task<AccountSampleV1>> sampleAccounts;
        private readonly TimeSpan captureTimeout;
        private readonly TimeSpan sampleTimeout;
        private int captureInProgress;

        /// <param name="sampleAccounts">
        /// The tracker reading. Optional, and a processor built without one
        /// refuses "sample_accounts" with invalid_request - the same answer an
        /// add-on that predates the command gives, so the agent needs no second
        /// code path for it.
        /// </param>
        /// <param name="sampleTimeout">
        /// Much shorter than the capture's by default. A sample is worthless five
        /// minutes later, so a slow one should be abandoned rather than waited
        /// for, and a reading that cannot be had in five seconds is telling us
        /// something about the terminal that waiting will not fix.
        /// </param>
        public CaptureRequestProcessor(
            Func<CancellationToken, Task<AutoExportSnapshotV1>> capture,
            TimeSpan captureTimeout,
            Func<CancellationToken, Task<AccountSampleV1>> sampleAccounts = null,
            TimeSpan? sampleTimeout = null)
        {
            this.capture = capture ?? throw new ArgumentNullException(nameof(capture));
            if (captureTimeout <= TimeSpan.Zero)
                throw new ArgumentOutOfRangeException(nameof(captureTimeout));
            this.captureTimeout = captureTimeout;
            this.sampleAccounts = sampleAccounts;
            this.sampleTimeout = sampleTimeout ?? TimeSpan.FromSeconds(5);
            if (this.sampleTimeout <= TimeSpan.Zero)
                throw new ArgumentOutOfRangeException(nameof(sampleTimeout));
        }

        public async Task<CaptureResponse> ProcessAsync(
            CaptureRequest request,
            CancellationToken cancellationToken = default(CancellationToken))
        {
            Guid requestId = request == null ? Guid.Empty : request.RequestId;
            if (request == null || request.RequestId == Guid.Empty)
                return Failure(requestId, "invalid_request", "The capture request is invalid.");

            bool isCapture = String.Equals(request.Command, "capture", StringComparison.Ordinal);
            bool isSample = String.Equals(request.Command, "sample_accounts", StringComparison.Ordinal);
            // A sample asked of an add-on built without the delegate is not a
            // different situation from a sample asked of an add-on built before
            // the command existed, and must not look like one.
            if (!isCapture && !(isSample && sampleAccounts != null))
                return Failure(requestId, "invalid_request", "The capture request is invalid.");

            if (Interlocked.CompareExchange(ref captureInProgress, 1, 0) != 0)
                return Failure(requestId, "capture_busy", "A capture is already in progress.");

            try
            {
                using (CancellationTokenSource timeout =
                    CancellationTokenSource.CreateLinkedTokenSource(cancellationToken))
                {
                    timeout.CancelAfter(isCapture ? captureTimeout : sampleTimeout);
                    return isCapture
                        ? await CaptureAsync(requestId, timeout.Token, cancellationToken).ConfigureAwait(false)
                        : await SampleAsync(requestId, timeout.Token, cancellationToken).ConfigureAwait(false);
                }
            }
            finally
            {
                Volatile.Write(ref captureInProgress, 0);
            }
        }

        private async Task<CaptureResponse> CaptureAsync(
            Guid requestId,
            CancellationToken timeoutToken,
            CancellationToken cancellationToken)
        {
            AutoExportSnapshotV1 snapshot;
            try
            {
                snapshot = await capture(timeoutToken).ConfigureAwait(false);
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

        /* ITS OWN ERROR CODES, so a tracker fault can never be mistaken for a
         * close fault. "sample_timeout" and "sample_failed" are deliberately not
         * "capture_timeout" and "capture_failed": those two are in the
         * heartbeat's fixed error vocabulary, and a tracker hiccup that borrowed
         * one would be reported, stored, and rendered on the fleet view as "the
         * collector reported an operational error" about a machine whose daily
         * close is working perfectly. These words stay inside the pipe and inside
         * this machine's own log. */
        private async Task<CaptureResponse> SampleAsync(
            Guid requestId,
            CancellationToken timeoutToken,
            CancellationToken cancellationToken)
        {
            AccountSampleV1 sample;
            try
            {
                sample = await sampleAccounts(timeoutToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                return Failure(requestId, "sample_timeout", "The account sample exceeded its time limit.");
            }
            catch
            {
                return Failure(requestId, "sample_failed", "NinjaTrader could not read the accounts.");
            }

            if (sample == null)
                return Failure(requestId, "sample_failed", "NinjaTrader returned no account sample.");

            return new CaptureResponse
            {
                Ok = true,
                RequestId = requestId,
                Sample = sample,
            };
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
