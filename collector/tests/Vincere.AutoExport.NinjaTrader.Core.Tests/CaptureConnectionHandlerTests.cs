using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Contracts;
using Vincere.AutoExport.NinjaTrader.Core.Pipe;
using Xunit;

namespace Vincere.AutoExport.NinjaTrader.Core.Tests;

public sealed class CaptureConnectionHandlerTests
{
    [Fact]
    public async Task Handles_one_framed_request_and_echoes_its_request_id()
    {
        Guid requestId = Guid.NewGuid();
        var processor = new CaptureRequestProcessor(
            _ => Task.FromResult(ValidSnapshot()),
            TimeSpan.FromSeconds(1));
        var handler = new CaptureConnectionHandler(
            new CaptureFrameCodec(1024, 64 * 1024),
            processor);
        using var stream = new DuplexMemoryStream(Frame(new CaptureRequest
        {
            Command = "capture",
            RequestId = requestId,
        }));

        await handler.HandleAsync(stream);

        CaptureResponse response = Response(stream.Written);
        Assert.True(response.Ok);
        Assert.Equal(requestId, response.RequestId);
        Assert.NotNull(response.Snapshot);
    }

    [Fact]
    public async Task Converts_malformed_input_to_a_small_stable_failure()
    {
        var processor = new CaptureRequestProcessor(
            _ => throw new InvalidOperationException("must not capture"),
            TimeSpan.FromSeconds(1));
        var handler = new CaptureConnectionHandler(
            new CaptureFrameCodec(1024, 64 * 1024),
            processor);
        using var stream = new DuplexMemoryStream(new byte[] { 2, 0, 0, 0, 0xC3, 0x28 });

        await handler.HandleAsync(stream);

        CaptureResponse response = Response(stream.Written);
        Assert.False(response.Ok);
        Assert.Equal(Guid.Empty, response.RequestId);
        Assert.Equal("invalid_request_json", response.ErrorCode);
        Assert.DoesNotContain("DecoderFallbackException", response.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Replaces_an_oversized_snapshot_with_a_bounded_failure()
    {
        AutoExportSnapshotV1 snapshot = ValidSnapshot();
        snapshot.Accounts.Add(new AccountRowV1 { AccountName = new string('x', 2_000) });
        var processor = new CaptureRequestProcessor(
            _ => Task.FromResult(snapshot),
            TimeSpan.FromSeconds(1));
        var handler = new CaptureConnectionHandler(
            new CaptureFrameCodec(1024, 512),
            processor);
        using var stream = new DuplexMemoryStream(Frame(new CaptureRequest
        {
            Command = "capture",
            RequestId = Guid.NewGuid(),
        }));

        await handler.HandleAsync(stream);

        CaptureResponse response = Response(stream.Written);
        Assert.False(response.Ok);
        Assert.Equal("response_too_large", response.ErrorCode);
        Assert.Null(response.Snapshot);
        Assert.True(stream.Written.Length <= 512 + 4);
    }

    private static byte[] Frame(object value)
    {
        byte[] payload = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(value));
        byte[] frame = new byte[payload.Length + 4];
        BinaryPrimitives.WriteInt32LittleEndian(frame.AsSpan(0, 4), payload.Length);
        payload.CopyTo(frame, 4);
        return frame;
    }

    private static CaptureResponse Response(byte[] frame)
    {
        int length = BinaryPrimitives.ReadInt32LittleEndian(frame.AsSpan(0, 4));
        Assert.Equal(frame.Length - 4, length);
        return JsonConvert.DeserializeObject<CaptureResponse>(Encoding.UTF8.GetString(frame, 4, length));
    }

    private static AutoExportSnapshotV1 ValidSnapshot()
    {
        return new AutoExportSnapshotV1
        {
            SchemaVersion = 1,
            CaptureId = Guid.NewGuid(),
            CapturedAt = DateTimeOffset.UtcNow,
            TradingDate = "2026-07-23",
            TimeZone = "America/New_York",
            Source = new SourceMetadataV1
            {
                AddonVersion = "1.0.0",
                NinjaTraderVersion = "8.1.5.2",
            },
            Accounts = new List<AccountRowV1>(),
            Strategies = new List<StrategyRowV1>(),
            Orders = new List<OrderRowV1>(),
            Executions = new List<ExecutionRowV1>(),
        };
    }

    private sealed class DuplexMemoryStream : Stream
    {
        private readonly MemoryStream input;
        private readonly MemoryStream output = new();

        public DuplexMemoryStream(byte[] input) => this.input = new MemoryStream(input);
        public byte[] Written => output.ToArray();
        public override bool CanRead => true;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position { get => throw new NotSupportedException(); set => throw new NotSupportedException(); }
        public override void Flush() => output.Flush();
        public override Task FlushAsync(System.Threading.CancellationToken cancellationToken) => output.FlushAsync(cancellationToken);
        public override int Read(byte[] buffer, int offset, int count) => input.Read(buffer, offset, count);
        public override Task<int> ReadAsync(byte[] buffer, int offset, int count, System.Threading.CancellationToken cancellationToken)
            => input.ReadAsync(buffer, offset, count, cancellationToken);
        public override void Write(byte[] buffer, int offset, int count) => output.Write(buffer, offset, count);
        public override Task WriteAsync(byte[] buffer, int offset, int count, System.Threading.CancellationToken cancellationToken)
            => output.WriteAsync(buffer, offset, count, cancellationToken);
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                input.Dispose();
                output.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
