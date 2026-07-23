using System;
using System.IO;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Security;

namespace Vincere.AutoExport.Agent.Configuration;

public interface IAgentOptionsStore
{
    Task<ConfigurationLoadResult> LoadAsync(CancellationToken cancellationToken = default);
    Task SaveAsync(AgentOptions options, CancellationToken cancellationToken = default);
}

public sealed class ConfigurationStore : IAgentOptionsStore
{
    private static readonly UTF8Encoding Utf8WithoutBom = new(false);
    private readonly SemaphoreSlim gate = new(1, 1);
    private readonly IAgentDirectorySecurity directorySecurity;

    public ConfigurationStore(string configurationPath)
        : this(configurationPath, new WindowsAgentDirectorySecurity())
    {
    }

    public ConfigurationStore(
        string configurationPath,
        IAgentDirectorySecurity directorySecurity)
    {
        if (string.IsNullOrWhiteSpace(configurationPath))
            throw new ArgumentException("A configuration path is required.", nameof(configurationPath));
        this.directorySecurity = directorySecurity ?? throw new ArgumentNullException(nameof(directorySecurity));
        ConfigurationPath = Path.GetFullPath(configurationPath);
        BackupPath = ConfigurationPath + ".bak";
        TemporaryPath = ConfigurationPath + ".tmp";
    }

    public string ConfigurationPath { get; }
    public string BackupPath { get; }
    public string TemporaryPath { get; }

    public async Task<ConfigurationLoadResult> LoadAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            directorySecurity.EnsureProtected(RequireDirectory());
            if (!File.Exists(ConfigurationPath) && !File.Exists(BackupPath))
                return new ConfigurationLoadResult(AgentOptions.CreateDefault(), false);

            if (TryLoad(ConfigurationPath, out AgentOptions current))
                return new ConfigurationLoadResult(current, false);
            if (TryLoad(BackupPath, out AgentOptions backup))
                return new ConfigurationLoadResult(backup, true);

            throw new AgentConfigurationException(
                "configuration_corrupt",
                "The collector configuration and its recovery copy are invalid.");
        }
        finally
        {
            gate.Release();
        }
    }

    public async Task SaveAsync(AgentOptions options, CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(options);
        Validate(options);
        string json = JsonConvert.SerializeObject(options, Formatting.Indented) + Environment.NewLine;

        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            directorySecurity.EnsureProtected(RequireDirectory());
            DeleteIfPresent(TemporaryPath);
            await WriteThroughAsync(TemporaryPath, Utf8WithoutBom.GetBytes(json), cancellationToken)
                .ConfigureAwait(false);

            if (TryLoad(ConfigurationPath, out _))
            {
                string backupTemporaryPath = BackupPath + ".tmp";
                DeleteIfPresent(backupTemporaryPath);
                byte[] currentBytes = await File.ReadAllBytesAsync(ConfigurationPath, cancellationToken)
                    .ConfigureAwait(false);
                await WriteThroughAsync(backupTemporaryPath, currentBytes, cancellationToken)
                    .ConfigureAwait(false);
                File.Move(backupTemporaryPath, BackupPath, true);
            }

            File.Move(TemporaryPath, ConfigurationPath, true);
        }
        catch
        {
            DeleteIfPresent(TemporaryPath);
            DeleteIfPresent(BackupPath + ".tmp");
            throw;
        }
        finally
        {
            gate.Release();
        }
    }

    private static bool TryLoad(string path, out AgentOptions options)
    {
        options = null;
        if (!File.Exists(path)) return false;
        try
        {
            string json = File.ReadAllText(path, Utf8WithoutBom);
            AgentOptions parsed = JsonConvert.DeserializeObject<AgentOptions>(json);
            if (parsed == null) return false;
            Validate(parsed);
            options = parsed;
            return true;
        }
        catch (Exception exception) when (
            exception is JsonException
            or IOException
            or UnauthorizedAccessException
            or AgentConfigurationException)
        {
            return false;
        }
    }

    private string RequireDirectory()
    {
        return Path.GetDirectoryName(ConfigurationPath)
            ?? throw new AgentConfigurationException("configuration_path_invalid", "The configuration directory is invalid.");
    }

    private static void Validate(AgentOptions options)
    {
        if (options.ConfigurationVersion != 1)
            throw new AgentConfigurationException("configuration_version_unsupported", "Unsupported collector configuration version.");
        if (options.TimeZone != "America/New_York")
            throw new AgentConfigurationException("configuration_timezone_invalid", "Collector time zone must be America/New_York.");
        if (!TimeOnly.TryParseExact(options.ScheduleTime, "HH:mm", out TimeOnly scheduleTime)
            || !TimeOnly.TryParseExact(options.CaptureCutoffTime, "HH:mm", out TimeOnly cutoffTime)
            || cutoffTime <= scheduleTime)
            throw new AgentConfigurationException("configuration_schedule_invalid", "Collector schedule must use 24-hour HH:mm format.");
        if (options.EnabledTradingDays == null || options.EnabledTradingDays.Length == 0)
            throw new AgentConfigurationException("configuration_schedule_invalid", "At least one trading day must be enabled.");
        HashSet<DayOfWeek> days = new();
        if (options.EnabledTradingDays.Any(day =>
            !Enum.TryParse(day, ignoreCase: false, out DayOfWeek parsed)
            || !Enum.IsDefined(parsed)
            || !days.Add(parsed)))
        {
            throw new AgentConfigurationException("configuration_schedule_invalid", "Enabled trading days are invalid or duplicated.");
        }
        if (!string.IsNullOrWhiteSpace(options.CrmBaseUrl)
            && (!Uri.TryCreate(options.CrmBaseUrl, UriKind.Absolute, out Uri endpoint)
                || (endpoint.Scheme != Uri.UriSchemeHttps
                    && !(endpoint.IsLoopback && endpoint.Scheme == Uri.UriSchemeHttp))))
        {
            throw new AgentConfigurationException("configuration_endpoint_invalid", "CRM endpoint must use HTTPS.");
        }
    }

    private static async Task WriteThroughAsync(string path, byte[] bytes, CancellationToken cancellationToken)
    {
        await using FileStream stream = new(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            4096,
            FileOptions.Asynchronous | FileOptions.WriteThrough);
        await stream.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        stream.Flush(true);
    }

    private static void DeleteIfPresent(string path)
    {
        if (File.Exists(path)) File.Delete(path);
    }
}

public sealed record ConfigurationLoadResult(AgentOptions Options, bool RecoveredFromBackup);

public sealed class AgentConfigurationException : Exception
{
    public AgentConfigurationException(string code, string message) : base(message)
    {
        Code = code;
    }

    public string Code { get; }
}
