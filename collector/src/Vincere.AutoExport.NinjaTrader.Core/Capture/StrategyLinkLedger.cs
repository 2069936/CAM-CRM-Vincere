using System;
using System.Collections.Generic;
using System.Linq;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{
    /* -----------------------------------------------------------------------
     * THE LINK NINJATRADER DELETES, KEPT BEFORE IT GOES.
     *
     * NinjaTrader records which strategy placed an order in Strategy2Order.
     * Read that table on a real VPS on 2026-09-24 and it holds 29 rows against
     * 18,827 orders spanning seven months, on 5 of 129 accounts, with the
     * execution level table empty. That is not a platform that never knew: it
     * is the schema doing what it says.
     *
     *     Strategy integer not null references Strategies on delete cascade
     *
     * `Strategies` holds the strategies configured RIGHT NOW, twelve of them on
     * that machine. Remove one from the workspace and the cascade takes every
     * link it ever had with it. A desk that rotates algorithms - which is this
     * desk's entire job - destroys its own attribution every time it does so,
     * and the orders stay behind with no way back to the algorithm that placed
     * them.
     *
     * So this is an append-only ledger, written by the agent while the rows are
     * still there. Once a link is observed it is ours; a later cascade cannot
     * unsay it. It is deliberately dumb: no interpretation, no inference, no
     * deletion. Every entry is something the platform itself asserted on a date
     * we can name.
     *
     * WHAT IT IS NOT. It is not a cache of NinjaTrader's tables and must never
     * be treated as authoritative about the present - a strategy renamed after
     * an entry was written keeps its old name here, which is correct, because
     * that is what it was called when it placed that order.
     * --------------------------------------------------------------------- */

    /// <summary>One assertion the platform made: this strategy placed this order.</summary>
    public sealed class StrategyOrderLink
    {
        public StrategyOrderLink(
            long orderId,
            long strategyId,
            string strategyName,
            string accountName,
            string firstSeenUtc)
        {
            OrderId = orderId;
            StrategyId = strategyId;
            StrategyName = strategyName;
            AccountName = accountName;
            FirstSeenUtc = firstSeenUtc;
        }

        public long OrderId { get; private set; }
        public long StrategyId { get; private set; }
        public string StrategyName { get; private set; }
        public string AccountName { get; private set; }
        public string FirstSeenUtc { get; private set; }

        /// <summary>Identity is the pair, not the names. A rename is not a new link.</summary>
        public string Key
        {
            get { return OrderId.ToString() + ":" + StrategyId.ToString(); }
        }

        public StrategyOrderLink WithNames(string strategyName, string accountName)
        {
            return new StrategyOrderLink(OrderId, StrategyId, strategyName, accountName, FirstSeenUtc);
        }
    }

    public static class StrategyLinkLedger
    {
        /// <summary>
        /// Fold newly observed links into what is already held.
        ///
        /// FIRST OBSERVATION WINS, and that is the whole point of the date. A
        /// link seen today and again next month is one link, first seen today,
        /// and the ledger says so. Re-running an export twice in an afternoon
        /// therefore changes nothing, which is what makes it safe to call on
        /// every capture.
        ///
        /// A later observation may still correct the NAMES: an account or
        /// strategy name that was blank when first seen and is readable now is
        /// worth taking, because a blank name attributes nothing. A name that
        /// merely CHANGED is left alone, for the reason in the type's comment.
        /// </summary>
        public static IList<StrategyOrderLink> Merge(
            IEnumerable<StrategyOrderLink> held,
            IEnumerable<StrategyOrderLink> observed)
        {
            var byKey = new Dictionary<string, StrategyOrderLink>(StringComparer.Ordinal);
            foreach (StrategyOrderLink link in Safe(held))
            {
                if (!Usable(link)) continue;
                byKey[link.Key] = link;
            }

            foreach (StrategyOrderLink link in Safe(observed))
            {
                if (!Usable(link)) continue;
                StrategyOrderLink existing;
                if (!byKey.TryGetValue(link.Key, out existing))
                {
                    byKey[link.Key] = link;
                    continue;
                }

                byKey[link.Key] = existing.WithNames(
                    Fill(existing.StrategyName, link.StrategyName),
                    Fill(existing.AccountName, link.AccountName));
            }

            return byKey.Values
                .OrderBy(link => link.OrderId)
                .ThenBy(link => link.StrategyId)
                .ToList();
        }

        private static IEnumerable<StrategyOrderLink> Safe(IEnumerable<StrategyOrderLink> source)
        {
            return source ?? new List<StrategyOrderLink>();
        }

        private static bool Usable(StrategyOrderLink link)
        {
            return link != null && link.OrderId > 0 && link.StrategyId > 0;
        }

        /// <summary>A blank we hold is worth replacing; a value we hold is not.</summary>
        private static string Fill(string held, string observed)
        {
            return string.IsNullOrWhiteSpace(held) && !string.IsNullOrWhiteSpace(observed)
                ? observed
                : held;
        }

        /// <summary>
        /// How much of the order history the ledger can speak for.
        ///
        /// Reported rather than assumed: a desk asking "do you know what ran on
        /// this account" deserves a number, and on a machine where the agent was
        /// installed last week that number is small and must look small.
        /// </summary>
        public static LedgerCoverage Coverage(IEnumerable<StrategyOrderLink> held, long totalOrders)
        {
            var links = Safe(held).Where(link => link != null && link.OrderId > 0).ToList();
            return new LedgerCoverage(
                links.Count,
                links.Select(link => link.OrderId).Distinct().Count(),
                links.Select(link => link.StrategyId).Distinct().Count(),
                links.Select(link => link.AccountName)
                    .Where(name => !string.IsNullOrWhiteSpace(name))
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .Count(),
                Math.Max(0, totalOrders));
        }
    }

    public sealed class LedgerCoverage
    {
        public LedgerCoverage(int links, int orders, int strategies, int accounts, long totalOrders)
        {
            Links = links;
            Orders = orders;
            Strategies = strategies;
            Accounts = accounts;
            TotalOrders = totalOrders;
        }

        public int Links { get; private set; }
        public int Orders { get; private set; }
        public int Strategies { get; private set; }
        public int Accounts { get; private set; }
        public long TotalOrders { get; private set; }

        /// <summary>Whole percent, floored, so a coverage of 0.4% never reads as 1%.</summary>
        public int OrderPercent
        {
            get { return TotalOrders <= 0 ? 0 : (int)(Orders * 100L / TotalOrders); }
        }
    }
}
