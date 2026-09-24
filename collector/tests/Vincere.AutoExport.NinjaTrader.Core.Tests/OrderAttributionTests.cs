using System.Collections.Generic;
using System.Linq;
using Vincere.AutoExport.NinjaTrader.Core.Capture;
using Xunit;

namespace Vincere.AutoExport.NinjaTrader.Core.Tests;

/* The numbers in these tests are the ones measured on a real VPS export on
 * 2026-09-24: 18,827 orders over seven months, 29 of them still carrying a
 * strategy link, on 5 of 129 accounts. The three strategies that survived had
 * these signatures, and they are what the matcher has to learn. */
public class OrderAttributionTests
{
    private static AttributableOrder Order(long id, string account, string instrument, string name, int quantity)
        => new AttributableOrder(id, account, instrument, name, quantity);

    /// <summary>G4M on MES: enters 4, scales out 2/1/1 across three targets.</summary>
    private static List<AttributableOrder> G4m(long from, string account = "A1")
        => new List<AttributableOrder>
        {
            Order(from, account, "MES", "Enter Short", 4),
            Order(from + 1, account, "MES", "PT1-Short", 2),
            Order(from + 2, account, "MES", "PT2-Short", 1),
            Order(from + 3, account, "MES", "PT3-Short", 1),
            Order(from + 4, account, "MES", "Stop Short", 4),
        };

    /// <summary>Bullet Bot on NQ: one target, flat 2.</summary>
    private static List<AttributableOrder> BulletBot(long from, string account = "B1")
        => new List<AttributableOrder>
        {
            Order(from, account, "NQ", "Enter Long", 2),
            Order(from + 1, account, "NQ", "PT-Long", 2),
            Order(from + 2, account, "NQ", "Stop Long", 2),
            Order(from + 3, account, "NQ", "Enter Long", 2),
        };

    [Fact]
    public void ALadderIsTheProfitTargetsAndNothingElse()
    {
        // Entries and stops are in every strategy here and separate nothing.
        Assert.Equal("PT1+PT2+PT3", OrderAttribution.Ladder(G4m(1)));
        Assert.Equal("PT", OrderAttribution.Ladder(BulletBot(1)));
        Assert.Equal(string.Empty, OrderAttribution.Ladder(new[] { Order(1, "A", "MES", "Enter Long", 1) }));
    }

    [Fact]
    public void LongAndShortAreOneStrategy()
    {
        // Folding the side into the signature would make every algorithm two.
        Assert.Equal("PT1", OrderAttribution.NameFamily("PT1-Short"));
        Assert.Equal("PT1", OrderAttribution.NameFamily("PT1-Long"));
        Assert.Equal("Enter", OrderAttribution.NameFamily("Enter Short"));
        Assert.Equal("Stop", OrderAttribution.NameFamily("Stop Long"));
        Assert.Equal(string.Empty, OrderAttribution.NameFamily(null));
    }

    [Fact]
    public void TheEntrySizeIsTheUsualOneNotTheLargest()
    {
        // A strategy that normally enters 2 and re-entered 4 once is a 2.
        var orders = new List<AttributableOrder>
        {
            Order(1, "A", "MNQ", "Enter Short", 2),
            Order(2, "A", "MNQ", "Enter Short", 2),
            Order(3, "A", "MNQ", "Enter Short", 4),
        };
        Assert.Equal(2, OrderAttribution.EntryQuantity(orders));
    }

    [Fact]
    public void LearnsTheSignatureOfEachStrategyItHasLinksFor()
    {
        var orders = G4m(1).Concat(BulletBot(100)).ToList();
        var known = new Dictionary<long, string>();
        foreach (var order in G4m(1)) known[order.OrderId] = "0 - G4M-3.4";
        foreach (var order in BulletBot(100)) known[order.OrderId] = "Bullet Bot-1.1";

        var signatures = OrderAttribution.LearnSignatures(orders, known);

        Assert.Equal(2, signatures.Count);
        Assert.Equal("0 - G4M-3.4", signatures[new OrderSignature("MES", "PT1+PT2+PT3", 4)]);
        Assert.Equal("Bullet Bot-1.1", signatures[new OrderSignature("NQ", "PT", 2)]);
    }

    [Fact]
    public void AttributesHistoryFromASignatureAndSaysItInferred()
    {
        // The whole point: orders from months ago, whose link the cascade ate.
        var known = new Dictionary<long, string>();
        foreach (var order in G4m(1)) known[order.OrderId] = "0 - G4M-3.4";
        var signatures = OrderAttribution.LearnSignatures(G4m(1), known);

        var history = G4m(500, "OLD-ACCOUNT");
        var attributed = OrderAttribution.Attribute(history, new Dictionary<long, string>(), signatures);

        Assert.All(attributed, row =>
        {
            Assert.Equal("0 - G4M-3.4", row.StrategyName);
            Assert.Equal(AttributionBasis.Inferred, row.Basis);
        });
    }

    [Fact]
    public void RecordAlwaysBeatsInference()
    {
        var known = new Dictionary<long, string>();
        foreach (var order in G4m(1)) known[order.OrderId] = "0 - G4M-3.4";
        var signatures = OrderAttribution.LearnSignatures(G4m(1), known);

        // The same orders, now with the ledger's own answer for one of them,
        // which disagrees. The ledger wins: it is what the platform asserted.
        var ledger = new Dictionary<long, string> { [2] = "Something Else-1.0" };
        var attributed = OrderAttribution.Attribute(G4m(1), ledger, signatures);

        AttributedOrder recorded = attributed.Single(row => row.OrderId == 2);
        Assert.Equal("Something Else-1.0", recorded.StrategyName);
        Assert.Equal(AttributionBasis.Record, recorded.Basis);
    }

    [Fact]
    public void ASignatureTwoStrategiesShareAttributesToNeither()
    {
        // A wrong strategy name is worse than an absent one: it moves a day's
        // losses onto an algorithm that never traded them.
        var twin = G4m(1).Concat(G4m(50, "A2")).ToList();
        var known = new Dictionary<long, string>();
        foreach (var order in G4m(1)) known[order.OrderId] = "0 - G4M-3.4";
        foreach (var order in G4m(50, "A2")) known[order.OrderId] = "0 - URGO-4.5";

        var signatures = OrderAttribution.LearnSignatures(twin, known);
        Assert.Empty(signatures);

        var attributed = OrderAttribution.Attribute(G4m(900, "OLD"), new Dictionary<long, string>(), signatures);
        Assert.All(attributed, row => Assert.Equal(AttributionBasis.None, row.Basis));
        Assert.All(attributed, row => Assert.Null(row.StrategyName));
    }

    [Fact]
    public void ASignatureLearnedFromOneOrderIsNotASignature()
    {
        var single = new List<AttributableOrder> { Order(1, "A", "MES", "PT1-Short", 1) };
        var known = new Dictionary<long, string> { [1] = "0 - G4M-3.4" };
        Assert.Empty(OrderAttribution.LearnSignatures(single, known));
    }

    [Fact]
    public void TheSameAlgorithmOnTwoInstrumentsIsTwoSignatures()
    {
        // Averaging them would produce one signature that matches neither.
        var mes = G4m(1);
        var mnq = new List<AttributableOrder>
        {
            Order(20, "A", "MNQ", "Enter Short", 2),
            Order(21, "A", "MNQ", "PT1-Short", 1),
            Order(22, "A", "MNQ", "PT2-Short", 1),
            Order(23, "A", "MNQ", "Stop Short", 2),
        };
        var known = new Dictionary<long, string>();
        foreach (var order in mes.Concat(mnq)) known[order.OrderId] = "0 - G4M-3.4";

        var signatures = OrderAttribution.LearnSignatures(mes.Concat(mnq).ToList(), known);

        Assert.Equal(2, signatures.Count);
        Assert.Equal("0 - G4M-3.4", signatures[new OrderSignature("MES", "PT1+PT2+PT3", 4)]);
        Assert.Equal("0 - G4M-3.4", signatures[new OrderSignature("MNQ", "PT1+PT2", 2)]);
    }

    [Fact]
    public void SurvivesEmptyAndMalformedInput()
    {
        Assert.Empty(OrderAttribution.Attribute(null, null, null));
        Assert.Empty(OrderAttribution.LearnSignatures(null, null));
        Assert.Equal(0, OrderAttribution.EntryQuantity(null));
        Assert.Equal(string.Empty, OrderAttribution.Ladder(null));
    }
}

public class StrategyLinkLedgerTests
{
    private static StrategyOrderLink Link(long order, long strategy, string name = "G4M", string account = "A1", string seen = "2026-09-24T10:00:00Z")
        => new StrategyOrderLink(order, strategy, name, account, seen);

    [Fact]
    public void FirstObservationWinsSoReRunningChangesNothing()
    {
        var held = new[] { Link(1, 7, seen: "2026-09-01T00:00:00Z") };
        var again = new[] { Link(1, 7, seen: "2026-09-24T00:00:00Z") };
        var merged = StrategyLinkLedger.Merge(held, again);
        Assert.Single(merged);
        Assert.Equal("2026-09-01T00:00:00Z", merged[0].FirstSeenUtc);
    }

    [Fact]
    public void ARenameDoesNotRewriteHistoryButABlankIsFilled()
    {
        // What the strategy was CALLED when it placed that order is the fact
        // worth keeping. A blank, though, attributes nothing and is replaced.
        var held = new[] { Link(1, 7, name: "G4M-3.3"), Link(2, 8, name: "", account: "") };
        var observed = new[] { Link(1, 7, name: "G4M-3.4"), Link(2, 8, name: "URGO-4.5", account: "A9") };
        var merged = StrategyLinkLedger.Merge(held, observed);

        Assert.Equal("G4M-3.3", merged.Single(link => link.OrderId == 1).StrategyName);
        Assert.Equal("URGO-4.5", merged.Single(link => link.OrderId == 2).StrategyName);
        Assert.Equal("A9", merged.Single(link => link.OrderId == 2).AccountName);
    }

    [Fact]
    public void KeepsBothStrategiesWhenTwoClaimTheSameOrder()
    {
        // The ledger records; it does not adjudicate. Whoever reads it decides
        // what an order claimed by two strategies means.
        var merged = StrategyLinkLedger.Merge(
            new[] { Link(1, 7, name: "G4M") },
            new[] { Link(1, 8, name: "URGO") });
        Assert.Equal(2, merged.Count);
    }

    [Fact]
    public void DropsRowsThatCannotBeALink()
    {
        var merged = StrategyLinkLedger.Merge(
            new[] { Link(0, 7), Link(1, 0), null },
            new[] { Link(5, 9) });
        Assert.Single(merged);
        Assert.Equal(5, merged[0].OrderId);
    }

    [Fact]
    public void ReportsCoverageAsAFractionOfTheWholeHistory()
    {
        // The measured state of a real machine: 29 links against 18,827 orders.
        var links = Enumerable.Range(1, 29).Select(i => Link(i, 7, account: "A" + (i % 5))).ToList();
        LedgerCoverage coverage = StrategyLinkLedger.Coverage(links, 18827);

        Assert.Equal(29, coverage.Links);
        Assert.Equal(29, coverage.Orders);
        Assert.Equal(5, coverage.Accounts);
        // 0.15%, which must read as 0 rather than round up to 1.
        Assert.Equal(0, coverage.OrderPercent);
    }

    [Fact]
    public void CoverageSurvivesNothingToReport()
    {
        LedgerCoverage coverage = StrategyLinkLedger.Coverage(null, 0);
        Assert.Equal(0, coverage.Links);
        Assert.Equal(0, coverage.OrderPercent);
    }
}
