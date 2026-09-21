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

    public string Code { get; init; }

    /// <summary>Why it is here, in a sentence a CAM can act on.</summary>
    public string Reason { get; init; }

    /// <summary>"1 of 3 retries used", or empty when the code is never retried.</summary>
    public string Attempts { get; init; }

    /// <summary>What happens next: retried at the review time, or waiting for the desk.</summary>
    public string Disposition { get; init; }

    /// <summary>Drives the row colour: pending when it will be retried, bad when it is final.</summary>
    public string Tone { get; init; }
}

/// <summary>
/// What the service said about its quarantine folder, read from the status
/// reply. Unknown or malformed entries are dropped rather than guessed at.
/// </summary>
public sealed class QuarantineView
{
    private const int MaximumAttempts = 3;

    public static QuarantineView Empty { get; } = new(0, Array.Empty<QuarantineItemView>(), null);

    private QuarantineView(int count, IReadOnlyList<QuarantineItemView> items, string reviewTime)
    {
        Count = count;
        Items = items;
        ReviewTime = reviewTime;
    }

    /// <summary>Everything in the folder, which may be more than <see cref="Items"/> lists.</summary>
    public int Count { get; }

    public IReadOnlyList<QuarantineItemView> Items { get; }

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
            if (retrying > 0) parts.Add($"{retrying} will be retried at {DisplayReviewTime()} New York");
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
                items.Add(new QuarantineItemView
                {
                    DateLabel = FriendlyDate(Text(item, "TradingDate")),
                    Code = code,
                    Reason = Describe(code),
                    Attempts = DescribeAttempts(code, attempts),
                    Disposition = willRetry
                        ? "Will be retried at " + DisplayTime(reviewTime) + " New York"
                        : attempts >= MaximumAttempts
                            ? "Retried " + MaximumAttempts + " times, waiting for the desk"
                            : "Waiting for the desk",
                    Tone = willRetry ? "pending" : "bad",
                });
            }
        }
        int count = Math.Max(Number(data, "Count") ?? 0, items.Count);
        return new QuarantineView(count, items, reviewTime);
    }

    // WHY A SENTENCE AND NOT THE CODE.
    //
    // The code is on the row too, for the desk. The sentence is for the person
    // at the VPS, who needs to know whether pressing the button will help. For
    // a 422 it will, once the CRM side is fixed; for the rest it will not, and
    // saying so is what stops the button being pressed every hour.
    private static string Describe(string code) => code switch
    {
        "snapshot_processing_failed" => "The CRM could not process this capture",
        "unsupported_schema_version" => "The CRM did not recognise this capture's format",
        "snapshot_rejected" => "The CRM refused this capture",
        "payload_too_large" => "This capture is too large to upload",
        "capture_requires_replay" => "The CRM already has this day and wants the desk to replay it",
        "capture_conflict" => "The CRM already has a different close for this day",
        "queue_payload_corrupt" or "queue_payload_mismatch" or "capture_id_conflict" => "The queued file is damaged",
        "receipt_invalid" or "receipt_hash_mismatch" => "The upload receipt is damaged",
        "quarantine_reason_invalid" => "The reason file is missing or damaged",
        _ => code,
    };

    private static string DescribeAttempts(string code, int attempts)
    {
        bool retryable = code is "snapshot_processing_failed" or "unsupported_schema_version";
        if (!retryable) return string.Empty;
        return attempts == 1
            ? $"1 of {MaximumAttempts} retries used"
            : $"{attempts} of {MaximumAttempts} retries used";
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
