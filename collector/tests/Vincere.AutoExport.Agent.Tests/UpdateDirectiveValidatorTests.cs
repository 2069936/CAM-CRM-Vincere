using System;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Updates;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* WHAT A DIRECTIVE FROM THE CRM MAY ASK FOR.
 *
 * The CRM names a version and a moment. The address of what gets installed is
 * not the CRM's to choose: it is rebuilt from the version under one repository's
 * releases and must match exactly, so a compromised CRM can at most ask for a
 * release this repository published. And never an older one. */
public sealed class UpdateDirectiveValidatorTests
{
    private const string Running = "1.3.0";
    private const string Sha = "43dacd04aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa282c";

    [Fact]
    public void A_newer_release_of_this_repository_is_accepted()
    {
        UpdateDirectiveValidation result = UpdateDirectiveValidator.Validate(Directive("1.3.1"), Running);

        Assert.True(result.IsValid);
        Assert.Null(result.ErrorCode);
        Assert.Equal("1.3.1", result.Version);
        Assert.Equal(Sha, result.ManifestSha256);
        Assert.Equal("2026-10-19T14:00:00.000Z", result.RequestedAt);
    }

    [Fact]
    public void The_manifest_address_is_the_one_the_spec_names()
    {
        Assert.Equal(
            "https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.3.1/release-manifest.json",
            UpdateDirectiveValidator.ManifestUrlFor("1.3.1"));
        Assert.Equal(
            "https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.3.1/Vincere-AutoExport-Agent.zip",
            UpdateDirectiveValidator.PackageUrlFor("1.3.1"));
    }

    [Fact]
    public void An_upper_case_digest_is_accepted_and_kept_in_lower_case()
    {
        UpdateDirectiveValidation result = UpdateDirectiveValidator.Validate(
            Directive("1.3.1") with { ManifestSha256 = Sha.ToUpperInvariant() },
            Running);

        Assert.True(result.IsValid);
        Assert.Equal(Sha, result.ManifestSha256);
    }

    [Theory]
    [InlineData("1.3.0")] // the running version
    [InlineData("1.2.9")] // a downgrade
    [InlineData("0.9.0")]
    public void A_version_that_is_not_strictly_newer_is_refused(string version)
    {
        UpdateDirectiveValidation result = UpdateDirectiveValidator.Validate(Directive(version), Running);

        Assert.False(result.IsValid);
        Assert.Equal(UpdateErrorCodes.VersionNotNewer, result.ErrorCode);
    }

    [Fact]
    public void Newer_is_numeric_not_textual()
    {
        // 1.10.0 is newer than 1.9.0 although it sorts before it as text.
        Assert.True(UpdateDirectiveValidator.Validate(Directive("1.10.0"), "1.9.0").IsValid);
        Assert.Equal(
            UpdateErrorCodes.VersionNotNewer,
            UpdateDirectiveValidator.Validate(Directive("1.9.0"), "1.10.0").ErrorCode);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("1.3")]
    [InlineData("1.3.1.0")]
    [InlineData("v1.3.1")]
    [InlineData("01.3.1")]
    [InlineData("1.3.1 ")]
    [InlineData("1.3.1-beta")]
    [InlineData("1.3.1\n")]
    [InlineData("../1.3.1")]
    public void A_version_that_is_not_x_y_z_is_refused(string version)
    {
        UpdateDirectiveValidation result = UpdateDirectiveValidator.Validate(
            new AgentUpdateDirective(
                version,
                "https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v" + version + "/release-manifest.json",
                Sha,
                "2026-10-19T14:00:00.000Z"),
            Running);

        Assert.False(result.IsValid);
        Assert.Equal(UpdateErrorCodes.DirectiveInvalid, result.ErrorCode);
        Assert.Null(result.Version);
    }

    [Theory]
    [InlineData("https://github.com/someone-else/CAM-CRM-Vincere/releases/download/agent-v1.3.1/release-manifest.json")]
    [InlineData("https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.3.2/release-manifest.json")]
    [InlineData("http://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.3.1/release-manifest.json")]
    [InlineData("https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.3.1/release-manifest.json?x=1")]
    [InlineData("https://GITHUB.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.3.1/release-manifest.json")]
    [InlineData("https://github.com/2069936/CAM-CRM-Vincere/releases/download/agent-v1.3.1/../agent-v1.3.1/release-manifest.json")]
    [InlineData("https://evil.example/2069936/CAM-CRM-Vincere/releases/download/agent-v1.3.1/release-manifest.json")]
    [InlineData("")]
    [InlineData(null)]
    public void Any_manifest_address_but_the_exact_one_is_refused(string url)
    {
        UpdateDirectiveValidation result = UpdateDirectiveValidator.Validate(
            Directive("1.3.1") with { ManifestUrl = url },
            Running);

        Assert.False(result.IsValid);
        Assert.Equal(UpdateErrorCodes.UrlNotAllowed, result.ErrorCode);
        Assert.Equal("1.3.1", result.Version);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("43dacd04")]
    [InlineData("43dacd04aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa282")]
    [InlineData("43dacd04aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa282cc")]
    [InlineData("43dacd04aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa282g")]
    [InlineData("43dacd04aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa282c\n")]
    public void A_digest_that_is_not_64_hex_is_refused(string sha)
    {
        UpdateDirectiveValidation result = UpdateDirectiveValidator.Validate(
            Directive("1.3.1") with { ManifestSha256 = sha },
            Running);

        Assert.False(result.IsValid);
        Assert.Equal(UpdateErrorCodes.DirectiveInvalid, result.ErrorCode);
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("yesterday")]
    public void A_request_without_a_readable_time_is_refused(string requestedAt)
    {
        UpdateDirectiveValidation result = UpdateDirectiveValidator.Validate(
            Directive("1.3.1") with { RequestedAt = requestedAt },
            Running);

        Assert.False(result.IsValid);
        Assert.Equal(UpdateErrorCodes.DirectiveInvalid, result.ErrorCode);
    }

    [Fact]
    public void No_directive_is_an_invalid_directive()
    {
        Assert.Equal(UpdateErrorCodes.DirectiveInvalid, UpdateDirectiveValidator.Validate(null, Running).ErrorCode);
    }

    [Fact]
    public void A_running_version_that_cannot_be_read_never_updates()
    {
        Assert.Equal(
            UpdateErrorCodes.VersionNotNewer,
            UpdateDirectiveValidator.Validate(Directive("9.9.9"), "unknown").ErrorCode);
    }

    private static AgentUpdateDirective Directive(string version) => new(
        version,
        UpdateDirectiveValidator.ManifestUrlFor(version),
        Sha,
        "2026-10-19T14:00:00.000Z");
}
