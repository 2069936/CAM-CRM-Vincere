using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Capture;
using Vincere.AutoExport.Agent.Scheduling;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class CapturePipeClientTests
{
    [Fact]
    public async Task CaptureReturnsSnapshotWhenServerEchoesRequestId()
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        Task serverTask = ServeOnceAsync(server, request => new CaptureResponse
        {
            Ok = true,
            RequestId = request.RequestId,
            Snapshot = Snapshot(),
        });
        CapturePipeClient client = CreateClient(pipeName, ninjaTraderRunning: true);

        AutoExportSnapshotV1 snapshot = await client.CaptureAsync();
        await serverTask;

        Assert.Equal(1, snapshot.SchemaVersion);
        Assert.Equal("2026-07-23", snapshot.TradingDate);
    }

    [Fact]
    public async Task MissingPipeDistinguishesClosedNinjaTraderFromUnavailableAddon()
    {
        CapturePipeClient closedClient = CreateClient(PipeName(), ninjaTraderRunning: false);
        CapturePipeClient addonClient = CreateClient(PipeName(), ninjaTraderRunning: true);

        CaptureAttemptException closed = await Assert.ThrowsAsync<CaptureAttemptException>(
            () => closedClient.CaptureAsync());
        CaptureAttemptException addon = await Assert.ThrowsAsync<CaptureAttemptException>(
            () => addonClient.CaptureAsync());

        Assert.Equal("ninjatrader_not_running", closed.Code);
        Assert.Equal("addon_unavailable", addon.Code);
    }

    [Fact]
    public async Task ConnectedServerThatDoesNotRespondTimesOut()
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        using CancellationTokenSource serverStop = new();
        Task serverTask = Task.Run(async () =>
        {
            await server.WaitForConnectionAsync(serverStop.Token);
            await Task.Delay(Timeout.InfiniteTimeSpan, serverStop.Token);
        });
        CapturePipeClient client = new(
            pipeName,
            new FixedProcessDetector(true),
            connectTimeout: TimeSpan.FromSeconds(1),
            captureTimeout: TimeSpan.FromMilliseconds(100));

        CaptureAttemptException error = await Assert.ThrowsAsync<CaptureAttemptException>(
            () => client.CaptureAsync());
        serverStop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => serverTask);

        Assert.Equal("capture_timeout", error.Code);
    }

    [Fact]
    public async Task ServerFailureBecomesStableCaptureFailedCode()
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        Task serverTask = ServeOnceAsync(server, request => new CaptureResponse
        {
            Ok = false,
            RequestId = request.RequestId,
            ErrorCode = "source_busy",
            Message = "Account collection changed while reading.",
        });
        CapturePipeClient client = CreateClient(pipeName, ninjaTraderRunning: true);

        CaptureAttemptException error = await Assert.ThrowsAsync<CaptureAttemptException>(
            () => client.CaptureAsync());
        await serverTask;

        Assert.Equal("capture_failed", error.Code);
        Assert.DoesNotContain("Account collection", error.Message);
    }

    [Fact]
    public async Task MismatchedRequestIdIsRejectedAsContractMismatch()
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        Task serverTask = ServeOnceAsync(server, _ => new CaptureResponse
        {
            Ok = true,
            RequestId = Guid.NewGuid(),
            Snapshot = Snapshot(),
        });
        CapturePipeClient client = CreateClient(pipeName, ninjaTraderRunning: true);

        CaptureAttemptException error = await Assert.ThrowsAsync<CaptureAttemptException>(
            () => client.CaptureAsync());
        await serverTask;

        Assert.Equal("contract_mismatch", error.Code);
    }

    [Fact]
    public async Task OversizedResponseIsRejectedBeforeAllocation()
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        Task serverTask = Task.Run(async () =>
        {
            await server.WaitForConnectionAsync();
            await ReadFrameAsync<CaptureRequest>(server);
            byte[] length = new byte[4];
            BinaryPrimitives.WriteInt32LittleEndian(length, 1025);
            await server.WriteAsync(length);
            await server.FlushAsync();
        });
        CapturePipeClient client = new(
            pipeName,
            new FixedProcessDetector(true),
            maxResponseBytes: 1024);

        CaptureAttemptException error = await Assert.ThrowsAsync<CaptureAttemptException>(
            () => client.CaptureAsync());
        await serverTask;

        Assert.Equal("contract_mismatch", error.Code);
    }

    [Fact]
    public async Task SnapshotWithoutAddonOrNinjaTraderVersionIsContractMismatch()
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        AutoExportSnapshotV1 snapshot = Snapshot();
        snapshot.Source.AddonVersion = null;
        snapshot.Source.NinjaTraderVersion = null;
        Task serverTask = ServeOnceAsync(server, request => new CaptureResponse
        {
            Ok = true,
            RequestId = request.RequestId,
            Snapshot = snapshot,
        });
        CapturePipeClient client = CreateClient(pipeName, ninjaTraderRunning: true);

        CaptureAttemptException error = await Assert.ThrowsAsync<CaptureAttemptException>(
            () => client.CaptureAsync());
        await serverTask;

        Assert.Equal("contract_mismatch", error.Code);
    }

    private static CapturePipeClient CreateClient(string pipeName, bool ninjaTraderRunning)
    {
        return new CapturePipeClient(
            pipeName,
            new FixedProcessDetector(ninjaTraderRunning),
            connectTimeout: TimeSpan.FromMilliseconds(100),
            captureTimeout: TimeSpan.FromSeconds(2));
    }

    private static NamedPipeServerStream CreateServer(string pipeName)
    {
        return new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);
    }

    private static async Task ServeOnceAsync(
        NamedPipeServerStream server,
        Func<CaptureRequest, CaptureResponse> responseFactory)
    {
        await server.WaitForConnectionAsync();
        CaptureRequest request = await ReadFrameAsync<CaptureRequest>(server);
        Assert.Equal("capture", request.Command);
        await WriteFrameAsync(server, responseFactory(request));
    }

    private static async Task<T> ReadFrameAsync<T>(Stream stream)
    {
        byte[] lengthBytes = new byte[4];
        await stream.ReadExactlyAsync(lengthBytes);
        int length = BinaryPrimitives.ReadInt32LittleEndian(lengthBytes);
        byte[] payload = new byte[length];
        await stream.ReadExactlyAsync(payload);
        return JsonConvert.DeserializeObject<T>(Encoding.UTF8.GetString(payload));
    }

    private static async Task WriteFrameAsync<T>(Stream stream, T value)
    {
        byte[] payload = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(value));
        byte[] length = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(length, payload.Length);
        await stream.WriteAsync(length);
        await stream.WriteAsync(payload);
        await stream.FlushAsync();
    }

    private static string PipeName() => "vat" + Guid.NewGuid().ToString("N")[..8];

    private static AutoExportSnapshotV1 Snapshot()
    {
        return new AutoExportSnapshotV1
        {
            SchemaVersion = 1,
            CaptureId = Guid.NewGuid(),
            CapturedAt = new DateTimeOffset(2026, 7, 23, 16, 45, 0, TimeSpan.FromHours(-4)),
            TradingDate = "2026-07-23",
            TimeZone = "America/New_York",
            Source = new SourceMetadataV1
            {
                AddonVersion = "0.1.0",
                NinjaTraderVersion = "8.1.5.2",
            },
            Accounts = new List<AccountRowV1>(),
            Strategies = new List<StrategyRowV1>(),
            Orders = new List<OrderRowV1>(),
            Executions = new List<ExecutionRowV1>(),
        };
    }

    private sealed class FixedProcessDetector : INinjaTraderProcessDetector
    {
        private readonly bool isRunning;

        public FixedProcessDetector(bool isRunning) => this.isRunning = isRunning;

        public bool IsRunning() => isRunning;
    }
}
