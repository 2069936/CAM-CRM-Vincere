using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;
using System.Xml.Linq;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{
    /* -----------------------------------------------------------------------
     * THE ALGORITHM CATALOGUE, READ OFF THE MACHINE.
     *
     * NinjaTrader keeps one XML per strategy template under
     * templates/Strategy/<Family>/. A real VPS carried 886 of them across 20
     * families, five versions and three risk levels. Each one declares the
     * geometry the algorithm trades with, which is what identifies it.
     *
     * WHERE EACH FIELD COMES FROM, because they come from two different places
     * and a reader that assumes one source gets half of them wrong.
     *
     * The geometry is in the XML: PosSize1..3, StopLossTicks and
     * ProfitTarget1..3Ticks. Those are the algorithm's own parameters.
     *
     * The identity is in the PATH: the folder is the family, and the file name
     * carries the instrument, the risk level and the version, in the shape
     * `1 - G4M (MES) - 15 Min - Low Risk - v1 - Period 0.xml`. The XML's own
     * <Name> holds a display string like `0 - G4M-3.4` which mixes the family
     * and a product version that is not the template version, so it is read as
     * a label and never parsed for identity.
     *
     * THE _PF SUFFIX IS A VARIANT, NOT AN ALGORITHM. `RBO_PF` is RBO configured
     * for a prop firm account. Measured across the catalogue, an algorithm and
     * its own _PF share their geometry in every case, and no two genuinely
     * different algorithms do. Folding the suffix here is what lets the match
     * answer one family instead of refusing.
     * --------------------------------------------------------------------- */
    public static class StrategyTemplateReader
    {
        private static readonly Regex InstrumentPattern = new Regex(@"\(([A-Za-z0-9]{1,6})\)", RegexOptions.Compiled);
        private static readonly Regex VersionPattern = new Regex(@"(?:^|[\s\-])v(\d+)(?:[\s\-]|$)", RegexOptions.Compiled | RegexOptions.IgnoreCase);
        private static readonly Regex RiskPattern = new Regex(@"\b(Low|Medium|High)\s+Risk\b", RegexOptions.Compiled | RegexOptions.IgnoreCase);

        private static readonly string[] SizeFields = { "PosSize1", "PosSize2", "PosSize3" };
        private static readonly string[] TargetFields = { "ProfitTarget1Ticks", "ProfitTarget2Ticks", "ProfitTarget3Ticks" };

        /// <summary>
        /// One template, or null when the file declares no geometry.
        ///
        /// Null rather than an empty template on purpose: a catalogue entry
        /// that matches everything is worse than a missing one, and a file
        /// without these fields is a strategy this method does not understand.
        /// </summary>
        public static StrategyTemplate Read(string folderName, string fileName, string xml)
        {
            if (string.IsNullOrWhiteSpace(xml)) return null;

            XDocument document;
            try { document = XDocument.Parse(xml); }
            catch (System.Xml.XmlException) { return null; }

            var values = new Dictionary<string, int>(StringComparer.OrdinalIgnoreCase);
            foreach (XElement element in document.Descendants())
            {
                if (element.HasElements) continue;
                int number;
                if (TryNumber(element.Value, out number) && !values.ContainsKey(element.Name.LocalName))
                    values[element.Name.LocalName] = number;
            }

            int[] sizes = SizeFields.Select(field => Lookup(values, field)).ToArray();
            int[] targets = TargetFields.Select(field => Lookup(values, field)).ToArray();
            int stop = Lookup(values, "StopLossTicks");
            if (stop <= 0 && targets.All(target => target <= 0)) return null;

            string name = fileName ?? string.Empty;
            var fingerprint = new StrategyFingerprint(
                Instrument(name), sizes[0], sizes[1], sizes[2], stop, targets[0], targets[1], targets[2]);
            if (fingerprint.IsEmpty) return null;

            string family = (folderName ?? string.Empty).Trim();
            bool propFirm = family.EndsWith("_PF", StringComparison.OrdinalIgnoreCase);
            if (propFirm) family = family.Substring(0, family.Length - 3);

            return new StrategyTemplate(family, Version(name), Risk(name), propFirm, fingerprint);
        }

        public static string Instrument(string fileName)
        {
            Match match = InstrumentPattern.Match(fileName ?? string.Empty);
            return match.Success ? match.Groups[1].Value.ToUpperInvariant() : string.Empty;
        }

        public static string Version(string fileName)
        {
            Match match = VersionPattern.Match(fileName ?? string.Empty);
            return match.Success ? "v" + match.Groups[1].Value : null;
        }

        public static string Risk(string fileName)
        {
            Match match = RiskPattern.Match(fileName ?? string.Empty);
            if (!match.Success) return null;
            string risk = match.Groups[1].Value.ToLowerInvariant();
            return char.ToUpperInvariant(risk[0]) + risk.Substring(1);
        }

        private static int Lookup(IDictionary<string, int> values, string field)
        {
            int value;
            return values.TryGetValue(field, out value) ? value : 0;
        }

        /// <summary>
        /// NinjaTrader writes these as plain integers, but a template edited by
        /// hand can carry `2.0`. Both are the same ladder.
        /// </summary>
        private static bool TryNumber(string text, out int value)
        {
            value = 0;
            if (string.IsNullOrWhiteSpace(text)) return false;
            string trimmed = text.Trim();
            int direct;
            if (int.TryParse(trimmed, NumberStyles.Integer, CultureInfo.InvariantCulture, out direct))
            {
                value = direct;
                return true;
            }
            double approximate;
            if (double.TryParse(trimmed, NumberStyles.Float, CultureInfo.InvariantCulture, out approximate)
                && Math.Abs(approximate - Math.Round(approximate)) < 0.0001)
            {
                value = (int)Math.Round(approximate);
                return true;
            }
            return false;
        }
    }
}
