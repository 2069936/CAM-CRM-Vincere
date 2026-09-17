using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace Vincere.AutoExport.Agent.UI.DeepExport;

/* ---------------------------------------------------------------------------
 * What goes in the package, decided in one place.
 *
 * NinjaTrader keeps its history in a handful of folders under the user's
 * Documents. Most of what is there is worth having for a forensic read of a
 * client: the database, the logs, the traces, the workspaces, the strategy
 * templates, and the daily snapshots this agent already sent. Some of it must
 * not go: market data runs to gigabytes and says nothing about the client, and
 * Config.xml carries connection credentials.
 *
 * Each source is a relative folder, a file pattern, and where it lands in the
 * ZIP. A missing folder is a warning, not a failure: a machine with no trace
 * folder has still got a database worth exporting.
 * ------------------------------------------------------------------------- */
public enum DeepExportRoot
{
    /// <summary>The user's Documents\NinjaTrader 8.</summary>
    NinjaTrader,
    /// <summary>%ProgramData%\Vincere\AutoExport, where this agent keeps its queue. Not under NinjaTrader.</summary>
    Agent,
}

public sealed record DeepExportSource(
    string Name,
    DeepExportRoot Root,
    string RelativeFolder,
    string SearchPattern,
    string ZipFolder,
    bool Recursive);

public static class DeepExportSources
{
    public const string DatabaseRelativePath = @"db\NinjaTrader.sqlite";

    /// <summary>Folders that are never entered. Market data and compiled code.</summary>
    public static readonly IReadOnlyList<string> ExcludedFolders = new[]
    {
        @"db\minute", @"db\tick", @"db\day", @"db\cache", @"bin\Custom",
    };

    /// <summary>Files that are never copied whole. Connection credentials live here.</summary>
    public static readonly IReadOnlyList<string> ExcludedFiles = new[] { "Config.xml" };

    public static readonly IReadOnlyList<DeepExportSource> All = new[]
    {
        new DeepExportSource("logs", DeepExportRoot.NinjaTrader, "log", "log.*.txt", "logs", false),
        new DeepExportSource("trace", DeepExportRoot.NinjaTrader, "trace", "trace.*.txt", "trace", false),
        new DeepExportSource("workspaces", DeepExportRoot.NinjaTrader, "workspaces", "*.xml", "workspaces", false),
        new DeepExportSource("strategy templates", DeepExportRoot.NinjaTrader, @"templates\Strategy", "*.xml", @"templates\Strategy", true),
        new DeepExportSource("sent snapshots", DeepExportRoot.Agent, @"queue\sent", "*.*", @"autoexport\sent", false),
        new DeepExportSource("uploading snapshots", DeepExportRoot.Agent, @"queue\uploading", "*.*", @"autoexport\uploading", false),
        new DeepExportSource("quarantined snapshots", DeepExportRoot.Agent, @"queue\quarantine", "*.*", @"autoexport\quarantine", false),
    };

    /// <summary>The queue folders only carry these. Anything else in there is not ours to ship.</summary>
    private static readonly string[] QueueExtensions = { ".json", ".receipt", ".reason" };

    public static bool IsExcludedFolder(string ninjaTraderRoot, string fullPath)
    {
        string root = Path.GetFullPath(ninjaTraderRoot).TrimEnd(Path.DirectorySeparatorChar);
        string path = Path.GetFullPath(fullPath);
        return ExcludedFolders.Any(excluded =>
        {
            string prefix = Path.Combine(root, excluded);
            return path.StartsWith(prefix + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                || string.Equals(path, prefix, StringComparison.OrdinalIgnoreCase);
        });
    }

    public static bool IsExcludedFile(string fileName)
    {
        return ExcludedFiles.Any(excluded => string.Equals(excluded, fileName, StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>Where a source's folder lives on this machine.</summary>
    public static string Folder(string ninjaTraderRoot, string agentRoot, DeepExportSource source)
    {
        string root = source.Root == DeepExportRoot.Agent ? agentRoot : ninjaTraderRoot;
        return string.IsNullOrEmpty(root) ? null : Path.Combine(root, source.RelativeFolder);
    }

    /// <summary>Every file a source contributes, as (absolute path, path inside the ZIP).</summary>
    public static IEnumerable<(string FullPath, string ZipPath)> Enumerate(string ninjaTraderRoot, string agentRoot, DeepExportSource source)
    {
        string folder = Folder(ninjaTraderRoot, agentRoot, source);
        if (folder == null || !Directory.Exists(folder)) yield break;
        SearchOption option = source.Recursive ? SearchOption.AllDirectories : SearchOption.TopDirectoryOnly;
        foreach (string file in Directory.EnumerateFiles(folder, source.SearchPattern, option).OrderBy(f => f, StringComparer.OrdinalIgnoreCase))
        {
            if (source.Root == DeepExportRoot.NinjaTrader && IsExcludedFolder(ninjaTraderRoot, file)) continue;
            string name = Path.GetFileName(file);
            if (IsExcludedFile(name)) continue;
            if (source.ZipFolder.StartsWith("autoexport", StringComparison.OrdinalIgnoreCase)
                && !QueueExtensions.Contains(Path.GetExtension(name), StringComparer.OrdinalIgnoreCase))
            {
                continue;
            }
            string relative = Path.GetRelativePath(folder, file).Replace(Path.DirectorySeparatorChar, '/');
            yield return (file, source.ZipFolder.Replace('\\', '/') + "/" + relative);
        }
    }
}
