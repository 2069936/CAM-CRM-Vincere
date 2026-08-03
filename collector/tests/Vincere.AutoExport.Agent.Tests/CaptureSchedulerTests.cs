using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using NodaTime;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Scheduling;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class CaptureSchedulerTests
{
    [Fact]
    public async Task ScheduledCapturePersistsTradingDateOnlyAfterDurableQueueCompletes()
    {
        List<string> events = new();
        FakeOptionsStore store = new(events);
        FakeCaptureWorkflow workflow = new(events);
        CaptureScheduler scheduler = new(store, workflow);

        CaptureRunResult result = await scheduler.RunScheduledAsync(
            Instant.FromUtc(2026, 7, 23, 20, 46));

        Assert.True(result.CaptureQueued);
        Assert.Equal(new[] { "capture-and-queue", "save-2026-07-23" }, events);
        Assert.Equal("2026-07-23", store.Options.LastScheduledTradingDate);
    }

    [Fact]
    public async Task FailedCaptureDoesNotPersistDateAndReturnsBoundedRetry()
    {
        FakeOptionsStore store = new();
        FakeCaptureWorkflow workflow = new()
        {
            Error = new CaptureAttemptException("addon_unavailable", "AddOn is unavailable."),
        };
        CaptureScheduler scheduler = new(store, workflow);
        Instant now = Instant.FromUtc(2026, 7, 23, 20, 50);

        CaptureRunResult result = await scheduler.RunScheduledAsync(now);

        Assert.False(result.CaptureQueued);
        Assert.Equal("addon_unavailable", result.ErrorCode);
        Assert.Equal(now + Duration.FromMinutes(2), result.RetryAt);
        Assert.Null(store.Options.LastScheduledTradingDate);
        Assert.Equal(0, store.SaveCount);
    }

    [Fact]
    public async Task FailedCaptureNearCutoffDoesNotScheduleAttemptOutsideWindow()
    {
        FakeOptionsStore store = new();
        FakeCaptureWorkflow workflow = new()
        {
            Error = new CaptureAttemptException("ninjatrader_not_running", "NinjaTrader is closed."),
        };
        CaptureScheduler scheduler = new(store, workflow);

        CaptureRunResult result = await scheduler.RunScheduledAsync(
            Instant.FromUtc(2026, 7, 23, 20, 59));

        Assert.Null(result.RetryAt);
        Assert.Equal("ninjatrader_not_running", result.ErrorCode);
    }

    [Fact]
    public async Task ConcurrentTicksQueueScheduledTradingDateOnlyOnce()
    {
        FakeOptionsStore store = new();
        FakeCaptureWorkflow workflow = new();
        CaptureScheduler scheduler = new(store, workflow);
        Instant now = Instant.FromUtc(2026, 7, 23, 20, 46);

        CaptureRunResult[] results = await Task.WhenAll(
            scheduler.RunScheduledAsync(now),
            scheduler.RunScheduledAsync(now));

        Assert.Equal(1, workflow.CallCount);
        Assert.Equal(1, store.SaveCount);
        Assert.Single(results, result => result.CaptureQueued);
        Assert.Single(results, result => result.Decision.Kind == CaptureScheduleDecisionKind.AlreadyCaptured);
    }

    [Fact]
    public async Task ManualCaptureUsesSameWorkflowWithoutSuppressingScheduledClose()
    {
        FakeOptionsStore store = new();
        FakeCaptureWorkflow workflow = new();
        CaptureScheduler scheduler = new(store, workflow);

        CaptureRunResult result = await scheduler.RunManualAsync(
            Instant.FromUtc(2026, 7, 23, 18, 0));

        Assert.True(result.CaptureQueued);
        Assert.True(workflow.LastContext.IsManual);
        Assert.Equal("2026-07-23", workflow.LastContext.TradingDate);
        Assert.Equal(0, store.SaveCount);
        Assert.Null(store.Options.LastScheduledTradingDate);
    }

    private sealed class FakeOptionsStore : IAgentOptionsStore
    {
        private readonly List<string> events;

        public FakeOptionsStore(List<string> events = null)
        {
            this.events = events;
            Options = AgentOptions.CreateDefault();
        }

        public AgentOptions Options { get; private set; }
        public int SaveCount { get; private set; }

        public Task<ConfigurationLoadResult> LoadAsync(CancellationToken cancellationToken = default)
        {
            return Task.FromResult(new ConfigurationLoadResult(Options, false));
        }

        public Task SaveAsync(AgentOptions options, CancellationToken cancellationToken = default)
        {
            Options = options;
            SaveCount++;
            events?.Add("save-" + options.LastScheduledTradingDate);
            return Task.CompletedTask;
        }
    }

    private sealed class FakeCaptureWorkflow : ICaptureWorkflow
    {
        private readonly List<string> events;

        public FakeCaptureWorkflow(List<string> events = null)
        {
            this.events = events;
        }

        public CaptureAttemptException Error { get; init; }
        public int CallCount { get; private set; }
        public CaptureRequestContext LastContext { get; private set; }

        public Task CaptureAndQueueAsync(
            CaptureRequestContext context,
            CancellationToken cancellationToken = default)
        {
            CallCount++;
            LastContext = context;
            events?.Add("capture-and-queue");
            if (Error != null) throw Error;
            return Task.CompletedTask;
        }
    }
}
