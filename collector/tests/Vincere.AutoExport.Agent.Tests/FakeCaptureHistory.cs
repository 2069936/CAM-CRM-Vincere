using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.History;

namespace Vincere.AutoExport.Agent.Tests;

/// <summary>
/// In-memory history that records what the loops asked it to write, so a test can
/// assert on the day outcome without touching disk.
/// </summary>
public sealed class FakeCaptureHistory : ICaptureHistoryStore
{
    private readonly List<CaptureHistoryEntry> entries = new();

    /// <summary>When set, every write throws, to prove callers survive it.</summary>
    public bool ThrowOnWrite { get; set; }

    public IReadOnlyList<CaptureHistoryEntry> Entries => entries;

    public IReadOnlyList<string> Uploaded { get; private set; } = Array.Empty<string>();

    public IReadOnlyList<(string TradingDate, string ErrorCode)> Failures { get; private set; } =
        Array.Empty<(string, string)>();

    public Task<IReadOnlyList<CaptureHistoryEntry>> LoadAsync(CancellationToken cancellationToken = default)
    {
        return Task.FromResult<IReadOnlyList<CaptureHistoryEntry>>(entries.ToList());
    }

    public Task RecordCapturedAsync(
        string tradingDate,
        DateTimeOffset capturedAt,
        int accountCount,
        CancellationToken cancellationToken = default)
    {
        if (ThrowOnWrite) throw new InvalidOperationException("history unavailable");
        Upsert(tradingDate, entry => entry with
        {
            CapturedAt = capturedAt,
            AccountCount = accountCount,
            ErrorCode = null,
        });
        return Task.CompletedTask;
    }

    public Task RecordUploadedAsync(
        string tradingDate,
        DateTimeOffset uploadedAt,
        CancellationToken cancellationToken = default)
    {
        if (ThrowOnWrite) throw new InvalidOperationException("history unavailable");
        Uploaded = Uploaded.Append(tradingDate).ToList();
        Upsert(tradingDate, entry => entry with { UploadedAt = uploadedAt, ErrorCode = null });
        return Task.CompletedTask;
    }

    public Task RecordFailureAsync(
        string tradingDate,
        string errorCode,
        CancellationToken cancellationToken = default)
    {
        if (ThrowOnWrite) throw new InvalidOperationException("history unavailable");
        Failures = Failures.Append((tradingDate, errorCode)).ToList();
        Upsert(tradingDate, entry => entry with { ErrorCode = errorCode });
        return Task.CompletedTask;
    }

    private void Upsert(string tradingDate, Func<CaptureHistoryEntry, CaptureHistoryEntry> mutate)
    {
        int index = entries.FindIndex(
            entry => string.Equals(entry.TradingDate, tradingDate, StringComparison.Ordinal));
        CaptureHistoryEntry current = index < 0
            ? new CaptureHistoryEntry(tradingDate, null, null, null, null)
            : entries[index];
        CaptureHistoryEntry updated = mutate(current);
        if (index < 0) entries.Add(updated);
        else entries[index] = updated;
    }
}
