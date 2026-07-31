using System.IO;
using Vincere.AutoExport.Agent.Configuration;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class AgentPathsTests
{
    [Fact]
    public void DerivesEveryMachineOwnedPathFromOneProgramDataRoot()
    {
        string root = Path.GetFullPath(Path.Combine(Path.GetTempPath(), "program-data"));

        AgentPaths paths = AgentPaths.FromProgramData(root);

        string expected = Path.Combine(root, "Vincere", "AutoExport");
        Assert.Equal(expected, paths.Root);
        Assert.Equal(Path.Combine(expected, "config.json"), paths.Configuration);
        Assert.Equal(Path.Combine(expected, "secret.bin"), paths.Secret);
        Assert.Equal(Path.Combine(expected, "queue", "pending"), paths.PendingQueue);
        Assert.Equal(Path.Combine(expected, "queue", "uploading"), paths.UploadingQueue);
        Assert.Equal(Path.Combine(expected, "queue", "sent"), paths.SentQueue);
        Assert.Equal(Path.Combine(expected, "queue", "quarantine"), paths.QuarantineQueue);
        Assert.Equal(Path.Combine(expected, "logs"), paths.Logs);
    }
}
