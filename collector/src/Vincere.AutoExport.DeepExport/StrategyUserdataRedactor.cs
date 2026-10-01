using System;
using System.Text;
using System.Text.RegularExpressions;

namespace Vincere.AutoExport.Agent.UI.DeepExport;

/* ---------------------------------------------------------------------------
 * THE THIRD CARRIER OF THE SAME LICENCE KEY, AND THE ONLY ONE NO GREP FINDS.
 *
 * templates/ carried it in plain ASCII and no longer ships at all. The queue
 * snapshots carried it in plain JSON and StrategyConfigurationRedactor empties
 * the map it sat in. This is the third place, inside the database that does
 * ship, and it is the one that would have survived both of those fixes:
 *
 *   MEASURED on a real export, read-only. Strategies holds 12 rows, every one
 *   with a non-null Userdata blob, 179,224 bytes in all, and every one of the
 *   12 carries exactly one non-empty LicenseKey element. TWO distinct values
 *   across those rows, 9 rows holding one and 3 the other, and the value in
 *   those 3 rows appears NOWHERE ELSE in the package - not in templates/, not
 *   in the queue, not anywhere. Deleting a folder could never have reached it.
 *
 *   AN ASCII GREP OVER THAT DATABASE RETURNS 0. The blob is UTF-16LE with no
 *   BOM, and its payload is HTML-escaped XML: the outer document is
 *   <NinjaTrader><_Impl> and the inner text reads &lt;LicenseKey&gt;value
 *   &lt;/LicenseKey&gt;. So on disk the key is 16-bit characters inside an
 *   escaped tag. Measured on the 21.9 MB file: 0 ASCII hits, 12 UTF-16LE hits
 *   in the live cells. A verification that greps the unpacked package for the
 *   plaintext key comes back near-zero and reads as success.
 *
 * WHY A RULE AND NOT A DROPPED TABLE. Strategies is allowlisted and has to be:
 * AttributionExport joins it to name the algorithm that placed an order. The
 * constraint is on the table, not the cell. SqliteSnapshot.CopyRows binds each
 * value as the type SQLite handed back, which is what preserves blobs, so this
 * runs there - in the copy itself, on the way into the shipped file - and not
 * as a pass over a finished database. That matters for the same reason it
 * matters for the trace: a staged file that holds the key even briefly is a
 * file that ships with it the day somebody moves the pass or returns early.
 *
 * WHAT IT DOES NOT TOUCH, AND THIS IS A DECISION, NOT AN OVERSIGHT. The same
 * 12 blobs carry 144 distinct element names, of which about 35 are the strategy
 * parameterisation: PosSize1-3, StopLossTicks, ProfitTarget1-3Ticks,
 * TrailByTicks, StartTrailAfterTicks, BreakEven*, TrailFrequency, the seven day
 * filters, TradeStartTime/TradeEndTime, EdgeLeverage, MaxDailyEntries. Those
 * stay. The line this change draws is: remove the copies the desk already holds
 * somewhere else, and mask the credential everywhere. templates/ went because
 * attribution/catalog.jsonl is the same library and is the copy with a reader.
 * The queue maps went because the CRM already received them. These 12 cells are
 * the live configuration of the strategies that were actually running, nothing
 * else in the package holds it, and attribution/catalog.jsonl already ships the
 * same class of declared geometry on purpose. A licence key is in no sense the
 * same kind of thing and has no reader anywhere.
 *
 * SO THE PACKAGE IS NOT "CLEAN" AFTER THIS AND THE COMMIT MUST NOT SAY IT IS.
 * It still carries the desk's declared geometry in attribution/catalog.jsonl,
 * deliberately, and the live geometry in these blobs, deliberately.
 *
 * NAME-BASED, OVER EVERY CELL, BY CONSTRUCTION. The element name is tested with
 * SecretRedactor.IsSecretKey - the one definition of "named like a secret",
 * which is where `licen[sc]e` was added - and the rule is applied to every TEXT
 * and BLOB cell of every allowlisted table rather than to Strategies.Userdata
 * by name. That costs nothing measurable and covers the next blob nobody
 * predicted: on the big export the cheap gate below opens on 12 of 2,739,801
 * cells, and on the small one on 0 of 30,023.
 * ------------------------------------------------------------------------- */
public static class StrategyUserdataRedactor
{
    /// <summary>The same mask the other two rules use, so one search finds all three.</summary>
    public const string Mask = SecretRedactor.Mask;

    /* AN OPENING TAG, IN EITHER FORM. The escaped form is what a real blob
     * holds; the plain form is what the same payload would look like unescaped,
     * and covering it costs nothing. The name is captured and handed to
     * SecretRedactor.IsSecretKey rather than listed here, so this file does not
     * become a second statement of that list.
     *
     * ONLY THE OPENING TAG, BECAUSE MATCHING THE PAIR IN ONE REGEX DOES NOT WORK
     * ON THE REAL SHAPE, and it fails SILENTLY, which is the dangerous way. Two
     * versions of this were written and tested before the mistake showed:
     *
     *   The payload is escaped XML nested inside PLAIN XML -
     *   <NinjaTrader><_Impl>&lt;G4M_PF&gt;…&lt;LicenseKey&gt;v&lt;/LicenseKey&gt;
     *   …&lt;/G4M_PF&gt;</_Impl></NinjaTrader> - so EVERY element of interest is
     *   inside two wrappers. A plain pattern whose value is "anything but '<'"
     *   matches the entire <_Impl>…</_Impl>, because the escaped text inside has
     *   no literal '<' at all; `_Impl` is not a secret name, so the match was
     *   returned untouched and the key travelled. Splitting it into an escaped
     *   pass and a plain pass did not help: the escaped pattern then matched the
     *   whole &lt;G4M_PF&gt;…&lt;/G4M_PF&gt; element for the same reason, one
     *   level down. A pair-matching regex always finds the OUTERMOST element, and
     *   the outermost element is never the one with the credential in it.
     *
     * So the walk below finds an opening tag, and when the name is not a secret
     * it steps INSIDE and keeps looking. Restricting the value to a leaf - no
     * nested delimiter - would have worked on the measured shape and would have
     * given up the other guarantee: that a value carrying a stray delimiter is
     * still masked WHOLE, because a partly masked credential is a leaked one. */
    private static readonly Regex OpeningTag = new(
        @"&lt;(?<name>[A-Za-z_][\w.\-]*)&gt;|<(?<name>[A-Za-z_][\w.\-]*)>",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    /// <summary>
    /// Cheap gate. A cell with no element delimiters in it cannot hold a
    /// secret-named element, and almost every cell in the database is a number
    /// or a short name. Derived from the SHAPE, not from the name list, so
    /// widening the list cannot leave this behind.
    /// </summary>
    private static bool CouldHoldAnElement(string text)
        => text != null && (text.IndexOf("&lt;", StringComparison.Ordinal) >= 0 || text.IndexOf('<') >= 0);

    /// <summary>
    /// Mask the value of every secret-named element in a text. The element, its
    /// delimiters and everything around it survive, so a reader still sees that
    /// a licence was configured. An already-empty element is left empty, the
    /// rule the other two redactors state.
    /// </summary>
    public static string RedactText(string text)
    {
        if (!CouldHoldAnElement(text)) return text;

        var builder = new StringBuilder(text.Length);
        bool changed = false;
        int at = 0;
        while (at < text.Length)
        {
            Match open = OpeningTag.Match(text, at);
            if (!open.Success) break;

            bool escaped = text[open.Index] == '&';
            string name = open.Groups["name"].Value;
            int valueAt = open.Index + open.Length;
            string closing = escaped ? "&lt;/" + name + "&gt;" : "</" + name + ">";
            int closeAt = text.IndexOf(closing, valueAt, StringComparison.Ordinal);

            // Not a secret, no closing tag, or an empty value: copy up to the end
            // of the tag and carry on INSIDE it. Stepping inside is what reaches an
            // element nested in a wrapper, and an empty value is left empty, which
            // is the rule all four of these rules state - "never configured" and
            // "configured and hidden" stay different facts.
            if (!SecretRedactor.IsSecretKey(name) || closeAt < 0 || closeAt == valueAt)
            {
                builder.Append(text, at, valueAt - at);
                at = valueAt;
                continue;
            }

            builder.Append(text, at, valueAt - at).Append(Mask).Append(closing);
            at = closeAt + closing.Length;
            changed = true;
        }
        if (!changed) return text;
        return builder.Append(text, at, text.Length - at).ToString();
    }

    /// <summary>
    /// A blob's bytes with the same rule applied, in whichever encoding the
    /// payload is really in.
    ///
    /// UTF-16LE IS TRIED FIRST BECAUSE THAT IS WHAT NinjaTrader WRITES, and it
    /// is only accepted when the bytes round-trip through it exactly - an
    /// even-length run of UTF-8 would otherwise decode to mojibake, match
    /// nothing, and be written back as different bytes. A blob the rule does not
    /// recognise is returned AS THE SAME REFERENCE, so a value with nothing to
    /// mask is copied byte for byte and the fidelity CopyRows exists to preserve
    /// is not spent on blobs this has no business touching.
    /// </summary>
    public static byte[] RedactBlob(byte[] value)
    {
        if (value == null || value.Length == 0) return value;

        // RedactText hands back THE SAME REFERENCE when it masked nothing, which
        // is what lets this return the original bytes rather than a re-encoding of
        // them. That matters: CopyRows exists partly to preserve blob values, and
        // a rule that quietly rewrote every blob it merely looked at would be a
        // loss with nothing beside it to notice.
        if (value.Length % 2 == 0)
        {
            string wide = TryDecode(Encoding.Unicode, value);
            if (wide != null && CouldHoldAnElement(wide))
            {
                string masked = RedactText(wide);
                return ReferenceEquals(masked, wide) ? value : Encoding.Unicode.GetBytes(masked);
            }
        }

        string narrow = TryDecode(new UTF8Encoding(false, true), value);
        if (narrow != null && CouldHoldAnElement(narrow))
        {
            string masked = RedactText(narrow);
            if (!ReferenceEquals(masked, narrow)) return new UTF8Encoding(false).GetBytes(masked);
        }
        return value;
    }

    /// <summary>Decode only if the bytes really are that encoding, round-trip included.</summary>
    private static string TryDecode(Encoding encoding, byte[] value)
    {
        try
        {
            var strict = (Encoding)encoding.Clone();
            strict.DecoderFallback = DecoderFallback.ExceptionFallback;
            string text = strict.GetString(value);
            byte[] again = strict.GetBytes(text);
            if (again.Length != value.Length) return null;
            for (int at = 0; at < again.Length; at++)
                if (again[at] != value[at]) return null;
            return text;
        }
        catch (Exception exception) when (exception is DecoderFallbackException or EncoderFallbackException or ArgumentException)
        {
            return null;
        }
    }
}
