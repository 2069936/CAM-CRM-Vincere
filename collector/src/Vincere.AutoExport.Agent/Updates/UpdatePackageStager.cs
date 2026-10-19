using System;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Security;

namespace Vincere.AutoExport.Agent.Updates;

/// <param name="PackagePath">The extracted package folder, when Ok.</param>
public sealed record UpdateStageResult(bool Ok, string ErrorCode, string PackagePath)
{
    public static UpdateStageResult Success(string packagePath) => new(true, null, packagePath);

    public static UpdateStageResult Failure(string code) => new(false, code, null);
}

/* DOWNLOAD, VERIFY, EXTRACT, AND CHECK THE PACKAGE IS ONE THIS AGENT CAN INSTALL.
 *
 * Nothing here touches the running install. Everything is written under
 * updates\{version}, and a failure at any step deletes that folder, so a machine
 * whose update failed holds no half-verified files that a later step could pick
 * up by mistake.
 *
 * THE DISK IS THE TRADING MACHINE'S DISK. NinjaTrader keeps its database on it,
 * and a full disk mid-session is a much worse outcome than an agent that stays
 * one version behind. So the download is refused unless three times the package
 * fits, and extraction is refused unless twice what it expands to fits (the
 * extraction itself, and update-agent.ps1's backup of the install root, which is
 * about the same size). */
public sealed class UpdatePackageStager
{
    public const long DiskMultiplier = 3;
    public const long MaximumExtractedBytes = 1536L * 1024 * 1024;
    public const int MaximumEntries = 20000;
    public static readonly TimeSpan DownloadTimeout = TimeSpan.FromMinutes(30);

    private static readonly string[] RequiredFiles =
    {
        "install-agent.ps1",
        "update-agent.ps1",
        Path.Combine("Agent", "Vincere.AutoExport.Agent.exe"),
    };

    private readonly UpdateLayout layout;
    private readonly IUpdateDownloader downloader;
    private readonly IUpdateDisk disk;
    private readonly IAgentDirectorySecurity directorySecurity;

    public UpdatePackageStager(
        UpdateLayout layout,
        IUpdateDownloader downloader,
        IUpdateDisk disk,
        IAgentDirectorySecurity directorySecurity)
    {
        this.layout = layout ?? throw new ArgumentNullException(nameof(layout));
        this.downloader = downloader ?? throw new ArgumentNullException(nameof(downloader));
        this.disk = disk ?? throw new ArgumentNullException(nameof(disk));
        this.directorySecurity = directorySecurity ?? throw new ArgumentNullException(nameof(directorySecurity));
    }

    /// <summary>The updates folder, created and restricted to SYSTEM and Administrators.</summary>
    public void EnsureRoot()
    {
        directorySecurity.EnsureProtected(layout.Root);
    }

    public async Task<UpdateStageResult> StageAsync(
        string version,
        ReleaseManifestArtifact package,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(package);
        string versionDirectory = layout.VersionDirectory(version);
        try
        {
            EnsureRoot();
            CleanOtherVersions(version);

            long free = disk.GetAvailableFreeBytes(layout.Root);
            if (free / DiskMultiplier < package.Size)
                return UpdateStageResult.Failure(UpdateErrorCodes.DiskSpace);

            DeleteDirectory(versionDirectory);
            Directory.CreateDirectory(versionDirectory);
            string zip = layout.PackageZip(version);
            string partial = zip + ".partial";

            string downloadFailure = await DownloadAsync(package, partial, cancellationToken).ConfigureAwait(false);
            if (downloadFailure != null)
            {
                DeleteDirectory(versionDirectory);
                return UpdateStageResult.Failure(downloadFailure);
            }
            File.Move(partial, zip, overwrite: true);

            UpdateStageResult extracted = Extract(version);
            if (!extracted.Ok) DeleteDirectory(versionDirectory);
            return extracted;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            TryDeleteDirectory(versionDirectory);
            return UpdateStageResult.Failure(IsDiskFull(exception) ? UpdateErrorCodes.DiskSpace : UpdateErrorCodes.StagingFailed);
        }
    }

    /* RIGHT BEFORE THE TASK IS HANDED THE FOLDER: the zip is hashed again and the
     * folder is extracted again from it, so what SYSTEM runs is exactly the bytes
     * that matched the manifest, whatever happened to the folder in the hours a
     * staged update can wait for the trading window to close (an antivirus
     * quarantining one DLL is the realistic case). */
    public Task<UpdateStageResult> PrepareForApplyAsync(
        string version,
        string sha256,
        long size,
        CancellationToken cancellationToken)
    {
        string versionDirectory = layout.VersionDirectory(version);
        try
        {
            cancellationToken.ThrowIfCancellationRequested();
            string zip = layout.PackageZip(version);
            if (!File.Exists(zip) || string.IsNullOrEmpty(sha256))
            {
                DeleteDirectory(versionDirectory);
                return Task.FromResult(UpdateStageResult.Failure(UpdateErrorCodes.PackageInvalid));
            }
            if (!HashMatches(zip, sha256, size))
            {
                DeleteDirectory(versionDirectory);
                return Task.FromResult(UpdateStageResult.Failure(UpdateErrorCodes.PackageHashMismatch));
            }
            UpdateStageResult extracted = Extract(version);
            if (!extracted.Ok) DeleteDirectory(versionDirectory);
            return Task.FromResult(extracted);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            TryDeleteDirectory(versionDirectory);
            return Task.FromResult(UpdateStageResult.Failure(
                IsDiskFull(exception) ? UpdateErrorCodes.DiskSpace : UpdateErrorCodes.StagingFailed));
        }
    }

    /// <summary>True when the zip for <paramref name="version"/> is on disk.</summary>
    public bool HasPackage(string version) => File.Exists(layout.PackageZip(version));

    /* Folders of OTHER versions only, named exactly like a version; every one of
     * them when keepVersion is null. The rollback folder, state.json and
     * last-result.json are never names a version can have, and nothing else in
     * this folder is touched. A folder that cannot be deleted is left for next time. */
    public void CleanOtherVersions(string keepVersion)
    {
        if (!Directory.Exists(layout.Root)) return;
        foreach (string directory in Directory.EnumerateDirectories(layout.Root))
        {
            string name = Path.GetFileName(directory);
            if (!UpdateVersion.IsTriple(name)) continue;
            if (string.Equals(name, keepVersion, StringComparison.Ordinal)) continue;
            TryDeleteDirectory(directory);
        }
    }

    private async Task<string> DownloadAsync(
        ReleaseManifestArtifact package,
        string destination,
        CancellationToken cancellationToken)
    {
        long written;
        string actual;
        using (FileStream file = new(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        using (HashingWriteStream hashing = new(file))
        {
            try
            {
                written = await downloader.CopyToAsync(
                    new Uri(package.Url, UriKind.Absolute),
                    hashing,
                    package.Size,
                    DownloadTimeout,
                    cancellationToken).ConfigureAwait(false);
            }
            // More bytes than the manifest promised: not the file it described.
            catch (UpdateDownloadException exception) when (exception.Failure == UpdateDownloadFailure.TooLarge)
            {
                return UpdateErrorCodes.PackageHashMismatch;
            }
            catch (UpdateDownloadException)
            {
                return UpdateErrorCodes.PackageUnreachable;
            }
            await file.FlushAsync(cancellationToken).ConfigureAwait(false);
            actual = hashing.HexDigest();
        }
        if (written != package.Size || !string.Equals(actual, package.Sha256, StringComparison.Ordinal))
            return UpdateErrorCodes.PackageHashMismatch;
        return null;
    }

    private UpdateStageResult Extract(string version)
    {
        string zip = layout.PackageZip(version);
        string packageDirectory = layout.PackageDirectory(version);
        DeleteDirectory(packageDirectory);
        long declared;
        try
        {
            declared = SafeZipExtractor.DeclaredSize(zip);
        }
        catch (UnsafeArchiveException)
        {
            return UpdateStageResult.Failure(UpdateErrorCodes.PackageInvalid);
        }
        if (declared > MaximumExtractedBytes)
            return UpdateStageResult.Failure(UpdateErrorCodes.PackageInvalid);
        if (disk.GetAvailableFreeBytes(layout.Root) / 2 < declared)
            return UpdateStageResult.Failure(UpdateErrorCodes.DiskSpace);
        try
        {
            SafeZipExtractor.Extract(zip, packageDirectory, MaximumExtractedBytes, MaximumEntries);
        }
        catch (UnsafeArchiveException)
        {
            DeleteDirectory(packageDirectory);
            return UpdateStageResult.Failure(UpdateErrorCodes.PackageInvalid);
        }
        foreach (string required in RequiredFiles)
        {
            if (!File.Exists(Path.Combine(packageDirectory, required)))
            {
                DeleteDirectory(packageDirectory);
                return UpdateStageResult.Failure(UpdateErrorCodes.PackageInvalid);
            }
        }
        return UpdateStageResult.Success(packageDirectory);
    }

    private static bool HashMatches(string path, string sha256, long size)
    {
        using FileStream file = new(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        if (file.Length != size) return false;
        string actual = Convert.ToHexString(SHA256.HashData(file)).ToLowerInvariant();
        return string.Equals(actual, sha256, StringComparison.OrdinalIgnoreCase);
    }

    private static void DeleteDirectory(string path)
    {
        if (Directory.Exists(path)) Directory.Delete(path, recursive: true);
    }

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            DeleteDirectory(path);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
        }
    }

    // ERROR_DISK_FULL and ERROR_HANDLE_DISK_FULL on Windows, ENOSPC elsewhere.
    private static bool IsDiskFull(Exception exception)
    {
        int code = exception.HResult & 0xFFFF;
        return code is 0x70 or 0x27 || exception.HResult == 28;
    }

    /// <summary>Hashes what passes through on its way to the file, so the package is read once.</summary>
    private sealed class HashingWriteStream : Stream
    {
        private readonly Stream inner;
        private readonly IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);

        public HashingWriteStream(Stream inner) => this.inner = inner;

        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => throw new NotSupportedException();
        public override long Position
        {
            get => throw new NotSupportedException();
            set => throw new NotSupportedException();
        }

        public string HexDigest() => Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();

        public override void Write(byte[] buffer, int offset, int count)
        {
            hash.AppendData(buffer, offset, count);
            inner.Write(buffer, offset, count);
        }

        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            hash.AppendData(buffer.Span);
            await inner.WriteAsync(buffer, cancellationToken).ConfigureAwait(false);
        }

        public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
            => WriteAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();

        public override void Flush() => inner.Flush();
        public override Task FlushAsync(CancellationToken cancellationToken) => inner.FlushAsync(cancellationToken);
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing) hash.Dispose();
            base.Dispose(disposing);
        }
    }
}
