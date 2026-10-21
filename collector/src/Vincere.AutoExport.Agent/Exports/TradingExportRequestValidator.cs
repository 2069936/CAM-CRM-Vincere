using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using Vincere.AutoExport.Agent.Crm;

namespace Vincere.AutoExport.Agent.Exports;

/* THE WORDS A TRADING EXPORT REPORTS WHEN IT FAILS, AND NOTHING ELSE.
 *
 * Each travels to the CRM as `errorCode` on export-complete, which accepts
 * snake_case up to 64 characters and shows it to the Manager who asked. A fixed
 * vocabulary for the reason UpdateErrorCodes gives: a message, a path or an
 * exception text would put this machine's details on a screen, and a code the
 * desk has not seen before cannot be looked up in installing.md. */
public static class TradingExportErrorCodes
{
    /// <summary>The request did not validate: an id, dates, datasets or a size limit the agent cannot use.</summary>
    public const string RequestInvalid = "request_invalid";

    /// <summary>No Windows profile on this machine has a Documents\NinjaTrader 8 folder.</summary>
    public const string NinjaTraderFolderNotFound = "ninjatrader_folder_not_found";

    /// <summary>More than one profile holds a NinjaTrader database, and the agent will not pick one.</summary>
    public const string NinjaTraderFolderAmbiguous = "ninjatrader_folder_ambiguous";

    /// <summary>The NinjaTrader folder was found and holds no db\NinjaTrader.sqlite.</summary>
    public const string DatabaseNotFound = "database_not_found";

    /// <summary>The database could not be copied, failed its integrity check, or has no table the export needs.</summary>
    public const string DatabaseUnreadable = "database_unreadable";

    /// <summary>The ProgramData drive has too little room for the copy and the file.</summary>
    public const string DiskSpace = "disk_space";

    /// <summary>The compressed file is larger than the request allows. The CRM asks for a narrower range.</summary>
    public const string ExportTooLarge = "export_too_large";

    /// <summary>Anything else that went wrong while building the file.</summary>
    public const string ExportFailed = "export_failed";

    /// <summary>The CRM did not hand out an upload address.</summary>
    public const string UploadUrlFailed = "upload_url_failed";

    /// <summary>The address the CRM handed out is not HTTPS on the CRM's storage host.</summary>
    public const string UrlNotAllowed = "url_not_allowed";

    /// <summary>The storage refused the upload, or could not be reached.</summary>
    public const string UploadFailed = "upload_failed";

    /// <summary>The upload did not finish within its time limit.</summary>
    public const string UploadTimeout = "upload_timeout";
}

/// <summary>The four datasets the CRM may ask for, in the order the file carries them.</summary>
public static class TradingExportDatasets
{
    public const string Executions = "executions";
    public const string Orders = "orders";
    public const string Strategies = "strategies";
    public const string Trades = "trades";

    public static readonly IReadOnlyList<string> All = new[] { Executions, Orders, Strategies, Trades };
}

/// <summary>
/// A request the agent has checked and will build. From and To are inclusive
/// calendar dates; null means unbounded on that side. MaxBytes is already the
/// smaller of what the CRM asked for and the agent's own ceiling.
/// </summary>
public sealed record TradingExportPlan(
    string RequestId,
    DateOnly? From,
    DateOnly? To,
    IReadOnlyList<string> Datasets,
    long MaxBytes)
{
    public string FromText => From?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public string ToText => To?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

    public bool Wants(string dataset) => Datasets.Contains(dataset, StringComparer.Ordinal);

    /// <summary>Whether a timestamp, read as NinjaTrader stored it, falls on a day the request covers.</summary>
    public bool Covers(DateTime time)
    {
        DateOnly day = DateOnly.FromDateTime(time);
        return (From is not DateOnly from || day >= from) && (To is not DateOnly to || day <= to);
    }
}

/// <param name="Plan">What to build; null when the request is refused.</param>
/// <param name="RequestId">The id to complete under; null when even that was unusable.</param>
public sealed record TradingExportValidation(TradingExportPlan Plan, string RequestId, string ErrorCode)
{
    public bool IsValid => Plan != null;

    /// <summary>A refused request can still be completed as failed when its id is usable.</summary>
    public bool CanComplete => RequestId != null;
}

/* NOTHING THE CRM SENDS IS TRUSTED FOR ITS SHAPE.
 *
 * The id becomes part of a request body and a log line, so it is held to a
 * short token. The dates must be real calendar dates in the CRM's own
 * YYYY-MM-DD and in order. The datasets must all be on the allowlist - an
 * unknown name is a request this agent does not understand, and building
 * something else instead would be answering a different question. The size
 * limit must be a positive integer and is capped at 25 MB whatever the CRM
 * says, because that is what the upload is sized for. */
public static class TradingExportRequestValidator
{
    /// <summary>The most a trading export may weigh, compressed, whatever the request says.</summary>
    public const long MaximumBytes = 25L * 1024 * 1024;

    private static readonly Regex IdPattern = new(@"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\z", RegexOptions.CultureInvariant);

    public static TradingExportValidation Validate(TradingExportRequest request)
    {
        if (request?.Id == null || !IdPattern.IsMatch(request.Id))
            return new TradingExportValidation(null, null, TradingExportErrorCodes.RequestInvalid);
        string id = request.Id;
        TradingExportValidation Refuse() => new(null, id, TradingExportErrorCodes.RequestInvalid);

        if (!TryDate(request.From, out DateOnly? from) || !TryDate(request.To, out DateOnly? to))
            return Refuse();
        if (from is DateOnly start && to is DateOnly end && start > end)
            return Refuse();
        if (!request.DatasetsWellFormed || request.Datasets == null || request.Datasets.Count == 0)
            return Refuse();
        if (request.Datasets.Any(name => !TradingExportDatasets.All.Contains(name, StringComparer.Ordinal)))
            return Refuse();
        if (request.MaxBytes is not long maxBytes || maxBytes <= 0)
            return Refuse();

        string[] datasets = TradingExportDatasets.All
            .Where(name => request.Datasets.Contains(name, StringComparer.Ordinal))
            .ToArray();
        return new TradingExportValidation(
            new TradingExportPlan(id, from, to, datasets, Math.Min(maxBytes, MaximumBytes)),
            id,
            null);
    }

    private static bool TryDate(string text, out DateOnly? value)
    {
        value = null;
        if (text == null) return true;
        if (!DateOnly.TryParseExact(text, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.None, out DateOnly parsed))
            return false;
        value = parsed;
        return true;
    }
}
