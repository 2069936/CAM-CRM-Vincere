using System;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.Crm;

namespace Vincere.AutoExport.Agent.Updates;

/* WHAT THE UPDATER REMEMBERS ACROSS A RESTART, AND IT HAS TO REMEMBER ACROSS ONE:
 * applying an update restarts this service by design.
 *
 * Two halves. The REPORT (State, ErrorCode, TargetVersion) is what the next poll
 * tells the CRM. The BUDGET (BudgetVersion, BudgetRequestedAt, Attempts) is how
 * many attempts this machine has spent on one press of the Update button, keyed
 * by the version and by the CRM's own timestamp of the press, so pressing again
 * is a new budget and nothing else is.
 *
 * The staged package's digest and size are kept so an update waiting for the
 * trading window can be re-verified when the window opens without asking GitHub
 * again. ApplyStartedAt is when the last task was started, which is what the
 * cooldown, the timeout and the reading of last-result.json are measured from. */
[JsonObject(MemberSerialization.OptIn)]
public sealed record AgentUpdateState
{
    public static readonly AgentUpdateState Empty = new();

    [JsonProperty("budgetVersion")]
    public string BudgetVersion { get; init; }

    [JsonProperty("budgetRequestedAt")]
    public string BudgetRequestedAt { get; init; }

    [JsonProperty("attempts")]
    public int Attempts { get; init; }

    [JsonProperty("state")]
    public string State { get; init; }

    [JsonProperty("errorCode")]
    public string ErrorCode { get; init; }

    [JsonProperty("targetVersion")]
    public string TargetVersion { get; init; }

    [JsonProperty("stagedSha256")]
    public string StagedSha256 { get; init; }

    [JsonProperty("stagedSize")]
    public long? StagedSize { get; init; }

    [JsonProperty("minimumAddonVersion")]
    public string MinimumAddonVersion { get; init; }

    [JsonProperty("applyStartedAt")]
    public DateTimeOffset? ApplyStartedAt { get; init; }

    /// <summary>The report half cleared: nothing in progress, nothing failed.</summary>
    public AgentUpdateState WithoutReport() => this with
    {
        State = null,
        ErrorCode = null,
        TargetVersion = null,
    };

    public AgentUpdateState WithoutStagedPackage() => this with
    {
        StagedSha256 = null,
        StagedSize = null,
        MinimumAddonVersion = null,
    };
}

/// <param name="Outcome">"installed" or "rolled_back".</param>
public sealed record AgentUpdateLastResult(
    string Version,
    string Outcome,
    string ErrorCode,
    DateTimeOffset At)
{
    public const string Installed = "installed";
    public const string RolledBack = "rolled_back";
}

public sealed class UpdateStateStore
{
    private static readonly UTF8Encoding Utf8WithoutBom = new(false);
    private static readonly Regex CodePattern = new("^[a-z0-9_]{1,64}\\z", RegexOptions.CultureInvariant);
    private readonly UpdateLayout layout;

    public UpdateStateStore(UpdateLayout layout)
    {
        this.layout = layout ?? throw new ArgumentNullException(nameof(layout));
    }

    /* A file that is missing, unreadable or not this shape is an empty state, not
     * an error: the worst that costs is a fresh attempt budget, and refusing to
     * start the loop over a damaged file would cost every update after it. */
    public AgentUpdateState Load()
    {
        try
        {
            if (!File.Exists(layout.StateFile)) return AgentUpdateState.Empty;
            AgentUpdateState state = JsonConvert.DeserializeObject<AgentUpdateState>(
                File.ReadAllText(layout.StateFile, Utf8WithoutBom),
                new JsonSerializerSettings { DateParseHandling = DateParseHandling.DateTimeOffset });
            return Sanitize(state);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return AgentUpdateState.Empty;
        }
    }

    /// <summary>Written to a temporary file and moved over the old one, so a crash leaves one or the other.</summary>
    public void Save(AgentUpdateState state)
    {
        ArgumentNullException.ThrowIfNull(state);
        Directory.CreateDirectory(layout.Root);
        string temporary = layout.StateFile + ".tmp";
        File.WriteAllText(temporary, JsonConvert.SerializeObject(state, Formatting.Indented), Utf8WithoutBom);
        File.Move(temporary, layout.StateFile, overwrite: true);
    }

    /* WRITTEN BY update-agent.ps1, read here as untrusted text. Anything that does
     * not fit is no result at all, and the apply timeout decides instead. The
     * error code is checked for shape before it can be sent to the CRM; one that
     * does not fit becomes install_failed. */
    public AgentUpdateLastResult ReadLastResult()
    {
        try
        {
            if (!File.Exists(layout.LastResultFile)) return null;
            FileInfo info = new(layout.LastResultFile);
            if (info.Length > 4096) return null;
            using JsonTextReader reader = new(new StringReader(File.ReadAllText(layout.LastResultFile)))
            {
                DateParseHandling = DateParseHandling.None,
            };
            if (JToken.ReadFrom(reader) is not JObject root) return null;
            string version = Text(root["version"]);
            string outcome = Text(root["outcome"]);
            string at = Text(root["at"]);
            if (!UpdateVersion.IsTriple(version)
                || outcome is not (AgentUpdateLastResult.Installed or AgentUpdateLastResult.RolledBack)
                || !DateTimeOffset.TryParse(at, CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out DateTimeOffset when))
                return null;
            string code = Text(root["errorCode"]);
            if (outcome == AgentUpdateLastResult.Installed)
                code = null;
            else if (code == null || !CodePattern.IsMatch(code))
                code = UpdateErrorCodes.InstallFailed;
            return new AgentUpdateLastResult(version, outcome, code, when);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or JsonException)
        {
            return null;
        }
    }

    private static string Text(JToken token)
        => token is JValue { Type: JTokenType.String } value ? (string)value.Value : null;

    // The report half is what goes on the wire, so it is held to the wire's shape
    // even when the file was edited by hand.
    private static AgentUpdateState Sanitize(AgentUpdateState state)
    {
        if (state == null) return AgentUpdateState.Empty;
        string reported = AgentUpdateStates.IsKnown(state.State) ? state.State : null;
        return state with
        {
            State = reported,
            ErrorCode = reported != null && state.ErrorCode != null && CodePattern.IsMatch(state.ErrorCode)
                ? state.ErrorCode
                : null,
            TargetVersion = UpdateVersion.IsTriple(state.TargetVersion) ? state.TargetVersion : null,
            BudgetVersion = UpdateVersion.IsTriple(state.BudgetVersion) ? state.BudgetVersion : null,
            Attempts = Math.Max(0, state.Attempts),
            MinimumAddonVersion = UpdateVersion.IsTriple(state.MinimumAddonVersion) ? state.MinimumAddonVersion : null,
        };
    }
}
