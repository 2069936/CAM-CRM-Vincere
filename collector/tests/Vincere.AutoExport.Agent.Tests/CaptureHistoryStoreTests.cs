using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.History;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class CaptureHistoryStoreTests : IDisposable
{
    private readonly string directory = Path.Combine(
        Path.GetTempPath(),
        "vincere-history-" + Guid.NewGuid().ToString("n"));

    private CaptureHistoryStore CreateStore() =>
        new(Path.Combine(directory, "history.json"));

    private static DateTimeOffset At(int hour, int minute) =>
        new(2026, 7, 27, hour, minute, 0, TimeSpan.FromHours(-4));

    [Fact]
    public async Task MissingFileReadsAsEmptyHistory()
    {
        Assert.Empty(await CreateStore().LoadAsync());
    }

    [Fact]
    public async Task CaptureThenUploadBuildOneDay()
    {
        CaptureHistoryStore store = CreateStore();

        await store.RecordCapturedAsync("2026-07-27", At(16, 31), 3);
        await store.RecordUploadedAsync("2026-07-27", At(16, 32));

        CaptureHistoryEntry entry = Assert.Single(await store.LoadAsync());
        Assert.Equal("2026-07-27", entry.TradingDate);
        Assert.Equal(At(16, 31), entry.CapturedAt);
        Assert.Equal(At(16, 32), entry.UploadedAt);
        Assert.Equal(3, entry.AccountCount);
        Assert.Null(entry.ErrorCode);
    }

    [Fact]
    public async Task ARetryThatSucceedsClearsTheEarlierFailure()
    {
        // The scheduler retries inside the capture window. A 4:30 failure followed
        // by a 4:35 success is a collected day, and showing it red would send a
        // CAM chasing a problem that already resolved itself.
        CaptureHistoryStore store = CreateStore();

        await store.RecordFailureAsync("2026-07-27", "addon_unavailable");
        await store.RecordCapturedAsync("2026-07-27", At(16, 35), 3);

        CaptureHistoryEntry entry = Assert.Single(await store.LoadAsync());
        Assert.Null(entry.ErrorCode);
        Assert.Equal(At(16, 35), entry.CapturedAt);
    }

    [Fact]
    public async Task AFailureAfterASuccessfulUploadDoesNotOverwriteIt()
    {
        // The day's data is in the CRM. Whatever failed afterwards did not undo
        // that, so the cell must stay green.
        CaptureHistoryStore store = CreateStore();

        await store.RecordCapturedAsync("2026-07-27", At(16, 31), 3);
        await store.RecordUploadedAsync("2026-07-27", At(16, 32));
        await store.RecordFailureAsync("2026-07-27", "crm_unavailable");

        CaptureHistoryEntry entry = Assert.Single(await store.LoadAsync());
        Assert.Null(entry.ErrorCode);
        Assert.Equal(At(16, 32), entry.UploadedAt);
    }

    [Fact]
    public async Task EntriesSurviveAcrossStoreInstancesAndStaySorted()
    {
        CaptureHistoryStore writer = CreateStore();
        await writer.RecordUploadedAsync("2026-07-24", At(16, 32));
        await writer.RecordUploadedAsync("2026-07-22", At(16, 32));
        await writer.RecordUploadedAsync("2026-07-23", At(16, 32));

        IReadOnlyList<CaptureHistoryEntry> reloaded = await CreateStore().LoadAsync();

        Assert.Equal(
            new[] { "2026-07-22", "2026-07-23", "2026-07-24" },
            reloaded.Select(entry => entry.TradingDate).ToArray());
    }

    [Fact]
    public async Task CorruptFileReadsAsEmptyRatherThanThrowing()
    {
        // History is a reporting aid. Refusing to answer a status call because a
        // diagnostic file was hand-edited would trade a cosmetic problem for an
        // apparently dead service.
        Directory.CreateDirectory(directory);
        await File.WriteAllTextAsync(Path.Combine(directory, "history.json"), "{not-json");

        CaptureHistoryStore store = CreateStore();

        Assert.Empty(await store.LoadAsync());

        // And it recovers: the next write replaces the unreadable file.
        await store.RecordUploadedAsync("2026-07-27", At(16, 32));
        Assert.Single(await store.LoadAsync());
    }

    [Fact]
    public async Task HistoryIsBoundedToTheMostRecentDays()
    {
        CaptureHistoryStore store = CreateStore();
        DateTime start = new(2026, 1, 1);
        for (int index = 0; index < CaptureHistoryStore.MaximumEntries + 10; index++)
        {
            string date = start.AddDays(index).ToString("yyyy-MM-dd");
            await store.RecordUploadedAsync(date, At(16, 32));
        }

        IReadOnlyList<CaptureHistoryEntry> entries = await store.LoadAsync();

        Assert.Equal(CaptureHistoryStore.MaximumEntries, entries.Count);
        Assert.Equal(start.AddDays(10).ToString("yyyy-MM-dd"), entries[0].TradingDate);
        Assert.Equal(
            start.AddDays(CaptureHistoryStore.MaximumEntries + 9).ToString("yyyy-MM-dd"),
            entries[^1].TradingDate);
    }

    [Fact]
    public async Task NoTemporaryFileIsLeftBehind()
    {
        CaptureHistoryStore store = CreateStore();
        await store.RecordUploadedAsync("2026-07-27", At(16, 32));

        Assert.False(File.Exists(Path.Combine(directory, "history.json.tmp")));
    }

    public void Dispose()
    {
        if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
    }
}
