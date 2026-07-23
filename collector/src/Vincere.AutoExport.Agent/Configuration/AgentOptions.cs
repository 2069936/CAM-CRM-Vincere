using Newtonsoft.Json;

namespace Vincere.AutoExport.Agent.Configuration;

[JsonObject(MemberSerialization.OptIn)]
public sealed record AgentOptions
{
    [JsonProperty("configurationVersion")]
    public int ConfigurationVersion { get; init; } = 1;

    [JsonProperty("crmBaseUrl")]
    public string CrmBaseUrl { get; init; } = string.Empty;

    [JsonProperty("scheduleTime")]
    public string ScheduleTime { get; init; } = "16:45";

    [JsonProperty("captureCutoffTime")]
    public string CaptureCutoffTime { get; init; } = "17:00";

    [JsonProperty("enabledTradingDays")]
    public string[] EnabledTradingDays { get; init; } = new[]
    {
        "Monday",
        "Tuesday",
        "Wednesday",
        "Thursday",
        "Friday",
    };

    [JsonProperty("timeZone")]
    public string TimeZone { get; init; } = "America/New_York";

    [JsonProperty("deviceId")]
    public string DeviceId { get; init; }

    [JsonProperty("clientName")]
    public string ClientName { get; init; }

    [JsonProperty("lastScheduledTradingDate")]
    public string LastScheduledTradingDate { get; init; }

    public static AgentOptions CreateDefault() => new();
}
