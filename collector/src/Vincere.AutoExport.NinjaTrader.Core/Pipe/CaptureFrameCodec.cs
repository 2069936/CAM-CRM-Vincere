using System;
using System.IO;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Contracts;

namespace Vincere.AutoExport.NinjaTrader.Core.Pipe
{
    public sealed class FrameProtocolException : Exception
    {
        public FrameProtocolException(string code, string message)
            : base(message)
        {
            Code = code;
        }

        public string Code { get; private set; }
    }

    public sealed class CaptureFrameCodec
    {
        private static readonly UTF8Encoding StrictUtf8 = new UTF8Encoding(false, true);
        private readonly int maximumRequestBytes;
        private readonly int maximumResponseBytes;

        public CaptureFrameCodec(int maximumRequestBytes, int maximumResponseBytes)
        {
            if (maximumRequestBytes <= 0)
                throw new ArgumentOutOfRangeException(nameof(maximumRequestBytes));
            if (maximumResponseBytes <= 0)
                throw new ArgumentOutOfRangeException(nameof(maximumResponseBytes));
            this.maximumRequestBytes = maximumRequestBytes;
            this.maximumResponseBytes = maximumResponseBytes;
        }

        public async Task<CaptureRequest> ReadRequestAsync(
            Stream stream,
            CancellationToken cancellationToken = default(CancellationToken))
        {
            if (stream == null) throw new ArgumentNullException(nameof(stream));
            byte[] lengthBytes = new byte[4];
            await ReadExactlyAsync(stream, lengthBytes, cancellationToken).ConfigureAwait(false);
            int length = lengthBytes[0]
                | (lengthBytes[1] << 8)
                | (lengthBytes[2] << 16)
                | (lengthBytes[3] << 24);
            if (length <= 0 || length > maximumRequestBytes)
                throw new FrameProtocolException("invalid_frame_size", "The request frame size is invalid.");

            byte[] payload = new byte[length];
            await ReadExactlyAsync(stream, payload, cancellationToken).ConfigureAwait(false);
            try
            {
                CaptureRequest request = JsonConvert.DeserializeObject<CaptureRequest>(
                    StrictUtf8.GetString(payload));
                if (request == null)
                    throw new JsonSerializationException("empty request");
                return request;
            }
            catch (Exception exception) when (
                exception is JsonException || exception is DecoderFallbackException)
            {
                throw new FrameProtocolException("invalid_request_json", "The request payload is invalid.");
            }
        }

        public async Task WriteResponseAsync(
            Stream stream,
            CaptureResponse response,
            CancellationToken cancellationToken = default(CancellationToken))
        {
            if (stream == null) throw new ArgumentNullException(nameof(stream));
            if (response == null) throw new ArgumentNullException(nameof(response));
            byte[] payload = StrictUtf8.GetBytes(JsonConvert.SerializeObject(response, Formatting.None));
            if (payload.Length <= 0 || payload.Length > maximumResponseBytes)
                throw new FrameProtocolException("response_too_large", "The response exceeds the frame limit.");

            byte[] length =
            {
                (byte)payload.Length,
                (byte)(payload.Length >> 8),
                (byte)(payload.Length >> 16),
                (byte)(payload.Length >> 24),
            };
            await stream.WriteAsync(length, 0, length.Length, cancellationToken).ConfigureAwait(false);
            await stream.WriteAsync(payload, 0, payload.Length, cancellationToken).ConfigureAwait(false);
            await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        }

        private static async Task ReadExactlyAsync(
            Stream stream,
            byte[] buffer,
            CancellationToken cancellationToken)
        {
            int offset = 0;
            while (offset < buffer.Length)
            {
                int read = await stream.ReadAsync(
                    buffer,
                    offset,
                    buffer.Length - offset,
                    cancellationToken).ConfigureAwait(false);
                if (read == 0)
                    throw new FrameProtocolException("unexpected_end_of_stream", "The request frame ended early.");
                offset += read;
            }
        }
    }
}
