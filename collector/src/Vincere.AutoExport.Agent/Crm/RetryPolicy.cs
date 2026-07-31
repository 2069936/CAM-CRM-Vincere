using System;
using System.Net;
using System.Threading;
using System.Threading.Tasks;

namespace Vincere.AutoExport.Agent.Crm;

public interface IRetryDelay
{
    Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken);
}

public sealed class SystemRetryDelay : IRetryDelay
{
    public Task DelayAsync(TimeSpan delay, CancellationToken cancellationToken)
    {
        return Task.Delay(delay, cancellationToken);
    }
}

public sealed class RetryPolicy
{
    private readonly Func<double> jitter;

    public RetryPolicy(
        int maxAttempts = 6,
        TimeSpan? baseDelay = null,
        TimeSpan? maximumDelay = null,
        Func<double> jitter = null)
    {
        if (maxAttempts <= 0) throw new ArgumentOutOfRangeException(nameof(maxAttempts));
        MaxAttempts = maxAttempts;
        BaseDelay = baseDelay ?? TimeSpan.FromSeconds(2);
        MaximumDelay = maximumDelay ?? TimeSpan.FromMinutes(2);
        if (BaseDelay <= TimeSpan.Zero || MaximumDelay < BaseDelay)
            throw new ArgumentOutOfRangeException(nameof(baseDelay));
        this.jitter = jitter ?? Random.Shared.NextDouble;
    }

    public int MaxAttempts { get; }
    public TimeSpan BaseDelay { get; }
    public TimeSpan MaximumDelay { get; }

    public TimeSpan? GetRetryDelay(
        int completedAttempts,
        HttpStatusCode? statusCode = null,
        string errorCode = null,
        TimeSpan? retryAfter = null,
        bool transportFailure = false)
    {
        if (completedAttempts >= MaxAttempts) return null;
        bool retryableStatus = statusCode == HttpStatusCode.RequestTimeout
            || statusCode == HttpStatusCode.TooManyRequests
            || (statusCode.HasValue && (int)statusCode.Value >= 500)
            || (statusCode == HttpStatusCode.Conflict
                && string.Equals(errorCode, "capture_processing", StringComparison.Ordinal));
        if (!transportFailure && !retryableStatus) return null;
        if (retryAfter.HasValue && retryAfter.Value >= TimeSpan.Zero)
            return retryAfter.Value <= MaximumDelay ? retryAfter.Value : MaximumDelay;

        double multiplier = Math.Pow(2, Math.Max(0, completedAttempts - 1));
        double unjitteredMilliseconds = Math.Min(
            MaximumDelay.TotalMilliseconds,
            BaseDelay.TotalMilliseconds * multiplier);
        double sample = jitter();
        if (sample < 0 || sample > 1 || double.IsNaN(sample))
            throw new InvalidOperationException("Retry jitter must be between zero and one.");
        double milliseconds = Math.Min(
            MaximumDelay.TotalMilliseconds,
            unjitteredMilliseconds * (0.8 + (0.4 * sample)));
        return TimeSpan.FromMilliseconds(milliseconds);
    }
}
