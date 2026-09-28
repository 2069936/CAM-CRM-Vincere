using System;
using System.Globalization;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Security;

namespace Vincere.AutoExport.Agent.Configuration;

/* ---------------------------------------------------------------------------
 * The account classification, kept for the day the CRM cannot be reached.
 *
 * A NinjaTrader capture knows balances and profit and loss. It does not know
 * that an account is an evaluation, and that is the one fact a client's daily
 * report cannot be correct without: an evaluation holds challenge capital the
 * client does not own, so its profit is not theirs. Measured on a real capture
 * from 2026-09-22, counting the accounts nobody had classified read +$1,565
 * against a true $0.00.
 *
 * The CRM answers every upload with a small projection of its own registry -
 * type, status, alias, the failure date, a few limits - and this keeps the last
 * copy. On 2026-09-25 the database stopped answering for three days while the
 * captures piled up on disk; a machine that had uploaded even once before that
 * would have had everything it needed to print the reports nobody could print.
 *
 * WRITTEN BY THE SERVICE, READ BY THE SETUP WINDOW. The window has no CRM
 * client and must not grow one.
 *
 * THE TIMESTAMP LIVES INSIDE THE FILE, not on it. A file's modification time is
 * changed by a backup, a copy, a virus scanner and half of Windows, and this
 * number decides whether a figure is printed for a client or held back.
 * ------------------------------------------------------------------------- */
public interface IRosterStore
{
    /// <summary>The roster as the CRM sent it, or null when none has arrived.</summary>
    Task<CachedRoster> LoadAsync(CancellationToken cancellationToken = default);

    Task SaveAsync(string registryJson, string version, DateTimeOffset fetchedAt, CancellationToken cancellationToken = default);
}

/// <summary>What the machine holds, and when it was told.</summary>
public sealed class CachedRoster
{
    public CachedRoster(string registryJson, string version, DateTimeOffset? fetchedAt)
    {
        RegistryJson = registryJson;
        Version = version;
        FetchedAt = fetchedAt;
    }

    /// <summary>Raw JSON, passed to the report bundle untouched. The agent has no reason to parse it.</summary>
    public string RegistryJson { get; }

    public string Version { get; }

    public DateTimeOffset? FetchedAt { get; }
}

public sealed class RosterStore : IRosterStore
{
    private static readonly System.Text.UTF8Encoding Utf8WithoutBom = new(false);
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly IAgentDirectorySecurity directorySecurity;

    public RosterStore(string rosterPath, IAgentDirectorySecurity directorySecurity = null)
    {
        if (string.IsNullOrWhiteSpace(rosterPath))
            throw new ArgumentException("A roster path is required.", nameof(rosterPath));
        RosterPath = Path.GetFullPath(rosterPath);
        this.directorySecurity = directorySecurity;
    }

    public string RosterPath { get; }

    private string TemporaryPath => RosterPath + ".tmp";

    public async Task<CachedRoster> LoadAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (!File.Exists(RosterPath)) return null;
            string text = await File.ReadAllTextAsync(RosterPath, cancellationToken).ConfigureAwait(false);
            return Parse(text);
        }
        catch (Exception)
        {
            // A roster that cannot be read is the same as none: the report will
            // say it could not classify anything and total nothing, which is
            // the honest answer and not a reason to refuse to run.
            return null;
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task SaveAsync(
        string registryJson,
        string version,
        DateTimeOffset fetchedAt,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(registryJson)) return;

        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            directorySecurity?.EnsureProtected(Path.GetDirectoryName(RosterPath));
            Directory.CreateDirectory(Path.GetDirectoryName(RosterPath));

            string document = "{\"version\":" + Quote(version)
                + ",\"fetchedAt\":" + Quote(fetchedAt.ToUniversalTime().ToString("o"))
                + ",\"registry\":" + registryJson + "}";

            // Temp then move, so a machine losing power mid-write keeps the old
            // roster rather than ending up with half of the new one.
            DeleteIfPresent(TemporaryPath);
            await File.WriteAllTextAsync(TemporaryPath, document, Utf8WithoutBom, cancellationToken)
                .ConfigureAwait(false);
            File.Move(TemporaryPath, RosterPath, true);
        }
        catch (Exception)
        {
            // Never fail an upload over this. The capture reaching the CRM is
            // what the agent is for; the roster is a convenience for a day that
            // may not come.
            DeleteIfPresent(TemporaryPath);
        }
        finally
        {
            gate.Release();
        }
    }

    internal static CachedRoster Parse(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        var document = Newtonsoft.Json.Linq.JObject.Parse(text);
        var registry = document["registry"];
        if (registry == null) return null;
        /* INVARIANT CULTURE, AND THAT IS NOT A STYLE CHOICE.
         *
         * The bare TryParse reads the machine's locale. On a VPS set to a
         * day-first locale it read the stamp 2026-09-01 back as 2026-01-09,
         * and on another it failed outright and answered null. This date is
         * what decides whether a figure is printed for a client or held back
         * as too old to trust, so a roster written in September must not read
         * as January because of where the machine happens to be.
         *
         * RoundtripKind keeps the offset the writer put there instead of
         * shifting it into local time. */
        DateTimeOffset? fetchedAt = null;
        string stamp = document.Value<string>("fetchedAt");
        if (DateTimeOffset.TryParse(
                stamp,
                CultureInfo.InvariantCulture,
                DateTimeStyles.RoundtripKind,
                out DateTimeOffset parsed))
        {
            fetchedAt = parsed;
        }
        return new CachedRoster(
            registry.ToString(Newtonsoft.Json.Formatting.None),
            document.Value<string>("version"),
            fetchedAt);
    }

    private static string Quote(string value) =>
        Newtonsoft.Json.JsonConvert.ToString(value ?? string.Empty);

    private static void DeleteIfPresent(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (Exception) { }
    }
}
