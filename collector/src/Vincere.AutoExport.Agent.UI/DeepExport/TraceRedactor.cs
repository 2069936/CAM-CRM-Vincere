using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

namespace Vincere.AutoExport.Agent.UI.DeepExport;

/* ---------------------------------------------------------------------------
 * WHY THERE ARE TWO REDACTORS, AND WHY THIS ONE COULD NOT BE THE OTHER.
 *
 * SecretRedactor asks "is this field NAMED like a secret?" and it asks it of a
 * parsed JSON tree. Both halves of that are wrong for NinjaTrader's trace and
 * log files, so pointing SecretRedactor at them would have been worse than
 * doing nothing:
 *
 *   - THE FILES ARE NOT JSON. SecretRedactor.RedactJsonText catches the parse
 *     failure and returns a one-line "withheld" stub. Aimed at 19 MB of trace,
 *     it replaces the whole file with that stub and the export loses the thing
 *     it exists to carry.
 *   - THE KEY IS NOT NAMED LIKE A SECRET. The broker login is logged as
 *     `user=`, which no secret-name list would ever contain, because `user` is
 *     the most ordinary field name there is.
 *   - THE SECRET-NAME LIST WOULD DO ACTIVE HARM HERE. Measured over a real
 *     export: `password`, `apikey`, `secret`, `credential`, `bearer` and
 *     `authorization` appear ZERO times in trace/ or logs/, while `token`
 *     appears 607 times and not one of them is a value - they are the method
 *     and log-category names RenewToken, GetAccessToken and AccessToken on
 *     Cbi.Auth lines. Masking those would hide the auth-retry story an analyst
 *     needs and protect nothing.
 *
 * So this is a deliberately different rule: a line-oriented pass that masks a
 * SHORT, NAMED, MEASURED set of identities and leaves every other key alone.
 * The two redactors agree on the one thing that matters - mask the value, keep
 * the key, and leave an empty value empty - so a reader of either output can
 * still tell that a login happened, and when, and that it was hidden on
 * purpose rather than never recorded.
 *
 * WHAT IS MASKED, AND WHY ONLY THIS.
 * Measured over one real export: 32 trace files (19 MB, 75,776 lines) and 8
 * log files. The login appears 2,179 times, as ONE distinct value, in exactly
 * two shapes, and nowhere else in the package.
 *
 *   (a) KEYED, 1,816 in trace/ and 0 in logs/:   user='<login>'
 *   (b) PROSE, 121 in trace/ and 242 in logs/:   an authentication-failure
 *       sentence that names the account with no quotes and no key at all.
 *
 * Shape (b) is 17% of the exposure overall and it is ALL of the exposure in
 * logs/. A rule written only for `user='...'` would leave 363 occurrences
 * behind, 242 of them in a directory that rule never visits. Both shapes and
 * both directories, or the fix is decoration.
 *
 * WHAT IS DELIBERATELY NOT MASKED. account= (6,198 occurrences, 5 distinct
 * values) is the broker account the whole export is about, and displayName=
 * and accountIds= carry the same values; masking them would destroy the
 * export's reason to exist without hiding an identity, because nobody can
 * reconstruct a trading day without knowing which account traded. Nor are
 * instrument=, time=, orderId=, name=, mode=, server= or the error and
 * exception prose touched: they are trading and diagnostic data. And nothing
 * is masked merely because it is empty - fcm=, onBehalfOf=, oco=, message=
 * and data= hold no value in any of their 10,365 combined occurrences, so a
 * mask there would delete the fact that the field was logged and protect
 * nothing.
 *
 * NOT IN SCOPE HERE. The same export carries a Windows account name in 278
 * filesystem paths (only 22 of them inside a key='value', the rest bare in
 * prose). It is not a `user=` and this class does not reach it. Named by this
 * review, not closed by it.
 *
 * THE LICENCE KEY THIS HEADER ALSO NAMED IS CLOSED, ELSEWHERE, AND THE COUNT
 * WAS WRONG. It said "890 times inside a <LicenseKey> XML element under
 * templates/". Re-measured on both real exports: the literal `LicenseKey`
 * appears 1,772 times under templates/, which is 886 open plus 886 close tags,
 * and the VALUE appears 886 times, once in each of 886 files. The 890 was
 * templates/ plus four copies in a folder a human had added to the unpacked
 * export by hand. Anyone verifying a fix on a tag count is counting the wrong
 * number, and a rule that empties an element leaves every tag in place. The key
 * travelled by three doors and all three are now rules: templates/ no longer
 * ships (DeepExportSources), the queue snapshots are emptied
 * (StrategyConfigurationRedactor) and the database blobs are masked
 * (StrategyUserdataRedactor). None of them is this class, which is why this
 * paragraph is a pointer and not a fourth rule.
 * ------------------------------------------------------------------------- */
public static class TraceRedactor
{
    /// <summary>The same mask SecretRedactor uses, so one grep over the ZIP finds both.</summary>
    public const string Mask = SecretRedactor.Mask;

    /// <summary>
    /// Keys whose quoted value is an identity rather than trading data. Kept as
    /// a list so the set stays readable and reviewable: every addition is a
    /// decision that something an analyst can currently read stops being
    /// readable, and it should be as visible as this.
    /// </summary>
    public static readonly IReadOnlyList<string> MaskedKeys = new[] { "user" };

    /* The closing quote is the one that ENDS THE FIELD, not simply the next one
     * on the line. A value holding an apostrophe or an equals sign - user='a'b'
     * or user='a=b' - would otherwise match only as far as the stray character
     * and leave the rest of the value in the file, which is the failure mode
     * that matters: a partly masked credential is a leaked credential. So the
     * closing quote has to be followed by whitespace or the end of the line.
     * .NET's `.` does not cross a newline, so no match can run past its line. */
    private static readonly Regex KeyedIdentity = new(
        @"\b(?<key>" + string.Join("|", MaskedKeys) + @")='(?<value>.*?)'(?=\s|$)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /* THE SHAPE WITH NO KEY AND NO QUOTES. NinjaTrader reports a failed login
     * as an English sentence that simply names the account, so there is nothing
     * to key on but the sentence itself. `account` is the measured noun in all
     * 363 occurrences; `user` is the same sentence with the other noun, covered
     * because covering it costs nothing and missing it would cost a login.
     *
     * The value runs to whitespace, but a sentence-ending period is left where
     * it is rather than swallowed into the mask, and a login that does contain
     * dots - an unmangled email address would - is still captured whole. */
    private static readonly Regex ProseIdentity = new(
        @"(?<prefix>\bauthenticating\s+(?:account|user)\s+)(?<value>\S+?)(?=[.,;:!?]?(?:\s|$))",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    /// <summary>Cheap gate: a line with no "authenticat" cannot hold the prose shape.</summary>
    private const string ProseHint = "authenticat";

    /// <summary>
    /// Whether a source's files are redacted on the way into the staging folder.
    /// The plain-text NinjaTrader sources: the trace and the logs.
    /// </summary>
    public static bool AppliesTo(DeepExportSource source)
        => source != null && AppliesToZipFolder(source.ZipFolder);

    /// <summary>The same decision over the path inside the ZIP, for callers holding only that.</summary>
    public static bool AppliesToZipFolder(string zipFolder)
    {
        if (string.IsNullOrEmpty(zipFolder)) return false;
        string folder = zipFolder.Replace('\\', '/').TrimStart('/');
        return folder.Equals("trace", StringComparison.OrdinalIgnoreCase)
            || folder.Equals("logs", StringComparison.OrdinalIgnoreCase)
            || folder.StartsWith("trace/", StringComparison.OrdinalIgnoreCase)
            || folder.StartsWith("logs/", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Redact one line of trace. The key, the quotes and the position all
    /// survive; only the value is replaced. An empty value is left empty, so
    /// "no login was recorded" and "a login was recorded and is not being
    /// named" stay different facts - the rule SecretRedactor already states
    /// for JSON.
    /// </summary>
    public static string RedactLine(string line)
    {
        if (string.IsNullOrEmpty(line)) return line;

        string redacted = line;
        if (redacted.IndexOf('=') >= 0 && redacted.IndexOf('\'') >= 0)
        {
            redacted = KeyedIdentity.Replace(redacted, match =>
                match.Groups["value"].Length == 0
                    ? match.Value
                    : match.Groups["key"].Value + "='" + Mask + "'");
        }
        if (redacted.IndexOf(ProseHint, StringComparison.OrdinalIgnoreCase) >= 0)
        {
            redacted = ProseIdentity.Replace(redacted, match => match.Groups["prefix"].Value + Mask);
        }
        return redacted;
    }

    /// <summary>
    /// Copy a text file line by line, redacting as it goes. Nothing bigger than
    /// one line is ever held, because a trace file runs to tens of megabytes -
    /// the longest single line measured in a real export is 145,522 characters -
    /// and the agent shares a VPS with a platform that is trading.
    ///
    /// The bytes are preserved everywhere the redaction does not reach: each
    /// line keeps its own terminator, so the CRLF a Windows VPS writes stays
    /// CRLF, a lone LF stays a lone LF, and a final line with no terminator
    /// gains none. Read as UTF-8 with BOM detection and written back as UTF-8
    /// with no BOM, which is what NinjaTrader writes.
    /// </summary>
    public static async Task RedactTextStreamAsync(
        Stream input, Stream output, CancellationToken cancellationToken = default)
    {
        if (input == null) throw new ArgumentNullException(nameof(input));
        if (output == null) throw new ArgumentNullException(nameof(output));

        using var reader = new StreamReader(input, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, bufferSize: 81920, leaveOpen: true);
        using var writer = new StreamWriter(output, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false), 81920, leaveOpen: true);

        char[] buffer = new char[81920];
        var line = new StringBuilder(256);
        // True when a CR has been written and we do not yet know whether the LF
        // of a CRLF follows - which happens when a chunk ends on the CR.
        bool pendingCr = false;
        int read;

        while ((read = await reader.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false)) > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int start = 0;
            for (int i = 0; i < read; i++)
            {
                char character = buffer[i];
                if (pendingCr)
                {
                    pendingCr = false;
                    if (character == '\n')
                    {
                        await writer.WriteAsync('\n').ConfigureAwait(false);
                        start = i + 1;
                        continue;
                    }
                    // Not an LF, so that CR ended its line alone. This character
                    // opens the next line and start already points at it.
                }
                if (character == '\r')
                {
                    line.Append(buffer, start, i - start);
                    await WriteLineAsync(writer, line).ConfigureAwait(false);
                    await writer.WriteAsync('\r').ConfigureAwait(false);
                    pendingCr = true;
                    start = i + 1;
                }
                else if (character == '\n')
                {
                    line.Append(buffer, start, i - start);
                    await WriteLineAsync(writer, line).ConfigureAwait(false);
                    await writer.WriteAsync('\n').ConfigureAwait(false);
                    start = i + 1;
                }
            }
            if (start < read) line.Append(buffer, start, read - start);
        }

        // A last line with no terminator. It is still a line and it is still
        // redacted, but it does not grow a newline it never had.
        if (line.Length > 0) await WriteLineAsync(writer, line).ConfigureAwait(false);
        await writer.FlushAsync().ConfigureAwait(false);
    }

    private static async Task WriteLineAsync(TextWriter writer, StringBuilder line)
    {
        // RedactLine hands back the same string when nothing matched, so a line
        // the rules do not touch - which is nearly all of them - costs one copy
        // out of the builder and two IndexOf scans, and never a second copy.
        string original = line.ToString();
        line.Clear();
        await writer.WriteAsync(RedactLine(original)).ConfigureAwait(false);
    }

    /// <summary>Redact a whole text through the same streaming path the export uses.</summary>
    public static async Task<string> RedactTextAsync(string text, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrEmpty(text)) return text;
        using var input = new MemoryStream(Encoding.UTF8.GetBytes(text));
        using var output = new MemoryStream();
        await RedactTextStreamAsync(input, output, cancellationToken).ConfigureAwait(false);
        return Encoding.UTF8.GetString(output.ToArray());
    }
}
