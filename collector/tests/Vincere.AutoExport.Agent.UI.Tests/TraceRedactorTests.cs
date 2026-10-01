using System;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.UI.DeepExport;
using Xunit;

namespace Vincere.AutoExport.Agent.UI.Tests;

/* THE BROKER LOGIN DOES NOT TRAVEL IN THE TRACE.
 *
 * NinjaTrader writes the platform login into its trace and log files as it
 * renews a token and retries a connection. Measured on one real export it is
 * there 2,179 times, and that export is handed around over Drive and Discord.
 *
 * These tests pin the two shapes it takes, measured rather than guessed, and
 * the properties that make the masking safe to run over 19 MB of text: the
 * shape of the log survives, an empty value stays empty, Windows line endings
 * come out as they went in, and nothing is truncated.
 *
 * EVERY LOGIN-LIKE STRING BELOW IS INVENTED FOR THIS FILE. The real export was
 * read to count occurrences and establish line shapes; no value from it is
 * reproduced here or anywhere in the repository. */
public sealed class TraceRedactorTests
{
    // Invented, and shaped like what NinjaTrader logs: a mail address with its
    // @ and . flattened to underscores.
    private const string Login = "someoperator_example_org";

    [Fact]
    public void TheLineShapeThatCarriesTheLoginComesOutMasked()
    {
        // The measured shape, 1,816 of 2,179 occurrences: a Cbi.Auth token
        // renewal line. Single quotes and `=`, which is why the JSON-shaped
        // acceptance sweep never saw it.
        string line = $"2026-09-28 07:15:45:123 (Continuum) Cbi.Auth.RenewToken: renew requested user='{Login}'";

        string redacted = TraceRedactor.RedactLine(line);

        Assert.DoesNotContain(Login, redacted);
        Assert.Contains("user='***'", redacted);
        // The shape of the log survives: a reader still sees that a login
        // happened, when, and which method logged it.
        Assert.Contains("2026-09-28 07:15:45:123", redacted);
        Assert.Contains("Cbi.Auth.RenewToken", redacted);
        Assert.Contains("renew requested", redacted);
    }

    [Fact]
    public void TheSentenceThatNamesTheAccountWithNoKeyAtAllComesOutMasked()
    {
        // 363 of the 2,179 occurrences have no key and no quotes - and they are
        // 100% of the exposure in logs/, where the keyed shape never appears.
        // A rule written only for user='...' leaves every one of these behind.
        string line = $"2026-09-28 07:15:45:123|3|2|There was a problem authenticating account {Login} online. Please try again or contact support.";

        string redacted = TraceRedactor.RedactLine(line);

        Assert.DoesNotContain(Login, redacted);
        Assert.Contains("authenticating account ***", redacted);
        // The sentence still reads, and its final period was not eaten.
        Assert.Contains("online. Please try again", redacted);
    }

    [Fact]
    public void AValueHoldingAQuoteOrAnEqualsSignIsMaskedWholeAndItsNeighbourSurvives()
    {
        // The failure that matters is a PARTLY masked credential. A naive
        // ('[^']*') match would stop at the stray character and leave the rest
        // of the login in the file, so the closing quote is the one followed by
        // whitespace or end of line, not simply the next one along.
        Assert.Equal(
            "Cbi.Auth: user='***' mode='Continuum'",
            TraceRedactor.RedactLine("Cbi.Auth: user='od'donnell_example_org' mode='Continuum'"));

        Assert.Equal(
            "Cbi.Auth: user='***' mode='Continuum'",
            TraceRedactor.RedactLine("Cbi.Auth: user='a=b_example_org' mode='Continuum'"));

        // Both at once, and at the end of a line where there is no following key.
        string both = TraceRedactor.RedactLine("Cbi.Auth: user='we'ird=value'");
        Assert.Equal("Cbi.Auth: user='***'", both);
        Assert.DoesNotContain("ird", both);
    }

    [Fact]
    public void TheKeysThatCarryTradingDataAreNotTouched()
    {
        // account= is the broker account this export exists to describe, 6,198
        // occurrences over 5 distinct values, and displayName= and accountIds=
        // repeat the same ones. Nobody can reconstruct a trading day without
        // them, so masking them would destroy the export and hide no identity.
        // orderId=, instrument=, time=, name= and mode= are the same argument.
        string line = "2026-09-28 07:15:45:123 (Continuum) Cbi.Order: account='1234567' displayName='1234567' "
            + "accountIds='1234567,7654321' instrument='ES 12-26' time='2026-09-28 07:15:45' orderId='12345678901' "
            + "name='ES-Trend' mode='Continuum' server='da-ny-mp-a01.a11.com' orderType='Limit'";

        Assert.Equal(line, TraceRedactor.RedactLine(line));

        // And the auth method names are method names, not values: 607
        // occurrences, none of them followed by an assignment. Masking them
        // would hide the retry story an analyst needs and protect nothing.
        string auth = "2026-09-28 07:15:45:123 (Continuum) NinjaTrader.Core.Auth.GetAccessToken: RenewToken scheduled, AccessToken cached";
        Assert.Equal(auth, TraceRedactor.RedactLine(auth));

        // THE NEAR MISS. Real keys in the trace START with the four letters the
        // rule matches on, so the rule matches a whole key and not a prefix of
        // one. Half-masking UserDataDir= would corrupt a path while hiding
        // nothing, because the key is not the login.
        string paths = @"Gui.Startup: UserDataDir='C:\Users\operator\Documents\NinjaTrader 8' UserName='svc' Username='svc'";
        Assert.Equal(paths, TraceRedactor.RedactLine(paths));
    }

    [Fact]
    public void AnEmptyValueStaysEmptyRatherThanBecomingAMask()
    {
        // The rule SecretRedactor already states for JSON, and the two agree:
        // "no login was recorded" and "a login was recorded and is not being
        // named" have to stay different facts.
        Assert.Equal("Cbi.Auth: user='' mode='Continuum'", TraceRedactor.RedactLine("Cbi.Auth: user='' mode='Continuum'"));

        // Which is also why the always-empty keys are left alone. fcm=,
        // onBehalfOf=, oco=, message= and data= hold no value in any of their
        // 10,365 combined occurrences; masking them would delete the only fact
        // they carry, which is that the field was logged at all.
        string empties = "Cbi.Order: fcm='' onBehalfOf='' oco='' message='' data='";
        Assert.Equal(empties, TraceRedactor.RedactLine(empties));
    }

    [Fact]
    public async Task ACrlfFileComesBackWithItsCrlfIntact()
    {
        // A Windows VPS writes CRLF, and the real trace files do. A redactor
        // that normalises them rewrites all 75,776 lines of a file it was
        // supposed to leave alone, and every manifest digest with them.
        string text = $"first line\r\nCbi.Auth: user='{Login}'\r\nthird line\r\n";

        string redacted = await RedactAsync(text);

        Assert.DoesNotContain(Login, redacted);
        Assert.Equal("first line\r\nCbi.Auth: user='***'\r\nthird line\r\n", redacted);
        Assert.Equal(3, redacted.Split("\r\n").Length - 1);
        Assert.DoesNotContain("\n\n", redacted);

        // A lone LF stays a lone LF, a lone CR stays a lone CR, and a last line
        // with no terminator does not grow one.
        Assert.Equal("a\nb", await RedactAsync("a\nb"));
        Assert.Equal("a\rb", await RedactAsync("a\rb"));
        Assert.Equal("trailing user='***'", await RedactAsync($"trailing user='{Login}'"));
    }

    [Fact]
    public async Task AVeryLongLineIsNeitherTruncatedNorSplit()
    {
        // The longest single line measured in a real trace is 145,522
        // characters, which is longer than any sane read buffer. This one is
        // longer still, and the login sits past the far side of several buffer
        // boundaries so that a chunked read has to carry a partial line across
        // them without losing or duplicating anything.
        string filler = new string('x', 300_000);
        string text = $"head {filler} user='{Login}' {filler} tail\r\nsecond line\r\n";

        string redacted = await RedactAsync(text);

        Assert.DoesNotContain(Login, redacted);
        Assert.Contains("user='***'", redacted);
        Assert.StartsWith("head ", redacted);
        Assert.EndsWith(" tail\r\nsecond line\r\n", redacted);
        // Nothing lost and nothing invented: the whole line minus the login,
        // plus the mask, and still exactly two lines.
        Assert.Equal(text.Length - Login.Length + TraceRedactor.Mask.Length, redacted.Length);
        Assert.Equal(600_000, redacted.Count(c => c == 'x'));
        Assert.Equal(2, redacted.Split("\r\n").Length - 1);
    }

    [Fact]
    public async Task EveryOccurrenceOnACrowdedLineGoesAndTheRestOfItStays()
    {
        // Both shapes on one line, twice each, to pin that the pass is not a
        // first-match-only replace.
        string text = $"user='{Login}' account='1234567' user='{Login}' "
            + $"problem authenticating account {Login} online. problem authenticating user {Login} online.\r\n";

        string redacted = await RedactAsync(text);

        Assert.DoesNotContain(Login, redacted);
        Assert.Equal(2, CountOf(redacted, "user='***'"));
        Assert.Equal(1, CountOf(redacted, "authenticating account ***"));
        Assert.Equal(1, CountOf(redacted, "authenticating user ***"));
        Assert.Contains("account='1234567'", redacted);
    }

    [Fact]
    public void TheTraceAndTheLogsAreWhatThisAppliesTo()
    {
        // The two plain-text NinjaTrader sources, and only those. workspaces/
        // and templates/ carry no login (measured: 0 occurrences); the queue
        // snapshots are JSON the config rule already covers.
        Assert.True(TraceRedactor.AppliesTo(Source("trace", "trace")));
        Assert.True(TraceRedactor.AppliesTo(Source("logs", "logs")));
        Assert.False(TraceRedactor.AppliesTo(Source("workspaces", "workspaces")));
        Assert.False(TraceRedactor.AppliesTo(Source("strategy templates", "templates/Strategy")));
        Assert.False(TraceRedactor.AppliesTo(Source("sent snapshots", "autoexport/sent")));
        Assert.False(TraceRedactor.AppliesTo(null));

        // And the live source list agrees, so a renamed or added source cannot
        // quietly drop out of the set this covers.
        Assert.Equal(
            new[] { "logs", "trace" },
            DeepExportSources.All.Where(TraceRedactor.AppliesTo).Select(s => s.Name).OrderBy(n => n).ToArray());
    }

    private static DeepExportSource Source(string name, string zipFolder)
        => new(name, DeepExportRoot.NinjaTrader, name, "*.txt", zipFolder, false);

    private static int CountOf(string haystack, string needle)
    {
        int count = 0;
        for (int i = haystack.IndexOf(needle, StringComparison.Ordinal); i >= 0; i = haystack.IndexOf(needle, i + needle.Length, StringComparison.Ordinal))
            count++;
        return count;
    }

    /// <summary>Through the same streaming path the export uses, over real streams.</summary>
    private static async Task<string> RedactAsync(string text)
    {
        using var input = new MemoryStream(Encoding.UTF8.GetBytes(text));
        using var output = new MemoryStream();
        await TraceRedactor.RedactTextStreamAsync(input, output);
        return Encoding.UTF8.GetString(output.ToArray());
    }
}
