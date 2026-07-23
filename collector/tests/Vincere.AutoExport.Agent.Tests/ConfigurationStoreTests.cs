using System;
using System.IO;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Security;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class ConfigurationStoreTests : IDisposable
{
    private readonly string directory = Path.Combine(
        Path.GetTempPath(), "vincere-agent-tests", Guid.NewGuid().ToString("N"));
    private int securityApplications;

    [Fact]
    public async Task MissingConfigurationReturnsSafeDefaults()
    {
        ConfigurationStore store = CreateStore();

        ConfigurationLoadResult result = await store.LoadAsync();

        Assert.False(result.RecoveredFromBackup);
        Assert.Equal("16:45", result.Options.ScheduleTime);
        Assert.Equal("America/New_York", result.Options.TimeZone);
        Assert.Equal(1, result.Options.ConfigurationVersion);
        Assert.Null(result.Options.DeviceId);
        Assert.Equal(1, securityApplications);
    }

    [Fact]
    public async Task SavingAgainAtomicallyReplacesCurrentAndKeepsLastKnownGoodBackup()
    {
        ConfigurationStore store = CreateStore();
        AgentOptions first = AgentOptions.CreateDefault() with { DeviceId = "device-1" };
        AgentOptions second = first with { ScheduleTime = "16:40" };

        await store.SaveAsync(first);
        await store.SaveAsync(second);

        ConfigurationLoadResult current = await store.LoadAsync();
        string backupJson = await File.ReadAllTextAsync(store.BackupPath);
        Assert.Equal("16:40", current.Options.ScheduleTime);
        Assert.Contains("device-1", backupJson);
        Assert.Contains("16:45", backupJson);
        Assert.False(File.Exists(store.TemporaryPath));
    }

    [Fact]
    public async Task CorruptCurrentConfigurationRecoversTheLastKnownGoodBackup()
    {
        ConfigurationStore store = CreateStore();
        AgentOptions first = AgentOptions.CreateDefault() with { DeviceId = "device-1" };
        await store.SaveAsync(first);
        await store.SaveAsync(first with { ScheduleTime = "16:40" });
        await File.WriteAllTextAsync(store.ConfigurationPath, "{not-json");

        ConfigurationLoadResult result = await store.LoadAsync();

        Assert.True(result.RecoveredFromBackup);
        Assert.Equal("16:45", result.Options.ScheduleTime);
    }

    [Fact]
    public async Task CorruptCurrentAndBackupReturnStableDiagnosticCode()
    {
        ConfigurationStore store = CreateStore();
        Directory.CreateDirectory(directory);
        await File.WriteAllTextAsync(store.ConfigurationPath, "{bad-current");
        await File.WriteAllTextAsync(store.BackupPath, "{bad-backup");

        AgentConfigurationException error = await Assert.ThrowsAsync<AgentConfigurationException>(
            () => store.LoadAsync());

        Assert.Equal("configuration_corrupt", error.Code);
        Assert.DoesNotContain("{bad-current", error.Message);
    }

    [Fact]
    public async Task SavingAfterRecoveryDoesNotReplaceAGoodBackupWithCorruptBytes()
    {
        ConfigurationStore store = CreateStore();
        AgentOptions first = AgentOptions.CreateDefault() with { DeviceId = "device-1" };
        await store.SaveAsync(first);
        await store.SaveAsync(first with { ScheduleTime = "16:40" });
        await File.WriteAllTextAsync(store.ConfigurationPath, "{corrupt-current");

        await store.SaveAsync(first with { ScheduleTime = "16:35" });

        string backupJson = await File.ReadAllTextAsync(store.BackupPath);
        Assert.Contains("16:45", backupJson);
        Assert.DoesNotContain("corrupt-current", backupJson);
    }

    public void Dispose()
    {
        if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
    }

    private ConfigurationStore CreateStore()
    {
        return new ConfigurationStore(
            Path.Combine(directory, "config.json"),
            new RecordingDirectorySecurity(this));
    }

    private sealed class RecordingDirectorySecurity : IAgentDirectorySecurity
    {
        private readonly ConfigurationStoreTests owner;

        public RecordingDirectorySecurity(ConfigurationStoreTests owner) => this.owner = owner;

        public void EnsureProtected(string path)
        {
            Directory.CreateDirectory(path);
            owner.securityApplications += 1;
        }
    }
}
