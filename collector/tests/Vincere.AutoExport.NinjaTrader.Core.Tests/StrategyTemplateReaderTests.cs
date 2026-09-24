using Vincere.AutoExport.NinjaTrader.Core.Capture;
using Xunit;

namespace Vincere.AutoExport.NinjaTrader.Core.Tests;

/* The shapes here are copied from a real VPS on 2026-09-24, which carried 886
 * of these across 20 family folders. The reader takes 823 of them; the rest
 * declare no geometry and are not strategies this can identify. */
public class StrategyTemplateReaderTests
{
    private const string G4mFile = "1 - G4M (MES) - 15 Min - Low Risk - v1 - Period 0.xml";

    private static string Xml(
        int s1 = 2, int s2 = 1, int s3 = 1,
        int stop = 80, int t1 = 80, int t2 = 120, int t3 = 160)
        => $@"<NinjaTrader>
  <StrategyType>NinjaTrader.NinjaScript.Strategies.G4M</StrategyType>
  <Name>0 - G4M-3.4</Name>
  <DefaultQuantity>1</DefaultQuantity>
  <PosSize1>{s1}</PosSize1>
  <PosSize2>{s2}</PosSize2>
  <PosSize3>{s3}</PosSize3>
  <StopLossTicks>{stop}</StopLossTicks>
  <ProfitTarget1Ticks>{t1}</ProfitTarget1Ticks>
  <ProfitTarget2Ticks>{t2}</ProfitTarget2Ticks>
  <ProfitTarget3Ticks>{t3}</ProfitTarget3Ticks>
  <Trail>true</Trail>
  <TrailByTicks>41</TrailByTicks>
</NinjaTrader>";

    [Fact]
    public void ReadsTheGeometryFromTheXmlAndTheIdentityFromThePath()
    {
        // They come from two different places, and a reader that assumes one
        // source gets half of them wrong.
        StrategyTemplate template = StrategyTemplateReader.Read("G4M", G4mFile, Xml());

        Assert.Equal("G4M", template.Family);
        Assert.Equal("v1", template.Version);
        Assert.Equal("Low", template.Risk);
        Assert.False(template.PropFirm);
        Assert.Equal("MES", template.Fingerprint.Instrument);
        Assert.Equal(80, template.Fingerprint.StopTicks);
        Assert.Equal(80, template.Fingerprint.Target1Ticks);
        Assert.Equal(120, template.Fingerprint.Target2Ticks);
        Assert.Equal(160, template.Fingerprint.Target3Ticks);
        Assert.Equal(2, template.Fingerprint.Size1);
    }

    [Fact]
    public void ThePropFirmSuffixIsAVariantNotAnAlgorithm()
    {
        // Measured: an algorithm and its own _PF share geometry in every case,
        // and no two genuinely different algorithms do. Folding the suffix is
        // what lets a match answer one family instead of refusing.
        StrategyTemplate template = StrategyTemplateReader.Read(
            "RBO_PF", "1 - RBO (M2K) - 15 Min - High Risk - v5 - Period 0.xml", Xml());

        Assert.Equal("RBO", template.Family);
        Assert.True(template.PropFirm);
        Assert.Equal("v5", template.Version);
        Assert.Equal("High", template.Risk);
        Assert.Equal("M2K", template.Fingerprint.Instrument);
    }

    [Fact]
    public void TheDisplayNameIsNotParsedForIdentity()
    {
        // <Name> holds `0 - G4M-3.4`, which mixes the family with a product
        // version that is not the template version. The file name is the
        // authority, and v1 is what it says.
        Assert.Equal("v1", StrategyTemplateReader.Read("G4M", G4mFile, Xml()).Version);
    }

    [Fact]
    public void ATemplateWithNoGeometryIsNotATemplateThisCanIdentify()
    {
        // Null rather than an empty template: a catalogue entry that matches
        // everything is worse than a missing one.
        Assert.Null(StrategyTemplateReader.Read("G4M", G4mFile,
            "<NinjaTrader><Name>0 - G4M-3.4</Name><DefaultQuantity>1</DefaultQuantity></NinjaTrader>"));
        Assert.Null(StrategyTemplateReader.Read("G4M", G4mFile, Xml(stop: 0, t1: 0, t2: 0, t3: 0)));
    }

    [Fact]
    public void AFileWithNoInstrumentInItsNameIdentifiesNothing()
    {
        Assert.Null(StrategyTemplateReader.Read("G4M", "G4M default.xml", Xml()));
    }

    [Fact]
    public void SurvivesAFileThatIsNotXml()
    {
        Assert.Null(StrategyTemplateReader.Read("G4M", G4mFile, "not xml at all <<<"));
        Assert.Null(StrategyTemplateReader.Read("G4M", G4mFile, null));
        Assert.Null(StrategyTemplateReader.Read(null, null, Xml()));
    }

    [Fact]
    public void ReadsAHandEditedDecimalAsTheSameLadder()
    {
        string xml = Xml().Replace("<PosSize1>2</PosSize1>", "<PosSize1>2.0</PosSize1>");
        Assert.Equal(2, StrategyTemplateReader.Read("G4M", G4mFile, xml).Fingerprint.Size1);
    }

    [Theory]
    [InlineData("1 - OGX (MNQ) - 15 Min - Medium Risk - v3 - Period 2.xml", "MNQ", "v3", "Medium")]
    [InlineData("1 - PLPI (PL) - 30 Min - High Risk - v5 - Period 0.xml", "PL", "v5", "High")]
    [InlineData("1 - ARPD (MGC) - 15 Min - Low Risk - v2 - Period 1.xml", "MGC", "v2", "Low")]
    public void ReadsTheRealNamingConvention(string fileName, string instrument, string version, string risk)
    {
        Assert.Equal(instrument, StrategyTemplateReader.Instrument(fileName));
        Assert.Equal(version, StrategyTemplateReader.Version(fileName));
        Assert.Equal(risk, StrategyTemplateReader.Risk(fileName));
    }
}
