using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Vincere.AutoExport.Agent.Updates;

/// <param name="Sha256">Lower case.</param>
public sealed record ReleaseManifestArtifact(string Name, string Url, string Sha256, long Size);

/// <param name="MinimumAddonVersion">
/// The lowest NinjaTrader AddOn the new agent fully works with, when the release
/// says. Null when it does not, which means any AddOn will do.
/// </param>
public sealed record VerifiedReleaseManifest(
    string Version,
    ReleaseManifestArtifact Package,
    string MinimumAddonVersion);

public sealed record ReleaseManifestResult(bool Ok, string ErrorCode, VerifiedReleaseManifest Manifest)
{
    public static ReleaseManifestResult Success(VerifiedReleaseManifest manifest) => new(true, null, manifest);

    public static ReleaseManifestResult Failure(string code) => new(false, code, null);
}

/* THE MANIFEST, READ AS UNTRUSTED UNTIL ITS DIGEST MATCHES, AND STRICTLY AFTER.
 *
 * The CRM pins the manifest by SHA-256, so the bytes are hashed before they are
 * parsed at all. A match proves only that they are the bytes the CRM meant, so
 * they are still checked: one schema, the version the directive named, and one
 * package whose address is rebuilt here and has to match exactly.
 *
 * UNKNOWN KEYS ARE REFUSED, at the top and inside each artifact, the way the
 * release schema's additionalProperties: false refuses them. A key this agent
 * does not understand may be a condition it would otherwise ignore, and a
 * release that adds a condition should stop old agents rather than be installed
 * by them. signingThumbprint and minimumAddonVersion are the two optional keys.
 *
 * NOT CHECKED: minimumAgentVersion. In this repository it is the oldest agent
 * the CRM still accepts (the release workflow sets it to the new version), not
 * the oldest agent that may update to it, so it says nothing about this machine. */
public sealed class ReleaseManifestReader
{
    public const int MaximumBytes = 64 * 1024;
    public const long MaximumPackageBytes = 300L * 1024 * 1024;
    public static readonly TimeSpan Timeout = TimeSpan.FromSeconds(30);

    private static readonly Regex Sha256Pattern = new("^[0-9a-fA-F]{64}\\z", RegexOptions.CultureInvariant);

    private static readonly HashSet<string> TopLevelKeys = new(StringComparer.Ordinal)
    {
        "schemaVersion",
        "version",
        "minimumAgentVersion",
        "minimumSchemaVersion",
        "publishedAt",
        "artifacts",
        "signingThumbprint",
        "minimumAddonVersion",
    };

    private static readonly HashSet<string> ArtifactKeys = new(StringComparer.Ordinal)
    {
        "name",
        "url",
        "sha256",
        "size",
    };

    private readonly IUpdateDownloader downloader;

    public ReleaseManifestReader(IUpdateDownloader downloader)
    {
        this.downloader = downloader ?? throw new ArgumentNullException(nameof(downloader));
    }

    /// <param name="version">Already validated as x.y.z by UpdateDirectiveValidator.</param>
    /// <param name="expectedSha256">The digest the CRM pinned.</param>
    public async Task<ReleaseManifestResult> ReadAsync(
        string version,
        string expectedSha256,
        CancellationToken cancellationToken)
    {
        byte[] bytes;
        try
        {
            bytes = await downloader.GetBytesAsync(
                new Uri(UpdateDirectiveValidator.ManifestUrlFor(version), UriKind.Absolute),
                MaximumBytes,
                Timeout,
                cancellationToken).ConfigureAwait(false);
        }
        catch (UpdateDownloadException exception) when (exception.Failure == UpdateDownloadFailure.TooLarge)
        {
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);
        }
        catch (UpdateDownloadException)
        {
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestUnreachable);
        }
        return Validate(bytes, version, expectedSha256);
    }

    /// <summary>Everything after the download. Public so the rules can be tested on bytes.</summary>
    public static ReleaseManifestResult Validate(byte[] bytes, string version, string expectedSha256)
    {
        if (bytes == null || bytes.Length > MaximumBytes)
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);
        if (expectedSha256 == null || !Sha256Pattern.IsMatch(expectedSha256))
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestHashMismatch);
        string actual = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        if (!string.Equals(actual, expectedSha256.ToLowerInvariant(), StringComparison.Ordinal))
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestHashMismatch);

        JObject root = Parse(bytes);
        if (root == null) return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);
        if (root.Properties().Any(property => !TopLevelKeys.Contains(property.Name)))
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);

        if (root["schemaVersion"] is not JValue { Type: JTokenType.Integer, Value: long schemaVersion }
            || schemaVersion != 1)
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);
        if (!string.Equals(StringValue(root["version"]), version, StringComparison.Ordinal))
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);
        if (!OptionalOfType(root, "minimumAgentVersion", JTokenType.String)
            || !OptionalOfType(root, "minimumSchemaVersion", JTokenType.Integer)
            || !OptionalOfType(root, "publishedAt", JTokenType.String)
            || !OptionalOfType(root, "signingThumbprint", JTokenType.String))
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);

        string minimumAddonVersion = null;
        if (root.ContainsKey("minimumAddonVersion"))
        {
            minimumAddonVersion = StringValue(root["minimumAddonVersion"]);
            if (!UpdateVersion.IsTriple(minimumAddonVersion))
                return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);
        }

        if (root["artifacts"] is not JArray artifacts)
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);
        List<JObject> entries = new();
        foreach (JToken artifact in artifacts)
        {
            if (artifact is not JObject entry
                || entry.Properties().Any(property => !ArtifactKeys.Contains(property.Name))
                || StringValue(entry["name"]) == null)
                return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);
            entries.Add(entry);
        }

        JObject[] packages = entries
            .Where(entry => string.Equals(
                StringValue(entry["name"]),
                UpdateDirectiveValidator.PackageArtifactName,
                StringComparison.Ordinal))
            .ToArray();
        if (packages.Length != 1)
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);
        JObject package = packages[0];

        string url = StringValue(package["url"]);
        if (!string.Equals(url, UpdateDirectiveValidator.PackageUrlFor(version), StringComparison.Ordinal))
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);
        string sha256 = StringValue(package["sha256"]);
        if (sha256 == null || !Sha256Pattern.IsMatch(sha256))
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);
        // A number too large for a long arrives as a BigInteger and is refused here.
        if (package["size"] is not JValue { Type: JTokenType.Integer, Value: long size })
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);
        if (size < 1 || size > MaximumPackageBytes)
            return ReleaseManifestResult.Failure(UpdateErrorCodes.ManifestInvalid);

        return ReleaseManifestResult.Success(new VerifiedReleaseManifest(
            version,
            new ReleaseManifestArtifact(UpdateDirectiveValidator.PackageArtifactName, url, sha256.ToLowerInvariant(), size),
            minimumAddonVersion));
    }

    // Strict UTF-8, no date parsing, and a repeated key is an error rather than
    // last-one-wins: two "url" keys are two answers, and this would otherwise
    // check one and some other reader might use the other.
    private static JObject Parse(byte[] bytes)
    {
        try
        {
            string text = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true)
                .GetString(bytes)
                .TrimStart('﻿');
            using JsonTextReader reader = new(new StringReader(text))
            {
                DateParseHandling = DateParseHandling.None,
                FloatParseHandling = FloatParseHandling.Decimal,
            };
            JToken token = JToken.ReadFrom(reader, new JsonLoadSettings
            {
                DuplicatePropertyNameHandling = DuplicatePropertyNameHandling.Error,
                CommentHandling = CommentHandling.Ignore,
            });
            // Nothing may follow the object.
            if (reader.Read()) return null;
            return token as JObject;
        }
        catch (Exception exception) when (exception is JsonException or DecoderFallbackException)
        {
            return null;
        }
    }

    private static string StringValue(JToken token)
        => token is JValue { Type: JTokenType.String } value ? (string)value.Value : null;

    private static bool OptionalOfType(JObject root, string key, JTokenType type)
        => !root.ContainsKey(key) || root[key].Type == type;
}
