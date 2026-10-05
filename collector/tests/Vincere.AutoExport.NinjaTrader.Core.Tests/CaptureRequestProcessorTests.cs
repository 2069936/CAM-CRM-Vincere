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

    /* ---------------------------------------------------------------------
     * The second command.
     * ------------------------------------------------------------------- */

    [Fact]
    public async Task ProcessAsync_answers_a_sample_without_building_a_snapshot()
    {
        bool captured = false;
        AccountSampleV1 sample = ValidSample();
        var processor = new CaptureRequestProcessor(
            _ =>
            {
                captured = true;
                return Task.FromResult(ValidSnapshot());
            },
            TimeSpan.FromSeconds(1),
            _ => Task.FromResult(sample));
        Guid requestId = Guid.NewGuid();

        CaptureResponse response = await processor.ProcessAsync(new CaptureRequest
        {
            Command = "sample_accounts",
            RequestId = requestId,
        });

        Assert.True(response.Ok);
        Assert.Equal(requestId, response.RequestId);
        Assert.Same(sample, response.Sample);
        // The two never travel together, and a sample must never be mistakable
        // for a close by code that only checks for null.
        Assert.Null(response.Snapshot);
        Assert.False(captured);
    }

    /* AN ADD-ON THAT PREDATES THE COMMAND REFUSES CLEANLY, AND THAT IS THE WHOLE
     * VERSION NEGOTIATION. The pipe has no handshake. Everything in the field
     * today answers this way, because the add-on cannot be replaced while
     * NinjaTrader is loaded. The agent's job is to read the code rather than
     * flatten it; this is the half that proves the code is there to read. */
    [Fact]
    public async Task An_addon_built_without_the_sample_delegate_refuses_it_as_invalid_request()
    {
        var processor = new CaptureRequestProcessor(
            _ => Task.FromResult(ValidSnapshot()),
            TimeSpan.FromSeconds(1));

        CaptureResponse response = await processor.ProcessAsync(new CaptureRequest
        {
            Command = "sample_accounts",
            RequestId = Guid.NewGuid(),
        });

        Assert.False(response.Ok);
        Assert.Equal("invalid_request", response.ErrorCode);
        Assert.Null(response.Sample);
    }

    /* ONE GATE FOR BOTH COMMANDS, so a sample and a close can never both be on
     * NinjaTrader's dispatcher. Today CapturePipeServer makes that impossible
     * anyway by serving one connection at a time; this keeps the invariant stated
     * in the code that depends on it rather than inferred from an accept loop. */
    [Fact]
    public async Task A_sample_cannot_start_while_a_capture_is_running()
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
            TimeSpan.FromSeconds(2),
            _ => Task.FromResult(ValidSample()));

        Task<CaptureResponse> capture = processor.ProcessAsync(new CaptureRequest
        {
            Command = "capture",
            RequestId = Guid.NewGuid(),
        });
        await started.Task;
        CaptureResponse sample = await processor.ProcessAsync(new CaptureRequest
        {
            Command = "sample_accounts",
            RequestId = Guid.NewGuid(),
        });
        release.TrySetResult(null);

        Assert.False(sample.Ok);
        Assert.Equal("capture_busy", sample.ErrorCode);
        // And the close, which is the irreplaceable one, is untouched by the
        // sample having asked.
        Assert.True((await capture).Ok);
    }

    /* A SAMPLE'S OWN TIMEOUT, SHORTER THAN THE CLOSE'S AND WITH ITS OWN WORD.
     * "capture_timeout" is in the heartbeat's accepted error vocabulary, so a
     * tracker that borrowed it would have a ten-minute hiccup rendered on the
     * fleet view as an operational error on a machine whose close is perfect. */
    [Fact]
    public async Task A_slow_sample_times_out_under_its_own_code()
    {
        var processor = new CaptureRequestProcessor(
            _ => Task.FromResult(ValidSnapshot()),
            TimeSpan.FromSeconds(30),
            async cancellationToken =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
                return ValidSample();
            },
            TimeSpan.FromMilliseconds(20));

        CaptureResponse response = await processor.ProcessAsync(new CaptureRequest
        {
            Command = "sample_accounts",
            RequestId = Guid.NewGuid(),
        });

        Assert.False(response.Ok);
        Assert.Equal("sample_timeout", response.ErrorCode);
    }

    [Fact]
    public async Task A_sample_that_throws_is_reported_under_its_own_code_too()
    {
        var processor = new CaptureRequestProcessor(
            _ => Task.FromResult(ValidSnapshot()),
            TimeSpan.FromSeconds(1),
            _ => throw new InvalidOperationException("NinjaTrader has no application dispatcher."));

        CaptureResponse response = await processor.ProcessAsync(new CaptureRequest
        {
            Command = "sample_accounts",
            RequestId = Guid.NewGuid(),
        });

        Assert.False(response.Ok);
        Assert.Equal("sample_failed", response.ErrorCode);
        Assert.DoesNotContain("InvalidOperationException", response.Message, StringComparison.Ordinal);
    }

    // A failed sample must release the gate, or the day's close - which matters
    // far more - would be refused as busy for the rest of the session.
    [Fact]
    public async Task A_failed_sample_leaves_the_capture_able_to_run()
    {
        var processor = new CaptureRequestProcessor(
            _ => Task.FromResult(ValidSnapshot()),
            TimeSpan.FromSeconds(1),
            _ => throw new InvalidOperationException("no dispatcher"));

        await processor.ProcessAsync(new CaptureRequest
        {
            Command = "sample_accounts",
            RequestId = Guid.NewGuid(),
        });
        CaptureResponse capture = await processor.ProcessAsync(new CaptureRequest
        {
            Command = "capture",
            RequestId = Guid.NewGuid(),
        });

        Assert.True(capture.Ok);
    }

    // Case-sensitive, like "capture" beside it. A near miss is an unknown command
    // and gets the unknown command's answer.
    [Theory]
    [InlineData("Sample_Accounts")]
    [InlineData("sample-accounts")]
    [InlineData("sampleaccounts")]
    public async Task Only_the_exact_command_word_is_a_sample(string command)
    {
        bool sampled = false;
        var processor = new CaptureRequestProcessor(
            _ => Task.FromResult(ValidSnapshot()),
            TimeSpan.FromSeconds(1),
            _ =>
            {
                sampled = true;
                return Task.FromResult(ValidSample());
            });

        CaptureResponse response = await processor.ProcessAsync(new CaptureRequest
        {
            Command = command,
            RequestId = Guid.NewGuid(),
        });

        Assert.Equal("invalid_request", response.ErrorCode);
        Assert.False(sampled);
    }

    private static AccountSampleV1 ValidSample()
    {
        return new AccountSampleV1
        {
            SchemaVersion = 1,
            SampledAt = DateTimeOffset.UtcNow,
            Accounts = new List<AccountSampleRowV1>(),
        };
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
