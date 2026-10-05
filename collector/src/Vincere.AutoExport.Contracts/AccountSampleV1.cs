using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace Vincere.AutoExport.Contracts
{
    /* A TRACKER READING, AND DELIBERATELY NOT A SNAPSHOT.
     *
     * ITS OWN TYPE, NOT AutoExportSnapshotV1 WITH EMPTY LISTS. That was the
     * obvious shortcut and it is the dangerous one: a snapshot carrying no
     * orders and no executions passes CapturePipeClient.ValidateResponse
     * unchanged, because that method only requires the four lists be non-null.
     * A sample would then be structurally indistinguishable from a daily close,
     * and one wrong call site would turn a 10:15 reading into the day's import -
     * a close with no trades in it, for a day that had plenty. A separate type
     * cannot be mistaken for a close by any code path, including ones nobody has
     * written yet.
     *
     * WHAT IS ABSENT IS THE POINT. The close already stores net liquidation,
     * cash value, the weekly figure, the trailing drawdown, buying power, the
     * four margin fields and the whole AccountValues dictionary. None of them is
     * here. The desk asked for a traffic light, and a traffic light that carries
     * the close's payload is just a second close with a worse name.
     *
     * TWO INTEGERS ANSWER "WHICH ARE RUNNING", and they are counted here rather
     * than shipped as a strategy array for the same reason: the question is how
     * many, so the wire carries how many.
     *
     * FORWARD AND BACKWARD COMPATIBLE BY NEWTONSOFT'S DEFAULTS. An old agent
     * reading a new add-on's response simply does not see `sample`, because
     * MissingMemberHandling defaults to Ignore in both directions. A new agent
     * asking an old add-on for this gets `invalid_request`, which is a clean
     * refusal and not a hang - see CaptureRequestProcessor. */
    public sealed class AccountSampleV1
    {
        [JsonProperty("schemaVersion")]
        public int SchemaVersion { get; set; }

        /// <summary>
        /// The machine's own clock at the moment it read the accounts. EVERY
        /// staleness judgement on every screen is made from this and never from
        /// the time the report arrived: a reading that spent minutes getting to
        /// the CRM must not land looking fresh.
        /// </summary>
        [JsonProperty("sampledAt")]
        public DateTimeOffset SampledAt { get; set; }

        [JsonProperty("accounts")]
        public IList<AccountSampleRowV1> Accounts { get; set; }
    }

    public sealed class AccountSampleRowV1
    {
        [JsonProperty("accountName")]
        public string AccountName { get; set; }

        [JsonProperty("connectionName")]
        public string ConnectionName { get; set; }

        /// <summary>
        /// Whether the account's connection was live when this was read.
        ///
        /// THE TRAFFIC LIGHT READS THIS, NOT <see cref="Status"/>. A boolean
        /// cannot be a word the CRM has never met, and it is the question the
        /// desk is actually asking. It also has to be carried explicitly,
        /// because unlike the close this sample KEEPS disconnected accounts: see
        /// AccountSampleRelevance for why an absent row and a dark row must not
        /// be the same thing.
        /// </summary>
        [JsonProperty("connected")]
        public bool Connected { get; set; }

        /// <summary>
        /// NinjaTrader's own ConnectionStatus word, verbatim, for the tooltip.
        /// Reported beside <see cref="Connected"/> rather than instead of it: it
        /// is free to read and it says WHICH flavour of not-connected this is,
        /// which is the difference between a machine to look at now and one to
        /// look at tomorrow.
        /// </summary>
        [JsonProperty("status")]
        public string Status { get; set; }

        [JsonProperty("realizedPnl")]
        public decimal? RealizedPnl { get; set; }

        [JsonProperty("unrealizedPnl")]
        public decimal? UnrealizedPnl { get; set; }

        [JsonProperty("totalPnl")]
        public decimal? TotalPnl { get; set; }

        /// <summary>
        /// How many strategies the account holds, and how many of those are
        /// actually live. NULL - both of them, together - means this sample did
        /// not measure it, which is NOT the same as an account holding no
        /// strategies, though both read "unmeasured" on screen. Neither is a
        /// zero, and the pair travels together or not at all: a total with no
        /// live count would read "the desk switched everything off" about an
        /// account nobody looked at.
        /// </summary>
        [JsonProperty("strategyCount")]
        public int? StrategyCount { get; set; }

        [JsonProperty("enabledStrategyCount")]
        public int? EnabledStrategyCount { get; set; }
    }
}
