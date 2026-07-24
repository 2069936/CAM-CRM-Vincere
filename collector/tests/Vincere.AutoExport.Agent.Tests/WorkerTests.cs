using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Service;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class WorkerTests
{
    [Fact]
    public async Task UnexpectedLoopFailureIsReportedAndTheLoopRecoversWithoutStoppingSiblings()
    {
        CancellationTokenSource lifetime = new(TimeSpan.FromSeconds(5));
        RecordingReporter reporter = new();
        ImmediateDelay delay = new(lifetime);
        ThrowOnceLoop recovering = new("uploader");
        CountingLoop sibling = new("heartbeat", expectedRuns: 2, lifetime);
        Worker worker = new(new ICollectorLoop[] { recovering, sibling }, delay, reporter);

        await worker.StartAsync(lifetime.Token);
        await sibling.Completed.Task.WaitAsync(lifetime.Token);
        await worker.StopAsync(CancellationToken.None);

        Assert.True(recovering.Runs >= 2);
        Assert.Contains(reporter.Failures, failure => failure.LoopName == "uploader");
        Assert.True(sibling.Runs >= 2);
    }

    [Fact]
    public async Task StopCancelsEverySupervisedLoopGracefully()
    {
        BlockingLoop first = new("scheduler");
        BlockingLoop second = new("control");
        Worker worker = new(
            new ICollectorLoop[] { first, second },
            new SystemCollectorDelay(),
            new RecordingReporter());

        await worker.StartAsync(CancellationToken.None);
        await Task.WhenAll(first.Started.Task, second.Started.Task).WaitAsync(TimeSpan.FromSeconds(5));
        await worker.StopAsync(new CancellationTokenSource(TimeSpan.FromSeconds(5)).Token);

        Assert.True(first.Cancelled);
        Assert.True(second.Cancelled);
    }

    private sealed class ThrowOnceLoop : ICollectorLoop
    {
        public ThrowOnceLoop(string name) => Name = name;

        public string Name { get; }
        public TimeSpan Interval => TimeSpan.FromMilliseconds(1);
        public int Runs { get; private set; }

        public Task RunOnceAsync(CancellationToken cancellationToken)
        {
            Runs++;
            if (Runs == 1) throw new InvalidOperationException("sensitive implementation detail");
            return Task.CompletedTask;
        }
    }

    private sealed class CountingLoop : ICollectorLoop
    {
        private readonly int expectedRuns;
        private readonly CancellationTokenSource lifetime;

        public CountingLoop(string name, int expectedRuns, CancellationTokenSource lifetime)
        {
            Name = name;
            this.expectedRuns = expectedRuns;
            this.lifetime = lifetime;
        }

        public string Name { get; }
        public TimeSpan Interval => TimeSpan.FromMilliseconds(1);
        public int Runs { get; private set; }
        public TaskCompletionSource Completed { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);

        public Task RunOnceAsync(CancellationToken cancellationToken)
        {
            Runs++;
            if (Runs >= expectedRuns) Completed.TrySetResult();
            return Task.CompletedTask;
        }
    }

    private sealed class BlockingLoop : ICollectorLoop
    {
        public BlockingLoop(string name) => Name = name;

        public string Name { get; }
        public TimeSpan Interval => TimeSpan.FromMinutes(1);
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool Cancelled { get; private set; }

        public async Task RunOnceAsync(CancellationToken cancellationToken)
        {
            Started.TrySetResult();
            try
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, cancellationToken);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                Cancelled = true;
                throw;
            }
        }
    }

    private sealed class ImmediateDelay : ICollectorDelay
    {
        public ImmediateDelay(CancellationTokenSource lifetime)
        {
        }

        public async Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await Task.Yield();
        }
    }

    private sealed class RecordingReporter : IServiceReporter
    {
        public List<(string LoopName, string ErrorCode)> Failures { get; } = new();

        public void LoopFailed(string loopName, string errorCode)
        {
            lock (Failures) Failures.Add((loopName, errorCode));
        }
    }
}
