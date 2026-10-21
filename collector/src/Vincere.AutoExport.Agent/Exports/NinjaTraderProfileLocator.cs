using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Vincere.AutoExport.Agent.UI.DeepExport;

namespace Vincere.AutoExport.Agent.Exports;

/// <summary>The NinjaTrader 8 folder, or the code that says why there is not exactly one.</summary>
public sealed record NinjaTraderFolderLookup(string Folder, string ErrorCode)
{
    public bool Found => Folder != null;

    public static NinjaTraderFolderLookup At(string folder) => new(folder, null);

    public static NinjaTraderFolderLookup Refused(string code) => new(null, code);
}

public interface INinjaTraderFolderLocator
{
    NinjaTraderFolderLookup Locate();
}

/* ---------------------------------------------------------------------------
 * WHERE NINJATRADER KEEPS ITS FILES, ASKED BY A SERVICE THAT IS NOT ITS USER.
 *
 * The service runs as LocalSystem. Every lookup the Setup window and the Deep
 * Export use - NinjaTraderFolder.Candidates, which asks the shell for "my
 * Documents" and reads USERPROFILE - answers for the account that asks, and for
 * SYSTEM that is C:\Windows\system32\config\systemprofile, where no NinjaTrader
 * lives. Nothing else tells the service the folder either: install-agent.ps1's
 * -NinjaTraderDocumentsPath and the bundle's NINJATRADERDOCUMENTS are used to
 * deploy the AddOn and are not written anywhere the service reads, and the
 * AddOn does not report it.
 *
 * SO THIS IS THE ONE LOOKUP THE REPOSITORY ALREADY HAS THAT DOES NOT DEPEND ON
 * WHO ASKS: the installer's own, Get-NinjaTraderProfileCandidates and
 * Resolve-NinjaTraderDocuments in Installer/CustomActions/DetectNinjaTrader.ps1,
 * with its Pester tests. Same profile root (%SystemDrive%\Users), same excluded
 * profiles, same two Documents locations per profile (Documents and
 * OneDrive\Documents), and the same refusal to pick when the answer is not
 * unique - the installer says "More than one NinjaTrader profile was found"
 * and so does this, as ninjatrader_folder_ambiguous.
 *
 * ONE REFINEMENT, FROM THE C# LOOKUP BESIDE IT. NinjaTraderFolder.Resolve
 * prefers "the candidate that actually holds the database over one that is
 * merely a folder with the right name". So the count that has to be one is the
 * count of profiles whose NinjaTrader 8 folder holds db\NinjaTrader.sqlite: an
 * administrator profile with an empty NinjaTrader 8 folder from opening the
 * platform once does not make a trading machine ambiguous. Two databases still
 * do, and the answer is then a refusal, never the first one found.
 *
 * WHAT IT CANNOT FIND, SAID PLAINLY: a Documents folder moved anywhere other
 * than those two places (another drive, a OneDrive folder with a business
 * name). That machine answers ninjatrader_folder_not_found, which is the honest
 * answer - the alternative is a guess at a path.
 * ------------------------------------------------------------------------- */
public sealed class ProfileNinjaTraderFolderLocator : INinjaTraderFolderLocator
{
    /// <summary>DetectNinjaTrader.ps1's list, compared without case as PowerShell's -notin does.</summary>
    public static readonly IReadOnlyList<string> ExcludedProfiles = new[]
    {
        "All Users", "Default", "Default User", "Public", "defaultuser0",
    };

    private static readonly string[] DocumentsUnderProfile =
    {
        "Documents",
        Path.Combine("OneDrive", "Documents"),
    };

    private readonly string usersRoot;

    public ProfileNinjaTraderFolderLocator(string usersRoot)
    {
        if (string.IsNullOrWhiteSpace(usersRoot)) throw new ArgumentException("A profiles folder is required.", nameof(usersRoot));
        this.usersRoot = usersRoot;
    }

    /// <summary>%SystemDrive%\Users, as the installer's lookup defaults to.</summary>
    public static ProfileNinjaTraderFolderLocator ForThisMachine()
    {
        string drive = Environment.GetEnvironmentVariable("SystemDrive");
        if (string.IsNullOrWhiteSpace(drive)) drive = "C:";
        return new ProfileNinjaTraderFolderLocator(Path.Combine(drive + Path.DirectorySeparatorChar, "Users"));
    }

    public NinjaTraderFolderLookup Locate()
    {
        List<string> folders = Candidates();
        List<string> withDatabase = folders.Where(HoldsDatabase).ToList();
        if (withDatabase.Count == 1) return NinjaTraderFolderLookup.At(withDatabase[0]);
        if (withDatabase.Count > 1) return NinjaTraderFolderLookup.Refused(TradingExportErrorCodes.NinjaTraderFolderAmbiguous);
        if (folders.Count == 0) return NinjaTraderFolderLookup.Refused(TradingExportErrorCodes.NinjaTraderFolderNotFound);
        // A folder with the right name and no database: one is a machine whose
        // NinjaTrader has not run yet, more than one is still not a choice.
        return NinjaTraderFolderLookup.Refused(folders.Count == 1
            ? TradingExportErrorCodes.DatabaseNotFound
            : TradingExportErrorCodes.NinjaTraderFolderAmbiguous);
    }

    /// <summary>Every profile's NinjaTrader 8 folder that exists, in a stable order.</summary>
    public List<string> Candidates()
    {
        var found = new List<string>();
        IEnumerable<string> profiles;
        try
        {
            if (!Directory.Exists(usersRoot)) return found;
            profiles = Directory.EnumerateDirectories(usersRoot).OrderBy(path => path, StringComparer.OrdinalIgnoreCase).ToList();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return found;
        }

        foreach (string profile in profiles)
        {
            if (ExcludedProfiles.Contains(Path.GetFileName(profile), StringComparer.OrdinalIgnoreCase)) continue;
            foreach (string documents in DocumentsUnderProfile)
            {
                try
                {
                    string folder = Path.GetFullPath(Path.Combine(profile, documents, NinjaTraderFolder.FolderName));
                    if (Directory.Exists(folder) && !found.Contains(folder, StringComparer.OrdinalIgnoreCase))
                        found.Add(folder);
                }
                catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
                {
                    // A profile this account cannot read is not a candidate.
                }
            }
        }
        return found;
    }

    private static bool HoldsDatabase(string folder)
    {
        try
        {
            return File.Exists(Path.GetFullPath(Path.Combine(folder, DeepExportSources.DatabaseRelativePath)));
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return false;
        }
    }
}
