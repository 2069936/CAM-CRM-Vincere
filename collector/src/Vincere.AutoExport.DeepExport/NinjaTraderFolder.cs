using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Vincere.AutoExport.Agent.UI.DeepExport;

/* ---------------------------------------------------------------------------
 * Where NinjaTrader keeps its files on this machine.
 *
 * The spec says %USERPROFILE%\Documents\NinjaTrader 8 and then, in the same
 * line, says not to assume it. OneDrive moves Documents, and the VPS images
 * this fleet runs on have both layouts. So: ask the shell where Documents is
 * (that follows the OneDrive redirect), try the two plain spellings after it,
 * and prefer the candidate that actually holds the database over one that is
 * merely a folder with the right name.
 *
 * AND WHEN NONE OF THEM IS IT, SAY WHICH ONES WERE TRIED. Every candidate here
 * is derived from the identity of the process doing the asking, so a service and
 * a trader on the same machine get different answers and the difference is
 * invisible from a CRM card. Resolve returns null and leaves the caller to
 * explain; Require refuses with the list and with the account, which is the only
 * form of the answer that reaches somebody who cannot open the machine.
 * ------------------------------------------------------------------------- */
public static class NinjaTraderFolder
{
    public const string FolderName = "NinjaTrader 8";

    public static IReadOnlyList<string> Candidates()
    {
        var list = new List<string>();
        void Add(string documents)
        {
            if (string.IsNullOrWhiteSpace(documents)) return;
            string candidate = Path.Combine(documents, FolderName);
            if (!list.Contains(candidate, StringComparer.OrdinalIgnoreCase)) list.Add(candidate);
        }
        try { Add(Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments)); } catch (Exception) { }
        string profile = Environment.GetEnvironmentVariable("USERPROFILE");
        if (!string.IsNullOrEmpty(profile))
        {
            Add(Path.Combine(profile, "OneDrive", "Documents"));
            Add(Path.Combine(profile, "Documents"));
        }
        return list;
    }

    /// <summary>The first candidate with a database in it, else the first that exists, else null.</summary>
    public static string Resolve(IEnumerable<string> candidates = null)
    {
        string[] all = (candidates ?? Candidates()).ToArray();
        return all.FirstOrDefault(c => File.Exists(Path.GetFullPath(Path.Combine(c, DeepExportSources.DatabaseRelativePath))))
            ?? all.FirstOrDefault(Directory.Exists);
    }

    /// <summary>
    /// Resolve, or refuse NAMING EVERY PATH IT TRIED AND WHAT WAS AT IT.
    ///
    /// Resolve returning null used to become the sentence "NinjaTrader 8 was not
    /// found under this user's Documents", which is unactionable twice over on a
    /// machine the reader cannot open: it names no path, and "this user" is the
    /// one fact in play. The candidates come from SpecialFolder.MyDocuments and
    /// %USERPROFILE%, so for the Windows service - installed as LocalSystem - they
    /// are all under C:\Windows\system32\config\systemprofile and none of them is
    /// where the trader's NinjaTrader lives. Printing them says so without anybody
    /// having to know it.
    /// </summary>
    public static string Require(IEnumerable<string> candidates = null)
    {
        string[] all = (candidates ?? Candidates()).ToArray();
        string resolved = Resolve(all);
        if (resolved != null) return resolved;
        throw new DeepExportRefusedException(
            $"{FolderName} was not found, so there is nothing to export. "
            + (all.Length == 0
                ? "This machine reported no Documents folder and no %USERPROFILE%, so there was nowhere to look. "
                : "Looked at: " + string.Join("; ", all.Select(Describe)) + ". ")
            + ThisAccount());
    }

    /// <summary>One candidate and what is actually at it, for a refusal a person can act on.</summary>
    private static string Describe(string candidate)
    {
        if (File.Exists(Path.GetFullPath(Path.Combine(candidate, DeepExportSources.DatabaseRelativePath))))
            return candidate + " (database here)";
        if (Directory.Exists(candidate)) return candidate + " (folder here, no database under it)";
        return candidate + " (no such folder)";
    }

    /// <summary>
    /// Which Windows account is doing the looking, and where that account's
    /// Documents folder is. TWO FACTS AND NO ADVICE, stated once and reused by
    /// every refusal: under LocalSystem they come back as SYSTEM and
    /// C:\Windows\system32\config\systemprofile\Documents, and that single line is
    /// the whole explanation of why the trader's export works and the service's
    /// finds nothing.
    /// </summary>
    public static string ThisAccount()
    {
        string user;
        try { user = Environment.UserName; } catch (Exception) { user = "(not reported)"; }
        string documents;
        try { documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments); } catch (Exception) { documents = null; }
        return $"This process is running as {(string.IsNullOrEmpty(user) ? "(not reported)" : user)}, "
            + $"whose Documents folder is {(string.IsNullOrEmpty(documents) ? "(not reported)" : documents)}.";
    }
}
