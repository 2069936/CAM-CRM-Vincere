using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Converters;
using NodaTime;

namespace Vincere.AutoExport.Agent.History;

[JsonConverter(typeof(StringEnumConverter))]
public enum CaptureDayStatus
{
    /// <summary>Not a configured trading day. Weekends, normally.</summary>
    NotScheduled,

    /// <summary>Before this agent was collecting. Absence proves nothing.</summary>
    NotTracked,

    /// <summary>A trading day still ahead of its capture window.</summary>
    Waiting,

    /// <summary>Captured and queued, not yet acknowledged by the CRM.</summary>
    Queued,

    /// <summary>In the CRM.</summary>
    Uploaded,

    /// <summary>Attempted and failed.</summary>
    Failed,

    /// <summary>A trading day whose window closed with nothing captured.</summary>
    Missed,
}

public sealed record CaptureDay(
    string TradingDate,
    string DayLabel,
    CaptureDayStatus Status,
    DateTimeOffset? CapturedAt,
    DateTimeOffset? UploadedAt,
    int? AccountCount,
    string ErrorCode);

/// <summary>
/// Turns the stored day history into the strip of cells the setup window shows.
///
/// The rule that matters here: a day is only ever <see cref="CaptureDayStatus.Missed"/>
/// when it was a configured trading day. Saturday with no capture is not a
/// failure, it is a Saturday, and painting it red would teach the operator to
/// ignore red. The same applies before the agent started collecting: a fresh
/// install must not open on a wall of false alarms for days that predate it.
///
/// Pure by construction — no clock, no disk — so every case below is testable.
/// </summary>
public static class CaptureDayTimeline
{
    private static readonly string[] DayLabels =
    {
        "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun",
    };

    /// <param name="now">Current local time in the schedule's zone.</param>
    /// <param name="cutoff">
    /// Time of day after which an uncaptured trading day counts as missed. This is
    /// the schedule's cutoff, not its capture time: between 4:30 and 5:00 the
    /// scheduler is still retrying, so the day is not lost yet.
    /// </param>
    /// <param name="enabledDays">Configured trading days.</param>
    /// <param name="history">Stored outcomes, in any order.</param>
    /// <param name="dayCount">How many calendar days to show, ending today.</param>
    public static IReadOnlyList<CaptureDay> Build(
        LocalDateTime now,
        LocalTime cutoff,
        IEnumerable<IsoDayOfWeek> enabledDays,
        IReadOnlyList<CaptureHistoryEntry> history,
        int dayCount)
    {
        ArgumentNullException.ThrowIfNull(enabledDays);
        if (dayCount <= 0) throw new ArgumentOutOfRangeException(nameof(dayCount));

        HashSet<IsoDayOfWeek> scheduled = new(enabledDays);
        IReadOnlyList<CaptureHistoryEntry> entries = history ?? Array.Empty<CaptureHistoryEntry>();
        Dictionary<string, CaptureHistoryEntry> byDate = entries
            .Where(entry => entry != null && !string.IsNullOrWhiteSpace(entry.TradingDate))
            .GroupBy(entry => entry.TradingDate, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.Last(), StringComparer.Ordinal);

        // Absence of a record only means something from the first day this agent
        // is known to have run.
        string trackedFrom = byDate.Keys.OrderBy(date => date, StringComparer.Ordinal).FirstOrDefault();

        LocalDate today = now.Date;
        List<CaptureDay> days = new(dayCount);
        for (int offset = dayCount - 1; offset >= 0; offset--)
        {
            LocalDate date = today.PlusDays(-offset);
            string key = Format(date);
            byDate.TryGetValue(key, out CaptureHistoryEntry entry);
            days.Add(new CaptureDay(
                key,
                DayLabels[((int)date.DayOfWeek) - 1],
                Classify(date, key, now, cutoff, scheduled, entry, trackedFrom, today),
                entry?.CapturedAt,
                entry?.UploadedAt,
                entry?.AccountCount,
                entry?.ErrorCode));
        }

        return days;
    }

    private static CaptureDayStatus Classify(
        LocalDate date,
        string key,
        LocalDateTime now,
        LocalTime cutoff,
        HashSet<IsoDayOfWeek> scheduled,
        CaptureHistoryEntry entry,
        string trackedFrom,
        LocalDate today)
    {
        // A recorded outcome outranks everything. If a capture somehow landed on a
        // day nobody scheduled, saying so beats hiding it behind a grey cell.
        if (entry != null)
        {
            if (entry.UploadedAt.HasValue) return CaptureDayStatus.Uploaded;
            if (!string.IsNullOrWhiteSpace(entry.ErrorCode)) return CaptureDayStatus.Failed;
            if (entry.CapturedAt.HasValue) return CaptureDayStatus.Queued;
        }

        if (!scheduled.Contains(date.DayOfWeek)) return CaptureDayStatus.NotScheduled;

        if (trackedFrom == null || String.CompareOrdinal(key, trackedFrom) < 0)
        {
            // Nothing was ever recorded for this day and the agent has no history
            // reaching back this far. Today is the exception: the agent is running
            // right now, so today's silence is real.
            if (date < today) return CaptureDayStatus.NotTracked;
        }

        if (date > today) return CaptureDayStatus.Waiting;
        if (date < today) return CaptureDayStatus.Missed;
        return now.TimeOfDay < cutoff ? CaptureDayStatus.Waiting : CaptureDayStatus.Missed;
    }

    private static string Format(LocalDate date) =>
        $"{date.Year:D4}-{date.Month:D2}-{date.Day:D2}";
}
