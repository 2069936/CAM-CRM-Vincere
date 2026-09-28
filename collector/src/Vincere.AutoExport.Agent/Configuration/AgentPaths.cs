using System;
using System.IO;

namespace Vincere.AutoExport.Agent.Configuration;

public sealed record AgentPaths(
    string Root,
    string Configuration,
    string Secret,
    string PendingQueue,
    string UploadingQueue,
    string SentQueue,
    string QuarantineQueue,
    string Logs,
    string History,
    /// <summary>The last account classification the CRM was able to send. See RosterStore.</summary>
    string Roster,
    /// <summary>The relay secret the heartbeat hands out, so this machine can mail its own close when the CRM cannot be reached. Its own file rather than a second field in config.json, because it is a credential and belongs encrypted at rest like the device token beside it.</summary>
    string RelaySecret = null)
{
    public static AgentPaths FromEnvironment()
    {
        return FromProgramData(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData));
    }

    public static AgentPaths FromProgramData(string programDataRoot)
    {
        if (string.IsNullOrWhiteSpace(programDataRoot))
            throw new ArgumentException("A ProgramData root is required.", nameof(programDataRoot));
        string root = Path.Combine(Path.GetFullPath(programDataRoot), "Vincere", "AutoExport");
        string queue = Path.Combine(root, "queue");
        return new AgentPaths(
            root,
            Path.Combine(root, "config.json"),
            Path.Combine(root, "secret.bin"),
            Path.Combine(queue, "pending"),
            Path.Combine(queue, "uploading"),
            Path.Combine(queue, "sent"),
            Path.Combine(queue, "quarantine"),
            Path.Combine(root, "logs"),
            Path.Combine(root, "history.json"),
            Path.Combine(root, "roster.json"),
            Path.Combine(root, "relay-secret.bin"));
    }
}
