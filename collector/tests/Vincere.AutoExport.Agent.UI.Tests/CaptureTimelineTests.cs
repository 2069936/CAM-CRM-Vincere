using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.UI;
using Xunit;

namespace Vincere.AutoExport.Agent.UI.Tests;

public sealed class CaptureTimelineTests
{
    private static JArray Timeline(params object[] days) => JArray.FromObject(days);

    private static object Day(
        string date,
        string label,
        string status,
        string capturedAt = null,
        int? accounts = null,
        string errorCode = null)
    {
        return new
        {
            TradingDate = date,
            DayLabel = label,
            Status = status,
            CapturedAt = capturedAt,
            UploadedAt = (string)null,
            AccountCount = accounts,
            ErrorCode = errorCode,
        };
    }

    [Fact]
    public void WeekendCellsAreNeitherGoodNorBad()
    {
        IReadOnlyList<CaptureDayView> days = CaptureTimeline.Parse(Timeline(
            Day("2026-07-25", "Sat", "NotScheduled"),
            Day("2026-07-26", "Sun", "NotScheduled")));

        Assert.Equal(new[] { "idle", "idle" }, days.Select(day => day.Tone).ToArray());
        Assert.All(days, day => Assert.Contains("not a trading day", day.Detail));
    }

    [Fact]
    public void AnAlertCountsOnlyRealProblems()
    {
        // Two weekend days and a day from before the agent existed must not appear
        // in the count, or the banner cries wolf every Monday.
        IReadOnlyList<CaptureDayView> days = CaptureTimeline.Parse(Timeline(
            Day("2026-07-21", "Tue", "NotTracked"),
            Day("2026-07-22", "Wed", "Uploaded", "2026-07-22T16:31:00-04:00", 3),
            Day("2026-07-23", "Thu", "Missed"),
            Day("2026-07-24", "Fri", "Failed", errorCode: "addon_unavailable"),
            Day("2026-07-25", "Sat", "NotScheduled"),
            Day("2026-07-26", "Sun", "NotScheduled"),
            Day("2026-07-27", "Mon", "Uploaded", "2026-07-27T16:31:00-04:00", 3)));

        Assert.Equal("1 trading day not collected · 1 failed", CaptureTimeline.Alert(days));
    }

    [Fact]
    public void ACleanWeekRaisesNoAlert()
    {
        IReadOnlyList<CaptureDayView> days = CaptureTimeline.Parse(Timeline(
            Day("2026-07-24", "Fri", "Uploaded", "2026-07-24T16:31:00-04:00", 3),
            Day("2026-07-25", "Sat", "NotScheduled"),
            Day("2026-07-26", "Sun", "NotScheduled"),
            Day("2026-07-27", "Mon", "Waiting")));

        Assert.Null(CaptureTimeline.Alert(days));
    }

    [Fact]
    public void TheSummaryNamesTheLastCollectedDayWithItsAccountCount()
    {
        IReadOnlyList<CaptureDayView> days = CaptureTimeline.Parse(Timeline(
            Day("2026-07-24", "Fri", "Uploaded", "2026-07-24T16:31:00-04:00", 3),
            Day("2026-07-27", "Mon", "Uploaded", "2026-07-27T16:32:00-04:00", 5)));

        string summary = CaptureTimeline.Summarize(days);

        Assert.Contains("Mon 27 Jul", summary);
        Assert.Contains("5 accounts", summary);
        // The capture instant carries the New York offset, so it reads as the VPS
        // wall clock rather than as UTC.
        Assert.Contains("4:32 PM", summary);
    }

    [Fact]
    public void ASingleAccountIsNotPluralised()
    {
        IReadOnlyList<CaptureDayView> days = CaptureTimeline.Parse(Timeline(
            Day("2026-07-27", "Mon", "Uploaded", "2026-07-27T16:32:00-04:00", 1)));

        Assert.Contains("1 account ", CaptureTimeline.Summarize(days) + " ");
        Assert.DoesNotContain("1 accounts", CaptureTimeline.Summarize(days));
    }

    [Fact]
    public void AQueuedDayIsReportedAsNotYetUploaded()
    {
        IReadOnlyList<CaptureDayView> days = CaptureTimeline.Parse(Timeline(
            Day("2026-07-27", "Mon", "Queued", "2026-07-27T16:31:00-04:00", 3)));

        Assert.Contains("waiting to upload", CaptureTimeline.Summarize(days));
        Assert.Equal("pending", days[0].Tone);
    }

    [Fact]
    public void AnEmptyTimelineSaysSoRatherThanClaimingSuccess()
    {
        Assert.Equal("No collection history yet", CaptureTimeline.Summarize(CaptureTimeline.Parse(null)));
        Assert.Empty(CaptureTimeline.Parse(new JObject()));
        Assert.Equal(
            "Nothing has been collected yet",
            CaptureTimeline.Summarize(CaptureTimeline.Parse(Timeline(Day("2026-07-27", "Mon", "Missed")))));
    }

    [Fact]
    public void MalformedCellsAreDroppedNotGuessed()
    {
        IReadOnlyList<CaptureDayView> days = CaptureTimeline.Parse(new JArray(
            new JValue("nonsense"),
            JObject.FromObject(Day("2026-07-27", "Mon", "Uploaded", "2026-07-27T16:31:00-04:00", 2)),
            JObject.FromObject(new { TradingDate = "2026-07-28", DayLabel = "Tue" })));

        Assert.Single(days);
        Assert.Equal("Uploaded", days[0].Status);
        Assert.Equal("27", days[0].DateLabel);
    }

    [Fact]
    public void CamelCasePayloadsReadTheSame()
    {
        IReadOnlyList<CaptureDayView> days = CaptureTimeline.Parse(new JArray(
            JObject.FromObject(new
            {
                tradingDate = "2026-07-27",
                dayLabel = "Mon",
                status = "Uploaded",
                capturedAt = "2026-07-27T16:31:00-04:00",
                accountCount = 4,
            })));

        Assert.Contains("4 accounts", CaptureTimeline.Summarize(days));
        Assert.Equal("ok", days[0].Tone);
    }
}
