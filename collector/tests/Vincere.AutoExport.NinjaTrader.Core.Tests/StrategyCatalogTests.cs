using System.Collections.Generic;
using System.Linq;
using Vincere.AutoExport.NinjaTrader.Core.Capture;
using Xunit;

namespace Vincere.AutoExport.NinjaTrader.Core.Tests;

/* Every number here was measured on a real VPS export on 2026-09-24: 886
 * templates across 20 algorithm families, 18,827 orders over seven months,
 * 4,696 reconstructed trades. The G4M template declares PosSize 2/1/1, stop
 * 80, targets 80/120/160, and its orders sat at exactly those distances. */
public class StrategyCatalogTests
{
    private static StrategyTemplate Template(
        string family, string version, string risk, string instrument,
        int s1, int s2, int s3, int stop, int t1, int t2, int t3, bool pf = false)
        => new StrategyTemplate(family, version, risk, pf,
            new StrategyFingerprint(instrument, s1, s2, s3, stop, t1, t2, t3));

    /// <summary>The real G4M MES configuration.</summary>
    private static StrategyTemplate G4m(string version = "v1")
        => Template("G4M", version, "Low", "MES", 2, 1, 1, 80, 80, 120, 160);

    private static TradeGeometry Trade(string instrument, int stop, params (int rung, int ticks, int size)[] rungs)
    {
        var geometry = new TradeGeometry(instrument) { StopTicks = stop };
        foreach ((int rung, int ticks, int size) in rungs) geometry.AddRung(rung, ticks, size);
        return geometry;
    }

    [Fact]
    public void AFullTradeMatchesTheTemplateThatDeclaredIt()
    {
        var catalog = new StrategyCatalog(new[] { G4m() });
        FingerprintMatch match = catalog.Match(
            Trade("MES", 80, (1, 80, 2), (2, 120, 1), (3, 160, 1)));

        Assert.True(match.Matched);
        Assert.Equal("G4M", match.Family);
        Assert.Equal("v1", match.Version);
        Assert.True(match.VersionCertain);
    }

    [Fact]
    public void ATradeStoppedOutAfterTwoTargetsStillMatches()
    {
        // THE DEFECT THIS EXISTS FOR. Requiring all three declared rungs meant
        // only 446 of 4,782 real trades could ever match, and the matcher
        // recognised 5% of seven months. Comparing what the trade actually
        // placed took it to 55%. A trade that took PT1 and PT2 and was then
        // stopped never places a third order; asking for one asks about an
        // order that does not exist.
        var catalog = new StrategyCatalog(new[] { G4m() });
        FingerprintMatch match = catalog.Match(Trade("MES", 80, (1, 80, 2), (2, 120, 1)));

        Assert.True(match.Matched);
        Assert.Equal("G4M", match.Family);
    }

    [Fact]
    public void OneTargetAndAStopIsEnoughWhenItIsUnambiguous()
    {
        var catalog = new StrategyCatalog(new[] { G4m() });
        Assert.Equal("G4M", catalog.Match(Trade("MES", 80, (1, 80, 2))).Family);
    }

    [Fact]
    public void ARungThatDisagreesOnDistanceOrSizeIsNotThatStrategy()
    {
        var catalog = new StrategyCatalog(new[] { G4m() });
        // Five ticks out is a different VERSION, not noise, which is why the
        // comparison is exact and never fuzzy.
        Assert.False(catalog.Match(Trade("MES", 80, (1, 85, 2))).Matched);
        // The right distance taken in the wrong size is a different ladder.
        Assert.False(catalog.Match(Trade("MES", 80, (1, 80, 4))).Matched);
        Assert.False(catalog.Match(Trade("MES", 75, (1, 80, 2))).Matched);
    }

    [Fact]
    public void AnAlgorithmAndItsOwnPropFirmVariantAreOneAnswer()
    {
        // Measured: 105 of 173 fingerprints were shared by exactly two
        // families, and every pair was an algorithm and its own _PF variant.
        // Zero genuinely different algorithms collided.
        var catalog = new StrategyCatalog(new[]
        {
            G4m(),
            Template("G4M", "v1", "Low", "MES", 2, 1, 1, 80, 80, 120, 160, pf: true),
        });
        FingerprintMatch match = catalog.Match(Trade("MES", 80, (1, 80, 2), (2, 120, 1)));

        Assert.Equal("G4M", match.Family);
        Assert.Equal(2, match.Candidates);
    }

    [Fact]
    public void TwoDifferENTAlgorithmsSharingAGeometryAnswerNeither()
    {
        var catalog = new StrategyCatalog(new[]
        {
            G4m(),
            Template("URGO", "v1", "Low", "MES", 2, 1, 1, 80, 80, 120, 160),
        });
        Assert.False(catalog.Match(Trade("MES", 80, (1, 80, 2))).Matched);
    }

    [Fact]
    public void TheFamilyIsCertainAndTheVersionIsNotAlwaysAnswered()
    {
        // Measured: of 50 family/instrument/risk groups, 33 change geometry
        // between versions and 17 do not. Where they do not, the version is
        // reported as null rather than picked.
        var catalog = new StrategyCatalog(new[] { G4m("v1"), G4m("v2") });
        FingerprintMatch match = catalog.Match(Trade("MES", 80, (1, 80, 2), (2, 120, 1)));

        Assert.Equal("G4M", match.Family);
        Assert.Null(match.Version);
        Assert.False(match.VersionCertain);
    }

    [Fact]
    public void AnotherInstrumentIsAnotherStrategyEvenWithTheSameLadder()
    {
        var catalog = new StrategyCatalog(new[] { G4m() });
        Assert.False(catalog.Match(Trade("MNQ", 80, (1, 80, 2), (2, 120, 1))).Matched);
    }

    [Fact]
    public void ATradeThatShowsNothingIsNotCompared()
    {
        var catalog = new StrategyCatalog(new[] { G4m() });
        Assert.False(catalog.Match(new TradeGeometry("MES")).Matched);
        Assert.False(catalog.Match(null).Matched);
        Assert.False(catalog.Match(new TradeGeometry(null)).Matched);
    }

    [Fact]
    public void ATemplateWithNoGeometryIsNotInTheCatalogue()
    {
        var catalog = new StrategyCatalog(new[]
        {
            Template("Ghost", "v1", "Low", "MES", 0, 0, 0, 0, 0, 0, 0),
            null,
        });
        Assert.Equal(0, catalog.Size);
    }
}

public class TradeReconstructionTests
{
    private static TradeOrder Order(long id, string name, int qty, double? fill, double? original, long time)
        => new TradeOrder(id, "A1", "MES", name, qty, fill, original, time);

    [Fact]
    public void AnEntryKeepsTheExitsThatBelongToIt()
    {
        var orders = new List<TradeOrder>
        {
            Order(1, "Enter Short", 4, 7691.25, null, 10),
            Order(2, "PT1-Short", 2, null, 7671.25, 11),
            Order(3, "PT2-Short", 1, null, 7661.25, 12),
            Order(4, "Stop Short", 4, null, 7711.25, 13),
        };
        IList<ReconstructedTrade> trades = TradeReconstruction.FromOrders(orders, 0.25);

        Assert.Single(trades);
        StrategyFingerprint print = trades[0].Fingerprint();
        Assert.Equal(80, print.Target1Ticks);
        Assert.Equal(120, print.Target2Ticks);
        Assert.Equal(80, print.StopTicks);
        Assert.Equal(2, print.Size1);
    }

    [Fact]
    public void AReEntryDoesNotStealThePreviousTradesTargets()
    {
        // A walk that closes the group on every entry hands the first trade's
        // still-live targets to the second. The rung each exit fills is what
        // decides which open entry owns it.
        var orders = new List<TradeOrder>
        {
            Order(1, "Enter Short", 4, 100.0, null, 10),
            Order(2, "Enter Short", 4, 200.0, null, 11),
            Order(3, "PT1-Short", 2, null, 80.0, 12),
            Order(4, "PT1-Short", 2, null, 180.0, 13),
        };
        IList<ReconstructedTrade> trades = TradeReconstruction.FromOrders(orders, 1.0);

        Assert.Equal(2, trades.Count);
        Assert.Equal(20, trades[0].Fingerprint().Target1Ticks);
        Assert.Equal(20, trades[1].Fingerprint().Target1Ticks);
    }

    [Fact]
    public void MeasuresFromTheOriginalPriceNotTheTrailedOne()
    {
        // The template declares the stop at its original distance; NinjaTrader
        // rewrites the price as the trail moves it. Reading the order's current
        // price measures the trail, not the strategy.
        var orders = new List<TradeOrder>
        {
            Order(1, "Enter Long", 2, 100.0, null, 10),
            Order(2, "Stop Long", 2, null, 80.0, 11),
        };
        Assert.Equal(20, TradeReconstruction.FromOrders(orders, 1.0)[0].Fingerprint().StopTicks);
    }

    [Fact]
    public void AnEntryThatNeverFilledYieldsNoGeometry()
    {
        var orders = new List<TradeOrder> { Order(1, "Enter Long", 2, null, null, 10) };
        Assert.Null(TradeReconstruction.FromOrders(orders, 1.0)[0].Fingerprint());
    }

    [Fact]
    public void AnExitThatFitsNoOpenEntryIsDroppedRatherThanGuessedAt()
    {
        var orders = new List<TradeOrder> { Order(1, "PT1-Long", 2, null, 80.0, 10) };
        Assert.Empty(TradeReconstruction.FromOrders(orders, 1.0));
    }

    [Fact]
    public void SurvivesNothingToReconstruct()
    {
        Assert.Empty(TradeReconstruction.FromOrders(null, 1.0));
        Assert.Empty(TradeReconstruction.FromOrders(new List<TradeOrder>(), 0));
    }
}
