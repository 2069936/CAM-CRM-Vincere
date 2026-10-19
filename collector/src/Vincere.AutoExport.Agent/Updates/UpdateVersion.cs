using System;
using System.Text.RegularExpressions;

namespace Vincere.AutoExport.Agent.Updates;

/* VERSIONS, COMPARED THE WAY A PERSON READS THEM.
 *
 * System.Version alone gets one case wrong that matters here: 1.2.1 and 1.2.1.0
 * are the same release, and Version says the first is LOWER, because a missing
 * component is -1. The AddOn reports four components on some machines and three
 * on others, so a straight comparison would refuse an update to a machine whose
 * AddOn is exactly the one required. Missing components count as zero here. */
public static class UpdateVersion
{
    /* x.y.z and nothing else: no leading zeros, no fourth part, no prefix, no
     * whitespace. The directive's version is built into a URL that is compared
     * byte for byte, so there is exactly one way to write each version. */
    private static readonly Regex TriplePattern = new(
        @"^(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\z",
        RegexOptions.CultureInvariant);

    // What an agent or an AddOn may say about itself: two to four numeric parts.
    private static readonly Regex LoosePattern = new(
        @"^[0-9]{1,5}(\.[0-9]{1,5}){1,3}\z",
        RegexOptions.CultureInvariant);

    public static bool IsTriple(string value) => value != null && TriplePattern.IsMatch(value);

    public static bool TryParseTriple(string value, out Version version)
    {
        version = null;
        if (!IsTriple(value)) return false;
        version = Version.Parse(value);
        return true;
    }

    public static bool TryParseLoose(string value, out Version version)
    {
        version = null;
        string trimmed = value?.Trim();
        if (string.IsNullOrEmpty(trimmed) || !LoosePattern.IsMatch(trimmed)) return false;
        return Version.TryParse(trimmed, out version);
    }

    /// <summary>Negative when <paramref name="left"/> is older, zero when equal, positive when newer.</summary>
    public static int Compare(Version left, Version right)
    {
        ArgumentNullException.ThrowIfNull(left);
        ArgumentNullException.ThrowIfNull(right);
        int result = left.Major.CompareTo(right.Major);
        if (result != 0) return result;
        result = left.Minor.CompareTo(right.Minor);
        if (result != 0) return result;
        result = Part(left.Build).CompareTo(Part(right.Build));
        if (result != 0) return result;
        return Part(left.Revision).CompareTo(Part(right.Revision));
    }

    private static int Part(int value) => value < 0 ? 0 : value;
}
