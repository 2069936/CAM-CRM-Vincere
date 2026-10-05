using System;
using System.Collections.Generic;
using Vincere.AutoExport.Contracts;

namespace Vincere.AutoExport.Agent.Capture;

/* WHICH DISCONNECTED ACCOUNTS ARE WORTH REPORTING, AND WHY THIS IS NOT
 * ACCOUNTANCY.
 *
 * The add-on's tracker read deliberately keeps disconnected accounts, because an
 * account that goes dark is the single most important thing a traffic light can
 * say, and dropping it would make it an ABSENT ROW - byte for byte what an
 * unreachable machine also produces. AccountSampleRelevance has the argument.
 *
 * But "every account NinjaTrader has ever been configured with" is not the desk's
 * book. The measured number on a real machine is 44 accounts against 3 that
 * matter: the rest are the platform's own fixtures plus DEMO and APEX accounts
 * left over from connections that no longer exist. Forward all 44 and the CRM's
 * overview counts 41 accounts as needing attention on that client, every ten
 * minutes, forever - and a count that is always wrong is a count a CAM learns to
 * stop reading. It would also quietly break the CRM's own sizing: that table is
 * built on "one row per account per machine is a few hundred rows for the whole
 * desk, forever".
 *
 * SO THE QUESTION IS HOW TO TELL "THIS ACCOUNT TRADES AND HAS GONE DARK" FROM
 * "THIS ACCOUNT HAS BEEN DEAD SINCE BEFORE THE CLIENT SIGNED UP", and the answer
 * is NOT to ask NinjaTrader. It is to remember.
 *
 * An account this agent has seen CONNECTED at least once since the service
 * started is one the client really trades, and when it stops being connected that
 * is news. An account that has never once been connected while we were watching
 * is a leftover, and saying nothing about it is correct. That rule needs no
 * platform knowledge at all - no guess about whether Account.Connection goes null
 * when a connection is deleted, nothing version-dependent - which is the whole
 * reason to prefer it. It is also testable off Windows, which the alternative is
 * not.
 *
 * AND EXPLICITLY NOT "DOES IT HOLD MONEY". That heuristic was tried in this repo
 * and removed, and AccountRelevance records why: keeping any disconnected account
 * that still showed money "is exactly the shape of an old prop-firm account left
 * configured after the client moved on: disconnected for months, holding a frozen
 * balance, and indistinguishable from a live one once it reaches the CRM". A
 * frozen balance is the signature of the thing being filtered out, not of the
 * thing being kept.
 *
 * THE COST, SAID PLAINLY. A service that restarts while an account is already
 * dark will not mention that account until it connects once. The CRM does not go
 * blind: the row that is already there ages, and the screen says "the VPS last
 * sampled this account N minutes ago", which is true. The alternative - inventing
 * a claim about an account we have never seen working - is the failure this whole
 * file exists to avoid. In-memory for the same reason: a remembered set that
 * survived restarts would start asserting that accounts matter on evidence from a
 * week ago, which is how a filter becomes a fiction. */
public sealed class LiveAccountMemory
{
    // Account names are matched the way every other account comparison in this
    // codebase matches them - case-insensitively - because the platform's casing
    // is not something the desk controls.
    private readonly HashSet<string> seenConnected = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>How many accounts have been seen connected since the service started.</summary>
    public int Count => seenConnected.Count;

    /// <summary>
    /// Records every connected account in this reading and returns the rows worth
    /// reporting: everything connected, plus the disconnected accounts this agent
    /// has previously seen working.
    ///
    /// Order is preserved and no row is altered. A null or nameless row is dropped
    /// rather than forwarded: the CRM refuses a report for one bad row, so a
    /// single unnameable account must not cost the whole reading.
    /// </summary>
    public IList<AccountSampleRowV1> Retain(IEnumerable<AccountSampleRowV1> rows)
    {
        List<AccountSampleRowV1> kept = new();
        if (rows == null) return kept;

        // Two passes, because an account can appear connected later in the list
        // than one that is disconnected, and the answer must not depend on the
        // order NinjaTrader happened to return them in.
        foreach (AccountSampleRowV1 row in rows)
        {
            if (row == null || string.IsNullOrWhiteSpace(row.AccountName)) continue;
            if (row.Connected) seenConnected.Add(row.AccountName.Trim());
        }

        foreach (AccountSampleRowV1 row in rows)
        {
            if (row == null || string.IsNullOrWhiteSpace(row.AccountName)) continue;
            if (row.Connected || seenConnected.Contains(row.AccountName.Trim())) kept.Add(row);
        }
        return kept;
    }
}
