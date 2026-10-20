using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Xml;
using System.Xml.Linq;
using Vincere.AutoExport.Agent.UI.DeepExport;

namespace Vincere.AutoExport.Agent.Exports;

/// <summary>One strategy's configuration as it may leave the machine.</summary>
/// <param name="Parameters">Leaf element name to value, in document order, every secret already masked. Null unless Status is "read".</param>
/// <param name="Status">"read", "absent" (no configuration stored) or "unreadable" (stored, and not parsed - so nothing of it is emitted).</param>
/// <param name="Geometry">The raw numbers the catalogue match needs, read before masking; none of them is secret-named.</param>
public sealed record StrategyConfiguration(
    IReadOnlyList<KeyValuePair<string, string>> Parameters,
    string Status,
    IReadOnlyDictionary<string, string> Geometry);

/* ---------------------------------------------------------------------------
 * A STRATEGY INSTANCE'S CONFIGURATION, FROM THE CELL NINJATRADER KEEPS IT IN.
 *
 * Strategies.Userdata is the live parameterisation of each strategy the
 * platform holds - StrategyUserdataRedactor's header has the measurements: a
 * UTF-16LE blob, an outer <NinjaTrader><_Impl> document whose text is
 * HTML-escaped XML, and inside it one element per property, about 35 of them the
 * stop, the targets, the sizes, the trail, break-even, the session window and the
 * day filters, and one of them a LicenseKey holding a live NinjaTrader licence.
 *
 * This reads the inner document's leaf elements into name/value pairs and masks
 * as it reads. THE RULES ARE THE EXISTING ONES, NOT NEW ONES:
 *
 *   - a leaf whose NAME is a secret by SecretRedactor.IsSecretKey - the single
 *     definition, licen[sc]e included - keeps its name and loses its value to
 *     the shared mask; an empty value stays empty, so "never configured" and
 *     "configured and hidden" stay different facts, as all five rules state;
 *   - every other value goes through StrategyUserdataRedactor.RedactText, so an
 *     element nested inside a value is masked the way the database copy masks it.
 *
 * AND ONE THING THOSE RULES NEVER HAD TO DO, because they mask in place and this
 * lifts values out of their context. The measured queue snapshot carries the key
 * a second time inside DisplayParameters, as "LicenseKey=<value>" - a value whose
 * NAME is not secret. So the value of every secret-named leaf is remembered
 * (SecretValues) and the writer replaces it wherever else it appears, in any
 * string of the whole file; and a "Name=value" or "Name: value" pair inside a
 * value is masked when Name is secret by the same predicate. Short values are not
 * remembered for that sweep - a secret-named boolean switch is "True", and
 * erasing every "True" in the file would protect nothing and destroy the rest.
 *
 * A CELL THAT DOES NOT PARSE EMITS NOTHING. Not the raw text, not a prefix of
 * it: a configuration this cannot inspect is one whose key it cannot find.
 * ------------------------------------------------------------------------- */
public static class StrategyConfigurationReader
{
    public const string Read = "read";
    public const string Absent = "absent";
    public const string Unreadable = "unreadable";

    /// <summary>Shorter than this, a secret-named value is masked where it stands but not hunted for elsewhere.</summary>
    public const int MinimumPropagatedSecretLength = 8;

    /// <summary>The parameters the catalogue match reads: StrategyTemplateReader's field names.</summary>
    public static readonly IReadOnlyList<string> GeometryFields = new[]
    {
        "PosSize1", "PosSize2", "PosSize3", "StopLossTicks",
        "ProfitTarget1Ticks", "ProfitTarget2Ticks", "ProfitTarget3Ticks",
    };

    private const int MaximumCharacters = 8 * 1024 * 1024;

    private static readonly Regex SecretPair = new(
        @"(?<name>[A-Za-z_][A-Za-z0-9_.\-]*)(?<sep>\s*[=:]\s*)(?<value>[^;,|\s]+)",
        RegexOptions.CultureInvariant | RegexOptions.Compiled);

    private static readonly XmlReaderSettings Settings = new()
    {
        DtdProcessing = DtdProcessing.Prohibit,
        XmlResolver = null,
        MaxCharactersInDocument = MaximumCharacters,
        IgnoreComments = true,
        IgnoreProcessingInstructions = true,
    };

    /// <param name="cell">The Userdata value as SQLite handed it back: bytes, text or null.</param>
    /// <param name="secretValues">Receives every secret-named value long enough to be hunted for elsewhere.</param>
    public static StrategyConfiguration ReadCell(object cell, ISet<string> secretValues)
    {
        ArgumentNullException.ThrowIfNull(secretValues);
        // Nothing stored is "absent"; something stored that is not text is
        // "unreadable" - never the same answer, because only one of them can be
        // hiding a configuration.
        if (cell == null || cell is byte[] { Length: 0 } || (cell is string stored && string.IsNullOrWhiteSpace(stored)))
            return new StrategyConfiguration(null, Absent, Empty);
        string text = Decode(cell);
        if (string.IsNullOrWhiteSpace(text)) return new StrategyConfiguration(null, Unreadable, Empty);

        List<XElement> leaves = Leaves(text);
        if (leaves == null) return new StrategyConfiguration(null, Unreadable, Empty);

        var parameters = new List<KeyValuePair<string, string>>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var geometry = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (XElement leaf in leaves)
        {
            string name = leaf.Name.LocalName;
            string raw = leaf.Value ?? string.Empty;
            bool secret = SecretRedactor.IsSecretKey(name);
            if (secret && raw.Trim().Length >= MinimumPropagatedSecretLength) secretValues.Add(raw.Trim());
            if (!seen.Add(name)) continue; // the first occurrence names the parameter
            if (!secret && GeometryFields.Contains(name, StringComparer.OrdinalIgnoreCase)) geometry[name] = raw.Trim();
            string value = secret
                ? (raw.Length == 0 ? string.Empty : SecretRedactor.Mask)
                : MaskPairs(StrategyUserdataRedactor.RedactText(raw));
            parameters.Add(new KeyValuePair<string, string>(name, value));
        }
        return new StrategyConfiguration(parameters, Read, geometry);
    }

    /// <summary>"LicenseKey=value" inside a value: the value is masked when the name is secret.</summary>
    public static string MaskPairs(string value)
    {
        if (string.IsNullOrEmpty(value) || value.IndexOfAny(new[] { '=', ':' }) < 0) return value;
        return SecretPair.Replace(value, match => SecretRedactor.IsSecretKey(match.Groups["name"].Value)
            ? match.Groups["name"].Value + match.Groups["sep"].Value + SecretRedactor.Mask
            : match.Value);
    }

    /// <summary>Whether a parameter's text reads as a switch that is on, off, or neither.</summary>
    public static bool? Switch(string value)
        => bool.TryParse((value ?? string.Empty).Trim(), out bool parsed) ? parsed : null;

    private static readonly IReadOnlyDictionary<string, string> Empty = new Dictionary<string, string>();

    /* The leaf elements of the configuration, or null when it is not XML. The
     * real shape nests the parameters as escaped text inside <_Impl>; a cell
     * that is plain XML is read as it stands. */
    private static List<XElement> Leaves(string text)
    {
        XDocument outer = Parse(text);
        if (outer?.Root == null) return null;
        XElement impl = outer.Root.DescendantsAndSelf().FirstOrDefault(element => element.Name.LocalName == "_Impl");
        XElement root = outer.Root;
        if (impl != null)
        {
            string inner = impl.Value?.Trim() ?? string.Empty;
            if (inner.StartsWith("<", StringComparison.Ordinal))
            {
                XDocument nested = Parse(inner);
                if (nested?.Root == null) return null;
                root = nested.Root;
            }
            else if (impl.HasElements)
            {
                root = impl;
            }
            else
            {
                return new List<XElement>();
            }
        }
        return root.Descendants().Where(element => !element.HasElements).ToList();
    }

    private static XDocument Parse(string text)
    {
        try
        {
            using StringReader reader = new(text);
            using XmlReader xml = XmlReader.Create(reader, Settings);
            return XDocument.Load(xml);
        }
        catch (Exception exception) when (exception is XmlException or InvalidOperationException)
        {
            return null;
        }
    }

    /* UTF-16LE first, because that is what NinjaTrader writes, accepted only when
     * the bytes round-trip exactly - the rule StrategyUserdataRedactor.RedactBlob
     * applies, for the same reason: an even-length run of UTF-8 would otherwise
     * decode to something that is not the configuration. */
    private static string Decode(object cell)
    {
        switch (cell)
        {
            case string text:
                return text;
            case byte[] bytes when bytes.Length > 0:
                if (bytes.Length % 2 == 0)
                {
                    string wide = Strict(Encoding.Unicode, bytes);
                    if (wide != null && wide.IndexOf('<') >= 0) return wide;
                }
                return Strict(new UTF8Encoding(false, true), bytes);
            default:
                return null;
        }
    }

    private static string Strict(Encoding encoding, byte[] bytes)
    {
        try
        {
            var strict = (Encoding)encoding.Clone();
            strict.DecoderFallback = DecoderFallback.ExceptionFallback;
            strict.EncoderFallback = EncoderFallback.ExceptionFallback;
            string text = strict.GetString(bytes);
            return strict.GetBytes(text).AsSpan().SequenceEqual(bytes) ? text : null;
        }
        catch (Exception exception) when (exception is DecoderFallbackException or EncoderFallbackException or ArgumentException)
        {
            return null;
        }
    }
}
