using System;
using Newtonsoft.Json;

namespace Vincere.AutoExport.Agent.Configuration;

[JsonObject(MemberSerialization.OptIn)]
public sealed class RedactedAgentState
{
    private RedactedAgentState()
    {
    }

    [JsonProperty("configurationVersion")]
    public int ConfigurationVersion { get; private init; }

    [JsonProperty("crmBaseUrl")]
    public string CrmBaseUrl { get; private init; }

    [JsonProperty("scheduleTime")]
    public string ScheduleTime { get; private init; }

    [JsonProperty("timeZone")]
    public string TimeZone { get; private init; }

    [JsonProperty("deviceId")]
    public string DeviceId { get; private init; }

    [JsonProperty("clientName")]
    public string ClientName { get; private init; }

    [JsonProperty("lastScheduledTradingDate")]
    public string LastScheduledTradingDate { get; private init; }

    [JsonProperty("hasCredential")]
    public bool HasCredential { get; private init; }

    [JsonProperty("machineIdHash")]
    public string MachineIdHash { get; private init; }

    public static RedactedAgentState From(
        AgentOptions options,
        bool hasCredential,
        string machineIdHash)
    {
        ArgumentNullException.ThrowIfNull(options);
        if (string.IsNullOrWhiteSpace(machineIdHash))
            throw new ArgumentException("A diagnostic machine hash is required.", nameof(machineIdHash));
        return new RedactedAgentState
        {
            ConfigurationVersion = options.ConfigurationVersion,
            CrmBaseUrl = options.CrmBaseUrl,
            ScheduleTime = options.ScheduleTime,
            TimeZone = options.TimeZone,
            DeviceId = options.DeviceId,
            ClientName = options.ClientName,
            LastScheduledTradingDate = options.LastScheduledTradingDate,
            HasCredential = hasCredential,
            MachineIdHash = machineIdHash,
        };
    }
}
