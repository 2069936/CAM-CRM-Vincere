using System;
using System.Net;
using Vincere.AutoExport.Agent.Crm;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class RetryPolicyTests
{
    [Fact]
    public void RetryableFailuresUseBoundedExponentialDelay()
    {
        RetryPolicy policy = new(
            maxAttempts: 6,
            baseDelay: TimeSpan.FromSeconds(2),
            maximumDelay: TimeSpan.FromSeconds(10),
            jitter: () => 0.5);

        Assert.Equal(TimeSpan.FromSeconds(2), policy.GetRetryDelay(1, transportFailure: true));
        Assert.Equal(TimeSpan.FromSeconds(4), policy.GetRetryDelay(2, HttpStatusCode.RequestTimeout));
        Assert.Equal(TimeSpan.FromSeconds(8), policy.GetRetryDelay(3, HttpStatusCode.InternalServerError));
        Assert.Equal(TimeSpan.FromSeconds(10), policy.GetRetryDelay(4, HttpStatusCode.TooManyRequests));
    }

    [Fact]
    public void RetryAfterIsHonoredButBounded()
    {
        RetryPolicy policy = new(maximumDelay: TimeSpan.FromMinutes(2));

        Assert.Equal(
            TimeSpan.FromSeconds(12),
            policy.GetRetryDelay(1, HttpStatusCode.TooManyRequests, retryAfter: TimeSpan.FromSeconds(12)));
        Assert.Equal(
            TimeSpan.FromMinutes(2),
            policy.GetRetryDelay(1, HttpStatusCode.TooManyRequests, retryAfter: TimeSpan.FromHours(1)));
    }

    [Theory]
    [InlineData(HttpStatusCode.BadRequest, null)]
    [InlineData(HttpStatusCode.Unauthorized, null)]
    [InlineData(HttpStatusCode.Forbidden, null)]
    [InlineData(HttpStatusCode.RequestEntityTooLarge, null)]
    [InlineData(HttpStatusCode.UnprocessableEntity, "unsupported_schema_version")]
    [InlineData(HttpStatusCode.Conflict, "capture_requires_replay")]
    public void PermanentResponsesAreNotRetried(HttpStatusCode status, string errorCode)
    {
        RetryPolicy policy = new();

        Assert.Null(policy.GetRetryDelay(1, status, errorCode));
    }

    [Fact]
    public void BusyConflictRetriesOnlyUntilMaximumAttempts()
    {
        RetryPolicy policy = new(maxAttempts: 2, jitter: () => 0.5);

        Assert.NotNull(policy.GetRetryDelay(1, HttpStatusCode.Conflict, "capture_processing"));
        Assert.Null(policy.GetRetryDelay(2, HttpStatusCode.Conflict, "capture_processing"));
    }
}
