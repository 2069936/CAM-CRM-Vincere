using System;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.Security;

namespace Vincere.AutoExport.Agent.Configuration;

/* ---------------------------------------------------------------------------
 * What the add-on last said it and NinjaTrader were, kept across a restart.
 *
 * The agent does not know the NinjaTrader version until the add-on has told it,
 * and the add-on tells it at the first successful CAPTURE and nowhere else: the
 * account and strategy readings carry no version on purpose. CollectorState
 * lived in memory, so a fresh install and every service restart after it (an
 * update, a reboot) sent ninjaTraderVersion null in each heartbeat until the
 * 16:30 close had been captured. Step 63 made that null harmless on the CRM;
 * this file makes it rare. The version is written here when a capture reports
 * it, and read back when the service starts, so the first heartbeat after a
 * restart says what the machine is running.
 *
 * A VERSION OR NOTHING. A value that is not shaped like a version is treated
 * as absent on the way in and on the way out, because CrmClient refuses a
 * heartbeat whose NinjaTrader version does not match its pattern, and a
 * corrupt file must not turn into a refused heartbeat. The pattern is
 * CrmClient's own.
 *
 * NEVER A REASON TO FAIL. A file that cannot be read is the same as none, and
 * a write that fails is swallowed: the capture this rides on is what the agent
 * is for, and this is a convenience for the heartbeat after it.
 * ------------------------------------------------------------------------- */
public sealed record ObservedEnvironment(string NinjaTraderVersion, string AddonVersion);

public interface IObservedEnvironmentStore
{
    /// <summary>What was last recorded, or null when nothing readable is on disk.</summary>
    ObservedEnvironment Load();

    /// <summary>Records what the add-on reported. Blank or malformed members are left out; nothing is written when both are.</summary>
    void Save(ObservedEnvironment environment);
}

public sealed class ObservedEnvironmentStore : IObservedEnvironmentStore
{
    // The same shape CrmClient accepts for a version on the heartbeat.
    private static readonly Regex VersionPattern = new(
        @"^\d{1,5}(?:\.\d{1,5}){1,3}$",
        RegexOptions.CultureInvariant);
    private static readonly UTF8Encoding Utf8WithoutBom = new(false);
    private readonly object gate = new();
    private readonly IAgentDirectorySecurity directorySecurity;

    public ObservedEnvironmentStore(string path, IAgentDirectorySecurity directorySecurity = null)
    {
        if (string.IsNullOrWhiteSpace(path))
            throw new ArgumentException("An environment path is required.", nameof(path));
        FilePath = Path.GetFullPath(path);
        this.directorySecurity = directorySecurity;
    }

    public string FilePath { get; }

    private string TemporaryPath => FilePath + ".tmp";

    public ObservedEnvironment Load()
    {
        lock (gate)
        {
            try
            {
                if (!File.Exists(FilePath)) return null;
                return Parse(File.ReadAllText(FilePath));
            }
            catch (Exception)
            {
                // Unreadable is the same as absent: the heartbeat says null until
                // the next capture, exactly as it did before this file existed.
                return null;
            }
        }
    }

    public void Save(ObservedEnvironment environment)
    {
        if (environment == null) return;
        string ninjaTraderVersion = AsVersion(environment.NinjaTraderVersion);
        string addonVersion = AsVersion(environment.AddonVersion);
        if (ninjaTraderVersion == null && addonVersion == null) return;

        lock (gate)
        {
            try
            {
                string directory = Path.GetDirectoryName(FilePath);
                directorySecurity?.EnsureProtected(directory);
                Directory.CreateDirectory(directory);

                string document = new JObject
                {
                    ["ninjaTraderVersion"] = ninjaTraderVersion,
                    ["addonVersion"] = addonVersion,
                    ["observedAt"] = DateTimeOffset.UtcNow.ToString("o"),
                }.ToString(Formatting.None);

                // Temp then move, so a machine losing power mid-write keeps the
                // last version rather than half of a file.
                DeleteIfPresent(TemporaryPath);
                File.WriteAllText(TemporaryPath, document, Utf8WithoutBom);
                File.Move(TemporaryPath, FilePath, true);
            }
            catch (Exception)
            {
                DeleteIfPresent(TemporaryPath);
            }
        }
    }

    internal static ObservedEnvironment Parse(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return null;
        JObject document = JObject.Parse(text);
        string ninjaTraderVersion = AsVersion(document.Value<string>("ninjaTraderVersion"));
        string addonVersion = AsVersion(document.Value<string>("addonVersion"));
        if (ninjaTraderVersion == null && addonVersion == null) return null;
        return new ObservedEnvironment(ninjaTraderVersion, addonVersion);
    }

    private static string AsVersion(string value)
    {
        if (string.IsNullOrWhiteSpace(value)) return null;
        string trimmed = value.Trim();
        return VersionPattern.IsMatch(trimmed) ? trimmed : null;
    }

    private static void DeleteIfPresent(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch (Exception) { }
    }
}
