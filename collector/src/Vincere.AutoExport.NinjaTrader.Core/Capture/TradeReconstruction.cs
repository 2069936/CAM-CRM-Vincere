using System;
using System.Collections.Generic;
using System.Linq;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{
    /* -----------------------------------------------------------------------
     * TURNING A LIST OF ORDERS BACK INTO THE TRADES THAT PRODUCED THEM.
     *
     * The geometry that identifies an algorithm is a property of a TRADE - one
     * entry and the exits that belong to it - and NinjaTrader stores orders,
     * not trades. Getting the grouping wrong is the difference between a
     * matcher that works and one that does not: a first attempt that paired
     * each entry with everything until the next entry recognised 12% of a real
     * machine's seven months, and the trades it did recognise were the ones
     * that happened to be clean.
     *
     * TWO THINGS BREAK THE NAIVE GROUPING, and both are normal trading.
     *
     * A re-entry while a position is open. The exits of the first trade are
     * still live when the second entry lands, so a walk that closes the group
     * on every entry hands the first trade's targets to the second.
     *
     * A trailed stop. The template declares the stop at its ORIGINAL distance,
     * and NinjaTrader rewrites the stop price as the trail moves it. Reading
     * the order's current price measures the trail, not the strategy. The
     * original is in the order's first update and that is what this reads.
     *
     * So an exit is matched to an entry by its QUANTITY LADDER rather than by
     * position in a list: the scale-out legs of a 4-lot entry are 2, 1 and 1,
     * and those are the exits that belong to it. An exit that fits no open
     * entry is left out of every trade rather than attached to the nearest one.
     * --------------------------------------------------------------------- */

    /// <summary>An order with everything the reconstruction needs.</summary>
    public sealed class TradeOrder
    {
        public TradeOrder(
            long orderId,
            string accountName,
            string instrument,
            string orderName,
            int quantity,
            double? fillPrice,
            double? originalPrice,
            long time)
        {
            OrderId = orderId;
            AccountName = accountName;
            Instrument = instrument;
            OrderName = orderName;
            Quantity = quantity;
            FillPrice = fillPrice;
            OriginalPrice = originalPrice;
            Time = time;
        }

        public long OrderId { get; private set; }
        public string AccountName { get; private set; }
        public string Instrument { get; private set; }
        public string OrderName { get; private set; }
        public int Quantity { get; private set; }

        /// <summary>The average fill, which is where an entry actually got in.</summary>
        public double? FillPrice { get; private set; }

        /// <summary>
        /// The limit or stop price as FIRST submitted, before any trail moved
        /// it. Null when the order has no update history to read it from.
        ///
        /// A ZERO IS NOT A PRICE, and the caller filling this must say so. An
        /// order row carries both a limit and a stop column and the one it does
        /// not use holds 0 rather than null, so a reader that takes
        /// `limit ?? stop` takes the zero and measures every stop from the
        /// instrument's own price. On crude that produced stops 6,411 ticks
        /// away and matched nothing at all; filtering the zeros took the same
        /// code from 0% to 55% on the same seven months.
        /// </summary>
        public double? OriginalPrice { get; private set; }

        public long Time { get; private set; }

        public string Rung { get { return OrderAttribution.NameFamily(OrderName); } }
        public bool IsEntry { get { return Rung.Equals("Enter", StringComparison.OrdinalIgnoreCase); } }
        public bool IsStop { get { return Rung.Equals("Stop", StringComparison.OrdinalIgnoreCase); } }
        public bool IsTarget { get { return Rung.StartsWith("PT", StringComparison.OrdinalIgnoreCase); } }

        /// <summary>`PT2-Short` is rung 2. A bare `PT` is rung 1.</summary>
        public int TargetNumber
        {
            get
            {
                if (!IsTarget) return 0;
                string digits = new string(Rung.Where(char.IsDigit).ToArray());
                int value;
                return digits.Length > 0 && int.TryParse(digits, out value) ? value : 1;
            }
        }
    }

    /// <summary>One entry and the exits that belong to it.</summary>
    public sealed class ReconstructedTrade
    {
        public ReconstructedTrade(TradeOrder entry, IEnumerable<TradeOrder> exits, double tickSize)
        {
            Entry = entry;
            Exits = new List<TradeOrder>(exits ?? new List<TradeOrder>());
            TickSize = tickSize;
        }

        public TradeOrder Entry { get; private set; }
        public IList<TradeOrder> Exits { get; private set; }
        public double TickSize { get; private set; }

        public IEnumerable<long> OrderIds
        {
            get { return new[] { Entry.OrderId }.Concat(Exits.Select(exit => exit.OrderId)); }
        }

        /// <summary>
        /// The geometry this trade exhibits, in the same units a template
        /// declares. Null when the entry never filled or the tick size is
        /// unknown: a distance measured against nothing is not a measurement.
        /// </summary>
        public StrategyFingerprint Fingerprint()
        {
            if (Entry == null || TickSize <= 0) return null;
            double? basis = Entry.FillPrice ?? Entry.OriginalPrice;
            if (!basis.HasValue || basis.Value <= 0) return null;

            int stop = 0;
            var targets = new Dictionary<int, TradeOrder>();
            foreach (TradeOrder exit in Exits)
            {
                if (!exit.OriginalPrice.HasValue) continue;
                int ticks = (int)Math.Round(Math.Abs(exit.OriginalPrice.Value - basis.Value) / TickSize);
                if (exit.IsStop) { if (stop == 0) stop = ticks; }
                else if (exit.IsTarget && !targets.ContainsKey(exit.TargetNumber)) targets[exit.TargetNumber] = exit;
            }

            return new StrategyFingerprint(
                Entry.Instrument,
                Size(targets, 1), Size(targets, 2), Size(targets, 3),
                stop,
                Ticks(targets, 1, basis.Value), Ticks(targets, 2, basis.Value), Ticks(targets, 3, basis.Value));
        }

        private int Size(IDictionary<int, TradeOrder> targets, int rung)
        {
            TradeOrder order;
            return targets.TryGetValue(rung, out order) ? order.Quantity : 0;
        }

        private int Ticks(IDictionary<int, TradeOrder> targets, int rung, double basis)
        {
            TradeOrder order;
            if (!targets.TryGetValue(rung, out order) || !order.OriginalPrice.HasValue) return 0;
            return (int)Math.Round(Math.Abs(order.OriginalPrice.Value - basis) / TickSize);
        }
    }

    public static class TradeReconstruction
    {
        /// <summary>
        /// Walk one account and instrument in time order, holding entries open
        /// until their scale-out quantity is accounted for.
        ///
        /// An entry of 4 expects exits totalling 4. Each exit is given to the
        /// OLDEST open entry that still has room for it, which is how a
        /// re-entry keeps its own targets instead of stealing the previous
        /// trade's. An exit that fits nowhere is dropped rather than guessed
        /// at, and an entry whose exits never arrived still yields a trade
        /// with whatever it has, because a stop-only trade is still a trade.
        /// </summary>
        public static IList<ReconstructedTrade> FromOrders(IEnumerable<TradeOrder> orders, double tickSize)
        {
            var ordered = (orders ?? new List<TradeOrder>())
                .Where(order => order != null)
                .OrderBy(order => order.Time)
                .ThenBy(order => order.OrderId)
                .ToList();

            var open = new List<OpenTrade>();
            var done = new List<ReconstructedTrade>();

            foreach (TradeOrder order in ordered)
            {
                if (order.IsEntry)
                {
                    open.Add(new OpenTrade(order));
                    continue;
                }
                OpenTrade target = open.FirstOrDefault(candidate => candidate.HasRoomFor(order));
                if (target == null) continue;
                target.Add(order);
            }

            foreach (OpenTrade trade in open)
            {
                done.Add(new ReconstructedTrade(trade.Entry, trade.Exits, tickSize));
            }

            return done;
        }

        private sealed class OpenTrade
        {
            private readonly List<TradeOrder> exits = new List<TradeOrder>();

            public OpenTrade(TradeOrder entry) { Entry = entry; }

            public TradeOrder Entry { get; private set; }
            public IEnumerable<TradeOrder> Exits { get { return exits; } }

            /// <summary>
            /// A stop covers the whole position, so one is enough. A target
            /// takes its own leg, and a rung already filled belongs to a later
            /// trade rather than this one.
            /// </summary>
            public bool HasRoomFor(TradeOrder order)
            {
                if (order.IsStop) return !exits.Any(exit => exit.IsStop);
                if (!order.IsTarget) return false;
                return !exits.Any(exit => exit.IsTarget && exit.TargetNumber == order.TargetNumber);
            }

            public void Add(TradeOrder order) { exits.Add(order); }
        }
    }
}
