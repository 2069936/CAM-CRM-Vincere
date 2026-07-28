using System;
using System.Collections.Generic;
using System.Linq;
using NodaTime;
using Vincere.AutoExport.Agent.History;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class CaptureDayTimelineTests
{
    // 2026-07-27 is a Monday, so a seven-day window ending on it runs
    // Tue 21 · Wed 22 · Thu 23 · Fri 24 · Sat 25 · Sun 26 · Mon 27.
    private static readonly LocalTime Cutoff = new(17, 0);

    private static readonly IsoDayOfWeek[] MondayToFriday =
    {
        IsoDayOfWeek.Monday,
        IsoDayOfWeek.Tuesday,
        IsoDayOfWeek.Wednesday,
        IsoDayOfWeek.Thursday,
        IsoDayOfWeek.Friday,
    };

    private static CaptureHistoryEntry Uploaded(string date, int accounts = 3) =>
        new(date, Offset(date, 16, 31), Offset(date, 16, 32), accounts, null);

    private static DateTimeOffset Offset(string date, int hour, int minute)
    {
        LocalDate parsed = new(
            int.Parse(date[..4]),
            int.Parse(date.Substring(5, 2)),
            int.Parse(date.Substring(8, 2)));
        return new DateTimeOffset(
            parsed.Year, parsed.Month, parsed.Day, hour, minute, 0, TimeSpan.FromHours(-4));
    }

    private static IReadOnlyList<CaptureDay> Build(
        LocalDateTime now,
        IReadOnlyList<CaptureHistoryEntry> history,
        int dayCount = 7)
    {
        return CaptureDayTimeline.Build(now, Cutoff, MondayToFriday, history, dayCount);
    }

    private static CaptureDay Day(IReadOnlyList<CaptureDay> days, string date) =>
        days.Single(day => day.TradingDate == date);

    [Fact]
    public void WeekendsAreNeverMissed()
    {
        // Every trading day in the window collected. The only days without a
        // record are the Saturday and the Sunday.
        CaptureHistoryEntry[] history =
        {
            Uploaded("2026-07-21"),
            Uploaded("2026-07-22"),
            Uploaded("2026-07-23"),
            Uploaded("2026-07-24"),
            Uploaded("2026-07-27"),
        };

        IReadOnlyList<CaptureDay> days = Build(new LocalDateTime(2026, 7, 27, 18, 0), history);

        Assert.Equal(CaptureDayStatus.NotScheduled, Day(days, "2026-07-25").Status);
        Assert.Equal(CaptureDayStatus.NotScheduled, Day(days, "2026-07-26").Status);
        Assert.Equal("Sat", Day(days, "2026-07-25").DayLabel);
        Assert.Equal("Sun", Day(days, "2026-07-26").DayLabel);
        Assert.DoesNotContain(days, day => day.Status == CaptureDayStatus.Missed);
    }

    [Fact]
    public void TradingDayWithoutARecordIsMissedOnceItsWindowClosed()
    {
        // Thursday is absent. Everything around it collected.
        CaptureHistoryEntry[] history =
        {
            Uploaded("2026-07-22"),
            Uploaded("2026-07-24"),
        };

        IReadOnlyList<CaptureDay> days = Build(new LocalDateTime(2026, 7, 27, 18, 0), history);

        Assert.Equal(CaptureDayStatus.Missed, Day(days, "2026-07-23").Status);
    }

    [Fact]
    public void TodayIsWaitingUntilTheCutoffAndMissedAfterIt()
    {
        CaptureHistoryEntry[] history = { Uploaded("2026-07-24") };

        IReadOnlyList<CaptureDay> beforeCutoff =
            Build(new LocalDateTime(2026, 7, 27, 16, 45), history);
        IReadOnlyList<CaptureDay> afterCutoff =
            Build(new LocalDateTime(2026, 7, 27, 17, 1), history);

        // 4:45 PM sits between the 4:30 capture and the 5:00 cutoff, so the
        // scheduler may still be retrying and the day is not lost.
        Assert.Equal(CaptureDayStatus.Waiting, Day(beforeCutoff, "2026-07-27").Status);
        Assert.Equal(CaptureDayStatus.Missed, Day(afterCutoff, "2026-07-27").Status);
    }

    [Fact]
    public void DaysBeforeTheAgentHadAnyHistoryAreNotBlamed()
    {
        // A machine paired on Friday must not open on a week of red cells for
        // days when nothing was installed to collect them.
        CaptureHistoryEntry[] history = { Uploaded("2026-07-24") };

        IReadOnlyList<CaptureDay> days = Build(new LocalDateTime(2026, 7, 27, 18, 0), history);

        Assert.Equal(CaptureDayStatus.NotTracked, Day(days, "2026-07-21").Status);
        Assert.Equal(CaptureDayStatus.NotTracked, Day(days, "2026-07-22").Status);
        Assert.Equal(CaptureDayStatus.NotTracked, Day(days, "2026-07-23").Status);
        Assert.Equal(CaptureDayStatus.Uploaded, Day(days, "2026-07-24").Status);

        // Today is still judged: the agent is demonstrably running now.
        Assert.Equal(CaptureDayStatus.Missed, Day(days, "2026-07-27").Status);
    }

    [Fact]
    public void QueuedFailedAndUploadedAreDistinguished()
    {
        CaptureHistoryEntry[] history =
        {
            new("2026-07-22", Offset("2026-07-22", 16, 31), null, 4, null),
            new("2026-07-23", Offset("2026-07-23", 16, 31), null, 4, "addon_unavailable"),
            Uploaded("2026-07-24", accounts: 5),
        };

        IReadOnlyList<CaptureDay> days = Build(new LocalDateTime(2026, 7, 27, 18, 0), history);

        Assert.Equal(CaptureDayStatus.Queued, Day(days, "2026-07-22").Status);
        Assert.Equal(CaptureDayStatus.Failed, Day(days, "2026-07-23").Status);
        Assert.Equal("addon_unavailable", Day(days, "2026-07-23").ErrorCode);
        Assert.Equal(CaptureDayStatus.Uploaded, Day(days, "2026-07-24").Status);
        Assert.Equal(5, Day(days, "2026-07-24").AccountCount);
    }

    [Fact]
    public void AnUploadOnANonTradingDayIsStillReported()
    {
        // A manual weekend capture is unusual, not invisible. Hiding a real
        // upload behind a grey "not scheduled" cell would misreport the data
        // that actually reached the CRM.
        CaptureHistoryEntry[] history = { Uploaded("2026-07-25") };

        IReadOnlyList<CaptureDay> days = Build(new LocalDateTime(2026, 7, 27, 18, 0), history);

        Assert.Equal(CaptureDayStatus.Uploaded, Day(days, "2026-07-25").Status);
    }

    [Fact]
    public void WindowIsOrderedOldestFirstAndEndsToday()
    {
        IReadOnlyList<CaptureDay> days =
            Build(new LocalDateTime(2026, 7, 27, 18, 0), Array.Empty<CaptureHistoryEntry>());

        Assert.Equal(7, days.Count);
        Assert.Equal("2026-07-21", days[0].TradingDate);
        Assert.Equal("2026-07-27", days[^1].TradingDate);
        Assert.Equal(
            new[] { "Tue", "Wed", "Thu", "Fri", "Sat", "Sun", "Mon" },
            days.Select(day => day.DayLabel).ToArray());
    }

    [Fact]
    public void EmptyHistoryBlamesOnlyToday()
    {
        // Nothing has ever been recorded, so no past day can be called missed.
        IReadOnlyList<CaptureDay> days =
            Build(new LocalDateTime(2026, 7, 27, 18, 0), Array.Empty<CaptureHistoryEntry>());

        Assert.Equal(CaptureDayStatus.Missed, Day(days, "2026-07-27").Status);
        Assert.All(
            days.Take(4),
            day => Assert.Equal(CaptureDayStatus.NotTracked, day.Status));
        Assert.Equal(CaptureDayStatus.NotScheduled, Day(days, "2026-07-25").Status);
    }

    [Fact]
    public void ASaturdayOnlyScheduleTreatsMondayAsNotScheduled()
    {
        // The weekend rule is not hardcoded to weekends: it follows configuration.
        IReadOnlyList<CaptureDay> days = CaptureDayTimeline.Build(
            new LocalDateTime(2026, 7, 27, 18, 0),
            Cutoff,
            new[] { IsoDayOfWeek.Saturday },
            Array.Empty<CaptureHistoryEntry>(),
            7);

        Assert.Equal(CaptureDayStatus.NotScheduled, Day(days, "2026-07-27").Status);
        Assert.Equal(CaptureDayStatus.NotTracked, Day(days, "2026-07-25").Status);
    }
}
