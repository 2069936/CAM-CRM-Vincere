using System;
using System.IO;

namespace Vincere.AutoExport.Agent.Updates;

/* WHERE AN UPDATE LIVES ON DISK: ProgramData\Vincere\AutoExport\updates.
 *
 *   updates\state.json            what the poll reports, and the attempt budget
 *   updates\last-result.json      written by update-agent.ps1 when it finishes
 *   updates\rollback\             the install root as it was, copied by update-agent.ps1
 *   updates\{version}\package.zip the verified download
 *   updates\{version}\package\    what update-agent.ps1 installs from
 *   updates\{version}\update-task.xml
 *
 * Under the data root, which the installer restricts to SYSTEM and
 * Administrators, and which the stager re-asserts on this folder before writing
 * anything: the package folder is run as SYSTEM, so a user who could write to it
 * could become SYSTEM. */
public sealed class UpdateLayout
{
    public UpdateLayout(string root)
    {
        if (string.IsNullOrWhiteSpace(root)) throw new ArgumentException("An updates folder is required.", nameof(root));
        Root = Path.GetFullPath(root);
    }

    public string Root { get; }

    public string StateFile => Path.Combine(Root, "state.json");

    public string LastResultFile => Path.Combine(Root, "last-result.json");

    public string RollbackDirectory => Path.Combine(Root, "rollback");

    public string VersionDirectory(string version) => Path.Combine(Root, RequireVersion(version));

    public string PackageZip(string version) => Path.Combine(VersionDirectory(version), "package.zip");

    public string PackageDirectory(string version) => Path.Combine(VersionDirectory(version), "package");

    public string TaskXml(string version) => Path.Combine(VersionDirectory(version), "update-task.xml");

    // A version is a folder name here, so it is checked for being a version and
    // not "..\something" before it is ever combined into a path.
    private static string RequireVersion(string version)
    {
        if (!UpdateVersion.IsTriple(version))
            throw new ArgumentException("A version in x.y.z form is required.", nameof(version));
        return version;
    }
}

/// <summary>Free space where the updates folder lives. A seam so tests can run out of disk.</summary>
public interface IUpdateDisk
{
    long GetAvailableFreeBytes(string path);
}

public sealed class SystemUpdateDisk : IUpdateDisk
{
    public long GetAvailableFreeBytes(string path)
    {
        string root = Path.GetPathRoot(Path.GetFullPath(path));
        return new DriveInfo(root).AvailableFreeSpace;
    }
}
