using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.Hosting;

namespace Vincere.AutoExport.Agent.Service;

public interface ICollectorLoop
{
    string Name { get; }
    TimeSpan Interval { get; }
    Task RunOnceAsync(CancellationToken cancellationToken);
}

public interface ICollectorDelay
{
    Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken);
}

public sealed class SystemCollectorDelay : ICollectorDelay
{
    public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        return Task.Delay(delay, cancellationToken);
    }
}

public interface IServiceReporter
{
    void LoopFailed(string loopName, string errorCode);
}

public sealed class Worker : BackgroundService
{
    private static readonly TimeSpan FailureDelay = TimeSpan.FromSeconds(5);
    private readonly IReadOnlyCollection<ICollectorLoop> loops;
    private readonly ICollectorDelay delay;
    private readonly IServiceReporter reporter;

    public Worker(
        IEnumerable<ICollectorLoop> loops,
        ICollectorDelay delay,
        IServiceReporter reporter)
    {
        this.loops = (loops ?? throw new ArgumentNullException(nameof(loops))).ToArray();
        if (this.loops.Count == 0) throw new ArgumentException("At least one collector loop is required.", nameof(loops));
        if (this.loops.Any(loop => loop == null || string.IsNullOrWhiteSpace(loop.Name) || loop.Interval <= TimeSpan.Zero))
            throw new ArgumentException("Collector loop metadata is invalid.", nameof(loops));
        this.delay = delay ?? throw new ArgumentNullException(nameof(delay));
        this.reporter = reporter ?? throw new ArgumentNullException(nameof(reporter));
    }

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        return Task.WhenAll(loops.Select(loop => SuperviseAsync(loop, stoppingToken)));
    }

    private async Task SuperviseAsync(ICollectorLoop loop, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            TimeSpan nextDelay = loop.Interval;
            try
            {
                await loop.RunOnceAsync(cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
            catch
            {
                reporter.LoopFailed(loop.Name, "unexpected_loop_failure");
                nextDelay = FailureDelay;
            }

            try
            {
                await delay.DelayAsync(nextDelay, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                break;
            }
        }
    }
}
