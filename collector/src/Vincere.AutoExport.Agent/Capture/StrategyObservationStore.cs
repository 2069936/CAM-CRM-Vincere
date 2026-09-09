using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Contracts;

namespace Vincere.AutoExport.Agent.Capture;

/* ---------------------------------------------------------------------------
 * The strategies, kept from when they were still running.
 *
 * ONE CAPTURE CANNOT ANSWER BOTH QUESTIONS. The day's realized PnL is only
 * correct after the desk has flattened, around 16:32. The strategies are only
 * visible before NinjaTrader disables them, around 16:30. Disabling does not
 * leave them behind marked off: they leave the account's collection entirely.
 *
 * Measured on one machine, one day: 14 strategies at 09:21, 9 at 16:30, and 0
 * at 18:28, every one of them Realtime and not one of them stopped. So moving
 * the capture later to fix the money is exactly what emptied the strategies
 * column on every report.
 *
 * This holds the last set actually seen for a trading date so the close can
 * carry it. It is not a guess and not a default: nothing is ever written here
 * that was not read from NinjaTrader on the day it belongs to.
 * ------------------------------------------------------------------------- */

public sealed record StrategyObservation(
    string TradingDate,
    DateTimeOffset ObservedAt,
    IReadOnlyList<StrategyRowV1> Strategies);

public interface IStrategyObservationStore
{
    Task SaveAsync(StrategyObservation observation, CancellationToken cancellationToken = default);
    Task<StrategyObservation> LoadAsync(string tradingDate, CancellationToken cancellationToken = default);
}

public sealed class StrategyObservationStore : IStrategyObservationStore
{
    private readonly string path;

    public StrategyObservationStore(string path)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("A path is required.", nameof(path));
        this.path = path;
    }

    public async Task SaveAsync(StrategyObservation observation, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(observation);
        // Never record an empty set. An observation that saw nothing is not
        // evidence that nothing was running, and writing it would overwrite a
        // real one taken earlier the same day.
        if (observation.Strategies == null || observation.Strategies.Count == 0) return;
        string directory = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        string json = JsonConvert.SerializeObject(observation, Formatting.Indented);
        // Written beside and moved into place, so a service killed mid-write
        // leaves the previous observation rather than a truncated file.
        string temporary = path + ".tmp";
        await File.WriteAllTextAsync(temporary, json, cancellationToken).ConfigureAwait(false);
        File.Move(temporary, path, overwrite: true);
    }

    public async Task<StrategyObservation> LoadAsync(string tradingDate, CancellationToken cancellationToken = default)
    {
        try
        {
            if (!File.Exists(path)) return null;
            string json = await File.ReadAllTextAsync(path, cancellationToken).ConfigureAwait(false);
            StrategyObservation stored = JsonConvert.DeserializeObject<StrategyObservation>(json);
            // Only for the day it was taken. Yesterday's algos are not evidence
            // about today, and a stale carry-forward would be worse than an
            // empty column because it would look right.
            if (stored == null || !string.Equals(stored.TradingDate, tradingDate, StringComparison.Ordinal))
                return null;
            return stored.Strategies == null || stored.Strategies.Count == 0 ? null : stored;
        }
        catch (Exception exception) when (exception is IOException or JsonException or UnauthorizedAccessException)
        {
            // A capture must never fail because a convenience file could not be
            // read. The column is empty for the day and the money is still right.
            return null;
        }
    }
}
