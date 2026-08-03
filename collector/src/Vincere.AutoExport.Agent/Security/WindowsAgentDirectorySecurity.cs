using System;
using System.IO;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Vincere.AutoExport.Agent.Security;

public sealed class WindowsAgentDirectorySecurity : IAgentDirectorySecurity
{
    public void EnsureProtected(string path)
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Collector directory ACLs require Windows.");

        Directory.CreateDirectory(path);
        DirectorySecurity security = new();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        SecurityIdentifier system = new(WellKnownSidType.LocalSystemSid, null);
        SecurityIdentifier administrators = new(WellKnownSidType.BuiltinAdministratorsSid, null);
        security.SetOwner(administrators);
        AddFullControl(security, system);
        AddFullControl(security, administrators);
        new DirectoryInfo(path).SetAccessControl(security);
    }

    private static void AddFullControl(DirectorySecurity security, SecurityIdentifier identity)
    {
        security.AddAccessRule(new FileSystemAccessRule(
            identity,
            FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None,
            AccessControlType.Allow));
    }
}
