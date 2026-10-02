using System;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Vincere.AutoExport.Agent.UI;

/* ---------------------------------------------------------------------------
 * HOW A STRATEGY WAS CONFIGURED DOES NOT LEAVE THE MACHINE. ONE RULE, HERE.
 *
 * THIS FILE IS THE SINGLE DEFINITION. It was a private method inside
 * OfflineReportWriter, which was correct for the one door that existed when it
 * was written and wrong the moment a second door opened. It now has two callers
 * and must keep having exactly one definition:
 *
 *   OfflineReportWriter  - the HTML report written to the operator's Desktop and
 *                          attached to a message addressed to a client.
 *   DeepExportRunner     - the autoexport/ queue snapshots copied into the Deep
 *                          Export, which is handed around over Drive and
 *                          Discord. AppliesTo below decides which files.
 *
 * Do not restate this rule in either caller. A second copy that agrees today is
 * the one that stops agreeing later, which is the bug db/ already had once.
 *
 * MEASURED ON A REAL MACHINE'S QUEUE, not imagined. A strategy row carries 149
 * entries in `extraValues` and 87 in `parameters`. Among the extraValues: a
 * LicenseKey holding a live NinjaTrader licence, a DisplayParameters string
 * that repeats it, PosSize1-3, StopLossTicks, ProfitTargetTicks1-3,
 * TrailByTicks, StartTrailAfterTicks, BreakEvenAfterTicks, BreakEvenOffset,
 * TrailFrequency, the seven day filters, the trade window times, EdgeLeverage
 * and MaxDailyEntries. That is the desk's tuning and a working licence. On one
 * real export the key sits in plain ASCII at /strategies[]/extraValues/
 * LicenseKey and /strategies[]/extraValues/DisplayParameters, 12 occurrences
 * across 2 of 15 queue snapshots, with all 6 strategy rows carrying it.
 *
 * EMPTIED, NOT REMOVED. The first version of this deleted the properties and
 * every capture with a strategy then failed validation - src/domain/
 * autoExportContract.js lists `parameters` among the objects a strategy row
 * must have. An empty object satisfies the contract and carries nothing. It
 * also keeps "configured and hidden" distinguishable from "never captured",
 * which is the rule SecretRedactor and TraceRedactor already follow for a
 * value.
 *
 * STRATEGY ROWS ONLY. `accounts[].accountValues` is the other big map in a
 * capture and it stays: BuyingPower, NetLiquidation, the drawdown limits. That
 * is the client's own account, which is the whole subject of both artefacts. So
 * do the orders, the executions, the P&L and every other field on the strategy
 * row - the day survives intact, only the configuration goes. A strategy row is
 * recognised by `parameterCaptureStatus`, which nothing else in a capture
 * carries, or by having `parameters` at all.
 *
 * WHAT IT COSTS IN THE DEEP EXPORT, which is new and is worth saying. The queue
 * folders are copied so the one day the CRM could not be reached is recoverable
 * from the package, and autoexport/pending holds exactly that day. After this,
 * a capture recovered from the package carries that day's accounts, orders,
 * executions and P&L but not the strategy parameter maps. Those are still in
 * the real queue file on the VPS, which this never touches - the Deep Export
 * only ever redacts its own copy on the way into staging.
 * ------------------------------------------------------------------------- */
public static class StrategyConfigurationRedactor
{
    /// <summary>
    /// Which files in the package this rule rewrites, as the path inside the
    /// ZIP. The queue snapshots, which are the only JSON captures that travel.
    /// The sibling .receipt and .reason files in those folders are not captures
    /// and hold no parameter map.
    /// </summary>
    public static bool AppliesTo(string zipPath)
    {
        if (string.IsNullOrEmpty(zipPath)) return false;
        string path = zipPath.Replace('\\', '/').TrimStart('/');
        return path.StartsWith("autoexport/", StringComparison.OrdinalIgnoreCase)
            && path.EndsWith(".json", StringComparison.OrdinalIgnoreCase);
    }

    /// <summary>Empty every strategy row's configuration maps, in place, anywhere in the tree.</summary>
    public static JToken Strip(JToken token)
    {
        switch (token)
        {
            case JArray array:
                foreach (JToken item in array) Strip(item);
                break;
            case JObject o:
                bool isStrategyRow = o["parameterCaptureStatus"] != null || o["parameters"] != null;
                if (isStrategyRow)
                {
                    if (o["parameters"] is JObject) o["parameters"] = new JObject();
                    if (o["extraValues"] is JObject) o["extraValues"] = new JObject();
                    o.Remove("parametersRaw");
                }
                foreach (JProperty property in o.Properties().ToList())
                    Strip(property.Value);
                break;
        }
        return token;
    }

    /// <summary>
    /// A queue snapshot's text with the configuration emptied.
    ///
    /// FAILS CLOSED, the way SecretRedactor does for the agent config: a capture
    /// this cannot parse is a capture it cannot inspect, and the only two places
    /// the licence key was measured are inside it. Shipping the bytes unread
    /// would ship the credential. The cost is a snapshot an analyst wanted and
    /// is bounded: measured over both real exports, 16 of 16 queue .json files
    /// parse, including the two quarantined ones - a snapshot is quarantined for
    /// a reason the server gave, recorded in the .reason file beside it, not for
    /// being malformed. The file is still named in the manifest and is still on
    /// the VPS.
    /// </summary>
    public static string RedactCaptureJsonText(string json)
    {
        try
        {
            return Strip(JToken.Parse(json ?? string.Empty)).ToString(Formatting.Indented);
        }
        catch (JsonException)
        {
            return "{ \"redacted\": \"a queue snapshot that was not valid JSON could not be inspected and was withheld\" }";
        }
    }
}
