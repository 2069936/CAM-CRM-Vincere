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
 * client: the database, the logs, the traces, the workspaces, and the daily
 * snapshots this agent already sent. Some of it must not go: market data runs
 * to gigabytes and says nothing about the client, and Config.xml carries
 * connection credentials.
 *
 * Each source is a relative folder, a file pattern, and where it lands in the
 * ZIP. A missing folder is a warning, not a failure: a machine with no trace
 * folder has still got a database worth exporting.
 *
 * THIS LIST IS THE ONLY STATEMENT OF WHAT SHIPS AS A FILE. Enumerate is the
 * only thing that walks a folder into staging, and DeepExportRunner's step 2 is
 * its only caller. Nothing else may copy a file into the package - that is the
 * mistake db/ made, where an allowlist in SqliteSnapshot was honoured for the
 * JSONL dump and undone by the whole database being copied in beside it.
 *
 * templates/Strategy IS NOT HERE ANY MORE, AND THAT IS THE POINT OF THIS NOTE.
 *
 * It shipped as 886 raw .xml files in 20 family directories - 7.8 MB on disk,
 * 1,879,557 bytes deflated, 22.7% of a real 34 MB package and 88.7% of the
 * manifest's file list. It was removed because THE PARAMETERISATION TRAVELLED
 * TWICE and this was the copy with no reader:
 *
 *   - attribution/catalog.jsonl is the DERIVED form and the only one anything
 *     reads. scripts/import_strategy_catalog.mjs opens exactly that file and
 *     manifest.json, loads public.strategy_templates, and scripts/
 *     attribute_orders.mjs names the desk's book off that table. 823 rows,
 *     117 KB, 2,860 bytes deflated. templates/ cost 657x the thing that is
 *     actually read.
 *   - NOTHING reads the raw library out of a finished package. Not in this
 *     repo, not in its history: no consumer was ever deleted either.
 *   - AttributionExport derives the catalogue from the LIVE folder, not from
 *     staging - see the path it builds in ReadTemplates - and it runs at step
 *     1b, before this list is walked at step 2. Removing the staged copy
 *     therefore cannot change what the catalogue contains. Verified against a
 *     real export by re-deriving the catalogue from templates/ alone: 886 files
 *     to 823 rows to 275 distinct identities, 0 shipped rows unreproducible and
 *     0 derived rows absent.
 *   - And the raw copy carried a credential the derived form does not: a
 *     NinjaTrader licence key in plain ASCII inside a <LicenseKey> element, in
 *     886 of 886 files, one per file. catalog.jsonl carries 0.
 *
 * WHAT THAT COSTS, PLAINLY. The 886 files were the only place in the package
 * carrying about 86 parameters that vary across the library and that the
 * catalogue does not: the trailing stop, break-even, the session window, the
 * seven day filters, MaxDailyEntries, EdgeLeverage, the timeframe and the
 * per-family tuning. An analyst whose habit is to unzip and read a family's
 * .xml loses that. The library is not destroyed - collector/scripts/
 * install-agent.ps1 backs templates\Strategy up on the VPS itself - but
 * recovering it now needs VPS access rather than a ZIP somebody already has.
 * If attribution later needs to match on trail or break-even geometry, the
 * answer is to widen what StrategyTemplateReader puts in catalog.jsonl, which
 * is parameters and not a credential, rather than to re-ship 886 files.
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
    // Forward slashes: Windows accepts them, and so does every other file
    // system the tests run on. Path.GetFullPath makes them native.
    public const string DatabaseRelativePath = "db/NinjaTrader.sqlite";

    /// <summary>Folders that are never entered. Market data and compiled code.</summary>
    public static readonly IReadOnlyList<string> ExcludedFolders = new[]
    {
        "db/minute", "db/tick", "db/day", "db/cache", "bin/Custom",
    };

    /// <summary>Files that are never copied whole. Connection credentials live here.</summary>
    public static readonly IReadOnlyList<string> ExcludedFiles = new[] { "Config.xml" };

    public static readonly IReadOnlyList<DeepExportSource> All = new[]
    {
        new DeepExportSource("logs", DeepExportRoot.NinjaTrader, "log", "log.*.txt", "logs", false),
        new DeepExportSource("trace", DeepExportRoot.NinjaTrader, "trace", "trace.*.txt", "trace", false),
        new DeepExportSource("workspaces", DeepExportRoot.NinjaTrader, "workspaces", "*.xml", "workspaces", false),
        // PENDING COMES FIRST BECAUSE IT HOLDS THE DAY THAT IS MISSING.
        //
        // A capture is written to pending/ and only moves to sent/ once the CRM
        // has accepted it. A failed upload returns it to pending/. So on the one
        // day this export exists for - the day the CRM could not be reached -
        // every other queue folder holds history and pending/ holds today.
        // Measured on 2026-09-25: an export taken during the outage carried
        // twelve historical days and omitted the day nobody had a report for.
        new DeepExportSource("pending snapshots", DeepExportRoot.Agent, "queue/pending", "*.*", "autoexport/pending", false),
        new DeepExportSource("sent snapshots", DeepExportRoot.Agent, "queue/sent", "*.*", "autoexport/sent", false),
        new DeepExportSource("uploading snapshots", DeepExportRoot.Agent, "queue/uploading", "*.*", "autoexport/uploading", false),
        new DeepExportSource("quarantined snapshots", DeepExportRoot.Agent, "queue/quarantine", "*.*", "autoexport/quarantine", false),
    };

    /// <summary>The queue folders only carry these. Anything else in there is not ours to ship.</summary>
    private static readonly string[] QueueExtensions = { ".json", ".receipt", ".reason" };

    public static bool IsExcludedFolder(string ninjaTraderRoot, string fullPath)
    {
        string root = Path.GetFullPath(ninjaTraderRoot).TrimEnd(Path.DirectorySeparatorChar);
        string path = Path.GetFullPath(fullPath);
        return ExcludedFolders.Any(excluded =>
        {
            string prefix = Path.GetFullPath(Path.Combine(root, excluded));
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
        return string.IsNullOrEmpty(root) ? null : Path.GetFullPath(Path.Combine(root, source.RelativeFolder));
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
            yield return (file, source.ZipFolder + "/" + relative);
        }
    }
}
