using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Updates;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* THE PACKAGE: ENOUGH DISK FIRST, THE RIGHT BYTES, A SAFE EXTRACTION, THE FILES
 * THE INSTALL NEEDS. A failure at any step leaves nothing behind that a later
 * step could pick up as if it had been verified. */
public sealed class UpdatePackageStagerTests : IDisposable
{
    private const string Version = "1.3.1";
    private readonly UpdateTempDirectory temp = new();
    private readonly FakeUpdateDownloader downloader = new();
    private readonly FixedUpdateDisk disk = new();
    private readonly RecordingDirectorySecurity security = new();
    private readonly UpdateLayout layout;
    private readonly UpdatePackageStager stager;

    public UpdatePackageStagerTests()
    {
        layout = new UpdateLayout(Path.Combine(temp.Path, "updates"));
        stager = new UpdatePackageStager(layout, downloader, disk, security);
    }

    public void Dispose() => temp.Dispose();

    [Fact]
    public async Task A_verified_package_is_extracted_where_update_agent_ps1_expects_it()
    {
        byte[] package = UpdateFixtures.Package();
        ReleaseManifestArtifact artifact = Serve(package);

        UpdateStageResult result = await stager.StageAsync(Version, artifact, CancellationToken.None);

        Assert.True(result.Ok, result.ErrorCode);
        Assert.Equal(layout.PackageDirectory(Version), result.PackagePath);
        Assert.True(File.Exists(layout.PackageZip(Version)));
        Assert.True(File.Exists(Path.Combine(result.PackagePath, "install-agent.ps1")));
        Assert.True(File.Exists(Path.Combine(result.PackagePath, "update-agent.ps1")));
        Assert.True(File.Exists(Path.Combine(result.PackagePath, "Agent", "Vincere.AutoExport.Agent.exe")));
        Assert.False(File.Exists(layout.PackageZip(Version) + ".partial"));
        // The folder SYSTEM will run code from is restricted before anything is written.
        Assert.Contains(layout.Root, security.Protected);
    }

    [Fact]
    public async Task Bytes_that_do_not_match_the_manifest_digest_are_refused_and_removed()
    {
        byte[] package = UpdateFixtures.Package();
        ReleaseManifestArtifact artifact = Serve(package) with { Sha256 = new string('0', 64) };

        UpdateStageResult result = await stager.StageAsync(Version, artifact, CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.PackageHashMismatch, result.ErrorCode);
        Assert.False(Directory.Exists(layout.VersionDirectory(Version)));
    }

    [Fact]
    public async Task A_package_shorter_than_the_manifest_says_is_refused()
    {
        byte[] package = UpdateFixtures.Package();
        ReleaseManifestArtifact artifact = Serve(package) with { Size = package.Length + 10 };

        UpdateStageResult result = await stager.StageAsync(Version, artifact, CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.PackageHashMismatch, result.ErrorCode);
        Assert.False(Directory.Exists(layout.VersionDirectory(Version)));
    }

    [Fact]
    public async Task A_package_longer_than_the_manifest_says_is_refused()
    {
        byte[] package = UpdateFixtures.Package();
        ReleaseManifestArtifact artifact = Serve(package) with { Size = package.Length - 1 };

        UpdateStageResult result = await stager.StageAsync(Version, artifact, CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.PackageHashMismatch, result.ErrorCode);
    }

    [Fact]
    public async Task An_unreachable_package_is_package_unreachable()
    {
        ReleaseManifestArtifact artifact = Serve(UpdateFixtures.Package());
        downloader.Failures[artifact.Url] = UpdateDownloadFailure.Unreachable;

        UpdateStageResult result = await stager.StageAsync(Version, artifact, CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.PackageUnreachable, result.ErrorCode);
        Assert.False(Directory.Exists(layout.VersionDirectory(Version)));
    }

    [Fact]
    public async Task Less_than_three_times_the_package_free_is_refused_before_downloading()
    {
        byte[] package = UpdateFixtures.Package();
        ReleaseManifestArtifact artifact = Serve(package);
        disk.FreeBytes = 3L * package.Length - 1;

        UpdateStageResult result = await stager.StageAsync(Version, artifact, CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.DiskSpace, result.ErrorCode);
        Assert.Empty(downloader.Requests);
    }

    [Fact]
    public async Task Exactly_three_times_the_package_free_is_enough_to_download()
    {
        byte[] package = UpdateFixtures.Package();
        ReleaseManifestArtifact artifact = Serve(package);
        disk.FreeBytes = 3L * package.Length;

        await stager.StageAsync(Version, artifact, CancellationToken.None);

        Assert.Single(downloader.Requests);
    }

    [Fact]
    public async Task A_package_that_would_write_outside_its_folder_is_refused()
    {
        byte[] package = UpdateFixtures.Package(("..\\..\\evil.ps1", "evil"));
        ReleaseManifestArtifact artifact = Serve(package);

        UpdateStageResult result = await stager.StageAsync(Version, artifact, CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.PackageInvalid, result.ErrorCode);
        Assert.False(Directory.Exists(layout.VersionDirectory(Version)));
        Assert.False(File.Exists(Path.Combine(temp.Path, "evil.ps1")));
    }

    [Theory]
    [InlineData("install-agent.ps1")]
    [InlineData("update-agent.ps1")]
    [InlineData("Agent/Vincere.AutoExport.Agent.exe")]
    public async Task A_package_missing_a_file_the_install_needs_is_refused(string missing)
    {
        byte[] package = UpdateFixtures.Zip(
            new[]
            {
                ("Agent/Vincere.AutoExport.Agent.exe", "agent"),
                ("install-agent.ps1", "# install"),
                ("update-agent.ps1", "# update"),
            }.Where(entry => entry.Item1 != missing).ToArray());
        ReleaseManifestArtifact artifact = Serve(package);

        UpdateStageResult result = await stager.StageAsync(Version, artifact, CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.PackageInvalid, result.ErrorCode);
    }

    [Fact]
    public async Task Older_version_folders_go_and_the_rollback_and_state_stay()
    {
        Directory.CreateDirectory(layout.VersionDirectory("1.2.9"));
        Directory.CreateDirectory(layout.VersionDirectory("1.3.0"));
        Directory.CreateDirectory(layout.RollbackDirectory);
        File.WriteAllText(Path.Combine(layout.RollbackDirectory, "keep.txt"), "keep");
        File.WriteAllText(layout.StateFile, "{}");
        File.WriteAllText(layout.LastResultFile, "{}");
        Directory.CreateDirectory(Path.Combine(layout.Root, "not-a-version"));

        UpdateStageResult result = await stager.StageAsync(Version, Serve(UpdateFixtures.Package()), CancellationToken.None);

        Assert.True(result.Ok);
        Assert.False(Directory.Exists(layout.VersionDirectory("1.2.9")));
        Assert.False(Directory.Exists(layout.VersionDirectory("1.3.0")));
        Assert.True(Directory.Exists(layout.VersionDirectory(Version)));
        Assert.True(File.Exists(Path.Combine(layout.RollbackDirectory, "keep.txt")));
        Assert.True(File.Exists(layout.StateFile));
        Assert.True(File.Exists(layout.LastResultFile));
        Assert.True(Directory.Exists(Path.Combine(layout.Root, "not-a-version")));
    }

    [Fact]
    public async Task Before_applying_the_zip_is_hashed_again_and_the_folder_rebuilt_from_it()
    {
        byte[] package = UpdateFixtures.Package();
        ReleaseManifestArtifact artifact = Serve(package);
        await stager.StageAsync(Version, artifact, CancellationToken.None);
        // Something removed a file from the extracted folder while it waited.
        File.Delete(Path.Combine(layout.PackageDirectory(Version), "Agent", "Vincere.AutoExport.Agent.exe"));

        UpdateStageResult result = await stager.PrepareForApplyAsync(Version, artifact.Sha256, artifact.Size, CancellationToken.None);

        Assert.True(result.Ok, result.ErrorCode);
        Assert.True(File.Exists(Path.Combine(layout.PackageDirectory(Version), "Agent", "Vincere.AutoExport.Agent.exe")));
    }

    [Fact]
    public async Task A_zip_changed_while_it_waited_is_refused_before_applying()
    {
        byte[] package = UpdateFixtures.Package();
        ReleaseManifestArtifact artifact = Serve(package);
        await stager.StageAsync(Version, artifact, CancellationToken.None);
        byte[] tampered = UpdateFixtures.Package(("Agent/extra.dll", "x"));
        File.WriteAllBytes(layout.PackageZip(Version), tampered);

        UpdateStageResult result = await stager.PrepareForApplyAsync(Version, artifact.Sha256, artifact.Size, CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.PackageHashMismatch, result.ErrorCode);
        Assert.False(Directory.Exists(layout.VersionDirectory(Version)));
    }

    [Fact]
    public async Task A_zip_that_is_gone_before_applying_is_refused()
    {
        UpdateStageResult result = await stager.PrepareForApplyAsync(Version, new string('a', 64), 10, CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.PackageInvalid, result.ErrorCode);
    }

    private ReleaseManifestArtifact Serve(byte[] package)
    {
        string url = UpdateDirectiveValidator.PackageUrlFor(Version);
        downloader.Responses[url] = package;
        return new ReleaseManifestArtifact(
            UpdateDirectiveValidator.PackageArtifactName,
            url,
            UpdateFixtures.Sha256(package),
            package.Length);
    }
}
