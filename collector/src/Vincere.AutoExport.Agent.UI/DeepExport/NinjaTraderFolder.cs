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
}
