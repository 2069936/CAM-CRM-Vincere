using System.Text.RegularExpressions;

namespace Vincere.AutoExport.Agent.UI.DeepExport;

/* ---------------------------------------------------------------------------
 * Nothing that opens a door leaves the machine.
 *
 * Keys are matched by NAME, case-insensitively. A field called "deviceToken" and
 * one called "api_key" are both caught. Every caller replaces the value and
 * keeps the key, so the analyst can still see that a credential was configured,
 * which is itself a fact worth knowing.
 *
 * The acceptance test is a grep over the unpacked ZIP for password|apikey|
 * token|secret that finds only "***". This is the code that has to make that
 * test pass, so the pattern here is deliberately broader than the test.
 *
 * THIS ANSWERS ONE QUESTION AND IT IS NOT THE ONLY ONE THE EXPORT HAS TO ASK.
 * It used to perform the copy of the agent's config.json itself, and that was
 * the wrong shape for that file: a denylist asks "is this key named like a
 * credential?", clientName is not, so a person's name travelled in a file whose
 * name says redacted. Widening the list to cover names would have been this
 * repository's THIRD go at making one rule answer two questions - the trace
 * already needed its own redactor for the same reason. The config file is now
 * governed by AgentConfigProjection, an allowlist, which calls IsSecretKey
 * about every key it is about to emit; see its header. So the JSON pass that
 * used to live here is gone rather than kept as a second statement of a rule
 * that no longer governs anything.
 *
 * `licen[sc]e` IS IN THE LIST NOW, AND ITS ABSENCE IS WHY A KEY TRAVELLED.
 * NinjaTrader's licence key is a device credential and it is named LicenseKey,
 * which matched none of password|apikey|token|secret|credential - so every rule
 * in the collector that asks this question answered no about it. The CRM side
 * had already worked this out: server/export/clientExport.js matches
 * licen[sc]e|password|passwd|secret|token|credential|api_?key and drops those
 * parameters from a client export. The collector's list was strictly narrower
 * than the CRM's for no reason anybody recorded. Both spellings, because the
 * British one appears in prose and nothing stops a field using it.
 *
 * THIS PREDICATE IS THE SINGLE DEFINITION OF "NAMED LIKE A SECRET" and it now
 * has three callers, none of which is a pass of its own: StrategyUserdataRedactor
 * for a secret-named XML element inside a database blob, AgentConfigProjection
 * for every key it is about to emit, and the suite. Do not restate the list; add
 * to it here.
 * ------------------------------------------------------------------------- */
public static class SecretRedactor
{
    public const string Mask = "***";

    private static readonly Regex SecretKey = new(
        @"(password|passwd|pwd|api[_-]?key|apikey|token|secret|credential|bearer|authorization|licen[sc]e)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static bool IsSecretKey(string key) => !string.IsNullOrEmpty(key) && SecretKey.IsMatch(key);
}
