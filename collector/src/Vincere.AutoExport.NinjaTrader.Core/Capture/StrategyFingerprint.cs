using System;
using System.Collections.Generic;
using System.Linq;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{
    /* -----------------------------------------------------------------------
     * THE ALGORITHM, READ OFF THE SHAPE OF THE TRADE.
     *
     * A strategy template declares the geometry it trades with: how many
     * contracts each scale-out leg takes, and how far the stop and each profit
     * target sit from the entry, in ticks. A placed trade leaves exactly that
     * geometry behind in the order book. So the trade can be matched back to
     * the template that produced it, without anybody having recorded which
     * strategy placed it.
     *
     * MEASURED, NOT ASSUMED. On a real VPS on 2026-09-24, the G4M template
     * declared PosSize 2/1/1, stop 80, targets 80/120/160. Its orders in
     * NinjaTrader's own database sat at exactly 80, 120, 160 and 80 ticks from
     * the entry fill, with quantities 2, 1, 1 and 4. Tick for tick.
     *
     * WHAT THIS BUYS. That machine held 886 templates across 20 algorithm
     * families. Instrument plus this geometry identifies the family uniquely:
     * of 173 distinct fingerprints, 105 are shared by exactly two families and
     * every one of those pairs is an algorithm and its own _PF variant - the
     * same algorithm configured for a prop firm account. Zero genuinely
     * different algorithms collide. The account type settles the remaining
     * pair.
     *
     * AND THE VERSION, TWO TIMES IN THREE. Of 50 family/instrument/risk groups,
     * 33 change geometry between versions - RBO on M2K at High risk moves its
     * stop across 100, 90, 105, 100, 105 ticks from v1 to v5, and v5 also moves
     * the ladder from 6/6/6 to 8/6/4. In the other 17 the versions are
     * geometrically identical and this cannot tell them apart. It says so
     * rather than guessing.
     *
     * WHY THE MATCH IS EXACT AND NEVER FUZZY. Versions are separated by as
     * little as five ticks. A tolerance wide enough to absorb noise is wide
     * enough to answer the wrong version, and a wrong answer is worse than
     * none: it moves a day's losses onto an algorithm that never traded them.
     * A trade that does not match exactly is reported unmatched.
     * --------------------------------------------------------------------- */

    /// <summary>The geometry a template declares, or a trade exhibits.</summary>
    public sealed class StrategyFingerprint : IEquatable<StrategyFingerprint>
    {
        public StrategyFingerprint(
            string instrument,
            int size1, int size2, int size3,
            int stopTicks,
            int target1Ticks, int target2Ticks, int target3Ticks)
        {
            Instrument = (instrument ?? string.Empty).Trim().ToUpperInvariant();
            Size1 = size1;
            Size2 = size2;
            Size3 = size3;
            StopTicks = stopTicks;
            Target1Ticks = target1Ticks;
            Target2Ticks = target2Ticks;
            Target3Ticks = target3Ticks;
        }

        public string Instrument { get; private set; }
        public int Size1 { get; private set; }
        public int Size2 { get; private set; }
        public int Size3 { get; private set; }
        public int StopTicks { get; private set; }
        public int Target1Ticks { get; private set; }
        public int Target2Ticks { get; private set; }
        public int Target3Ticks { get; private set; }

        /// <summary>A fingerprint with no geometry at all matches nothing, on purpose.</summary>
        public bool IsEmpty
        {
            get
            {
                return Instrument.Length == 0
                    || (StopTicks <= 0 && Target1Ticks <= 0 && Target2Ticks <= 0 && Target3Ticks <= 0);
            }
        }

        public bool Equals(StrategyFingerprint other)
        {
            return other != null
                && string.Equals(Instrument, other.Instrument, StringComparison.Ordinal)
                && Size1 == other.Size1 && Size2 == other.Size2 && Size3 == other.Size3
                && StopTicks == other.StopTicks
                && Target1Ticks == other.Target1Ticks
                && Target2Ticks == other.Target2Ticks
                && Target3Ticks == other.Target3Ticks;
        }

        public override bool Equals(object obj) { return Equals(obj as StrategyFingerprint); }

        public override int GetHashCode()
        {
            unchecked
            {
                int hash = 17;
                hash = (hash * 31) + Instrument.GetHashCode();
                hash = (hash * 31) + Size1;
                hash = (hash * 31) + Size2;
                hash = (hash * 31) + Size3;
                hash = (hash * 31) + StopTicks;
                hash = (hash * 31) + Target1Ticks;
                hash = (hash * 31) + Target2Ticks;
                hash = (hash * 31) + Target3Ticks;
                return hash;
            }
        }

        public override string ToString()
        {
            return Instrument + "|" + Size1 + "/" + Size2 + "/" + Size3
                + "|S" + StopTicks + "|T" + Target1Ticks + "/" + Target2Ticks + "/" + Target3Ticks;
        }
    }

    /// <summary>One template on the machine, reduced to what identifies it.</summary>
    public sealed class StrategyTemplate
    {
        public StrategyTemplate(string family, string version, string risk, bool propFirm, StrategyFingerprint fingerprint)
        {
            Family = family;
            Version = version;
            Risk = risk;
            PropFirm = propFirm;
            Fingerprint = fingerprint;
        }

        /// <summary>`RBO`, with the `_PF` suffix stripped: that is a variant, not an algorithm.</summary>
        public string Family { get; private set; }
        public string Version { get; private set; }
        public string Risk { get; private set; }
        public bool PropFirm { get; private set; }
        public StrategyFingerprint Fingerprint { get; private set; }
    }

    /// <summary>What the catalogue could say about one trade.</summary>
    public sealed class FingerprintMatch
    {
        public FingerprintMatch(string family, string version, string risk, bool versionCertain, int candidates)
        {
            Family = family;
            Version = version;
            Risk = risk;
            VersionCertain = versionCertain;
            Candidates = candidates;
        }

        public static readonly FingerprintMatch NoMatch = new FingerprintMatch(null, null, null, false, 0);

        public string Family { get; private set; }
        public string Version { get; private set; }
        public string Risk { get; private set; }

        /// <summary>
        /// False when several versions share this geometry. The family is still
        /// certain; the version is reported as null rather than picked.
        /// </summary>
        public bool VersionCertain { get; private set; }

        /// <summary>How many templates carried this geometry. 0 is no match.</summary>
        public int Candidates { get; private set; }

        public bool Matched { get { return Family != null; } }
    }

    /// <summary>
    /// What one trade actually exhibited: the rungs it placed, and nothing it
    /// did not. A trade that took its first two targets and was then stopped
    /// never places a third, so it has two rungs and a stop, and asking it for
    /// a third is asking about an order that does not exist.
    /// </summary>
    public sealed class TradeGeometry
    {
        private readonly Dictionary<int, TradeRung> rungs = new Dictionary<int, TradeRung>();

        public TradeGeometry(string instrument) { Instrument = (instrument ?? string.Empty).Trim().ToUpperInvariant(); }

        public string Instrument { get; private set; }

        /// <summary>0 when no stop was placed or its price could not be read.</summary>
        public int StopTicks { get; set; }

        public IDictionary<int, TradeRung> Rungs { get { return rungs; } }

        public void AddRung(int number, int ticks, int size)
        {
            if (number < 1 || number > 3 || rungs.ContainsKey(number)) return;
            rungs[number] = new TradeRung(ticks, size);
        }

        /// <summary>Nothing to match on is not a match of nothing; it is no question.</summary>
        public bool IsEmpty
        {
            get { return Instrument.Length == 0 || (rungs.Count == 0 && StopTicks <= 0); }
        }

        public override string ToString()
        {
            var parts = rungs.OrderBy(pair => pair.Key)
                .Select(pair => "T" + pair.Key + "=" + pair.Value.Ticks + "x" + pair.Value.Size);
            return Instrument + "|S" + StopTicks + "|" + string.Join(",", parts.ToArray());
        }
    }

    public sealed class TradeRung
    {
        public TradeRung(int ticks, int size) { Ticks = ticks; Size = size; }
        public int Ticks { get; private set; }
        public int Size { get; private set; }
    }

    /// <summary>The machine's template library, asked about one trade at a time.</summary>
    public sealed class StrategyCatalog
    {
        private readonly Dictionary<string, List<StrategyTemplate>> byInstrument;

        public StrategyCatalog(IEnumerable<StrategyTemplate> templates)
        {
            byInstrument = new Dictionary<string, List<StrategyTemplate>>(StringComparer.OrdinalIgnoreCase);
            foreach (StrategyTemplate template in templates ?? new List<StrategyTemplate>())
            {
                if (template == null || template.Fingerprint == null || template.Fingerprint.IsEmpty) continue;
                List<StrategyTemplate> bucket;
                string key = template.Fingerprint.Instrument;
                if (!byInstrument.TryGetValue(key, out bucket))
                {
                    bucket = new List<StrategyTemplate>();
                    byInstrument[key] = bucket;
                }
                bucket.Add(template);
            }
        }

        public int Size { get { return byInstrument.Values.Sum(bucket => bucket.Count); } }

        /// <summary>
        /// Which algorithm produced a trade with this geometry.
        ///
        /// MATCHED ON WHAT THE TRADE SHOWS, NOT ON THE WHOLE TEMPLATE. Requiring
        /// every declared rung meant only trades that ran all the way to their
        /// third target could ever match: on a real machine that was 446 trades
        /// of 4,782, and the matcher recognised 5% of seven months. Comparing
        /// only the rungs the trade actually placed, it recognises 55%, with
        /// the version in 53%, and no trade matched two families.
        ///
        /// Every rung present must agree on BOTH its distance and its size, and
        /// the stop must agree when one was placed. A trade that agrees on
        /// nothing is not compared.
        /// </summary>
        public FingerprintMatch Match(TradeGeometry trade)
        {
            if (trade == null || trade.IsEmpty) return FingerprintMatch.NoMatch;
            List<StrategyTemplate> bucket;
            if (!byInstrument.TryGetValue(trade.Instrument, out bucket)) return FingerprintMatch.NoMatch;

            var candidates = bucket.Where(template => Fits(template.Fingerprint, trade)).ToList();
            if (candidates.Count == 0) return FingerprintMatch.NoMatch;

            var families = candidates.Select(t => t.Family)
                .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            if (families.Count != 1) return FingerprintMatch.NoMatch;

            var versions = candidates.Select(t => t.Version)
                .Where(v => !string.IsNullOrWhiteSpace(v))
                .Distinct(StringComparer.OrdinalIgnoreCase).ToList();
            var risks = candidates.Select(t => t.Risk)
                .Where(r => !string.IsNullOrWhiteSpace(r))
                .Distinct(StringComparer.OrdinalIgnoreCase).ToList();

            bool versionCertain = versions.Count == 1;
            return new FingerprintMatch(
                families[0],
                versionCertain ? versions[0] : null,
                risks.Count == 1 ? risks[0] : null,
                versionCertain,
                candidates.Count);
        }

        private static bool Fits(StrategyFingerprint declared, TradeGeometry trade)
        {
            if (trade.StopTicks > 0 && declared.StopTicks != trade.StopTicks) return false;
            foreach (KeyValuePair<int, TradeRung> pair in trade.Rungs)
            {
                int ticks;
                int size;
                switch (pair.Key)
                {
                    case 1: ticks = declared.Target1Ticks; size = declared.Size1; break;
                    case 2: ticks = declared.Target2Ticks; size = declared.Size2; break;
                    case 3: ticks = declared.Target3Ticks; size = declared.Size3; break;
                    default: return false;
                }
                if (ticks != pair.Value.Ticks || size != pair.Value.Size) return false;
            }
            return true;
        }
    }
}
