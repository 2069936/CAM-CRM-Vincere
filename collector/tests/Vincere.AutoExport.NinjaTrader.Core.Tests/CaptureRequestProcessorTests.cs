using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Contracts;
using Vincere.AutoExport.NinjaTrader.Core.Pipe;
using Xunit;

namespace Vincere.AutoExport.NinjaTrader.Core.Tests;

public sealed class CaptureRequestProcessorTests
{
    [Fact]
    public async Task ProcessAsync_returns_the_snapshot_and_echoes_the_request_id()
    {
        Guid requestId = Guid.NewGuid();
        AutoExportSnapshotV1 snapshot = ValidSnapshot();
        var processor = new CaptureRequestProcessor(
            _ => Task.FromResult(snapshot),
            TimeSpan.FromSeconds(1));

        CaptureResponse response = await processor.ProcessAsync(new CaptureRequest
        {
            Command = "capture",
            RequestId = requestId,
        });

        Assert.True(response.Ok);
        Assert.Equal(requestId, response.RequestId);
        Assert.Same(snapshot, response.Snapshot);
        Assert.Null(response.ErrorCode);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("status")]
    public async Task ProcessAsync_rejects_unknown_commands_without_running_capture(string command)
    {
        bool called = false;
        var processor = new CaptureRequestProcessor(
            _ =>
            {
                called = true;
                return Task.FromResult(ValidSnapshot());
            },
            TimeSpan.FromSeconds(1));
        Guid requestId = Guid.NewGuid();

        CaptureResponse response = await processor.ProcessAsync(new CaptureRequest
        {
            Command = command,
            RequestId = requestId,
        });

        Assert.False(response.Ok);
        Assert.Equal(requestId, response.RequestId);
        Assert.Equal("invalid_request", response.ErrorCode);
        Assert.False(called);
    }

    [Fact]
    public async Task ProcessAsync_allows_only_one_capture_at_a_time()
    {
        var started = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource<object>(TaskCreationOptions.RunContinuationsAsynchronously);
        var processor = new CaptureRequestProcessor(
            async cancellationToken =>
            {
                started.TrySetResult(null);
                await release.Task.WaitAsync(cancellationToken);
                return ValidSnapshot();
            },
            TimeSpan.FromSeconds(2));

        Task<CaptureResponse> first = processor.ProcessAsync(new CaptureRequest
        {
            Command = "capture",
            RequestId = Guid.NewGuid(),
        });
        await started.Task;
        CaptureResponse second = await processor.ProcessAsync(new CaptureRequest
        {
            Command = "capture",
            RequestId = Guid.NewGuid(),
        });
        release.TrySetResult(null);

        Assert.False(second.Ok);
        Assert.Equal("capture_busy", second.ErrorCode);
        Assert.True((await first).Ok);
    }

    [Fact]
    public async Task ProcessAsync_returns_a_stable_timeout_without_leaking_exception_text()
    {
        var processor = new CaptureRequestProcessor(
            async cancellationToken =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return ValidSnapshot();
            },
            TimeSpan.FromMilliseconds(20));

        CaptureResponse response = await processor.ProcessAsync(new CaptureRequest
        {
            Command = "capture",
            RequestId = Guid.NewGuid(),
        });

        Assert.False(response.Ok);
        Assert.Equal("capture_timeout", response.ErrorCode);
        Assert.DoesNotContain("TaskCanceledException", response.Message, StringComparison.Ordinal);
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
}
