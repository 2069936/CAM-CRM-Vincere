using Newtonsoft.Json;

namespace Vincere.AutoExport.Agent.Configuration;

[JsonObject(MemberSerialization.OptIn)]
public sealed record AgentOptions
{
    [JsonProperty("configurationVersion")]
    public int ConfigurationVersion { get; init; } = 1;

    [JsonProperty("crmBaseUrl")]
    public string CrmBaseUrl { get; init; } = "https://cam-crm-vincere.vercel.app/";

    [JsonProperty("scheduleTime")]
    public string ScheduleTime { get; init; } = "16:30";

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

    /* When the quarantine folder is walked, New York time. Midday because the
     * previous close has had the night to be looked at on the CRM side, and
     * because it is hours from the capture window, so a resend never competes
     * with the day's own upload. */
    [JsonProperty("quarantineReviewTime")]
    public string QuarantineReviewTime { get; init; } = "12:00";

    [JsonProperty("lastQuarantineReviewDate")]
    public string LastQuarantineReviewDate { get; init; }

    /* The last trading date whose report was mailed from this machine.
     *
     * Same shape as the quarantine review above and for the same reason: the
     * loop runs every few minutes and the thing it does must happen once a
     * day. A machine that restarts at 17:05 must not mail the close again. */
    [JsonProperty("lastReportEmailDate")]
    public string LastReportEmailDate { get; init; }

    public static AgentOptions CreateDefault() => new();
}
