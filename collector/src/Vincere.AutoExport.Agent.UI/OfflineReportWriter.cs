using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Vincere.AutoExport.Agent.UI;

/* ---------------------------------------------------------------------------
 * A client's daily report, written on the machine, with no CRM.
 *
 * On 2026-09-25 the database stopped answering at 16:30 and did not come back
 * for three days. Six of eleven client reports had been sent; five had not, and
 * the rest of the desk could not export at all. The captures existed the whole
 * time, queued on disk where this agent puts them.
 *
 * WHAT THIS CLASS DOES AND DOES NOT DO. It picks a capture, reads the cached
 * roster, and writes one HTML file. It computes nothing. Every figure on the
 * page is produced by the CRM's own report code, bundled into report-bundle.js
 * and running in the browser that opens the file, so the numbers cannot drift
 * from the desk's: there is only one implementation of them.
 *
 * The bundle is the only interpreter available. The machine has no Node and
 * this agent has no WebView2, so the browser doing the opening is what runs it.
 * Nothing is fetched: the code and the data are both already in the file.
 * ------------------------------------------------------------------------- */
public sealed class OfflineReportWriter
{
    /// <summary>The element the bundle reads its input from.</summary>
    public const string DataElementId = "vincere-offline-data";

    private static readonly UTF8Encoding Utf8WithoutBom = new(false);

    /// <summary>
    /// Every capture on this machine, newest first, one entry per file.
    ///
    /// All four queue folders are read. `pending` holds a capture the CRM has
    /// not accepted yet, which on the one day this feature exists for is
    /// exactly the day that is missing; `sent` holds the history.
    /// </summary>
    public static IReadOnlyList<CaptureFile> FindCaptures(IEnumerable<string> queueFolders)
    {
        List<CaptureFile> found = new();
        foreach (string folder in queueFolders ?? Enumerable.Empty<string>())
        {
            if (string.IsNullOrWhiteSpace(folder) || !Directory.Exists(folder)) continue;
            foreach (string path in Directory.EnumerateFiles(folder, "*.json"))
            {
                CaptureFile file = Read(path);
                if (file != null) found.Add(file);
            }
        }

        return found
            .OrderByDescending(file => file.TradingDate, StringComparer.Ordinal)
            .ThenByDescending(file => file.CapturedAt)
            .ToList();
    }

    /// <summary>
    /// The capture to report on for a trading day.
    ///
    /// THE NEWEST ONE WINS, WHATEVER FOLDER IT IS IN. A day is captured again
    /// whenever the first attempt found positions still open, and the later
    /// capture is the settled one. Choosing by folder instead would prefer an
    /// unsent early capture over the corrected one sitting in `sent`.
    /// </summary>
    public static CaptureFile Newest(IEnumerable<CaptureFile> captures, string tradingDate = null)
    {
        IEnumerable<CaptureFile> candidates = captures ?? Enumerable.Empty<CaptureFile>();
        if (!string.IsNullOrWhiteSpace(tradingDate))
            candidates = candidates.Where(file => file.TradingDate == tradingDate);
        return candidates.OrderByDescending(file => file.CapturedAt).FirstOrDefault();
    }

    /// <summary>
    /// The file the browser opens: the capture, the roster, and the bundle.
    ///
    /// Returns the path written.
    /// </summary>
    public static string Write(
        CaptureFile capture,
        string rosterJson,
        DateTimeOffset? rosterFetchedAt,
        string clientName,
        string bundleJavaScript,
        string outputFolder)
    {
        if (capture == null) throw new ArgumentNullException(nameof(capture));
        if (string.IsNullOrWhiteSpace(bundleJavaScript))
            throw new InvalidOperationException(
                "report-bundle.js is missing from this installation, so the report cannot be built here.");
        if (string.IsNullOrWhiteSpace(outputFolder))
            throw new ArgumentException("An output folder is required.", nameof(outputFolder));

        string name = string.IsNullOrWhiteSpace(clientName) ? "Client" : clientName.Trim();
        string payload = BuildPayload(capture.Json, rosterJson, rosterFetchedAt, name);
        string title = $"{name} - {capture.TradingDate} daily report";

        Directory.CreateDirectory(outputFolder);
        string path = Path.Combine(outputFolder, SafeFileName(title) + ".html");

        string html =
            "<!doctype html>\r\n<html lang=\"en\"><head><meta charset=\"utf-8\" />\r\n"
            + "<title>" + Escape(title) + "</title>\r\n</head><body>\r\n"
            + "<script id=\"" + DataElementId + "\" type=\"application/json\">" + payload + "</script>\r\n"
            + "<script>" + bundleJavaScript + "</script>\r\n"
            + "</body></html>\r\n";

        File.WriteAllText(path, html, Utf8WithoutBom);
        return path;
    }

    /// <summary>
    /// The input the bundle reads, with every `&lt;` escaped.
    ///
    /// AN ACCOUNT CAN BE NAMED ANYTHING. A client's name or an account named
    /// with a closing script tag would end the block early and put the rest of
    /// the payload on the page as markup. The tag is not executed by the
    /// browser, and escaping `&lt;` as < means it cannot be closed from
    /// inside a JSON string either.
    /// </summary>
    internal static string BuildPayload(
        string captureJson,
        string rosterJson,
        DateTimeOffset? rosterFetchedAt,
        string clientName)
    {
        JToken capture = JToken.Parse(captureJson);
        StripStrategyConfiguration(capture);

        JObject payload = new()
        {
            ["capture"] = capture,
            ["roster"] = string.IsNullOrWhiteSpace(rosterJson) ? new JObject() : JToken.Parse(rosterJson),
            ["clientName"] = clientName,
        };
        payload["rosterFetchedAt"] = rosterFetchedAt.HasValue
            ? rosterFetchedAt.Value.ToUniversalTime().ToString("o", CultureInfo.InvariantCulture)
            : null;

        return payload.ToString(Formatting.None).Replace("<", "\\u003c");
    }

    /* WHAT THE PAGE DOES NOT SHOW MUST NOT BE IN THE FILE EITHER.
     *
     * renderOfflineReport names the algorithm and deliberately says nothing
     * about how it was configured: src/offline/renderOfflineReport.js reads
     * four named fields off a strategy and never spreads the row, and there is
     * a test asserting the rendered sheet carries no LicenseKey and no
     * StopLossTicks. All of that was true and all of it was beside the point,
     * because the file on the Desktop is not the sheet. It is the raw capture
     * in a script tag with a bundle that rewrites the document at open time,
     * so everything the sheet refused to print was still sitting in the bytes
     * a CAM attaches to a message.
     *
     * MEASURED ON A REAL MACHINE'S QUEUE, not imagined. A strategy row there
     * carries 149 entries in `extraValues`, among them a LicenseKey with a
     * live value, URGO1 through URGO4, the stop and the three profit targets,
     * the day filters, the trade window times and EdgeLeverage. That is the
     * desk's tuning and a working licence, in a file addressed to a client.
     *
     * EMPTIED, NOT REMOVED. The first version of this deleted the properties
     * and every capture with a strategy then rendered "strategies[0]
     * .parameters must be an object" where the client's day should have been:
     * src/domain/autoExportContract.js validates the snapshot before anything
     * reads it. An empty object satisfies the contract and carries nothing.
     *
     * STRATEGY ROWS ONLY. `accounts[].accountValues` is the other big map in a
     * capture and it stays: BuyingPower, NetLiquidation, the drawdown limits.
     * That is the client's own account, which is the whole subject of the
     * report. A strategy row is recognised by `parameterCaptureStatus`, which
     * nothing else in a capture carries, or by having `parameters` at all.
     *
     * Nothing downstream needs either map. src/domain/autoImport.js turns
     * `parameters` into `parametersRaw` for algorithmRanking.js in the CRM,
     * which this file never reaches, and `extraValues` has no reader in src/
     * at all. So they come out here, where the bytes are written, rather than
     * being trusted not to be displayed.
     */
    private static void StripStrategyConfiguration(JToken token)
    {
        switch (token)
        {
            case JArray array:
                foreach (JToken item in array) StripStrategyConfiguration(item);
                break;
            case JObject o:
                bool isStrategyRow = o["parameterCaptureStatus"] != null || o["parameters"] != null;
                if (isStrategyRow)
                {
                    if (o["parameters"] is JObject) o["parameters"] = new JObject();
                    if (o["extraValues"] is JObject) o["extraValues"] = new JObject();
                    o.Remove("parametersRaw");
                }
                foreach (JProperty property in o.Properties().ToList())
                    StripStrategyConfiguration(property.Value);
                break;
        }
    }

    /// <summary>
    /// The roster the service cached, read straight off disk.
    ///
    /// The Setup window does not reference the service project and must not:
    /// it has no CRM client and no business growing one. The file is JSON the
    /// service wrote and this reads, which is a smaller contract than a shared
    /// assembly and one the control pipe does not have to carry.
    ///
    /// Answers an empty roster rather than throwing. A machine that has never
    /// uploaded has none, and the report handles that by classifying nothing
    /// and totalling nothing, which is the honest answer.
    /// </summary>
    public static (string Json, DateTimeOffset? FetchedAt) ReadRoster(string rosterPath)
    {
        try
        {
            if (string.IsNullOrWhiteSpace(rosterPath) || !File.Exists(rosterPath)) return (null, null);
            JObject document = JObject.Parse(File.ReadAllText(rosterPath));
            JToken registry = document["registry"];
            if (registry == null) return (null, null);
            DateTimeOffset? fetchedAt = null;
            if (DateTimeOffset.TryParse(
                    document.Value<string>("fetchedAt"),
                    CultureInfo.InvariantCulture,
                    DateTimeStyles.RoundtripKind,
                    out DateTimeOffset parsed))
            {
                fetchedAt = parsed;
            }
            return (registry.ToString(Formatting.None), fetchedAt);
        }
        catch (Exception)
        {
            return (null, null);
        }
    }

    private static CaptureFile Read(string path)
    {
        try
        {
            string json = File.ReadAllText(path);
            JObject document = JObject.Parse(json);
            string tradingDate = document.Value<string>("tradingDate");
            if (string.IsNullOrWhiteSpace(tradingDate)) return null;
            DateTimeOffset captured = default;
            DateTimeOffset.TryParse(
                document.Value<string>("capturedAt"),
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out captured);
            int accounts = (document["accounts"] as JArray)?.Count ?? 0;
            return new CaptureFile(path, tradingDate, captured, accounts, json);
        }
        catch (Exception)
        {
            // A queue folder can hold a file half-written by a machine that lost
            // power. One unreadable capture is not a reason to offer none.
            return null;
        }
    }

    private static string SafeFileName(string value)
    {
        StringBuilder builder = new(value.Length);
        char[] invalid = Path.GetInvalidFileNameChars();
        foreach (char c in value) builder.Append(Array.IndexOf(invalid, c) >= 0 ? '-' : c);
        return builder.ToString();
    }

    private static string Escape(string value) => value
        .Replace("&", "&amp;").Replace("<", "&lt;").Replace(">", "&gt;").Replace("\"", "&quot;");
}

/// <summary>One capture on disk, read far enough to choose between them.</summary>
public sealed class CaptureFile
{
    public CaptureFile(string path, string tradingDate, DateTimeOffset capturedAt, int accountCount, string json)
    {
        Path = path;
        TradingDate = tradingDate;
        CapturedAt = capturedAt;
        AccountCount = accountCount;
        Json = json;
    }

    public string Path { get; }

    public string TradingDate { get; }

    public DateTimeOffset CapturedAt { get; }

    public int AccountCount { get; }

    /// <summary>The file verbatim. It is handed to the bundle untouched.</summary>
    public string Json { get; }

    /// <summary>What the Setup window puts in the list.</summary>
    public string Label => $"{TradingDate} · {AccountCount} account{(AccountCount == 1 ? string.Empty : "s")}";
}
