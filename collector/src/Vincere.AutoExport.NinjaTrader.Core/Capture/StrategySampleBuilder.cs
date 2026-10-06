using System;
using System.Collections.Generic;
using Vincere.AutoExport.Contracts;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{
    public sealed class StrategySampleBuildContext
    {
        /// <summary>The machine's clock when the strategies were read.</summary>
        public DateTimeOffset SampledAt { get; set; }
    }

    /// <summary>
    /// Builds the per strategy reading from what the facade read.
    ///
    /// ONLY LIVE INSTANCES TRAVEL. A strategy in Realtime or Transition is one the
    /// desk has switched on. The others are loading, stopped or dead, and the
    /// measured captures hold a Finalized instance and a Realtime one sharing the
    /// same id (7 groups in 6 files): keeping state out of the identity and the
    /// dead ones off the wire is what makes (account, id) unique again.
    ///
    /// A ROW WITHOUT AN IDENTITY IS DROPPED, NOT SENT. The route refuses the whole
    /// post for one blank string, so one unnameable instance must not cost the
    /// rest of the reading.
    ///
    /// DUPLICATES KEEP THE FIRST, for the same reason: the route refuses a post
    /// that names one (account, id) twice. Account names compare the way every
    /// other account comparison here does, ignoring case; ids compare exactly.
    ///
    /// P&L IS PASSED THROUGH AS READ. Null stays null, because null is "not
    /// measured" and the CRM shows it as such rather than as a zero.
    /// </summary>
    public sealed class StrategySampleBuilder
    {
        private readonly IStrategySampleFacade facade;

        public StrategySampleBuilder(IStrategySampleFacade facade)
        {
            this.facade = facade ?? throw new ArgumentNullException(nameof(facade));
        }

        public StrategySampleV1 Build(StrategySampleBuildContext context)
        {
            if (context == null) throw new ArgumentNullException(nameof(context));

            IEnumerable<StrategySampleCaptureSource> sources = facade.ReadStrategiesForSample();
            var rows = new List<StrategySampleRowV1>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            if (sources != null)
            {
                foreach (StrategySampleCaptureSource source in sources)
                {
                    if (source == null || !StrategyLiveCount.IsLive(source.State)) continue;
                    if (String.IsNullOrWhiteSpace(source.AccountName)
                        || String.IsNullOrWhiteSpace(source.StrategyId)
                        || String.IsNullOrWhiteSpace(source.StrategyName)
                        || String.IsNullOrWhiteSpace(source.Instrument))
                        continue;

                    string accountName = source.AccountName.Trim();
                    string strategyId = source.StrategyId.Trim();
                    if (!seen.Add(accountName.ToUpperInvariant() + "\u0000" + strategyId)) continue;

                    rows.Add(new StrategySampleRowV1
                    {
                        AccountName = accountName,
                        StrategyId = strategyId,
                        StrategyName = source.StrategyName.Trim(),
                        Instrument = source.Instrument.Trim(),
                        RealizedPnl = source.RealizedPnl,
                        UnrealizedPnl = source.UnrealizedPnl,
                        RestartedAt = null,
                    });
                }
            }

            return new StrategySampleV1
            {
                SchemaVersion = StrategySampleV1.CurrentSchemaVersion,
                SampledAt = context.SampledAt,
                Strategies = rows,
            };
        }
    }
}
