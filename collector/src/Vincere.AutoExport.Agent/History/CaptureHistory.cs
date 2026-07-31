using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;

namespace Vincere.AutoExport.Agent.History;

/// <summary>
/// What happened on one trading day, kept so the CAM can answer "did yesterday
/// land?" without opening a diagnostics zip.
///
/// The runtime state in <see cref="Service.CollectorState"/> holds only the most
/// recent capture and upload, in memory, and a service restart erases it. That is
/// enough to drive a heartbeat and nothing else: it cannot tell an operator
/// whether Tuesday was collected. This record is the durable, per-day answer.
/// </summary>
public sealed record CaptureHistoryEntry(
    string TradingDate,
    DateTimeOffset? CapturedAt,
    DateTimeOffset? UploadedAt,
    int? AccountCount,
    string ErrorCode);

public interface ICaptureHistoryStore
{
    Task<IReadOnlyList<CaptureHistoryEntry>> LoadAsync(CancellationToken cancellationToken = default);

    Task RecordCapturedAsync(
        string tradingDate,
        DateTimeOffset capturedAt,
        int accountCount,
        CancellationToken cancellationToken = default);

    Task RecordUploadedAsync(
        string tradingDate,
        DateTimeOffset uploadedAt,
        CancellationToken cancellationToken = default);

    Task RecordFailureAsync(
        string tradingDate,
        string errorCode,
        CancellationToken cancellationToken = default);
}

/// <summary>
/// Stores the day history as a single small JSON file next to the agent's other
/// state.
///
/// Deliberately forgiving on read: a truncated or hand-edited file yields an
/// empty history rather than an exception. History is a reporting aid, and
/// refusing to start the service because a diagnostic file is malformed would
/// trade a cosmetic problem for an outage.
/// </summary>
public sealed class CaptureHistoryStore : ICaptureHistoryStore
{
    /// <summary>
    /// Roughly a quarter of trading days. Long enough for "was last month clean?"
    /// and short enough that the file stays a few kilobytes.
    /// </summary>
    public const int MaximumEntries = 90;

    private static readonly UTF8Encoding Utf8WithoutBom = new(encoderShouldEmitUTF8Identifier: false);
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly string path;
    private readonly string temporaryPath;

    public CaptureHistoryStore(string historyPath)
    {
        if (string.IsNullOrWhiteSpace(historyPath))
            throw new ArgumentException("A history path is required.", nameof(historyPath));
        path = historyPath;
        temporaryPath = historyPath + ".tmp";
    }

    public async Task<IReadOnlyList<CaptureHistoryEntry>> LoadAsync(
        CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            return ReadUnsynchronized();
        }
        finally
        {
            gate.Release();
        }
    }

    public Task RecordCapturedAsync(
        string tradingDate,
        DateTimeOffset capturedAt,
        int accountCount,
        CancellationToken cancellationToken = default)
    {
        if (accountCount < 0)
            throw new ArgumentOutOfRangeException(nameof(accountCount));

        // A capture clears any earlier error for the same day. The scheduler
        // retries inside the capture window, so a 4:30 failure followed by a 4:35
        // success is a good day, not a red one.
        return MutateAsync(
            tradingDate,
            existing => (existing ?? Empty(tradingDate)) with
            {
                CapturedAt = capturedAt,
                AccountCount = accountCount,
                ErrorCode = null,
            },
            cancellationToken);
    }

    public Task RecordUploadedAsync(
        string tradingDate,
        DateTimeOffset uploadedAt,
        CancellationToken cancellationToken = default)
    {
        return MutateAsync(
            tradingDate,
            existing => (existing ?? Empty(tradingDate)) with
            {
                UploadedAt = uploadedAt,
                ErrorCode = null,
            },
            cancellationToken);
    }

    public Task RecordFailureAsync(
        string tradingDate,
        string errorCode,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(errorCode))
            throw new ArgumentException("An error code is required.", nameof(errorCode));

        return MutateAsync(
            tradingDate,
            existing =>
            {
                CaptureHistoryEntry entry = existing ?? Empty(tradingDate);

                // An upload that already succeeded outranks a later failure: the
                // day's data is in the CRM regardless of what happened after.
                return entry.UploadedAt.HasValue ? entry : entry with { ErrorCode = errorCode };
            },
            cancellationToken);
    }

    private async Task MutateAsync(
        string tradingDate,
        Func<CaptureHistoryEntry, CaptureHistoryEntry> mutate,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(tradingDate))
            throw new ArgumentException("A trading date is required.", nameof(tradingDate));

        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            List<CaptureHistoryEntry> entries = ReadUnsynchronized().ToList();
            int index = entries.FindIndex(
                entry => string.Equals(entry.TradingDate, tradingDate, StringComparison.Ordinal));
            CaptureHistoryEntry updated = mutate(index < 0 ? null : entries[index]);
            if (index < 0) entries.Add(updated);
            else entries[index] = updated;

            IEnumerable<CaptureHistoryEntry> bounded = entries
                .OrderBy(entry => entry.TradingDate, StringComparer.Ordinal)
                .TakeLast(MaximumEntries);

            WriteUnsynchronized(bounded.ToList());
        }
        finally
        {
            gate.Release();
        }
    }

    private IReadOnlyList<CaptureHistoryEntry> ReadUnsynchronized()
    {
        try
        {
            if (!File.Exists(path)) return Array.Empty<CaptureHistoryEntry>();
            string json = File.ReadAllText(path, Utf8WithoutBom);
            if (string.IsNullOrWhiteSpace(json)) return Array.Empty<CaptureHistoryEntry>();
            List<CaptureHistoryEntry> parsed =
                JsonConvert.DeserializeObject<List<CaptureHistoryEntry>>(json);
            if (parsed == null) return Array.Empty<CaptureHistoryEntry>();
            return parsed
                .Where(entry => entry != null && !string.IsNullOrWhiteSpace(entry.TradingDate))
                .OrderBy(entry => entry.TradingDate, StringComparer.Ordinal)
                .ToList();
        }
        catch (Exception exception) when (
            exception is IOException
            or UnauthorizedAccessException
            or JsonException)
        {
            return Array.Empty<CaptureHistoryEntry>();
        }
    }

    private void WriteUnsynchronized(IReadOnlyList<CaptureHistoryEntry> entries)
    {
        string directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        string json = JsonConvert.SerializeObject(entries, Formatting.Indented);
        File.WriteAllText(temporaryPath, json, Utf8WithoutBom);
        File.Move(temporaryPath, path, true);
    }

    private static CaptureHistoryEntry Empty(string tradingDate) =>
        new(tradingDate, null, null, null, null);
}
