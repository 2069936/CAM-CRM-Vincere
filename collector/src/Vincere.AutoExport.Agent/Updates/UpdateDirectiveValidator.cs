using System;
using System.Globalization;
using System.Text.RegularExpressions;
using Vincere.AutoExport.Agent.Crm;

namespace Vincere.AutoExport.Agent.Updates;

/// <param name="IsValid">True only when every check passed.</param>
/// <param name="ErrorCode">Why not, from UpdateErrorCodes. Null when valid.</param>
/// <param name="Version">The requested version, exactly as sent. Null when it was not x.y.z.</param>
/// <param name="ManifestSha256">The pinned digest in lower case. Null when invalid.</param>
/// <param name="RequestedAt">The CRM's own text for when the Manager pressed, kept as the budget key.</param>
public sealed record UpdateDirectiveValidation(
    bool IsValid,
    string ErrorCode,
    string Version,
    string ManifestSha256,
    string RequestedAt);

/* THE ONLY THINGS A DIRECTIVE MAY NAME.
 *
 * The CRM is trusted to say WHICH version and WHEN, and nothing else. It cannot
 * point this machine at a URL: the manifest address is rebuilt here from the
 * version, under one repository's releases, and the directive's URL has to equal
 * it byte for byte. So a compromised CRM, or anyone who can write to its
 * database, can at most ask for a release that this repository published. The
 * digest it sends pins which manifest bytes are acceptable, and the manifest pins
 * the package's own digest, which is the chain the installer line already uses.
 *
 * NEVER BACKWARDS. A version that is not strictly newer than this build is
 * refused. A downgrade through the CRM would be a way to put a known-bad agent
 * back on thirty machines with one button. */
public static class UpdateDirectiveValidator
{
    public const string ReleaseDownloadBase = "https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v";
    public const string PackageArtifactName = "Vincere-AutoExport-Agent.zip";

    private static readonly Regex Sha256Pattern = new("^[0-9a-fA-F]{64}\\z", RegexOptions.CultureInvariant);

    public static string ManifestUrlFor(string version) => ReleaseDownloadBase + version + "/release-manifest.json";

    public static string PackageUrlFor(string version) => ReleaseDownloadBase + version + "/" + PackageArtifactName;

    public static UpdateDirectiveValidation Validate(AgentUpdateDirective directive, string runningVersion)
    {
        if (directive == null)
            return Invalid(UpdateErrorCodes.DirectiveInvalid, null);
        if (!UpdateVersion.TryParseTriple(directive.Version, out Version requested))
            return Invalid(UpdateErrorCodes.DirectiveInvalid, null);
        if (directive.ManifestSha256 == null || !Sha256Pattern.IsMatch(directive.ManifestSha256))
            return Invalid(UpdateErrorCodes.DirectiveInvalid, directive.Version);
        if (!IsTimestamp(directive.RequestedAt))
            return Invalid(UpdateErrorCodes.DirectiveInvalid, directive.Version);
        // A running version this cannot read is treated as newer than anything:
        // the safe failure is not updating.
        if (!UpdateVersion.TryParseLoose(runningVersion, out Version running)
            || UpdateVersion.Compare(requested, running) <= 0)
            return Invalid(UpdateErrorCodes.VersionNotNewer, directive.Version);
        if (!string.Equals(directive.ManifestUrl, ManifestUrlFor(directive.Version), StringComparison.Ordinal))
            return Invalid(UpdateErrorCodes.UrlNotAllowed, directive.Version);

        return new UpdateDirectiveValidation(
            true,
            null,
            directive.Version,
            directive.ManifestSha256.ToLowerInvariant(),
            directive.RequestedAt);
    }

    private static bool IsTimestamp(string value)
    {
        return !string.IsNullOrWhiteSpace(value)
            && value.Length <= 64
            && DateTimeOffset.TryParse(
                value,
                CultureInfo.InvariantCulture,
                DateTimeStyles.AssumeUniversal,
                out _);
    }

    private static UpdateDirectiveValidation Invalid(string code, string version)
        => new(false, code, version, null, null);
}
