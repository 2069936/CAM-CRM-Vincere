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
    string Logs)
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
            Path.Combine(root, "logs"));
    }
}
