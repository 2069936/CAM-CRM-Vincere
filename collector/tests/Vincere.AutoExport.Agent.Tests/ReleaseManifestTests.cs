using System;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.Updates;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* THE RELEASE MANIFEST: HASHED BEFORE IT IS READ, AND READ STRICTLY AFTER.
 *
 * Shaped like the real agent-v1.2.2/release-manifest.json. The CRM pins its
 * digest; the manifest pins the package's. Everything a manifest could use to
 * point this machine somewhere else is checked against an address built here. */
public sealed class ReleaseManifestTests
{
    private const string Version = "1.3.1";
    private static readonly byte[] Package = UpdateFixtures.Package();

    [Fact]
    public void A_manifest_like_the_real_one_is_accepted()
    {
        (byte[] bytes, string sha) = Serialize(UpdateFixtures.Manifest(Version, Package));

        ReleaseManifestResult result = ReleaseManifestReader.Validate(bytes, Version, sha);

        Assert.True(result.Ok, result.ErrorCode);
        Assert.Equal(Version, result.Manifest.Version);
        Assert.Equal(UpdateDirectiveValidator.PackageUrlFor(Version), result.Manifest.Package.Url);
        Assert.Equal(UpdateFixtures.Sha256(Package), result.Manifest.Package.Sha256);
        Assert.Equal(Package.LongLength, result.Manifest.Package.Size);
        Assert.Null(result.Manifest.MinimumAddonVersion);
    }

    [Fact]
    public void The_real_1_2_2_manifest_text_is_accepted()
    {
        // Byte for byte the shape of the published file, with its own numbers.
        string text = """
            {
              "schemaVersion": 1,
              "version": "1.2.2",
              "minimumAgentVersion": "1.2.0",
              "minimumSchemaVersion": 1,
              "publishedAt": "2026-10-13T11:40:42.000Z",
              "artifacts": [
                {
                  "name": "Vincere-AutoExport-Agent.zip",
                  "url": "https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.2.2/Vincere-AutoExport-Agent.zip",
                  "sha256": "2d3355a8aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaed32",
                  "size": 110635838
                }
              ]
            }
            """;
        byte[] bytes = Encoding.UTF8.GetBytes(text);

        ReleaseManifestResult result = ReleaseManifestReader.Validate(bytes, "1.2.2", UpdateFixtures.Sha256(bytes));

        Assert.True(result.Ok, result.ErrorCode);
        Assert.Equal(110635838, result.Manifest.Package.Size);
    }

    [Fact]
    public void Bytes_that_do_not_match_the_pinned_digest_are_refused_before_they_are_parsed()
    {
        (byte[] bytes, _) = Serialize(UpdateFixtures.Manifest(Version, Package));

        ReleaseManifestResult result = ReleaseManifestReader.Validate(bytes, Version, new string('a', 64));

        Assert.False(result.Ok);
        Assert.Equal(UpdateErrorCodes.ManifestHashMismatch, result.ErrorCode);
    }

    [Fact]
    public void A_manifest_for_another_version_is_refused()
    {
        (byte[] bytes, string sha) = Serialize(UpdateFixtures.Manifest("1.3.2", Package));

        Assert.Equal(UpdateErrorCodes.ManifestInvalid, ReleaseManifestReader.Validate(bytes, Version, sha).ErrorCode);
    }

    [Theory]
    [InlineData("https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.3.2/Vincere-AutoExport-Agent.zip")]
    [InlineData("https://objects.githubusercontent.com/agent-v1.3.1/Vincere-AutoExport-Agent.zip")]
    [InlineData("http://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.3.1/Vincere-AutoExport-Agent.zip")]
    [InlineData("https://github.com/someone/CAM-CRM-Vincere/releases/download/agent-v1.3.1/Vincere-AutoExport-Agent.zip")]
    public void A_package_address_other_than_this_release_is_refused(string url)
    {
        JObject manifest = UpdateFixtures.Manifest(Version, Package);
        manifest["artifacts"][0]["url"] = url;
        (byte[] bytes, string sha) = Serialize(manifest);

        Assert.Equal(UpdateErrorCodes.ManifestInvalid, ReleaseManifestReader.Validate(bytes, Version, sha).ErrorCode);
    }

    [Fact]
    public void A_manifest_without_the_agent_package_is_refused()
    {
        JObject manifest = UpdateFixtures.Manifest(Version, Package);
        manifest["artifacts"][0]["name"] = "Vincere-AutoExport-Setup.exe";
        (byte[] bytes, string sha) = Serialize(manifest);

        Assert.Equal(UpdateErrorCodes.ManifestInvalid, ReleaseManifestReader.Validate(bytes, Version, sha).ErrorCode);
    }

    [Fact]
    public void Two_packages_of_the_same_name_are_two_answers_and_refused()
    {
        JObject manifest = UpdateFixtures.Manifest(Version, Package);
        ((JArray)manifest["artifacts"]).Add(manifest["artifacts"][0].DeepClone());
        (byte[] bytes, string sha) = Serialize(manifest);

        Assert.Equal(UpdateErrorCodes.ManifestInvalid, ReleaseManifestReader.Validate(bytes, Version, sha).ErrorCode);
    }

    [Fact]
    public void Other_artifacts_beside_the_package_are_ignored()
    {
        JObject manifest = UpdateFixtures.Manifest(Version, Package);
        ((JArray)manifest["artifacts"]).Insert(0, new JObject
        {
            ["name"] = "Vincere.AutoExport.Machine.msi",
            ["url"] = "https://example.test/Vincere.AutoExport.Machine.msi",
            ["sha256"] = new string('b', 64),
            ["size"] = 1234,
        });
        (byte[] bytes, string sha) = Serialize(manifest);

        Assert.True(ReleaseManifestReader.Validate(bytes, Version, sha).Ok);
    }

    [Theory]
    [InlineData(0L)]
    [InlineData(-1L)]
    [InlineData(300L * 1024 * 1024 + 1)]
    [InlineData(5_000_000_000L)]
    public void A_package_size_outside_1_byte_to_300_MB_is_refused(long size)
    {
        JObject manifest = UpdateFixtures.Manifest(Version, Package);
        manifest["artifacts"][0]["size"] = size;
        (byte[] bytes, string sha) = Serialize(manifest);

        Assert.Equal(UpdateErrorCodes.ManifestInvalid, ReleaseManifestReader.Validate(bytes, Version, sha).ErrorCode);
    }

    [Fact]
    public void Exactly_300_MB_is_allowed()
    {
        JObject manifest = UpdateFixtures.Manifest(Version, Package);
        manifest["artifacts"][0]["size"] = 300L * 1024 * 1024;
        (byte[] bytes, string sha) = Serialize(manifest);

        Assert.True(ReleaseManifestReader.Validate(bytes, Version, sha).Ok);
    }

    [Theory]
    [InlineData("not-a-digest")]
    [InlineData("2d3355a8")]
    public void A_package_digest_that_is_not_64_hex_is_refused(string digest)
    {
        JObject manifest = UpdateFixtures.Manifest(Version, Package);
        manifest["artifacts"][0]["sha256"] = digest;
        (byte[] bytes, string sha) = Serialize(manifest);

        Assert.Equal(UpdateErrorCodes.ManifestInvalid, ReleaseManifestReader.Validate(bytes, Version, sha).ErrorCode);
    }

    [Fact]
    public void Only_schema_version_1_is_read()
    {
        JObject manifest = UpdateFixtures.Manifest(Version, Package);
        manifest["schemaVersion"] = 2;
        (byte[] bytes, string sha) = Serialize(manifest);

        Assert.Equal(UpdateErrorCodes.ManifestInvalid, ReleaseManifestReader.Validate(bytes, Version, sha).ErrorCode);
    }

    [Fact]
    public void An_unknown_top_level_key_is_refused()
    {
        JObject manifest = UpdateFixtures.Manifest(Version, Package);
        manifest["installAddOn"] = true;
        (byte[] bytes, string sha) = Serialize(manifest);

        Assert.Equal(UpdateErrorCodes.ManifestInvalid, ReleaseManifestReader.Validate(bytes, Version, sha).ErrorCode);
    }

    [Fact]
    public void An_unknown_key_inside_an_artifact_is_refused()
    {
        JObject manifest = UpdateFixtures.Manifest(Version, Package);
        manifest["artifacts"][0]["mirror"] = "https://example.test/x.zip";
        (byte[] bytes, string sha) = Serialize(manifest);

        Assert.Equal(UpdateErrorCodes.ManifestInvalid, ReleaseManifestReader.Validate(bytes, Version, sha).ErrorCode);
    }

    [Fact]
    public void The_optional_signing_thumbprint_is_accepted()
    {
        JObject manifest = UpdateFixtures.Manifest(Version, Package);
        manifest["signingThumbprint"] = new string('A', 40);
        (byte[] bytes, string sha) = Serialize(manifest);

        Assert.True(ReleaseManifestReader.Validate(bytes, Version, sha).Ok);
    }

    [Fact]
    public void The_optional_minimum_addon_version_is_accepted_and_carried()
    {
        (byte[] bytes, string sha) = Serialize(UpdateFixtures.Manifest(Version, Package, minimumAddonVersion: "1.3.0"));

        ReleaseManifestResult result = ReleaseManifestReader.Validate(bytes, Version, sha);

        Assert.True(result.Ok, result.ErrorCode);
        Assert.Equal("1.3.0", result.Manifest.MinimumAddonVersion);
    }

    [Theory]
    [InlineData("1.3")]
    [InlineData("1.3.0.0")]
    [InlineData("latest")]
    [InlineData("")]
    public void A_minimum_addon_version_that_is_not_x_y_z_is_refused(string value)
    {
        (byte[] bytes, string sha) = Serialize(UpdateFixtures.Manifest(Version, Package, minimumAddonVersion: value));

        Assert.Equal(UpdateErrorCodes.ManifestInvalid, ReleaseManifestReader.Validate(bytes, Version, sha).ErrorCode);
    }

    [Fact]
    public void A_minimum_addon_version_that_is_not_a_string_is_refused()
    {
        JObject manifest = UpdateFixtures.Manifest(Version, Package);
        manifest["minimumAddonVersion"] = 130;
        (byte[] bytes, string sha) = Serialize(manifest);

        Assert.Equal(UpdateErrorCodes.ManifestInvalid, ReleaseManifestReader.Validate(bytes, Version, sha).ErrorCode);
    }

    [Fact]
    public void A_repeated_key_is_refused_rather_than_read_last_wins()
    {
        string text = UpdateFixtures.Manifest(Version, Package).ToString()
            .Replace("\"schemaVersion\": 1,", "\"schemaVersion\": 1, \"version\": \"9.9.9\",");
        byte[] bytes = Encoding.UTF8.GetBytes(text);

        Assert.Equal(
            UpdateErrorCodes.ManifestInvalid,
            ReleaseManifestReader.Validate(bytes, Version, UpdateFixtures.Sha256(bytes)).ErrorCode);
    }

    [Theory]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("{}")]
    [InlineData("{\"schemaVersion\":1} trailing")]
    public void Text_that_is_not_a_manifest_is_refused(string text)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(text);

        Assert.Equal(
            UpdateErrorCodes.ManifestInvalid,
            ReleaseManifestReader.Validate(bytes, Version, UpdateFixtures.Sha256(bytes)).ErrorCode);
    }

    [Fact]
    public async Task The_reader_asks_for_the_manifest_of_this_release_and_nothing_else()
    {
        (byte[] bytes, string sha) = Serialize(UpdateFixtures.Manifest(Version, Package));
        FakeUpdateDownloader downloader = new();
        downloader.Responses[UpdateDirectiveValidator.ManifestUrlFor(Version)] = bytes;

        ReleaseManifestResult result = await new ReleaseManifestReader(downloader).ReadAsync(Version, sha, CancellationToken.None);

        Assert.True(result.Ok);
        Assert.Equal(new[] { UpdateDirectiveValidator.ManifestUrlFor(Version) }, downloader.Requests);
    }

    [Fact]
    public async Task An_unreachable_manifest_is_manifest_unreachable()
    {
        FakeUpdateDownloader downloader = new();

        ReleaseManifestResult result = await new ReleaseManifestReader(downloader)
            .ReadAsync(Version, new string('a', 64), CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.ManifestUnreachable, result.ErrorCode);
    }

    [Fact]
    public async Task A_manifest_over_64_KB_is_refused()
    {
        FakeUpdateDownloader downloader = new();
        downloader.Responses[UpdateDirectiveValidator.ManifestUrlFor(Version)] = new byte[64 * 1024 + 1];

        ReleaseManifestResult result = await new ReleaseManifestReader(downloader)
            .ReadAsync(Version, new string('a', 64), CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.ManifestInvalid, result.ErrorCode);
    }

    private static (byte[] Bytes, string Sha) Serialize(JObject manifest)
    {
        byte[] bytes = UpdateFixtures.Bytes(manifest);
        return (bytes, UpdateFixtures.Sha256(bytes));
    }
}
