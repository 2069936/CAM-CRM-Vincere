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
     * THE POSITION TRAVELS TOO, SINCE AGENT 1.2.1. The CAMs tell each other in the
     * team chat whether BulletBot fired long or short today, and the CRM cannot
     * know that from the strategy catalogue: BulletBot decides each day. So the
     * reading carries the instance's market position (long, short, flat), the
     * contracts it holds, and the real time trades this run has completed. All
     * three are optional on the wire, null when not readable, and the same rule
     * applies: null is "not read", written explicitly, never a zero or a "flat"
     * standing in for one. The schema version stays 1: a 1.2.0 agent reads a
     * 1.2.1 add-on's reply with the new members ignored, and the CRM route reads
     * a 1.2.0 agent's post with the three keys missing as null.
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
        /// When the agent saw this instance start a new run earlier the same day:
        /// it came back after a reading that did not hold it, or its real time
        /// trade count went down between two readings. NinjaTrader resets the
        /// figure to zero on a re-enable, so a restarted row counts only since then
        /// and is never compared. The add-on never sets this; the agent fills it in.
        /// </summary>
        [JsonProperty("restartedAt")]
        public DateTimeOffset? RestartedAt { get; set; }

        /// <summary>
        /// Which way the instance is in the market as the add-on read it: "long",
        /// "short" or "flat", always lower case, or null when the position could
        /// not be read or answered a word that is none of the three. This is how
        /// the desk learns whether BulletBot fired long or short today.
        /// </summary>
        [JsonProperty("marketPosition")]
        public string MarketPosition { get; set; }

        /// <summary>
        /// How many contracts the instance holds, zero when flat, null when the
        /// position could not be read.
        /// </summary>
        [JsonProperty("positionQuantity")]
        public int? PositionQuantity { get; set; }

        /// <summary>
        /// The real time trades this run of the instance has completed, FOR THE
        /// CRM. The agent fills it from <see cref="RealtimeTradeCount"/> after the
        /// restart detection has read the same number; the add-on leaves it null.
        /// Null when the add-on could not read the count.
        /// </summary>
        [JsonProperty("tradesThisRun")]
        public int? TradesThisRun { get; set; }

        /// <summary>
        /// How many real time trades this run of the instance has completed, as the
        /// add-on read it, or null when it could not be read. PIPE ONLY: the add-on
        /// sends it so the agent can see a disable and enable that fell between two
        /// readings (the count only grows within a run, and a re-enable starts it
        /// again from zero). The agent never posts it under this name (it travels
        /// to the CRM as tradesThisRun), and a null is left out of the JSON. The
        /// name is kept as it is: a 1.2.0 add-on keeps sending it to a 1.2.1 agent.
        /// </summary>
        [JsonProperty("realtimeTradeCount", NullValueHandling = NullValueHandling.Ignore)]
        public int? RealtimeTradeCount { get; set; }
    }
}
