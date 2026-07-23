using System;
using NodaTime;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Scheduling;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class CaptureScheduleTests
{
    [Fact]
    public void DefaultScheduleUsesNewYorkOffsetAcrossEstAndEdt()
    {
        CaptureSchedule schedule = CaptureSchedule.Default;

        Instant winter = schedule.GetScheduledInstant(new LocalDate(2026, 1, 15));
        Instant summer = schedule.GetScheduledInstant(new LocalDate(2026, 7, 23));

        Assert.Equal(Instant.FromUtc(2026, 1, 15, 21, 45), winter);
        Assert.Equal(Instant.FromUtc(2026, 7, 23, 20, 45), summer);
    }

    [Fact]
    public void NextScheduledInstantSkipsDstTransitionWeekend()
    {
        CaptureSchedule schedule = CaptureSchedule.Default;

        Instant next = schedule.GetNextScheduledInstant(
            Instant.FromUtc(2026, 3, 6, 22, 0));

        Assert.Equal(Instant.FromUtc(2026, 3, 9, 20, 45), next);
    }

    [Fact]
    public void DueDecisionDependsOnNewYorkInstantNotHostTimeZone()
    {
        CaptureSchedule schedule = CaptureSchedule.Default;

        CaptureScheduleDecision before = schedule.Evaluate(
            Instant.FromUtc(2026, 7, 23, 20, 44, 59),
            lastScheduledTradingDate: null);
        CaptureScheduleDecision due = schedule.Evaluate(
            Instant.FromUtc(2026, 7, 23, 20, 45, 1),
            lastScheduledTradingDate: null);

        Assert.Equal(CaptureScheduleDecisionKind.Waiting, before.Kind);
        Assert.Equal(CaptureScheduleDecisionKind.Due, due.Kind);
        Assert.Equal("2026-07-23", due.TradingDate);
    }

    [Fact]
    public void RestartAfterSuccessfulQueueDoesNotTriggerDuplicateCapture()
    {
        CaptureSchedule schedule = CaptureSchedule.Default;

        CaptureScheduleDecision decision = schedule.Evaluate(
            Instant.FromUtc(2026, 7, 23, 20, 50),
            lastScheduledTradingDate: "2026-07-23");

        Assert.Equal(CaptureScheduleDecisionKind.AlreadyCaptured, decision.Kind);
    }

    [Fact]
    public void RestartAfterCutoffReportsMissedWindow()
    {
        CaptureSchedule schedule = CaptureSchedule.Default;

        CaptureScheduleDecision decision = schedule.Evaluate(
            Instant.FromUtc(2026, 7, 23, 21, 0),
            lastScheduledTradingDate: null);

        Assert.Equal(CaptureScheduleDecisionKind.WindowClosed, decision.Kind);
        Assert.Equal("2026-07-23", decision.TradingDate);
    }

    [Fact]
    public void EnabledDaysAreConfigurableIncludingWeekend()
    {
        CaptureSchedule sundaySchedule = new(
            new LocalTime(16, 45),
            new LocalTime(17, 0),
            new[] { IsoDayOfWeek.Sunday });

        CaptureScheduleDecision decision = sundaySchedule.Evaluate(
            Instant.FromUtc(2026, 7, 26, 20, 46),
            lastScheduledTradingDate: null);

        Assert.Equal(CaptureScheduleDecisionKind.Due, decision.Kind);
        Assert.Equal("2026-07-26", decision.TradingDate);
    }

    [Fact]
    public void ManualCaptureUsesCurrentNewYorkTradingDateOutsideSchedule()
    {
        CaptureSchedule schedule = CaptureSchedule.Default;

        ManualCaptureContext context = schedule.CreateManualCaptureContext(
            Instant.FromUtc(2026, 7, 24, 1, 30));

        Assert.Equal("2026-07-23", context.TradingDate);
        Assert.Equal(TimeSpan.FromHours(-4), context.CapturedAt.Offset);
        Assert.Equal("America/New_York", context.TimeZone);
    }

    [Fact]
    public void ScheduleRejectsCutoffThatDoesNotFollowCaptureTime()
    {
        ArgumentOutOfRangeException error = Assert.Throws<ArgumentOutOfRangeException>(() => new CaptureSchedule(
            new LocalTime(16, 45),
            new LocalTime(16, 45),
            new[] { IsoDayOfWeek.Monday }));

        Assert.Equal("cutoffTime", error.ParamName);
    }

    [Fact]
    public void ScheduleLoadsValidatedAgentConfiguration()
    {
        AgentOptions options = AgentOptions.CreateDefault() with
        {
            ScheduleTime = "16:35",
            CaptureCutoffTime = "16:58",
            EnabledTradingDays = new[] { "Sunday", "Monday" },
        };

        CaptureSchedule schedule = CaptureSchedule.FromOptions(options);

        Assert.Equal(new LocalTime(16, 35), schedule.CaptureTime);
        Assert.Equal(new LocalTime(16, 58), schedule.CutoffTime);
        Assert.Contains(IsoDayOfWeek.Sunday, schedule.EnabledDays);
        Assert.Contains(IsoDayOfWeek.Monday, schedule.EnabledDays);
    }
}
