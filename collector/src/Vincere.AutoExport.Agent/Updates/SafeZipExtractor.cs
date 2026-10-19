using System;
using System.IO;
using System.IO.Compression;
using System.Linq;

namespace Vincere.AutoExport.Agent.Updates;

public sealed class UnsafeArchiveException : Exception
{
    public UnsafeArchiveException(string message, Exception innerException = null)
        : base(message, innerException)
    {
    }
}

/* EXTRACTION THAT CANNOT WRITE OUTSIDE ITS FOLDER.
 *
 * The package has already matched its digest when this runs, so this is defence
 * in depth rather than the gate: if a release zip ever carried an entry named
 * "..\..\Windows\System32\something", a SYSTEM process extracting it naively
 * would write there. So every entry name is refused unless it is a plain relative
 * path, and the resolved target is checked to sit inside the destination anyway.
 *
 * Separators are normalised first. Windows PowerShell's Compress-Archive writes
 * backslashes into entry names, and a check that only looked for "../" would
 * pass "..\" on a machine where backslash is a separator.
 *
 * Sizes are counted as bytes are written, not as the archive declares them: a
 * header can lie, and the cap is what keeps a hostile archive from filling the
 * disk the trading machine's NinjaTrader database lives on. */
public static class SafeZipExtractor
{
    private static readonly char[] ForbiddenCharacters = { ':', '*', '?', '"', '<', '>', '|' };

    /// <summary>The sum of the sizes the archive declares, for the disk check before extracting.</summary>
    public static long DeclaredSize(string zipPath)
    {
        try
        {
            using ZipArchive archive = ZipFile.OpenRead(zipPath);
            return archive.Entries.Sum(entry => entry.Length);
        }
        catch (InvalidDataException exception)
        {
            throw new UnsafeArchiveException("The archive is not a readable zip.", exception);
        }
    }

    public static void Extract(string zipPath, string destination, long maximumTotalBytes, int maximumEntries)
    {
        if (maximumTotalBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maximumTotalBytes));
        if (maximumEntries <= 0) throw new ArgumentOutOfRangeException(nameof(maximumEntries));
        string root = Path.GetFullPath(destination);
        string rootPrefix = root.EndsWith(Path.DirectorySeparatorChar) ? root : root + Path.DirectorySeparatorChar;
        StringComparison comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;

        ZipArchive archive;
        try
        {
            archive = ZipFile.OpenRead(zipPath);
        }
        catch (InvalidDataException exception)
        {
            throw new UnsafeArchiveException("The archive is not a readable zip.", exception);
        }

        using (archive)
        {
            if (archive.Entries.Count > maximumEntries)
                throw new UnsafeArchiveException("The archive has too many entries.");
            Directory.CreateDirectory(root);
            long total = 0;
            byte[] buffer = new byte[81920];
            foreach (ZipArchiveEntry entry in archive.Entries)
            {
                string relative = RelativePath(entry.FullName, out bool isDirectory);
                string target = Path.GetFullPath(Path.Combine(root, relative));
                if (!target.StartsWith(rootPrefix, comparison))
                    throw new UnsafeArchiveException("An archive entry resolves outside the destination.");

                if (isDirectory)
                {
                    Directory.CreateDirectory(target);
                    continue;
                }

                // A second entry with the same name is refused rather than allowed
                // to replace the first; CreateNew below holds the same line.
                if (File.Exists(target) || Directory.Exists(target))
                    throw new UnsafeArchiveException("The archive names the same file twice.");
                Directory.CreateDirectory(Path.GetDirectoryName(target));
                try
                {
                    using Stream input = entry.Open();
                    using FileStream output = new(target, FileMode.CreateNew, FileAccess.Write, FileShare.None);
                    long written = 0;
                    int read;
                    while ((read = input.Read(buffer, 0, buffer.Length)) > 0)
                    {
                        written += read;
                        total += read;
                        if (written > entry.Length || total > maximumTotalBytes)
                            throw new UnsafeArchiveException("The archive expands beyond its limit.");
                        output.Write(buffer, 0, read);
                    }
                }
                catch (InvalidDataException exception)
                {
                    throw new UnsafeArchiveException("An archive entry is corrupt.", exception);
                }
            }
        }
    }

    /* A plain relative path or nothing. Refused: empty names, absolute paths
     * ("/x", "\x", "\\server\share"), anything with a drive or a stream (":"),
     * any "." or ".." segment, empty segments ("a//b"), segments Windows would
     * silently trim (trailing dot or space), and characters Windows forbids. */
    private static string RelativePath(string fullName, out bool isDirectory)
    {
        if (string.IsNullOrEmpty(fullName))
            throw new UnsafeArchiveException("An archive entry has no name.");
        string normalized = fullName.Replace('\\', '/');
        isDirectory = normalized.EndsWith('/');
        if (isDirectory) normalized = normalized[..^1];
        if (normalized.Length == 0 || normalized.StartsWith('/'))
            throw new UnsafeArchiveException("An archive entry has an absolute name.");
        if (normalized.Any(character => character < 0x20 || ForbiddenCharacters.Contains(character)))
            throw new UnsafeArchiveException("An archive entry name has a forbidden character.");
        string[] segments = normalized.Split('/');
        foreach (string segment in segments)
        {
            if (segment.Length == 0
                || segment == "."
                || segment == ".."
                || segment.EndsWith('.')
                || segment.EndsWith(' '))
                throw new UnsafeArchiveException("An archive entry name is not a plain relative path.");
        }
        return Path.Combine(segments);
    }
}
