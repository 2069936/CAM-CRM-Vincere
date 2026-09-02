using System;
using System.Net.Http;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;

namespace Vincere.AutoExport.Agent.UI;

/* ---------------------------------------------------------------------------
 * Asking whether there is a newer build, rather than waiting to be told.
 *
 * The window already had an update notice, and it was worthless: it only lit up
 * when the CRM said so in a heartbeat response. Heartbeats have been failing
 * with a 500 all week, which is exactly when someone would want to know whether
 * their agent is current, so the one notice that existed was dark precisely
 * when it mattered.
 *
 * This asks the release manifest directly. It is a public file on the same
 * release the install line downloads from, so the answer does not depend on the
 * CRM being healthy, on being paired, or on holding any credential.
 *
 * IT DOES NOT DOWNLOAD AND IT DOES NOT INSTALL. Those are the same decision as
 * an auto-update, only spelled differently, and an agent that replaces itself
 * on machines carrying live client accounts is a decision for the people who
 * own those accounts. This reads a version number and says a sentence.
 *
 * A FAILURE HERE IS NOT A FAULT. No network, a blocked egress, a manifest that
 * moved: none of that means anything is wrong with this machine's collection,
 * so it says it could not check rather than reporting a problem.
 * ------------------------------------------------------------------------- */
public sealed record ReleaseCheckResult(bool Checked, bool UpdateAvailable, string LatestVersion, string Message);

public sealed class ReleaseCheck
{
    // The manifest the CRM's install line points at. Kept here as a default
    // rather than fetched from the CRM on purpose: the whole point is to work
    // when the CRM does not.
    public const string DefaultManifestUrl =
        "https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.0.1/release-manifest.json";

    private static readonly Regex VersionPattern = new(@"^\d{1,5}(\.\d{1,5}){1,3}$", RegexOptions.Compiled);

    private readonly HttpMessageHandler handler;
    private readonly string manifestUrl;

    public ReleaseCheck(HttpMessageHandler handler = null, string manifestUrl = null)
    {
        this.handler = handler;
        this.manifestUrl = string.IsNullOrWhiteSpace(manifestUrl) ? DefaultManifestUrl : manifestUrl;
    }

    /// <summary>Compare two dotted versions. Missing parts count as zero.</summary>
    public static int Compare(string left, string right)
    {
        string[] a = (left ?? string.Empty).Split('.');
        string[] b = (right ?? string.Empty).Split('.');
        for (int i = 0; i < Math.Max(a.Length, b.Length); i++)
        {
            int x = i < a.Length && int.TryParse(a[i], out int parsedA) ? parsedA : 0;
            int y = i < b.Length && int.TryParse(b[i], out int parsedB) ? parsedB : 0;
            if (x != y) return x < y ? -1 : 1;
        }
        return 0;
    }

    public static ReleaseCheckResult Evaluate(string installedVersion, string latestVersion)
    {
        if (!VersionPattern.IsMatch(latestVersion ?? string.Empty))
            return new ReleaseCheckResult(false, false, null, "Could not read the published version.");
        if (Compare(installedVersion, latestVersion) < 0)
        {
            return new ReleaseCheckResult(
                true,
                true,
                latestVersion,
                $"Version {latestVersion} is available. You are on {installedVersion}. Re-run the install line from the CRM to update.");
        }
        return new ReleaseCheckResult(true, false, latestVersion, $"You are up to date on {installedVersion}.");
    }

    public async Task<ReleaseCheckResult> CheckAsync(string installedVersion, CancellationToken cancellationToken = default)
    {
        using HttpClient http = handler == null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        http.Timeout = TimeSpan.FromSeconds(15);
        try
        {
            string body = await http.GetStringAsync(manifestUrl, cancellationToken).ConfigureAwait(false);
            string latest = JObject.Parse(body).Value<string>("version");
            return Evaluate(installedVersion, latest);
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or Newtonsoft.Json.JsonException)
        {
            // Deliberately not the exception text: it carries proxy names and
            // hostnames, and nothing here is a fault worth alarming anyone with.
            return new ReleaseCheckResult(false, false, null, "Could not check for updates right now.");
        }
    }
}
