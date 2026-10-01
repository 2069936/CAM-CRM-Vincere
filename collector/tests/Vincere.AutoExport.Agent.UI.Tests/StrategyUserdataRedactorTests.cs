using System;
using System.Text;
using Vincere.AutoExport.Agent.UI.DeepExport;
using Xunit;

namespace Vincere.AutoExport.Agent.UI.Tests;

/* THE RULE FOR THE CARRIER AN ASCII GREP CANNOT SEE.
 *
 * Measured on a real export, read-only: Strategies holds 12 rows, all 12
 * Userdata blobs carry a non-empty LicenseKey, the payload is UTF-16LE with no
 * BOM and its text is HTML-escaped XML, and an ASCII search of the whole 21.9 MB
 * database returns 0 while the key is in it 12 times. Two distinct values across
 * those rows and one of them appears nowhere else in the package.
 *
 * Every licence value below is FABRICATED, in the measured shape. */
public sealed class StrategyUserdataRedactorTests
{
    private const string Licence = "V-ZZQQ77-FIXTUREK-TESTKEY";
    private const string Other = "V-AAB311-SECONDKY-OTHERKY";

    [Fact]
    public void TheEscapedElementIsMaskedAndEverythingAroundItSurvives()
    {
        // The measured shape: outer plain XML, inner escaped XML.
        string text = "<NinjaTrader><_Impl>&lt;G4M&gt;"
            + "&lt;StopLossTicks&gt;40&lt;/StopLossTicks&gt;"
            + $"&lt;LicenseKey&gt;{Licence}&lt;/LicenseKey&gt;"
            + "&lt;TrailByTicks&gt;8&lt;/TrailByTicks&gt;"
            + "&lt;/G4M&gt;</_Impl></NinjaTrader>";

        string redacted = StrategyUserdataRedactor.RedactText(text);

        Assert.DoesNotContain(Licence, redacted);
        Assert.Contains("&lt;LicenseKey&gt;***&lt;/LicenseKey&gt;", redacted);
        // THE PARAMETERISATION IS NOT THE CREDENTIAL and is deliberately kept.
        Assert.Contains("&lt;StopLossTicks&gt;40&lt;/StopLossTicks&gt;", redacted);
        Assert.Contains("&lt;TrailByTicks&gt;8&lt;/TrailByTicks&gt;", redacted);
        Assert.Contains("<NinjaTrader><_Impl>", redacted);
        // Nothing lost and nothing invented: the whole text minus the value,
        // plus the mask.
        Assert.Equal(text.Length - Licence.Length + StrategyUserdataRedactor.Mask.Length, redacted.Length);
    }

    [Fact]
    public void TheUnescapedFormIsMaskedToo()
    {
        // Not the measured shape, and covering it costs nothing - a blob written
        // by a future NinjaTrader without the escaping would otherwise pass.
        string redacted = StrategyUserdataRedactor.RedactText(
            $"<Strategy><LicenseKey>{Licence}</LicenseKey><StopLossTicks>40</StopLossTicks></Strategy>");

        Assert.DoesNotContain(Licence, redacted);
        Assert.Contains("<LicenseKey>***</LicenseKey>", redacted);
        Assert.Contains("<StopLossTicks>40</StopLossTicks>", redacted);
    }

    [Fact]
    public void EveryOccurrenceGoesAndAnEmptyElementStaysEmpty()
    {
        // Several elements, two distinct values, and an empty one. An empty value
        // is left empty so "never configured" and "configured and hidden" stay
        // different facts - the rule the other three redactors state.
        string redacted = StrategyUserdataRedactor.RedactText(
            $"&lt;LicenseKey&gt;{Licence}&lt;/LicenseKey&gt;"
            + $"&lt;DeviceToken&gt;{Other}&lt;/DeviceToken&gt;"
            + "&lt;LicenceKey&gt;&lt;/LicenceKey&gt;"
            + "&lt;PosSize1&gt;2&lt;/PosSize1&gt;");

        Assert.DoesNotContain(Licence, redacted);
        Assert.DoesNotContain(Other, redacted);
        Assert.Contains("&lt;LicenseKey&gt;***&lt;/LicenseKey&gt;", redacted);
        Assert.Contains("&lt;DeviceToken&gt;***&lt;/DeviceToken&gt;", redacted);
        Assert.Contains("&lt;LicenceKey&gt;&lt;/LicenceKey&gt;", redacted);
        Assert.Contains("&lt;PosSize1&gt;2&lt;/PosSize1&gt;", redacted);
    }

    [Fact]
    public void AValueHoldingAStrayDelimiterIsStillMaskedWhole()
    {
        // THE FAILURE MODE THAT MATTERS: a partly masked credential is a leaked
        // credential. The closing tag has to name the SAME element, so a value
        // carrying a stray '<' cannot end the match early.
        string redacted = StrategyUserdataRedactor.RedactText(
            $"&lt;LicenseKey&gt;{Licence}&lt;junk{Other}&lt;/LicenseKey&gt;&lt;PosSize1&gt;2&lt;/PosSize1&gt;");

        Assert.DoesNotContain(Licence, redacted);
        Assert.DoesNotContain(Other, redacted);
        Assert.Contains("&lt;LicenseKey&gt;***&lt;/LicenseKey&gt;", redacted);
        Assert.Contains("&lt;PosSize1&gt;2&lt;/PosSize1&gt;", redacted);
    }

    [Fact]
    public void AUtf16BlobIsMaskedAndStaysUtf16()
    {
        byte[] blob = Encoding.Unicode.GetBytes(
            $"<NinjaTrader><_Impl>&lt;LicenseKey&gt;{Licence}&lt;/LicenseKey&gt;</_Impl></NinjaTrader>");

        // THE GUARD THAT STOPS THIS PASSING FOR THE WRONG REASON: the key really
        // is invisible to a byte-wise search of these bytes and really is there
        // once they are decoded. ORDINAL on purpose - the default comparison is
        // culture-sensitive, and ICU treats NUL as ignorable, so a culture-
        // sensitive search finds "V-..." inside "V\0-\0..." and this guard would
        // pass while proving nothing. That is the same trap as grepping a package
        // for a plaintext key, one layer down.
        Assert.DoesNotContain(Licence, Encoding.Latin1.GetString(blob), StringComparison.Ordinal);
        Assert.Contains(Licence, Encoding.Unicode.GetString(blob), StringComparison.Ordinal);

        byte[] redacted = StrategyUserdataRedactor.RedactBlob(blob);
        string text = Encoding.Unicode.GetString(redacted);

        Assert.DoesNotContain(Licence, text);
        Assert.Contains("&lt;LicenseKey&gt;***&lt;/LicenseKey&gt;", text);
        // Still UTF-16LE with no BOM, which is what NinjaTrader wrote.
        Assert.Equal(text.Length * 2, redacted.Length);
        Assert.NotEqual(0xFF, redacted[0]);
    }

    [Fact]
    public void AUtf8BlobIsMaskedAndStaysUtf8()
    {
        byte[] blob = Encoding.UTF8.GetBytes($"<Strategy><LicenseKey>{Licence}</LicenseKey></Strategy>");
        byte[] redacted = StrategyUserdataRedactor.RedactBlob(blob);
        string text = Encoding.UTF8.GetString(redacted);

        Assert.DoesNotContain(Licence, text);
        Assert.Contains("<LicenseKey>***</LicenseKey>", text);
    }

    [Fact]
    public void ABlobWithNothingToMaskIsReturnedByteForByte()
    {
        // THE FIDELITY CopyRows EXISTS TO PRESERVE. An even-length run of binary
        // would decode to mojibake under UTF-16LE; it must come back unchanged
        // rather than re-encoded, or the rebuild quietly rewrites every blob in
        // the database. Both parities, because the UTF-16 path is length-gated.
        foreach (byte[] blob in new[]
        {
            new byte[] { 0x01, 0x02, 0x03, 0x04 },
            new byte[] { 0x0A, 0x0B, 0x0C },
            new byte[] { 0xFF, 0xFE, 0x00, 0xD8, 0x41, 0x00 },
            Array.Empty<byte>(),
        })
        {
            byte[] redacted = StrategyUserdataRedactor.RedactBlob(blob);
            Assert.Equal(blob, redacted);
        }
        Assert.Null(StrategyUserdataRedactor.RedactBlob(null));
    }

    [Fact]
    public void ATextCellWithNoMarkupIsUntouched()
    {
        // Almost every cell in the database is a number or a short name. The gate
        // is the element delimiter, not the key name, so widening the name list
        // cannot leave it behind.
        foreach (string plain in new[] { "LTATAGREH509159302022", "MNQ 12-26", "G4M", "", "LicenseKey" })
        {
            Assert.Same(plain, StrategyUserdataRedactor.RedactText(plain));
        }
        Assert.Null(StrategyUserdataRedactor.RedactText(null));
    }

    [Fact]
    public void TheNamesItTreatsAsSecretAreNotListedHere()
    {
        // The predicate is SecretRedactor's, which is the single definition. A
        // name it does not consider secret is left alone even in the same shape,
        // which is what keeps the parameterisation in the blob.
        Assert.Contains("&lt;StopLossTicks&gt;40&lt;/StopLossTicks&gt;",
            StrategyUserdataRedactor.RedactText("&lt;StopLossTicks&gt;40&lt;/StopLossTicks&gt;"));
        Assert.Contains("***", StrategyUserdataRedactor.RedactText("&lt;ApiKey&gt;abc&lt;/ApiKey&gt;"));
    }
}
