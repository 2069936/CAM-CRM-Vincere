using System;
using System.Text.RegularExpressions;
using Newtonsoft.Json.Linq;

namespace Vincere.AutoExport.Agent.UI.DeepExport;

/* ---------------------------------------------------------------------------
 * Nothing that opens a door leaves the machine.
 *
 * The export copies the agent's own configuration so an analyst can see how the
 * machine was set up: schedule, paths, versions. It must not copy what the
 * configuration uses to authenticate, because the ZIP is handed around over
 * Drive and Discord and read by people who have no business holding a device
 * credential.
 *
 * Keys are matched by NAME, case-insensitively, anywhere in the tree. A field
 * called "deviceToken" and one called "api_key" are both caught. The value is
 * replaced, never removed, so the analyst can still see that a credential was
 * configured, which is itself a fact worth knowing.
 *
 * The acceptance test is a grep over the unpacked ZIP for password|apikey|
 * token|secret that finds only "***". This is the code that has to make that
 * test pass, so the pattern here is deliberately broader than the test.
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
 * has two callers: RedactJsonText below, for the agent's own config.json, and
 * StrategyUserdataRedactor, for a secret-named XML element inside a database
 * blob. Do not restate the list; add to it here.
 * ------------------------------------------------------------------------- */
public static class SecretRedactor
{
    public const string Mask = "***";

    private static readonly Regex SecretKey = new(
        @"(password|passwd|pwd|api[_-]?key|apikey|token|secret|credential|bearer|authorization|licen[sc]e)",
        RegexOptions.IgnoreCase | RegexOptions.Compiled);

    public static bool IsSecretKey(string key) => !string.IsNullOrEmpty(key) && SecretKey.IsMatch(key);

    /// <summary>Redact every secret-named field in a JSON document, in place.</summary>
    public static JToken Redact(JToken token)
    {
        if (token is JObject obj)
        {
            foreach (JProperty property in obj.Properties())
            {
                if (IsSecretKey(property.Name))
                {
                    // Only a value that was actually there is masked. A null or
                    // empty credential stays as it was, so "never configured"
                    // and "configured and hidden" remain distinguishable.
                    if (property.Value.Type != JTokenType.Null
                        && !(property.Value.Type == JTokenType.String && string.IsNullOrEmpty(property.Value.ToString())))
                    {
                        property.Value = Mask;
                    }
                }
                else
                {
                    Redact(property.Value);
                }
            }
        }
        else if (token is JArray array)
        {
            foreach (JToken item in array) Redact(item);
        }
        return token;
    }

    /// <summary>Redact a JSON text. Text that is not JSON is returned masked whole rather than leaked.</summary>
    public static string RedactJsonText(string json)
    {
        try
        {
            return Redact(JToken.Parse(json ?? string.Empty)).ToString(Newtonsoft.Json.Formatting.Indented);
        }
        catch (Newtonsoft.Json.JsonException)
        {
            // A configuration file that does not parse cannot be inspected for
            // secrets, so none of it is exported. Losing the analyst a config
            // dump is better than losing the desk a credential.
            return "{ \"redacted\": \"configuration was not valid JSON and was withheld\" }";
        }
    }
}
