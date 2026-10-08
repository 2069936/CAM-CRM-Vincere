using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using Newtonsoft.Json.Linq;

namespace Vincere.AutoExport.Agent.UI;

/// <summary>
/// One quarantined capture, already shaped for binding: the window does no
/// interpretation of its own.
/// </summary>
public sealed class QuarantineItemView
{
    /// <summary>The trading day, as "Thu 18 Sep".</summary>
    public string DateLabel { get; init; }

    /// <summary>The trading day as the service sent it, "yyyy-MM-dd", kept so groups can order and span their rows.</summary>
    public string TradingDate { get; init; }

    public string Code { get; init; }

    /// <summary>How many times the service has sent this capture again, as a number; <see cref="Attempts"/> words it.</summary>
    public int AttemptCount { get; init; }

    /// <summary>Why it is here, in a sentence a CAM can act on.</summary>
    public string Reason { get; init; }

    /// <summary>"1 of 3 retries used", "Sent again 4 times", or empty when the code is never retried.</summary>
    public string Attempts { get; init; }

    /// <summary>What happens next: retried at the review time, sent again until the desk replays it, or waiting for the desk.</summary>
    public string Disposition { get; init; }

    /// <summary>Drives the row colour: pending when it will be retried, bad when it is final.</summary>
    public string Tone { get; init; }
}

/// <summary>
/// Every quarantined capture that shares a code and a tone, as one row. A
/// machine with twenty refused closes used to show twenty amber rows that all
/// said the same sentence; this says it once, with the count and the span of
/// days, and keeps the rows behind a toggle for the one time they matter.
/// </summary>
public sealed class QuarantineGroupView
{
    public string Code { get; init; }

    /// <summary>pending when every row will be retried, bad when they are final. Shared by the whole group.</summary>
    public string Tone { get; init; }

    /// <summary>The same sentence the rows carry.</summary>
    public string Reason { get; init; }

    public int Count { get; init; }

    /// <summary>"Thu 18 Sep to Mon 22 Sep", oldest first, or the one day when they are all on it.</summary>
    public string DateRange { get; init; }

    /// <summary>"3 captures, Thu 18 Sep to Mon 22 Sep" or "1 capture, Thu 18 Sep".</summary>
    public string Headline { get; init; }

    /// <summary>What happens to the group next; the rows' sentence when they agree, the tone's plain one when they do not.</summary>
    public string Disposition { get; init; }

    /// <summary>The retry text for the group: "2 of 3 retries used", "1 to 2 of 3 retries used", "Sent again up to 4 times", or empty.</summary>
    public string Retry { get; init; }

    /// <summary>The individual rows, newest first, for the Details toggle.</summary>
    public IReadOnlyList<QuarantineItemView> Items { get; init; }

    /// <summary>A group of one is its own detail; the toggle is only offered when there is something behind it.</summary>
    public bool HasDetails => Count > 1;

    /// <summary>The name a screen reader gives the Details toggle.</summary>
    public string DetailsName => $"Show or hide the {Count} captures with code {Code}";
}

/// <summary>
/// What the service said about its quarantine folder, read from the status
/// reply. Unknown or malformed entries are dropped rather than guessed at.
/// </summary>
public sealed class QuarantineView
{
    private const int MaximumAttempts = 3;
    private const string AwaitingReplayCode = "capture_requires_replay";

    public static QuarantineView Empty { get; } = new(0, Array.Empty<QuarantineItemView>(), null);

    private QuarantineView(int count, IReadOnlyList<QuarantineItemView> items, string reviewTime)
    {
        Count = count;
        Items = items;
        ReviewTime = reviewTime;
        Groups = Group(items);
    }

    /// <summary>Everything in the folder, which may be more than <see cref="Items"/> lists.</summary>
    public int Count { get; }

    /// <summary>Every row the service listed, in the order it listed them.</summary>
    public IReadOnlyList<QuarantineItemView> Items { get; }

    /// <summary>
    /// <see cref="Items"/> folded by code and tone: the rows that will be retried
    /// first, then the final ones, each kind newest first. A row is in exactly
    /// one group.
    /// </summary>
    public IReadOnlyList<QuarantineGroupView> Groups { get; }

    /// <summary>One row is shown as itself; the grouping only earns its place from two.</summary>
    public bool IsGrouped => Items.Count > 1;

    /// <summary>The configured New York review time, "HH:mm", or null when the service did not say.</summary>
    public string ReviewTime { get; }

    public bool HasItems => Count > 0;

    /// <summary>The one line above the list: how many, and how many of them will be retried.</summary>
    public string Summary
    {
        get
        {
            if (Count == 0) return "No captures in quarantine";
            int retrying = Items.Count(item => item.Tone == "pending");
            int final = Items.Count - retrying;
            string head = Count == 1 ? "1 capture in quarantine" : $"{Count} captures in quarantine";
            List<string> parts = new();
            if (retrying > 0) parts.Add($"{retrying} will be sent again at {DisplayReviewTime()} New York");
            if (final > 0) parts.Add($"{final} waiting for the desk");
            return parts.Count == 0 ? head : head + " · " + string.Join(", ", parts);
        }
    }

    public static QuarantineView Parse(JToken quarantine)
    {
        if (quarantine is not JObject data) return Empty;
        string reviewTime = Text(data, "ReviewTime");
        List<QuarantineItemView> items = new();
        if (Value(data, "Items") is JArray array)
        {
            foreach (JToken token in array)
            {
                if (token is not JObject item) continue;
                string code = Text(item, "Code");
                if (string.IsNullOrWhiteSpace(code)) continue;
                int attempts = Number(item, "Attempts") ?? 0;
                bool willRetry = Flag(item, "WillRetry") ?? false;
                string tradingDate = Text(item, "TradingDate");
                items.Add(new QuarantineItemView
                {
                    DateLabel = FriendlyDate(tradingDate),
                    TradingDate = tradingDate,
                    Code = code,
                    AttemptCount = attempts,
                    Reason = Describe(code),
                    Attempts = DescribeAttempts(code, attempts),
                    Disposition = DescribeDisposition(code, attempts, willRetry, reviewTime),
                    Tone = willRetry ? "pending" : "bad",
                });
            }
        }
        int count = Math.Max(Number(data, "Count") ?? 0, items.Count);
        return new QuarantineView(count, items, reviewTime);
    }

    // WHY BY CODE AND TONE, AND NOT BY CODE ALONE.
    //
    // The same code can be amber on one row and red on another: a 422 that
    // still has retries left and one that has used all three. The two rows
    // ask different things of the person reading them, so they do not share a
    // row here either. The order is the Summary's order, the retried kind
    // first, and inside a kind the group with the newest capture first,
    // because that is the one the desk is most likely to be asked about.
    private static IReadOnlyList<QuarantineGroupView> Group(IReadOnlyList<QuarantineItemView> items)
    {
        return items
            .GroupBy(item => (item.Code, item.Tone))
            .Select(group =>
            {
                QuarantineItemView[] rows = group.OrderByDescending(item => SortKey(item.TradingDate), StringComparer.Ordinal).ToArray();
                QuarantineItemView newest = rows[0];
                QuarantineItemView oldest = rows[rows.Length - 1];
                string dateRange = oldest.DateLabel == newest.DateLabel
                    ? newest.DateLabel
                    : oldest.DateLabel + " to " + newest.DateLabel;
                string count = rows.Length == 1 ? "1 capture" : $"{rows.Length} captures";
                return new QuarantineGroupView
                {
                    Code = group.Key.Code,
                    Tone = group.Key.Tone,
                    Reason = newest.Reason,
                    Count = rows.Length,
                    DateRange = dateRange,
                    Headline = count + ", " + dateRange,
                    Disposition = GroupDisposition(rows),
                    Retry = GroupRetry(group.Key.Code, rows),
                    Items = rows,
                };
            })
            .OrderBy(group => group.Tone == "pending" ? 0 : 1)
            .ThenByDescending(group => SortKey(group.Items[0].TradingDate), StringComparer.Ordinal)
            .ThenBy(group => group.Code, StringComparer.Ordinal)
            .ToArray();
    }

    // "yyyy-MM-dd" orders as text. A row without a readable date sorts last,
    // not first, so it never claims the newest slot of a group it was dropped
    // into by code alone.
    private static string SortKey(string tradingDate) =>
        DateTime.TryParseExact(tradingDate, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out _)
            ? tradingDate
            : string.Empty;

    private static string GroupDisposition(IReadOnlyList<QuarantineItemView> rows)
    {
        string first = rows[0].Disposition;
        if (rows.All(row => row.Disposition == first)) return first;
        return rows[0].Tone == "pending" ? first : "Waiting for the desk";
    }

    private static string GroupRetry(string code, IReadOnlyList<QuarantineItemView> rows)
    {
        int least = rows.Min(row => row.AttemptCount);
        int most = rows.Max(row => row.AttemptCount);
        if (IsCapped(code))
        {
            return least == most
                ? DescribeAttempts(code, most)
                : $"{least} to {most} of {MaximumAttempts} retries used";
        }
        if (code == AwaitingReplayCode && most > 0)
        {
            return least == most
                ? DescribeAttempts(code, most)
                : most == 1 ? "Sent again up to once" : $"Sent again up to {most} times";
        }
        return string.Empty;
    }

    // WHY A SENTENCE AND NOT THE CODE.
    //
    // The code is on the row too, for the desk. The sentence is for the person
    // at the VPS, who needs to know whether pressing the button will help. For
    // a 422 it will, once the CRM side is fixed; for a capture the CRM already
    // holds it will only after the desk has replayed it there; for the rest it
    // will not, and saying so is what stops the button being pressed every
    // hour.
    private static string Describe(string code) => code switch
    {
        "snapshot_processing_failed" => "The CRM could not process this capture",
        "unsupported_schema_version" => "The CRM did not recognise this capture's format",
        "snapshot_rejected" => "The CRM refused this capture",
        "payload_too_large" => "This capture is too large to upload",
        AwaitingReplayCode => "The CRM already holds this day as a failed close and the desk has to replay it there",
        "capture_conflict" => "The CRM already has a different close for this day",
        "queue_payload_corrupt" or "queue_payload_mismatch" or "capture_id_conflict" => "The queued file is damaged",
        "receipt_invalid" or "receipt_hash_mismatch" => "The upload receipt is damaged",
        "quarantine_reason_invalid" => "The reason file is missing or damaged",
        _ => code,
    };

    // The same three kinds QuarantinePolicy in the service knows: the two 422
    // codes, retried under a cap; the 409 for a close the CRM already holds,
    // sent again at every review until the desk has replayed it; and the rest,
    // never. The service says per row whether it will retry; this only words it.
    private static bool IsCapped(string code) => code is "snapshot_processing_failed" or "unsupported_schema_version";

    private static string DescribeAttempts(string code, int attempts)
    {
        if (IsCapped(code))
        {
            return attempts == 1
                ? $"1 of {MaximumAttempts} retries used"
                : $"{attempts} of {MaximumAttempts} retries used";
        }
        if (code == AwaitingReplayCode && attempts > 0)
            return attempts == 1 ? "Sent again once" : $"Sent again {attempts} times";
        return string.Empty;
    }

    private static string DescribeDisposition(string code, int attempts, bool willRetry, string reviewTime)
    {
        if (willRetry && code == AwaitingReplayCode)
            return "Sent again at " + DisplayTime(reviewTime) + " New York until the desk replays it";
        if (willRetry)
            return "Will be retried at " + DisplayTime(reviewTime) + " New York";
        if (IsCapped(code) && attempts >= MaximumAttempts)
            return "Retried " + MaximumAttempts + " times, waiting for the desk";
        return "Waiting for the desk";
    }

    private string DisplayReviewTime() => DisplayTime(ReviewTime);

    private static string DisplayTime(string time)
    {
        return TimeOnly.TryParseExact(time, "HH:mm", out TimeOnly parsed)
            ? parsed.ToString("h:mm tt", CultureInfo.InvariantCulture)
            : "12:00 PM";
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

    private static JToken Value(JObject source, string name)
    {
        return source[name] ?? source[Camel(name)];
    }

    private static string Text(JObject source, string name)
    {
        return source.Value<string>(name) ?? source.Value<string>(Camel(name));
    }

    private static int? Number(JObject source, string name)
    {
        return source.Value<int?>(name) ?? source.Value<int?>(Camel(name));
    }

    private static bool? Flag(JObject source, string name)
    {
        return source.Value<bool?>(name) ?? source.Value<bool?>(Camel(name));
    }

    private static string Camel(string name) =>
        name.Length == 0 ? name : char.ToLowerInvariant(name[0]) + name.Substring(1);
}
