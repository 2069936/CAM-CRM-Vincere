using System;
using System.Collections.Generic;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{
    /// <summary>
    /// What one strategy says it owns: how it identifies itself, and the ids of
    /// the orders and executions the platform lists under it.
    /// </summary>
    public sealed class StrategyOrderOwnership
    {
        public StrategyOrderOwnership(
            string strategyId,
            string strategyName,
            IEnumerable<string> orderIds,
            IEnumerable<string> executionIds)
        {
            StrategyId = strategyId;
            StrategyName = strategyName;
            OrderIds = Copy(orderIds);
            ExecutionIds = Copy(executionIds);
        }

        public string StrategyId { get; private set; }
        public string StrategyName { get; private set; }
        public IEnumerable<string> OrderIds { get; private set; }
        public IEnumerable<string> ExecutionIds { get; private set; }

        // Copied on the way in: the caller reads these off live platform
        // collections, and the map must not be holding an enumerator over one.
        private static IEnumerable<string> Copy(IEnumerable<string> ids)
        {
            return ids == null ? new List<string>() : new List<string>(ids);
        }
    }

    /// <summary>
    /// The strategy an order or a fill belongs to, as the snapshot reports it.
    /// Either field can be null: some platform versions expose no strategy id,
    /// and the CRM attributes on the name.
    /// </summary>
    public sealed class StrategyAttribution
    {
        public StrategyAttribution(string strategyId, string strategyName)
        {
            StrategyId = strategyId;
            StrategyName = strategyName;
        }

        public string StrategyId { get; private set; }
        public string StrategyName { get; private set; }
    }

    /// <summary>
    /// Which strategy owns which order and which fill, for one account.
    ///
    /// WHY THIS EXISTS.
    ///
    /// NinjaTrader names no strategy on an Order or an Execution: OnBehalfOf
    /// reads empty on this platform, and the capture wrote strategyId and
    /// strategyName as null on every order and every execution it sent. Measured
    /// on production for the window from 2026-09-01, 5,824 of 5,943 executions on
    /// the automatic path arrived with an empty strategy_name, against 18% on the
    /// manual CSV path, which reads NinjaTrader's own grid export where the column
    /// is populated; 37% of automatic closes carried no strategy rows at all. No
    /// derivation in the CRM can rescue an account day that arrives with neither a
    /// strategy grid nor a name on its fills, and 292 of 737 funded account days
    /// in the Stack Playbook's window were in exactly that state, carrying 57% of
    /// the window's losses.
    ///
    /// The link does exist on the machine. A Deep Export of a real VPS carries
    /// NinjaTrader's own Strategy2Order table with 225 rows, and each StrategyBase
    /// exposes the orders and executions it owns. This is that table in the
    /// direction the capture needs it: built once per account from what the
    /// strategies claim, then asked one row at a time.
    ///
    /// WHAT IT REFUSES TO DO.
    ///
    /// It adds attribution and never invents it. An id nobody claims, an id two
    /// strategies disagree about, and a blank id all resolve to nothing, which
    /// leaves the row exactly as it left here before this existed. A wrong
    /// strategy name is worse than an absent one: absent, the account day shows up
    /// as unattributable and someone looks at it; wrong, it silently moves a day's
    /// losses onto an algorithm that never traded them.
    /// </summary>
    public sealed class StrategyAttributionMap
    {
        /// <summary>An account whose strategies claim nothing.</summary>
        public static readonly StrategyAttributionMap Empty = Build(null);

        private readonly IDictionary<string, StrategyAttribution> byOrderId;
        private readonly IDictionary<string, StrategyAttribution> byExecutionId;

        private StrategyAttributionMap(
            IDictionary<string, StrategyAttribution> byOrderId,
            IDictionary<string, StrategyAttribution> byExecutionId)
        {
            this.byOrderId = byOrderId;
            this.byExecutionId = byExecutionId;
        }

        /// <summary>
        /// Folds what every strategy on one account claims into a single lookup.
        /// Build it per account: order ids are only unique within the connection
        /// that issued them.
        /// </summary>
        public static StrategyAttributionMap Build(IEnumerable<StrategyOrderOwnership> strategies)
        {
            var byOrderId = new Dictionary<string, StrategyAttribution>(StringComparer.Ordinal);
            var byExecutionId = new Dictionary<string, StrategyAttribution>(StringComparer.Ordinal);
            foreach (StrategyOrderOwnership strategy in strategies ?? Array.Empty<StrategyOrderOwnership>())
            {
                if (strategy == null)
                    continue;
                StrategyAttribution attribution = AttributionOf(strategy);
                if (attribution == null)
                    continue;
                foreach (string orderId in strategy.OrderIds)
                    Claim(byOrderId, orderId, attribution);
                foreach (string executionId in strategy.ExecutionIds)
                    Claim(byExecutionId, executionId, attribution);
            }
            return new StrategyAttributionMap(byOrderId, byExecutionId);
        }

        /// <summary>
        /// The strategy that placed this order, or null when no strategy claims
        /// it or more than one does.
        /// </summary>
        public StrategyAttribution ResolveOrder(string orderId)
        {
            StrategyAttribution attribution;
            TryResolve(byOrderId, orderId, out attribution);
            return attribution;
        }

        /// <summary>
        /// The strategy behind a fill. A fill the strategy lists answers for
        /// itself; one it does not list is attributed through the order it filled,
        /// which is the ordinary case, because a strategy keeps its orders for the
        /// session and its execution list is the shorter of the two.
        ///
        /// A fill whose own id is claimed by two strategies is NOT then rescued
        /// through its order: the account's strategies have contradicted each
        /// other about this fill, and reaching for the other key until one of them
        /// answers is how a guess gets dressed as a fact.
        /// </summary>
        public StrategyAttribution ResolveExecution(string executionId, string orderId)
        {
            StrategyAttribution attribution;
            if (TryResolve(byExecutionId, executionId, out attribution))
                return attribution;
            return ResolveOrder(orderId);
        }

        // True when the id was claimed at all, which is not the same as having an
        // answer for it: a contested id is present and resolves to null.
        private static bool TryResolve(
            IDictionary<string, StrategyAttribution> claims,
            string id,
            out StrategyAttribution attribution)
        {
            attribution = null;
            string key = Key(id);
            return key != null && claims.TryGetValue(key, out attribution);
        }

        private static void Claim(
            IDictionary<string, StrategyAttribution> claims,
            string id,
            StrategyAttribution attribution)
        {
            // A blank id is not an id. It never enters the map, so it can never be
            // matched by the blank OrderId an order or a fill can also carry, which
            // would attribute unrelated rows to each other wholesale.
            string key = Key(id);
            if (key == null)
                return;

            StrategyAttribution standing;
            if (!claims.TryGetValue(key, out standing))
            {
                claims[key] = attribution;
                return;
            }
            if (standing == null || SameStrategy(standing, attribution))
                return;

            // TWO STRATEGIES, ONE ID: THE ID ATTRIBUTES TO NOBODY.
            //
            // Null is kept as a tombstone rather than removing the entry, so a
            // third strategy claiming the same id later in the walk cannot win it,
            // and so the contest does not depend on the order the strategies were
            // read in. The same strategy listed twice, or the same id reached
            // through both an order and one of its fills, is not a contest: those
            // agree, and agreement resolves.
            claims[key] = null;
        }

        private static StrategyAttribution AttributionOf(StrategyOrderOwnership strategy)
        {
            string id = Reported(strategy.StrategyId);
            string name = Reported(strategy.StrategyName);
            // Nothing to attribute with. A strategy that can name neither itself
            // nor its id would stamp orders with two nulls, which is what they
            // already carry.
            return id == null && name == null
                ? null
                : new StrategyAttribution(id, name);
        }

        private static bool SameStrategy(StrategyAttribution left, StrategyAttribution right)
        {
            return String.Equals(Key(left.StrategyId), Key(right.StrategyId), StringComparison.Ordinal)
                && String.Equals(Key(left.StrategyName), Key(right.StrategyName), StringComparison.Ordinal);
        }

        // Ids are matched on their trimmed text, so padding a provider adds to an
        // id does not cost the row its strategy.
        private static string Key(string id)
        {
            return String.IsNullOrWhiteSpace(id) ? null : id.Trim();
        }

        // What we attribute WITH is kept exactly as the platform reported it, so
        // the strategyName on an order is the same string the strategies section
        // carries for that strategy and the CRM's join on the two holds.
        private static string Reported(string value)
        {
            return String.IsNullOrWhiteSpace(value) ? null : value;
        }
    }
}
