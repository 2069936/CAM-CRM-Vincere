using System;
using System.Collections.Generic;
using System.Linq;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{

/* ---------------------------------------------------------------------------
 * WHICH ALGORITHM PLACED THE ORDERS NOBODY KEPT A RECORD FOR.
 *
 * The ledger beside this holds every link the platform asserted while we were
 * watching. Everything older than the agent is unattributed and cannot be
 * recovered from NinjaTrader, because the cascade already took it.
 *
 * It can be INFERRED, and the measurement that says so came off a real VPS on
 * 2026-09-24. Three strategies still had live links there, and the three
 * signatures do not overlap:
 *
 *   G4M-3.4        MES  PT1/PT2/PT3   enters 4, exits 2/1/1
 *   URGO-4.5       MNQ  PT1/PT2/PT3   enters 2 or 4
 *   Bullet Bot-1.1 NQ   a single PT   flat 2
 *
 * Across the whole seven months those axes keep separating: nine instruments,
 * and the exit ladder falls into four families - a lone PT (50 account and
 * instrument pairs), PT1 (125), PT1+PT2 (81), PT1+PT2+PT3 (46).
 *
 * THE ONE RULE THIS FILE EXISTS TO OBEY. A wrong strategy name is worse than
 * no strategy name. Absent, an account day shows up as unattributable and
 * somebody looks at it. Wrong, it silently moves a day's losses onto an
 * algorithm that never traded them, and every number computed from it after
 * that is confidently false. So:
 *
 *   - a signature that matches two strategies attributes to NEITHER;
 *   - a signature learned from a single order is not a signature;
 *   - every inferred row is labelled `inferred` and can be dropped by any
 *     reader that only wants record.
 *
 * WHAT IT CANNOT DO, stated so nobody has to discover it. It answers the algo,
 * not the version: URGO-4.5 and URGO-4.4 on the same instrument with the same
 * ladder are one signature. And an algorithm retired before the agent arrived
 * has no example to learn from, so its orders stay unattributed forever. That
 * is the honest outcome and the ledger is the only cure, going forward.
 * ------------------------------------------------------------------------- */

/// <summary>An order as the attribution needs to see it.</summary>
public sealed class AttributableOrder
{
    public AttributableOrder(long orderId, string accountName, string instrument, string orderName, int quantity)
    {
        OrderId = orderId;
        AccountName = accountName;
        Instrument = instrument;
        OrderName = orderName;
        Quantity = quantity;
    }

    public long OrderId { get; private set; }
    public string AccountName { get; private set; }
    public string Instrument { get; private set; }
    public string OrderName { get; private set; }
    public int Quantity { get; private set; }
}

public enum AttributionBasis
{
    /// <summary>The platform said so and we wrote it down before the cascade.</summary>
    Record,
    /// <summary>Nothing said so; the signature matched exactly one strategy.</summary>
    Inferred,
    /// <summary>Nothing said so and the signature did not settle it.</summary>
    None,
}

public sealed class AttributedOrder
{
    public AttributedOrder(long orderId, string strategyName, AttributionBasis basis, string signature)
    {
        OrderId = orderId;
        StrategyName = strategyName;
        Basis = basis;
        Signature = signature;
    }

    public long OrderId { get; private set; }
    public string StrategyName { get; private set; }
    public AttributionBasis Basis { get; private set; }
    public string Signature { get; private set; }
}

/// <summary>
/// What an order looks like to the matcher: the instrument it traded, the shape
/// of the exit ladder its strategy uses, and the size that ladder starts from.
///
/// The order NAME is in the signature only as its family (`PT1` from
/// `PT1-Short`), never its side. A strategy that goes long on Monday and short
/// on Tuesday is one strategy, and folding the side in would make it two.
/// </summary>
public sealed class OrderSignature : IEquatable<OrderSignature>
{
    public OrderSignature(string instrument, string ladder, int entryQuantity)
    {
        Instrument = instrument ?? string.Empty;
        Ladder = ladder ?? string.Empty;
        EntryQuantity = entryQuantity;
    }

    public string Instrument { get; private set; }
    public string Ladder { get; private set; }
    public int EntryQuantity { get; private set; }

    public bool Equals(OrderSignature other)
    {
        return other != null
            && string.Equals(Instrument, other.Instrument, StringComparison.OrdinalIgnoreCase)
            && string.Equals(Ladder, other.Ladder, StringComparison.OrdinalIgnoreCase)
            && EntryQuantity == other.EntryQuantity;
    }

    public override bool Equals(object obj) { return Equals(obj as OrderSignature); }

    public override int GetHashCode()
    {
        unchecked
        {
            int hash = 17;
            hash = (hash * 31) + StringComparer.OrdinalIgnoreCase.GetHashCode(Instrument);
            hash = (hash * 31) + StringComparer.OrdinalIgnoreCase.GetHashCode(Ladder);
            hash = (hash * 31) + EntryQuantity;
            return hash;
        }
    }

    public override string ToString() { return Instrument + "|" + Ladder + "|" + EntryQuantity; }
}

public static class OrderAttribution
{
    /// <summary>A ladder learned from fewer than this many orders is a coincidence.</summary>
    public const int MinimumOrdersPerSignature = 4;

    /// <summary>`PT1-Short` and `PT1-Long` are the same rung.</summary>
    public static string NameFamily(string orderName)
    {
        string name = (orderName ?? string.Empty).Trim();
        if (name.Length == 0) return string.Empty;
        int dash = name.IndexOf('-');
        string head = dash > 0 ? name.Substring(0, dash) : name;
        // "Enter Long" / "Stop Short" split on the space instead.
        int space = head.IndexOf(' ');
        if (space > 0) head = head.Substring(0, space);
        return head.Trim();
    }

    /// <summary>
    /// The exit ladder of a group of orders, as a stable string.
    ///
    /// Only the profit-target rungs, sorted: entries and stops are present in
    /// every strategy here and separate nothing. `PT` alone is a different
    /// shape from `PT1`, which is why the family is kept verbatim rather than
    /// stripped of its digit.
    /// </summary>
    public static string Ladder(IEnumerable<AttributableOrder> orders)
    {
        var rungs = (orders ?? Enumerable.Empty<AttributableOrder>())
            .Select(order => NameFamily(order?.OrderName))
            .Where(family => family.StartsWith("PT", StringComparison.OrdinalIgnoreCase))
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .OrderBy(family => family, StringComparer.OrdinalIgnoreCase)
            .ToList();
        return rungs.Count == 0 ? string.Empty : string.Join("+", rungs);
    }

    /// <summary>The size the strategy enters with, which the exits scale out of.</summary>
    public static int EntryQuantity(IEnumerable<AttributableOrder> orders)
    {
        var entries = (orders ?? Enumerable.Empty<AttributableOrder>())
            .Where(order => order != null
                && NameFamily(order.OrderName).Equals("Enter", StringComparison.OrdinalIgnoreCase)
                && order.Quantity > 0)
            .Select(order => order.Quantity)
            .ToList();
        if (entries.Count == 0) return 0;
        // The mode, not the maximum: a strategy that usually enters 2 and once
        // entered 4 on a re-entry is a 2.
        return entries.GroupBy(quantity => quantity)
            .OrderByDescending(group => group.Count())
            .ThenByDescending(group => group.Key)
            .First().Key;
    }

    /// <summary>
    /// Learn one signature per strategy from the orders we KNOW belong to it.
    ///
    /// Grouped by strategy and instrument, because the same algorithm on MES
    /// and on MNQ is two signatures and must not be averaged into one that
    /// matches neither.
    /// </summary>
    public static IReadOnlyDictionary<OrderSignature, string> LearnSignatures(
        IEnumerable<AttributableOrder> orders,
        IReadOnlyDictionary<long, string> strategyByOrderId)
    {
        var byStrategyAndInstrument = new Dictionary<Tuple<string, string>, List<AttributableOrder>>();
        foreach (AttributableOrder order in orders ?? Enumerable.Empty<AttributableOrder>())
        {
            if (order is null) continue;
            if (strategyByOrderId is null) break;
            string strategy;
            if (!strategyByOrderId.TryGetValue(order.OrderId, out strategy)) continue;
            if (string.IsNullOrWhiteSpace(strategy)) continue;
            var key = Tuple.Create(strategy, order.Instrument ?? string.Empty);
            List<AttributableOrder> bucket;
            if (!byStrategyAndInstrument.TryGetValue(key, out bucket))
            {
                bucket = new List<AttributableOrder>();
                byStrategyAndInstrument[key] = bucket;
            }
            bucket.Add(order);
        }

        // A signature two strategies produce identifies neither, so it is
        // dropped rather than given to whichever was learned first.
        var claims = new Dictionary<OrderSignature, HashSet<string>>();
        foreach (KeyValuePair<Tuple<string, string>, List<AttributableOrder>> pair in byStrategyAndInstrument)
        {
            string strategy = pair.Key.Item1;
            string instrument = pair.Key.Item2;
            List<AttributableOrder> bucket = pair.Value;
            if (bucket.Count < MinimumOrdersPerSignature) continue;
            string ladder = Ladder(bucket);
            if (ladder.Length == 0) continue;
            var signature = new OrderSignature(instrument, ladder, EntryQuantity(bucket));
            HashSet<string> owners;
            if (!claims.TryGetValue(signature, out owners))
            {
                owners = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                claims[signature] = owners;
            }
            owners.Add(strategy);
        }

        return claims
            .Where(pair => pair.Value.Count == 1)
            .ToDictionary(pair => pair.Key, pair => pair.Value.Single());
    }

    /// <summary>
    /// Attribute every order: from the ledger where we have it, from the
    /// signature where it settles, and from nothing otherwise.
    ///
    /// Orders are grouped by account and instrument before matching, because a
    /// ladder is a property of a run of trading and not of one order. One order
    /// on its own carries no ladder and is left alone.
    /// </summary>
    public static IReadOnlyList<AttributedOrder> Attribute(
        IEnumerable<AttributableOrder> orders,
        IReadOnlyDictionary<long, string> strategyByOrderId,
        IReadOnlyDictionary<OrderSignature, string> signatures)
    {
        var all = (orders ?? Enumerable.Empty<AttributableOrder>()).Where(order => order != null).ToList();
        var known = strategyByOrderId ?? new Dictionary<long, string>();
        var learned = signatures ?? new Dictionary<OrderSignature, string>();
        var results = new List<AttributedOrder>(all.Count);

        foreach (IGrouping<Tuple<string, string>, AttributableOrder> group in all.GroupBy(
            order => Tuple.Create(order.AccountName ?? string.Empty, order.Instrument ?? string.Empty)))
        {
            var bucket = group.ToList();
            string ladder = Ladder(bucket);
            int entry = EntryQuantity(bucket);
            var signature = new OrderSignature(group.Key.Item2, ladder, entry);
            string match;
            string inferred = ladder.Length > 0 && learned.TryGetValue(signature, out match) ? match : null;

            foreach (AttributableOrder order in bucket)
            {
                string recorded;
                if (known.TryGetValue(order.OrderId, out recorded) && !string.IsNullOrWhiteSpace(recorded))
                {
                    results.Add(new AttributedOrder(order.OrderId, recorded, AttributionBasis.Record, signature.ToString()));
                    continue;
                }
                results.Add(inferred == null
                    ? new AttributedOrder(order.OrderId, null, AttributionBasis.None, signature.ToString())
                    : new AttributedOrder(order.OrderId, inferred, AttributionBasis.Inferred, signature.ToString()));
            }
        }

        return results.OrderBy(result => result.OrderId).ToList();
    }
}

}
