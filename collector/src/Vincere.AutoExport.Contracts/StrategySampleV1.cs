using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace Vincere.AutoExport.Contracts
{
    /* ONE READING OF THE STRATEGIES TAB, PER LIVE STRATEGY INSTANCE.
     *
     * The desk wants to see, during the day, what each algorithm has made on each
     * account next to what the same algorithm has made across the desk. The number
     * is the Strategies tab's Realized plus Unrealized for one instance, and this
     * carries the two halves and nothing else about the strategy.
     *
     * ITS OWN TYPE AND ITS OWN PIPE COMMAND, NOT A SECTION OF AccountSampleV1.
     * Agents from PR 68 refuse any account sample whose schemaVersion is not 1,
     * and they would lose every account row if the account sample grew a version.
     * A separate reply also keeps a slow P&L read from spending the five seconds
     * the account reading has. AccountSampleV1 is untouched by this type existing.
     *
     * NULL IS "NOT MEASURED", NEVER ZERO, in both P&L members. The serializer the
     * agent posts with writes nulls explicitly, so the CRM can tell a strategy whose
     * P&L could not be read from one that has made nothing. Unrealized is 0, not
     * null, when the position was read and it is flat.
     *
     * THE JSON NAMES ARE THE WIRE CONTRACT with POST /api/ingest/strategies, and the
     * route's test and this project's test embed the same fixture. */
    public sealed class StrategySampleV1
    {
        public const int CurrentSchemaVersion = 1;

        [JsonProperty("schemaVersion")]
        public int SchemaVersion { get; set; }

        /// <summary>
        /// The machine's own clock when the strategies were read. The CRM derives
        /// the comparison cycle from this, never from the time the post arrived.
        /// </summary>
        [JsonProperty("sampledAt")]
        public DateTimeOffset SampledAt { get; set; }

        [JsonProperty("strategies")]
        public IList<StrategySampleRowV1> Strategies { get; set; }
    }

    public sealed class StrategySampleRowV1
    {
        [JsonProperty("accountName")]
        public string AccountName { get; set; }

        /// <summary>
        /// NinjaTrader's instance id. Stable across days and across a contract
        /// roll, which the instrument string is not, so this and the account are
        /// the instance's identity.
        /// </summary>
        [JsonProperty("strategyId")]
        public string StrategyId { get; set; }

        [JsonProperty("strategyName")]
        public string StrategyName { get; set; }

        [JsonProperty("instrument")]
        public string Instrument { get; set; }

        [JsonProperty("realizedPnl")]
        public decimal? RealizedPnl { get; set; }

        [JsonProperty("unrealizedPnl")]
        public decimal? UnrealizedPnl { get; set; }

        /// <summary>
        /// When the agent saw this instance come back after it had gone away
        /// earlier the same day. NinjaTrader resets the figure to zero on a
        /// re-enable, so a restarted row counts only since then and is never
        /// compared. The add-on never sets this; the agent fills it in.
        /// </summary>
        [JsonProperty("restartedAt")]
        public DateTimeOffset? RestartedAt { get; set; }
    }
}
