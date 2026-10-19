using System;
using System.Globalization;
using Vincere.AutoExport.Agent.Updates;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* NEVER DURING THE CLOSE: 15:45 TO 17:45 NEW YORK TIME, MONDAY TO FRIDAY.
 *
 * Every instant below is written in UTC, so the tests prove the window moves with
 * daylight saving: 15:45 in New York is 19:45 UTC in July and 20:45 UTC in
 * January. 2026's changes are Sunday 8 March and Sunday 1 November. */
public sealed class UpdateApplyWindowTests
{
    private readonly UpdateApplyWindow window = new();

    [Theory]
    // Tuesday 14 July 2026, daylight time (UTC-4).
    [InlineData("2026-07-14T19:44:59Z", true)]   // 15:44:59
    [InlineData("2026-07-14T19:45:00Z", false)]  // 15:45
    [InlineData("2026-07-14T20:30:00Z", false)]  // 16:30, the capture
    [InlineData("2026-07-14T21:44:59Z", false)]  // 17:44:59
    [InlineData("2026-07-14T21:45:00Z", true)]   // 17:45
    [InlineData("2026-07-14T16:00:00Z", true)]   // 12:00
    // Tuesday 13 January 2026, standard time (UTC-5).
    [InlineData("2026-01-13T19:45:00Z", true)]   // 14:45, which would be 15:45 in July
    [InlineData("2026-01-13T20:44:59Z", true)]   // 15:44:59
    [InlineData("2026-01-13T20:45:00Z", false)]  // 15:45
    [InlineData("2026-01-13T22:44:59Z", false)]  // 17:44:59
    [InlineData("2026-01-13T22:45:00Z", true)]   // 17:45
    public void The_window_follows_new_york_time(string utc, bool allowed)
    {
        Assert.Equal(allowed, window.IsApplyAllowed(At(utc)));
    }

    [Theory]
    // Monday 9 March 2026, the first weekday of daylight time.
    [InlineData("2026-03-09T19:45:00Z", false)]  // 15:45 EDT
    [InlineData("2026-03-09T21:45:00Z", true)]   // 17:45 EDT
    // Monday 2 November 2026, the first weekday back on standard time.
    [InlineData("2026-11-02T19:45:00Z", true)]   // 14:45 EST
    [InlineData("2026-11-02T20:45:00Z", false)]  // 15:45 EST
    [InlineData("2026-11-02T22:45:00Z", true)]   // 17:45 EST
    public void The_window_is_right_on_the_days_the_clocks_change(string utc, bool allowed)
    {
        Assert.Equal(allowed, window.IsApplyAllowed(At(utc)));
    }

    [Theory]
    [InlineData("2026-07-17T20:30:00Z", false)]  // Friday 16:30
    [InlineData("2026-07-18T20:30:00Z", true)]   // Saturday 16:30
    [InlineData("2026-07-19T20:30:00Z", true)]   // Sunday 16:30
    public void Weekends_have_no_close_and_are_always_allowed(string utc, bool allowed)
    {
        Assert.Equal(allowed, window.IsApplyAllowed(At(utc)));
    }

    [Fact]
    public void Monday_is_a_weekday_like_the_others()
    {
        Assert.False(window.IsApplyAllowed(At("2026-07-13T20:00:00Z")));  // Monday 16:00
        Assert.True(window.IsApplyAllowed(At("2026-07-13T14:00:00Z")));   // Monday 10:00
    }

    [Fact]
    public void Without_a_new_york_zone_nothing_is_ever_applied()
    {
        UpdateApplyWindow unresolved = new(null);

        Assert.False(unresolved.IsApplyAllowed(At("2026-07-18T12:00:00Z")));
        Assert.False(unresolved.IsApplyAllowed(At("2026-07-14T12:00:00Z")));
    }

    [Fact]
    public void The_zone_resolves_on_this_platform()
    {
        Assert.NotNull(UpdateApplyWindow.ResolveNewYork());
    }

    private static DateTimeOffset At(string utc) => DateTimeOffset.Parse(utc, CultureInfo.InvariantCulture);
}
