using System;
using System.Buffers.Binary;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Vincere.AutoExport.Contracts;
using Vincere.AutoExport.NinjaTrader.Core.Pipe;
using Xunit;

namespace Vincere.AutoExport.NinjaTrader.Core.Tests;

public sealed class CaptureFrameCodecTests
{
    [Fact]
    public async Task ReadRequestAsync_reads_a_fragmented_length_prefixed_utf8_request()
    {
        Guid requestId = Guid.Parse("90cd1134-b987-4ae6-918f-60a0dfd52eec");
        byte[] json = Encoding.UTF8.GetBytes(
            "{\"command\":\"capture\",\"requestId\":\"" + requestId + "\"}");
        byte[] frame = new byte[4 + json.Length];
        BinaryPrimitives.WriteInt32LittleEndian(frame, json.Length);
        Buffer.BlockCopy(json, 0, frame, 4, json.Length);
        var codec = new CaptureFrameCodec(maximumRequestBytes: 1024, maximumResponseBytes: 2048);

        CaptureRequest request = await codec.ReadRequestAsync(new FragmentedReadStream(frame));

        Assert.Equal("capture", request.Command);
        Assert.Equal(requestId, request.RequestId);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(-1)]
    [InlineData(1025)]
    public async Task ReadRequestAsync_rejects_invalid_frame_lengths(int length)
    {
        byte[] frame = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(frame, length);
        var codec = new CaptureFrameCodec(maximumRequestBytes: 1024, maximumResponseBytes: 2048);

        FrameProtocolException exception = await Assert.ThrowsAsync<FrameProtocolException>(
            () => codec.ReadRequestAsync(new MemoryStream(frame)));

        Assert.Equal("invalid_frame_size", exception.Code);
    }

    [Fact]
    public async Task ReadRequestAsync_rejects_malformed_utf8_or_json_with_a_stable_code()
    {
        byte[] frame = { 2, 0, 0, 0, 0xC3, 0x28 };
        var codec = new CaptureFrameCodec(maximumRequestBytes: 1024, maximumResponseBytes: 2048);

        FrameProtocolException exception = await Assert.ThrowsAsync<FrameProtocolException>(
            () => codec.ReadRequestAsync(new MemoryStream(frame)));

        Assert.Equal("invalid_request_json", exception.Code);
    }

    [Fact]
    public async Task WriteResponseAsync_writes_a_little_endian_length_and_enforces_the_limit()
    {
        var codec = new CaptureFrameCodec(maximumRequestBytes: 1024, maximumResponseBytes: 128);
        var response = new CaptureResponse
        {
            Ok = false,
            RequestId = Guid.NewGuid(),
            ErrorCode = "capture_busy",
            Message = "busy",
        };
        using var stream = new MemoryStream();

        await codec.WriteResponseAsync(stream, response);
        byte[] frame = stream.ToArray();

        int payloadLength = BinaryPrimitives.ReadInt32LittleEndian(frame.AsSpan(0, 4));
        Assert.Equal(frame.Length - 4, payloadLength);
        Assert.Contains("capture_busy", Encoding.UTF8.GetString(frame, 4, payloadLength));

        response.Message = new string('x', 1000);
        FrameProtocolException exception = await Assert.ThrowsAsync<FrameProtocolException>(
            () => codec.WriteResponseAsync(new MemoryStream(), response));
        Assert.Equal("response_too_large", exception.Code);
    }

    private sealed class FragmentedReadStream : MemoryStream
    {
        public FragmentedReadStream(byte[] buffer)
            : base(buffer)
        {
        }

        public override int Read(byte[] buffer, int offset, int count)
        {
            return base.Read(buffer, offset, Math.Min(1, count));
        }

        public override Task<int> ReadAsync(
            byte[] buffer,
            int offset,
            int count,
            System.Threading.CancellationToken cancellationToken)
        {
            return base.ReadAsync(buffer, offset, Math.Min(1, count), cancellationToken);
        }
    }
}
