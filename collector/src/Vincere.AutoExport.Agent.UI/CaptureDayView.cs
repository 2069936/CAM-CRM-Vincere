using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace Vincere.AutoExport.Agent.UI;

/// <summary>
/// One cell of the seven-day strip, already shaped for binding: the window does
/// no interpretation of its own.
/// </summary>
public sealed class CaptureDayView
{
    public string DayLabel { get; init; }

    /// <summary>Day of month, so two cells for the same weekday stay distinct.</summary>
    public string DateLabel { get; init; }

    public string Status { get; init; }

    /// <summary>Drives the cell colour through a style selector.</summary>
    public string Tone { get; init; }

    public string Detail { get; init; }
}

public static class CaptureTimeline
{
    private const string Uploaded = "Uploaded";
    private const string Queued = "Queued";
    private const string Failed = "Failed";
    private const string Missed = "Missed";
    private const string Waiting = "Waiting";
    private const string NotScheduled = "NotScheduled";
    private const string NotTracked = "NotTracked";

    /// <summary>
    /// Reads the strip the service sent. Unknown or malformed entries are dropped
    /// rather than guessed at: an empty strip reads as "no history yet", which is
    /// true, while a fabricated cell would not be.
    /// </summary>
    public static IReadOnlyList<CaptureDayView> Parse(JToken timeline)
    {
        if (timeline is not JArray array) return Array.Empty<CaptureDayView>();
        List<CaptureDayView> days = new();
        foreach (JToken token in array)
        {
            if (token is not JObject day) continue;
            string status = Text(day, "Status");
            if (string.IsNullOrWhiteSpace(status)) continue;
            string tradingDate = Text(day, "TradingDate");
            days.Add(new CaptureDayView
            {
                DayLabel = Text(day, "DayLabel") ?? string.Empty,
                DateLabel = DayOfMonth(tradingDate),
                Status = status,
                Tone = ToneFor(status),
                Detail = Describe(status, tradingDate, day),
            });
        }

        return days;
    }

    /// <summary>
    /// The one line a CAM reads first. It answers "did the last trading day land?"
    /// and nothing else.
    /// </summary>
    public static string Summarize(IReadOnlyList<CaptureDayView> days)
    {
        if (days == null || days.Count == 0) return "No collection history yet";
        CaptureDayView lastUploaded = days.LastOrDefault(day => day.Status == Uploaded);
        if (lastUploaded != null) return "Last collected " + lastUploaded.Detail;
        CaptureDayView queued = days.LastOrDefault(day => day.Status == Queued);
        if (queued != null) return "Captured, waiting to upload · " + queued.Detail;
        return "Nothing has been collected yet";
    }

    /// <summary>
    /// Null unless something needs attention. Counting only scheduled days that
    /// closed empty keeps weekends out of the alert.
    /// </summary>
    public static string Alert(IReadOnlyList<CaptureDayView> days)
    {
        if (days == null) return null;
        int missed = days.Count(day => day.Status == Missed);
        int failed = days.Count(day => day.Status == Failed);
        if (missed == 0 && failed == 0) return null;
        List<string> parts = new();
        if (missed > 0) parts.Add($"{missed} trading day{(missed == 1 ? string.Empty : "s")} not collected");
        if (failed > 0) parts.Add($"{failed} failed");
        return string.Join(" · ", parts);
    }

    private static string ToneFor(string status) => status switch
    {
        Uploaded => "ok",
        Queued => "pending",
        Waiting => "pending",
        Failed => "bad",
        Missed => "bad",
        _ => "idle",
    };

    private static string Describe(string status, string tradingDate, JObject day)
    {
        string date = FriendlyDate(tradingDate);
        switch (status)
        {
            case Uploaded:
            {
                string time = CaptureTime(day);
                int? accounts = Number(day, "AccountCount");
                string counted = accounts.HasValue
                    ? $" · {accounts.Value} account{(accounts.Value == 1 ? string.Empty : "s")}"
                    : string.Empty;
                return date + counted + (time == null ? string.Empty : " · " + time);
            }

            case Queued:
                return date + " · captured, not yet uploaded";
            case Failed:
                return date + " · failed (" + (Text(day, "ErrorCode") ?? "unknown") + ")";
            case Missed:
                return date + " · not collected";
            case Waiting:
                return date + " · scheduled";
            case NotScheduled:
                return date + " · not a trading day";
            case NotTracked:
                return date + " · before collection started";
            default:
                return date;
        }
    }

    /// <summary>
    /// Capture time, not upload time. The capture instant carries the New York
    /// offset the snapshot was taken with, so it can be shown as a wall clock the
    /// operator recognises; the acknowledgement timestamp cannot.
    /// </summary>
    private static string CaptureTime(JObject day)
    {
        string raw = Text(day, "CapturedAt");
        if (string.IsNullOrWhiteSpace(raw)) return null;

        // Parsed without AdjustToUniversal so the stored New York offset is kept
        // and the time reads as the clock on the VPS, not as UTC.
        return DateTimeOffset.TryParse(
            raw,
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out DateTimeOffset captured)
            ? captured.ToString("h:mm tt", CultureInfo.InvariantCulture)
            : null;
    }

    private static string FriendlyDate(string tradingDate)
    {
        return DateTime.TryParseExact(
            tradingDate,
            "yyyy-MM-dd",
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out DateTime parsed)
            ? parsed.ToString("ddd d MMM", CultureInfo.InvariantCulture)
            : tradingDate ?? string.Empty;
    }

    private static string DayOfMonth(string tradingDate)
    {
        return DateTime.TryParseExact(
            tradingDate,
            "yyyy-MM-dd",
            CultureInfo.InvariantCulture,
            DateTimeStyles.None,
            out DateTime parsed)
            ? parsed.Day.ToString(CultureInfo.InvariantCulture)
            : string.Empty;
    }

    private static string Text(JObject source, string name)
    {
        return source.Value<string>(name) ?? source.Value<string>(Camel(name));
    }

    private static int? Number(JObject source, string name)
    {
        return source.Value<int?>(name) ?? source.Value<int?>(Camel(name));
    }

    private static string Camel(string name) =>
        name.Length == 0 ? name : char.ToLowerInvariant(name[0]) + name.Substring(1);
}
