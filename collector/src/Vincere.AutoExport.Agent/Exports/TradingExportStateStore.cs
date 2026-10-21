using System;
using System.IO;
using System.Text;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Crm;

namespace Vincere.AutoExport.Agent.Exports;

/* WHAT THIS MACHINE LAST DID WITH A TRADING EXPORT, AND ONLY THAT.
 *
 * The CRM is the source of truth for what has been exported and what is still
 * wanted; this file is not a second ledger of it. It exists for one failure: the
 * bytes reached storage and the "ready" did not reach the CRM. Without it the next
 * poll would hand back the same request and the machine would copy the database,
 * build and upload the whole file again to say one sentence. With it, the next
 * poll sends only the sentence.
 *
 * So it holds the request id, how far it got, and the completion it owes - the
 * digest, the size, the row counts and the dates covered, which is also the local
 * record of what was exported last. No path, no address, no bytes of the export.
 *
 *   uploaded   the file is in storage; "ready" is owed
 *   failed     the export failed with ErrorCode; "failed" is owed
 *   completed  the CRM acknowledged whichever it was */
[JsonObject(MemberSerialization.OptIn)]
public sealed record TradingExportState
{
    public const string Uploaded = "uploaded";
    public const string FailedPhase = "failed";
    public const string Completed = "completed";

    [JsonProperty("requestId")]
    public string RequestId { get; init; }

    [JsonProperty("phase")]
    public string Phase { get; init; }

    [JsonProperty("status")]
    public string Status { get; init; }

    [JsonProperty("errorCode")]
    public string ErrorCode { get; init; }

    [JsonProperty("sha256")]
    public string Sha256 { get; init; }

    [JsonProperty("byteSize")]
    public long? ByteSize { get; init; }

    [JsonProperty("rowCounts")]
    public ExportRowCounts RowCounts { get; init; }

    [JsonProperty("from")]
    public string From { get; init; }

    [JsonProperty("to")]
    public string To { get; init; }

    [JsonProperty("updatedAt")]
    public DateTimeOffset UpdatedAt { get; init; }

    /// <summary>True while a completion is owed to the CRM.</summary>
    public bool CompletionOwed => Phase is Uploaded or FailedPhase;

    public ExportCompleteRequest ToCompletion() => new(RequestId, Status, Sha256, ByteSize, RowCounts, From, To, ErrorCode);
}

public sealed class TradingExportStateStore
{
    private static readonly UTF8Encoding Utf8WithoutBom = new(false);
    private readonly string path;

    public TradingExportStateStore(string exportsRoot)
    {
        if (string.IsNullOrWhiteSpace(exportsRoot)) throw new ArgumentException("An exports folder is required.", nameof(exportsRoot));
        path = Path.Combine(Path.GetFullPath(exportsRoot), "state.json");
    }

    public string FilePath => path;

    /// <summary>A missing or damaged file is no state: the worst that costs is building one export twice.</summary>
    public TradingExportState Load()
    {
        try
        {
            if (!File.Exists(path)) return null;
            TradingExportState state = JsonConvert.DeserializeObject<TradingExportState>(
                File.ReadAllText(path, Utf8WithoutBom),
                new JsonSerializerSettings { DateParseHandling = DateParseHandling.DateTimeOffset });
            return string.IsNullOrWhiteSpace(state?.RequestId) ? null : state;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    /// <summary>Written beside and moved over, so a crash leaves the old record or the new one.</summary>
    public void Save(TradingExportState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        Directory.CreateDirectory(Path.GetDirectoryName(path));
        string temporary = path + ".tmp";
        File.WriteAllText(temporary, JsonConvert.SerializeObject(state, Formatting.Indented), Utf8WithoutBom);
        File.Move(temporary, path, overwrite: true);
    }
}
