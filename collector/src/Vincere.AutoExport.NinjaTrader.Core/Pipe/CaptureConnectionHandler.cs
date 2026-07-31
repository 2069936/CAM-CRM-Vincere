using System;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Contracts;

namespace Vincere.AutoExport.NinjaTrader.Core.Pipe
{
    public sealed class CaptureConnectionHandler
    {
        private readonly CaptureFrameCodec codec;
        private readonly CaptureRequestProcessor processor;
        private readonly Action<CaptureResponse> observeResponse;

        public CaptureConnectionHandler(
            CaptureFrameCodec codec,
            CaptureRequestProcessor processor,
            Action<CaptureResponse> observeResponse = null)
        {
            this.codec = codec ?? throw new ArgumentNullException(nameof(codec));
            this.processor = processor ?? throw new ArgumentNullException(nameof(processor));
            this.observeResponse = observeResponse;
        }

        public async Task HandleAsync(
            Stream stream,
            CancellationToken cancellationToken = default(CancellationToken))
        {
            if (stream == null) throw new ArgumentNullException(nameof(stream));
            CaptureRequest request;
            try
            {
                request = await codec.ReadRequestAsync(stream, cancellationToken).ConfigureAwait(false);
            }
            catch (FrameProtocolException exception)
            {
                await WriteObservedAsync(
                    stream,
                    Failure(Guid.Empty, exception.Code, "The capture request frame is invalid."),
                    cancellationToken).ConfigureAwait(false);
                return;
            }

            CaptureResponse response = await processor.ProcessAsync(request, cancellationToken)
                .ConfigureAwait(false);
            try
            {
                await WriteObservedAsync(stream, response, cancellationToken).ConfigureAwait(false);
            }
            catch (FrameProtocolException exception) when (exception.Code == "response_too_large")
            {
                await WriteObservedAsync(
                    stream,
                    Failure(request.RequestId, "response_too_large", "The capture response exceeds the size limit."),
                    cancellationToken).ConfigureAwait(false);
            }
        }

        private async Task WriteObservedAsync(
            Stream stream,
            CaptureResponse response,
            CancellationToken cancellationToken)
        {
            await codec.WriteResponseAsync(stream, response, cancellationToken).ConfigureAwait(false);
            observeResponse?.Invoke(response);
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
