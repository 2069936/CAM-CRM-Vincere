using System;
using System.Collections.Generic;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Vincere.AutoExport.Agent.UI.DeepExport;

/* ---------------------------------------------------------------------------
 * WHO THE EXPORT IS ABOUT IS NOT A SECRET, WHICH IS EXACTLY WHY IT TRAVELLED.
 *
 * config/agent.config.redacted.json is eleven lines at the top of the ZIP, the
 * first thing anybody opens, and its filename says redacted. It carried
 * clientName - a person's name - on both real exports measured on the operator's
 * machine. The rule applied to it was SecretRedactor, which asks one question:
 * is this key NAMED like a credential? clientName is not. Neither are deviceId
 * or crmBaseUrl. They are IDENTITY, a different question, and nothing in the
 * copy was ever asking it.
 *
 * THE FIX IS NOT TO TEACH THE SECRET RULE THE WORD "CLIENT". This repository has
 * already paid for conflating the two questions: the licence key travelled
 * because every rule that asked "is this a secret?" answered no about a field
 * called LicenseKey, and the trace needed a second redactor because one rule
 * answering two questions answered both badly. Widening the denylist would be
 * the same mistake a third time, and it would still be a denylist - fail-open in
 * the direction that costs, where the field nobody thought of ships.
 *
 * SO THIS IS AN ALLOWLIST, AND IT EMITS ONLY KEYS IT NAMES. A field added to
 * config.json later is not in this file, so it cannot ride out unexamined.
 *
 * IT MIRRORS A PROJECTION THAT ALREADY EXISTS AND DOES NOT REPLACE IT.
 * RedactedAgentState, in the Agent project, is opt-in by construction and was
 * built with care - hasCredential rather than the credential, machineIdHash
 * rather than the machine id. It carries clientName, and for its one consumer
 * that is RIGHT: DiagnosticsCollector serves the local control pipe on the same
 * machine, where naming the client is the point. This file is the same shape
 * with a second policy, because a ZIP that goes to Drive and Discord is a
 * different destination from a pipe to localhost. Two destinations, two
 * policies. AgentConfigProjectionTests reads that class's SOURCE and fails when
 * a JsonProperty on it is classified nowhere here, so growing one forces a
 * decision about the other at build time.
 *
 * IT LIVES IN THE UI PROJECT ON PURPOSE. Vincere.AutoExport.Agent.UI.csproj
 * references Contracts and NinjaTrader.Core and nothing else; a WPF project
 * taking a ProjectReference on the service project to reach one class would move
 * packages.lock.json and is a far larger change than this needs. The tie is the
 * test, not a reference.
 *
 * THE DECISIONS, because a reader should not have to infer them.
 *   clientName   MASKED. The one field that names a human.
 *   deviceId     KEPT. A GUID names nobody, and it is how an analyst ties this
 *                package to a device row in the CRM. Dropping it costs a real
 *                answer for no gain.
 *   crmBaseUrl   KEPT. A public deployment URL. On both real exports it was 35
 *                characters, which is the exact length of the value compiled
 *                into AgentOptions.CreateDefault() and visible in this
 *                repository - so it held nothing about a client, and it tells
 *                the analyst which deployment the machine reported to.
 *   hasCredential, machineIdHash
 *                DERIVED. RedactedAgentState computes them for the pipe; the
 *                configuration file has no such field to read, so there is
 *                nothing here to project and saying "kept" would be a lie.
 *
 * WHAT A READER CAN TELL FROM THE FILE ITSELF, which is the half an allowlist
 * usually gets wrong:
 *   - A masked field keeps its key and loses its value, so "configured and
 *     hidden" stays distinguishable from "never configured". That is
 *     SecretRedactor's opinion and it is right; this follows it rather than
 *     arguing with it, and an empty value stays empty for the same reason.
 *   - A field that WAS in the configuration and is on no list is named under
 *     _projection.notProjected. Vanishing is the failure mode an allowlist has
 *     and it is the exact mirror of the leak a denylist has; the file has to
 *     account for it or the reader cannot tell "absent from the machine" from
 *     "dropped on the way out". Names only - a key name is structure, the way
 *     the manifest already names the database tables it withheld.
 * ------------------------------------------------------------------------- */

/// <summary>The projected JSON, and anything the run should say out loud about it.</summary>
public sealed record AgentConfigProjectionResult(string Json, IReadOnlyList<string> Warnings);

public static class AgentConfigProjection
{
    /// <summary>Carried verbatim. Nothing here names a person.</summary>
    public static readonly IReadOnlyList<string> Keep = new[]
    {
        "configurationVersion",
        "crmBaseUrl",
        "scheduleTime",
        "captureCutoffTime",
        "enabledTradingDays",
        "timeZone",
        "deviceId",
        "lastScheduledTradingDate",
        "quarantineReviewTime",
        "lastQuarantineReviewDate",
    };

    /// <summary>Key kept, value replaced. The export must not say who it is about.</summary>
    public static readonly IReadOnlyList<string> Masked = new[]
    {
        "clientName",
    };

    /// <summary>
    /// Fields RedactedAgentState computes rather than reads. The configuration
    /// holds no such key, so there is nothing to project; they are classified so
    /// the gate can insist that every field of that class was decided about.
    /// </summary>
    public static readonly IReadOnlyList<string> Derived = new[]
    {
        "hasCredential",
        "machineIdHash",
    };

    /// <summary>
    /// What the file says about itself, a sentence to a line so that a human who
    /// opens the ZIP can read it. An analyst should not have to come here to
    /// learn why a field is masked or why one they expected is absent, and
    /// should not be left to wonder why a device id was worth keeping.
    /// </summary>
    private static readonly IReadOnlyList<string> Note = new[]
    {
        "An allowlist projection of the agent configuration, not a copy of it: only the keys named in AgentConfigProjection are carried.",
        "A key under withheld was configured on this machine and its value was replaced. That is a different fact from the key being absent, which is why the key is still here.",
        "A key under notProjected was in the configuration and is deliberately not in this file. Its name is recorded so that nothing leaves the export without a trace.",
        "deviceId is kept on purpose: a GUID names nobody, and it is how an analyst ties this package to a device row in the CRM.",
    };

    /// <summary>Project the agent's configuration text into what the package may carry.</summary>
    public static AgentConfigProjectionResult Project(string configurationJson)
        => ProjectWith(configurationJson, Keep, Masked);

    /// <summary>
    /// The one code path, with the policy passed in. Not public: the policy is
    /// the lists above and a caller does not get to supply its own. The test
    /// project compiles this file rather than referencing the WPF assembly, so
    /// it can reach this to prove the keep path really does consult
    /// SecretRedactor - there is no secret-named field on the Keep list today,
    /// and a guard that has never been exercised is a guess.
    /// </summary>
    internal static AgentConfigProjectionResult ProjectWith(
        string configurationJson,
        IReadOnlyList<string> keep,
        IReadOnlyList<string> masked)
    {
        var warnings = new List<string>();
        JObject source = null;
        try
        {
            source = JToken.Parse(configurationJson ?? string.Empty) as JObject;
        }
        catch (JsonException)
        {
        }

        if (source == null)
        {
            // LOUDLY, AND NOT RAW. A file that cannot be parsed cannot be
            // projected, so none of it travels - the same trade SecretRedactor
            // makes, except that this also tells the run, so the refusal reaches
            // manifest.json's warnings instead of only the package.
            warnings.Add("the agent configuration was not a JSON object; none of it was projected into the package");
            var refused = new JObject
            {
                ["_projection"] = Header(
                    "the agent configuration could not be read as a JSON object, so none of it was projected",
                    new JArray(),
                    new JArray()),
            };
            return new AgentConfigProjectionResult(Serialise(refused), warnings);
        }

        var withheld = new JArray();
        var notProjected = new JArray();
        JObject header = Header(null, withheld, notProjected);
        var projected = new JObject { ["_projection"] = header };

        // THE DOCUMENT'S OWN ORDER, so the file still reads like the
        // configuration it describes. The decision to emit is driven by the
        // lists and never by the document, which is what makes this an
        // allowlist: a key the lists do not name reaches `notProjected` and
        // nothing else.
        foreach (JProperty property in source.Properties())
        {
            string keptAs = Canonical(keep, property.Name);
            string maskedAs = Canonical(masked, property.Name);
            if (keptAs == null && maskedAs == null)
            {
                notProjected.Add(property.Name);
                continue;
            }

            // The key as the lists spell it, not as the file did, so the output
            // is stable whatever casing a hand-edited configuration used.
            string name = keptAs ?? maskedAs;

            if (IsEmpty(property.Value))
            {
                // Nothing to hide and nothing to lose. "Never configured" has to
                // survive the projection intact or the file cannot tell a reader
                // which of the two it is looking at.
                projected[name] = property.Value.DeepClone();
                continue;
            }

            if (maskedAs != null)
            {
                Withhold(projected, withheld, name);
                continue;
            }

            // THE TWO RULES COMPOSE WITHOUT EITHER WIDENING. This list answers
            // the identity question. SecretRedactor is still the single
            // definition of "named like a credential" and it is asked about
            // every key about to be emitted, so a token added to the keep list
            // by a later editor is masked rather than shipped.
            if (SecretRedactor.IsSecretKey(name))
            {
                Withhold(projected, withheld, name);
                warnings.Add($"{name} is on the keep list and is named like a credential; its value was withheld");
                continue;
            }

            // A KEPT KEY IS A SCALAR OR A LIST OF SCALARS. The list names keys;
            // it does not name whatever a nested object under one of those keys
            // might hold, and copying an unexamined subtree because its PARENT
            // was vetted is the denylist's mistake in an allowlist's clothes.
            // The configuration is flat today, so a container here means the
            // file was edited by hand.
            if (!IsShallow(property.Value))
            {
                Withhold(projected, withheld, name);
                warnings.Add($"{name} held a nested value the projection does not describe; it was withheld");
                continue;
            }

            projected[name] = property.Value.DeepClone();
        }

        return new AgentConfigProjectionResult(Serialise(projected), warnings);
    }

    private static void Withhold(JObject projected, JArray withheld, string name)
    {
        projected[name] = SecretRedactor.Mask;
        // Named once. A configuration holding both clientName and ClientName
        // matches the same list entry twice, and the accounting is a statement to
        // a reader rather than a tally.
        if (!withheld.Any(already => (string)already == name)) withheld.Add(name);
    }

    private static JObject Header(string error, JArray withheld, JArray notProjected)
    {
        var header = new JObject { ["note"] = new JArray(Note) };
        if (error != null) header["error"] = error;
        header["masked"] = SecretRedactor.Mask;
        header["withheld"] = withheld;
        header["notProjected"] = notProjected;
        return header;
    }

    private static string Serialise(JObject projected)
        => projected.ToString(Formatting.Indented);

    /// <summary>The list's own spelling of <paramref name="name"/>, or null when it names nothing on it.</summary>
    private static string Canonical(IReadOnlyList<string> names, string name)
        => names.FirstOrDefault(candidate => string.Equals(candidate, name, StringComparison.OrdinalIgnoreCase));

    /// <summary>Null, or the empty string. Masking one of these would invent a fact.</summary>
    private static bool IsEmpty(JToken value)
        => value == null
            || value.Type == JTokenType.Null
            || (value.Type == JTokenType.String && string.IsNullOrEmpty(value.Value<string>()));

    /// <summary>A value, or a list of values. Not a container the list never described.</summary>
    private static bool IsShallow(JToken value)
    {
        if (value is JObject) return false;
        if (value is JArray array) return array.All(item => item is JValue);
        return value is JValue;
    }
}
