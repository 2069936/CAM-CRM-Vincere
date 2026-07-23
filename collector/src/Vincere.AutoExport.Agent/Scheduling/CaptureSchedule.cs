using System;
using System.Collections.Generic;
using System.Linq;
using NodaTime;
using NodaTime.Text;
using Vincere.AutoExport.Agent.Configuration;

namespace Vincere.AutoExport.Agent.Scheduling;

public enum CaptureScheduleDecisionKind
{
    Waiting,
    Due,
    AlreadyCaptured,
    WindowClosed,
    DisabledDay,
}

public sealed record CaptureScheduleDecision(
    CaptureScheduleDecisionKind Kind,
    string TradingDate,
    Instant? NextScheduledInstant);

public sealed record ManualCaptureContext(
    string TradingDate,
    DateTimeOffset CapturedAt,
    string TimeZone);

public sealed class CaptureSchedule
{
    public const string TimeZoneId = "America/New_York";
    private static readonly DateTimeZone NewYork = DateTimeZoneProviders.Tzdb[TimeZoneId];
    private readonly HashSet<IsoDayOfWeek> enabledDays;

    public CaptureSchedule(
        LocalTime captureTime,
        LocalTime cutoffTime,
        IEnumerable<IsoDayOfWeek> enabledDays)
    {
        if (cutoffTime <= captureTime)
            throw new ArgumentOutOfRangeException(nameof(cutoffTime), "Cutoff must follow the scheduled capture time.");
        ArgumentNullException.ThrowIfNull(enabledDays);
        this.enabledDays = new HashSet<IsoDayOfWeek>(enabledDays);
        if (this.enabledDays.Count == 0)
            throw new ArgumentException("At least one trading day must be enabled.", nameof(enabledDays));
        if (this.enabledDays.Any(day => day < IsoDayOfWeek.Monday || day > IsoDayOfWeek.Sunday))
            throw new ArgumentOutOfRangeException(nameof(enabledDays), "Enabled trading days are invalid.");

        CaptureTime = captureTime;
        CutoffTime = cutoffTime;
    }

    public static CaptureSchedule Default { get; } = new(
        new LocalTime(16, 45),
        new LocalTime(17, 0),
        new[]
        {
            IsoDayOfWeek.Monday,
            IsoDayOfWeek.Tuesday,
            IsoDayOfWeek.Wednesday,
            IsoDayOfWeek.Thursday,
            IsoDayOfWeek.Friday,
        });

    public static CaptureSchedule FromOptions(AgentOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        ParseResult<LocalTime> capture = LocalTimePattern.CreateWithInvariantCulture("HH:mm")
            .Parse(options.ScheduleTime);
        ParseResult<LocalTime> cutoff = LocalTimePattern.CreateWithInvariantCulture("HH:mm")
            .Parse(options.CaptureCutoffTime);
        if (!capture.Success || !cutoff.Success || options.EnabledTradingDays == null)
            throw new ArgumentException("Agent schedule configuration is invalid.", nameof(options));
        IsoDayOfWeek[] days;
        try
        {
            days = options.EnabledTradingDays
                .Select(day => Enum.Parse<IsoDayOfWeek>(day, ignoreCase: false))
                .ToArray();
        }
        catch (ArgumentException exception)
        {
            throw new ArgumentException("Agent trading-day configuration is invalid.", nameof(options), exception);
        }
        return new CaptureSchedule(capture.Value, cutoff.Value, days);
    }

    public LocalTime CaptureTime { get; }
    public LocalTime CutoffTime { get; }
    public IReadOnlyCollection<IsoDayOfWeek> EnabledDays => enabledDays;

    public Instant GetScheduledInstant(LocalDate tradingDate)
    {
        return tradingDate.At(CaptureTime).InZoneStrictly(NewYork).ToInstant();
    }

    public Instant GetCutoffInstant(LocalDate tradingDate)
    {
        return tradingDate.At(CutoffTime).InZoneStrictly(NewYork).ToInstant();
    }

    public Instant GetNextScheduledInstant(Instant after)
    {
        LocalDate localDate = after.InZone(NewYork).Date;
        for (int offset = 0; offset <= 7; offset++)
        {
            LocalDate candidateDate = localDate.PlusDays(offset);
            if (!enabledDays.Contains(candidateDate.DayOfWeek)) continue;
            Instant candidate = GetScheduledInstant(candidateDate);
            if (candidate > after) return candidate;
        }
        throw new InvalidOperationException("Unable to find the next enabled capture day.");
    }

    public CaptureScheduleDecision Evaluate(Instant now, string lastScheduledTradingDate)
    {
        ZonedDateTime localNow = now.InZone(NewYork);
        LocalDate tradingDate = localNow.Date;
        string tradingDateText = FormatDate(tradingDate);
        if (!enabledDays.Contains(tradingDate.DayOfWeek))
        {
            return new CaptureScheduleDecision(
                CaptureScheduleDecisionKind.DisabledDay,
                tradingDateText,
                GetNextScheduledInstant(now));
        }

        Instant scheduled = GetScheduledInstant(tradingDate);
        if (now < scheduled)
        {
            return new CaptureScheduleDecision(
                CaptureScheduleDecisionKind.Waiting,
                tradingDateText,
                scheduled);
        }

        if (string.Equals(lastScheduledTradingDate, tradingDateText, StringComparison.Ordinal))
        {
            return new CaptureScheduleDecision(
                CaptureScheduleDecisionKind.AlreadyCaptured,
                tradingDateText,
                GetNextScheduledInstant(now));
        }

        Instant cutoff = GetCutoffInstant(tradingDate);
        if (now >= cutoff)
        {
            return new CaptureScheduleDecision(
                CaptureScheduleDecisionKind.WindowClosed,
                tradingDateText,
                GetNextScheduledInstant(now));
        }

        return new CaptureScheduleDecision(CaptureScheduleDecisionKind.Due, tradingDateText, null);
    }

    public ManualCaptureContext CreateManualCaptureContext(Instant now)
    {
        ZonedDateTime localNow = now.InZone(NewYork);
        return new ManualCaptureContext(
            FormatDate(localNow.Date),
            localNow.ToDateTimeOffset(),
            TimeZoneId);
    }

    private static string FormatDate(LocalDate date)
    {
        return $"{date.Year:D4}-{date.Month:D2}-{date.Day:D2}";
    }
}
