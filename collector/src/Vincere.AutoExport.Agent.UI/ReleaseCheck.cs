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
public sealed record ReleaseCheckResult(
    bool Checked,
    bool UpdateAvailable,
    string LatestVersion,
    string Message,
    /* Like the two below, only set when the published checksum is
     * trustworthy. A person pasting a line into an elevated PowerShell is no
     * more able to tell what arrived than the Install button is, so a command
     * that does not check the download before running it is not handed over
     * at all. */
    string InstallCommand = null,
    /* Only set when the published checksum is trustworthy, and that is what
     * gates the Install button. Nothing downloads and runs a package as
     * administrator on a machine holding live client accounts without knowing
     * what it got. */
    string DownloadUrl = null,
    string Sha256 = null)
{
    public bool CanInstall => UpdateAvailable
        && !string.IsNullOrWhiteSpace(DownloadUrl)
        && !string.IsNullOrWhiteSpace(Sha256);
}

public sealed class ReleaseCheck
{
    // The manifest the CRM's install line pointed at before the CRM moved to
    // one manifest per release. Kept here as a default rather than fetched from
    // the CRM on purpose: the whole point is to work when the CRM does not.
    public const string DefaultManifestUrl =
        "https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.0.3/release-manifest.json";

    /* A SECOND DESCRIPTOR, BECAUSE THE FIRST ONE CANNOT BE CORRECTED.
     *
     * release-manifest.json is pinned by sha256 inside the CRM's own source
     * (server/apiLib/collectorRelease.js), so replacing it takes the install
     * card down for every client until that constant is changed and deployed.
     * It is therefore frozen in practice, while the package beside it is
     * replaced whenever a build ships. On the release serving this fleet that
     * file still declares 1.0.3 and 3f3444ee... for a package that is 1.0.9 and
     * dc129ad4..., and it is left that way deliberately: the CRM was moved onto
     * a differently named manifest rather than this one being overwritten, so
     * the install card never spent a minute reporting no release.
     *
     * Verifying an install against a checksum that is known to be stale would
     * refuse every real package. Not verifying at all would download and
     * execute code as administrator on machines carrying live client accounts.
     * Neither is acceptable, so the update flow reads a descriptor nobody pins
     * and that ships next to the package it describes.
     *
     * Absent, this falls back to the manifest for the version check alone:
     * the window can still say a version exists, and it points at the CRM's
     * install line, which is verified against a manifest the CRM does pin. It
     * offers no Install button and no command of its own, because the only
     * checksum it would have is the stale one above. */
    public const string DefaultUpdateDescriptorUrl =
        "https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.0.3/agent-update.json";

    // \z rather than $: in .NET, $ also matches before a trailing newline, and
    // a digest carrying one would split the one line command in two.
    private static readonly Regex Sha256Pattern = new(@"^[0-9a-fA-F]{64}\z", RegexOptions.Compiled);

    private static readonly Regex VersionPattern = new(@"^\d{1,5}(\.\d{1,5}){1,3}$", RegexOptions.Compiled);

    private readonly HttpMessageHandler handler;
    private readonly string manifestUrl;
    private readonly string descriptorUrl;

    public ReleaseCheck(HttpMessageHandler handler = null, string manifestUrl = null, string descriptorUrl = null)
    {
        this.handler = handler;
        this.manifestUrl = string.IsNullOrWhiteSpace(manifestUrl) ? DefaultManifestUrl : manifestUrl;
        this.descriptorUrl = string.IsNullOrWhiteSpace(descriptorUrl) ? DefaultUpdateDescriptorUrl : descriptorUrl;
    }

    /// <summary>Read {version, sha256, url} from the descriptor we control.</summary>
    public static ReleaseCheckResult EvaluateDescriptor(string installedVersion, JObject descriptor)
    {
        string latest = descriptor?.Value<string>("version");
        string sha = descriptor?.Value<string>("sha256");
        string url = descriptor?.Value<string>("url");
        if (!VersionPattern.IsMatch(latest ?? string.Empty)) return null;
        if (!Sha256Pattern.IsMatch(sha ?? string.Empty)) return null;
        if (!Uri.TryCreate(url ?? string.Empty, UriKind.Absolute, out Uri parsed)
            || parsed.Scheme != Uri.UriSchemeHttps)
        {
            return null;
        }
        if (Compare(installedVersion, latest) >= 0)
            return new ReleaseCheckResult(true, false, latest, $"You are up to date on {installedVersion}.");
        return new ReleaseCheckResult(
            true,
            true,
            latest,
            $"Version {latest} is available. You are on {installedVersion}.",
            BuildInstallCommand(url, sha),
            url,
            sha.ToLowerInvariant());
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

    /* THE COMMAND A PERSON COPIES, AND IT CHECKS THE BYTES FIRST.
     *
     * Byte for byte the line the CRM builds (src/domain/autoCollectionViewModel.js
     * buildInstallCommand), so there is one install line to keep working, not
     * two spellings of it.
     *
     * The zip is hashed right after the download and compared with the
     * published SHA-256. On a mismatch the zip is deleted and the line throws,
     * which stops the rest of the pasted line before Expand-Archive and before
     * install-agent.ps1. -ne compares strings case insensitively, so
     * Get-FileHash's upper case answer matches the lower case digest.
     *
     * A person pasting this into an elevated PowerShell cannot tell what
     * arrived any better than the Install button can, so without a well formed
     * digest there is no command at all: null, never a line that runs
     * unverified bytes as administrator on a machine holding live client
     * accounts. The digest is not trimmed, as in the CRM: one with anything
     * around it is not a digest.
     *
     * IT STILL DOES NOT RUN IT. A person copies it into an elevated PowerShell
     * and watches it. An agent that replaces itself unattended on one of these
     * machines is a decision for whoever owns the accounts, not for this window.
     */
    public static string BuildInstallCommand(string artifactUrl, string sha256)
    {
        string url = (artifactUrl ?? string.Empty).Trim();
        if (url.Length == 0) return null;
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri parsed)
            || parsed.Scheme != Uri.UriSchemeHttps)
        {
            // A release that names a non https artifact is not one to build a
            // copy and paste command from.
            return null;
        }
        // Hex by this check, so the digest cannot carry a quote out of the
        // single quoted literal it sits in.
        if (!Sha256Pattern.IsMatch(sha256 ?? string.Empty)) return null;
        string quoted = url.Replace("'", "''");
        string sha = sha256.ToLowerInvariant();
        return string.Join("; ", new[]
        {
            "$d=\"$env:TEMP\\vincere-agent\"",
            "Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue",
            "Invoke-WebRequest '" + quoted + "' -OutFile \"$d.zip\" -UseBasicParsing",
            "$hash=(Get-FileHash -LiteralPath \"$d.zip\" -Algorithm SHA256).Hash",
            "if ($hash -ne '" + sha + "') { Remove-Item -LiteralPath \"$d.zip\" -Force -ErrorAction SilentlyContinue; throw \"SHA256 mismatch, nothing was installed: $hash\" }",
            "Expand-Archive \"$d.zip\" $d -Force",
            "& \"$d\\install-agent.ps1\" -PackagePath $d",
        });
    }

    /* THE SCRIPT THE INSTALL BUTTON RUNS.
     *
     * The same check as the command a person copies: the download is compared
     * with the published checksum BEFORE anything out of it is executed. What
     * differs is the form. This one runs from a file in a console the reader
     * did not open, so it says what it is doing and, on a mismatch, holds the
     * window open on a sentence instead of a red exception that vanishes.
     *
     * A mismatch installs nothing. It is far more likely to mean a half
     * finished upload than an attack, and either way the correct move is the
     * same one.
     *
     * Written as a file rather than passed inline: a hundred-character URL and
     * a checksum threaded through nested quoting is how an install line becomes
     * a bug nobody can read.
     */
    public static string BuildVerifiedInstallScript(string artifactUrl, string sha256)
    {
        string url = (artifactUrl ?? string.Empty).Trim();
        string sha = (sha256 ?? string.Empty).Trim();
        if (!Sha256Pattern.IsMatch(sha)) return null;
        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri parsed) || parsed.Scheme != Uri.UriSchemeHttps) return null;
        string quoted = url.Replace("'", "''");
        return string.Join("\r\n", new[]
        {
            "$ErrorActionPreference = 'Stop'",
            "$d = \"$env:TEMP\\vincere-agent\"",
            "Remove-Item $d -Recurse -Force -ErrorAction SilentlyContinue",
            "Write-Host 'Downloading the agent package...'",
            "Invoke-WebRequest '" + quoted + "' -OutFile \"$d.zip\" -UseBasicParsing",
            "$actual = (Get-FileHash \"$d.zip\" -Algorithm SHA256).Hash",
            "if ($actual -ne '" + sha.ToUpperInvariant() + "') {",
            "    Write-Host ''",
            "    Write-Host 'The download does not match the published checksum. Nothing was installed.' -ForegroundColor Red",
            "    Write-Host ('  expected " + sha.ToLowerInvariant() + "')",
            "    Write-Host ('  received ' + $actual.ToLower())",
            "    Read-Host 'Press Enter to close'",
            "    exit 1",
            "}",
            "Write-Host 'Checksum verified. Installing...'",
            "Expand-Archive \"$d.zip\" $d -Force",
            "& \"$d\\install-agent.ps1\" -PackagePath $d",
        });
    }

    /* THE MANIFEST FALLBACK SAYS A VERSION AND HANDS OVER NO COMMAND.
     *
     * It is reached only when the descriptor cannot be read or trusted. The
     * manifest does carry a sha256 per artifact, but the one this reads by
     * default is the frozen file described above DefaultUpdateDescriptorUrl:
     * its digest names a package that was replaced long ago. A command checked
     * against it would refuse the real package every time, which is a dead end
     * that reads like an attack. A command not checked against anything is
     * what this must never hand over.
     *
     * So it says the version and points at the CRM, whose card has a "Show
     * install line" for a client that is already paired. That line is checked
     * against a manifest the CRM pins by its own digest, which this window
     * cannot do for the file it reads here.
     */
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
                $"Version {latestVersion} is available. You are on {installedVersion}. To update, open this client in the CRM, press Show install line, and run that line in PowerShell as administrator.");
        }
        return new ReleaseCheckResult(true, false, latestVersion, $"You are up to date on {installedVersion}.");
    }

    public async Task<ReleaseCheckResult> CheckAsync(string installedVersion, CancellationToken cancellationToken = default)
    {
        using HttpClient http = handler == null ? new HttpClient() : new HttpClient(handler, disposeHandler: false);
        http.Timeout = TimeSpan.FromSeconds(15);
        try
        {
            // The descriptor first, because it is the only one that can be
            // corrected. A machine that cannot reach it still gets a version
            // answer from the manifest, without an Install button or a command.
            try
            {
                string descriptorBody = await http.GetStringAsync(descriptorUrl, cancellationToken).ConfigureAwait(false);
                ReleaseCheckResult fromDescriptor = EvaluateDescriptor(installedVersion, JObject.Parse(descriptorBody));
                if (fromDescriptor != null) return fromDescriptor;
            }
            catch (Exception exception) when (exception is HttpRequestException or Newtonsoft.Json.JsonException)
            {
                // No descriptor published for this release yet.
            }

            string body = await http.GetStringAsync(manifestUrl, cancellationToken).ConfigureAwait(false);
            JObject manifest = JObject.Parse(body);
            return Evaluate(installedVersion, manifest.Value<string>("version"));
        }
        catch (Exception exception) when (exception is HttpRequestException or TaskCanceledException or Newtonsoft.Json.JsonException)
        {
            // Deliberately not the exception text: it carries proxy names and
            // hostnames, and nothing here is a fault worth alarming anyone with.
            return new ReleaseCheckResult(false, false, null, "Could not check for updates right now.");
        }
    }
}
