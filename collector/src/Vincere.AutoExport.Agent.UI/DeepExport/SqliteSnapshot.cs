using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace Vincere.AutoExport.Agent.UI.DeepExport;

/* ---------------------------------------------------------------------------
 * A consistent copy of NinjaTrader's database, what is in it, and what ships.
 *
 * THE COPY IS THE WHOLE POINT AND ALSO THE WHOLE RISK. NinjaTrader holds the
 * database open, in WAL mode, while it trades. Copying the file by hand while
 * it is open produces a snapshot whose pages disagree with each other, and it
 * can produce it silently. The SQLite Online Backup API exists for exactly this
 * case: it walks the pages under the database's own locking and yields a copy
 * that is consistent at a single point in time, without ever taking a write
 * lock the trading platform would have to wait on.
 *
 * NOTHING BELOW READS THE LIVE FILE. Row counts, the schema, the rows that go
 * into the shipped database: all of it comes off the copy. NinjaTrader is opened
 * read-only, once, for the duration of the backup, and never touched again.
 *
 * The raw copy fallback exists because a backup can fail for reasons that are
 * not ours (a corrupt WAL, an odd permission), and a possibly inconsistent copy
 * with a warning on it is still better than no database. The manifest says
 * which method produced the file, so the analyst knows what they are reading.
 *
 * WHY THE SHIPPED DATABASE IS BUILT RATHER THAN COPIED.
 *
 * This file has always chosen which tables an analyst gets. IsAllowedTable is
 * that choice and it was honoured for the per-table JSONL dump this package
 * used to carry - and then undone by the file lying next to it, because the
 * runner also copied the whole database in. Measured on one real export: 21
 * tables in the file, 12 dumped as JSONL, and the other 9 shipped anyway -
 * Users, JournalEntries, Logs, User2MarketDataEntitlement, Instruments,
 * MasterInstruments, InstrumentLists, Instrument2InstrumentList, Versions.
 * An allowlist that the file beside it undoes is not an allowlist.
 *
 * Users is the one that makes this serious, and NOT because of its rows. On
 * that export it has none. Its COLUMNS are Password, Salt, Email1, Email2,
 * Email3, FirstName, LastName, Phone, Address, City, Country, PostalCode,
 * State, Company and Auth0UserId, so the leak switches on when a client
 * configures NinjaTrader, not when anybody changes this code. Reporting it as
 * "the export leaks user records" would be false about this ZIP; leaving it is
 * waiting for the first machine where it is true.
 *
 * AND THE FILE LEAKS TABLES THAT ARE EMPTY. This is the part a row count
 * cannot show. That same export holds 36 pages on the freelist, 147,456 bytes
 * of content SQLite has freed and not overwritten, and in them: 19
 * NinjaTrader.NinjaScript.Strategies. signatures and 20 UTF-16LE occurrences
 * of LicenseKey - while the live Strategies table has 0 rows and an ASCII grep
 * over the file finds 0. Deleting rows does not remove them from the file, so
 * neither does DROP TABLE. Measured on that export: dropping all 9 tables left
 * the file byte-for-byte the same size with all 19 signatures and all 20
 * licence keys still in it. Only a rebuild removes anything.
 *
 * So CopyAllowedTables does not edit a copy of the original. It opens the
 * original read-only and writes a NEW file containing only the allowlisted
 * tables, their rows and their indexes. Nothing withheld is ever written, so
 * nothing withheld has to be erased, and a page of it cannot survive in
 * unallocated space. The same export: 4,771,840 bytes down to 319,488, and 0
 * signatures and 0 licence keys in the result.
 *
 * THAT LAST CLAUSE IS TRUE OF THAT EXPORT AND DOES NOT GENERALISE, which is
 * worth fixing here before it is quoted again. It was measured on the machine
 * whose strategy table holds 0 rows. On the other real export that table holds
 * 12 rows, and their Userdata blobs - 179,224 bytes of UTF-16LE, HTML-escaped
 * strategy XML - each carry a non-empty LicenseKey element: two distinct key
 * values, one of which appears nowhere else in the package. The rebuild copies
 * blob values deliberately (see CopyRows) so it copies those too. "0 licence
 * keys" describes an export with no strategies, not the filter.
 *
 * SO THE BLOBS ARE NOT THE PLAIN WIN THIS HEADER USED TO OFFER. It sold the
 * rebuild partly on carrying blob VALUES where the JSONL could only write a
 * placeholder. Measured across all 12 allowlisted tables on both exports, the
 * only blob values that exist anywhere are those 12 strategy rows: Orders.Data
 * and Accounts.Data are declared BLOB and 100% NULL on both machines, and
 * Strategies.Template is TEXT rather than a blob and empty on all 12 rows. So
 * the fidelity the placeholder costs is exactly those 12 cells, and what those
 * 12 cells contain is a licence key.
 *
 * IT IS AN EXPOSURE AND IT IS NOT THIS CHANGE'S TO FIX, deliberately. It
 * predates this commit - the rebuild has carried those blobs since it landed,
 * and removing the JSONL does not add them, because the JSONL never held them.
 * It is also not where the key mostly lives: templates/ ships one in plain
 * ASCII in 886 of 886 files, 1,772 occurrences, and nothing in db/ touches
 * that. A change that stripped the blob and called the package clean would be
 * fixing the smaller half - it would take the distinct keys in the package from
 * 2 to 1 and leave 1,772 plaintext copies of the other. The honest fix is a
 * templates/ rule and a blob rule together, with their own reasoning and their
 * own tests, the way the user table and the trace login each got their own.
 * Named here, measured, so the next reader inherits it rather than finds it.
 *
 * AND AN ASCII GREP OVER THE DATABASE FINDS NONE OF IT. The payload is UTF-16LE
 * and HTML-escaped, so on disk the tag reads &lt;LicenseKey&gt; in UTF-16LE and
 * an ASCII search returns 0 on both machines. The note above about an ASCII grep
 * finding 0 signatures has the same blind spot, stated as reassurance. Any check
 * of a future fix has to search both encodings and the escaped form, or it will
 * pass while the key is still in the file.
 *
 * WHAT IT COSTS TO TRAVEL, WHICH CORRECTS WHAT THIS HEADER USED TO CLAIM. It
 * said the rebuild costs the export nothing, because 319,488 bytes is smaller
 * than the 536,599 bytes of db/tables/*.jsonl that used to sit beside it. That
 * compares two files on disk and the package is a ZIP. JSON Lines is mostly
 * repeated key names and deflates to about 5%; a database deflates to about
 * 25%. Measured on both real exports, deflate -9:
 *
 *                     on disk                      in the zip
 *   small machine     319,488 vs    536,599      68,213 vs    33,901
 *   big machine    17,268,736 vs 49,461,338   4,990,593 vs 2,509,993
 *
 * The database is a third of the JSONL on disk and TWICE the JSONL in the
 * package. 319,488 was also the small machine; the big machine's rebuilt file
 * is 17,268,736 bytes, fifty-four times that, which no note here has ever
 * mentioned. The rebuild is still right - it is what keeps the withheld tables
 * out of the file, which is the whole point above - but it is not free, and the
 * old sentence would have been quoted as proof that a second artefact is.
 *
 * WHAT IT DOES COST, PLAINLY. The freed pages are not only a leak, they are
 * also a forensic capability: NinjaTrader cascades Strategy2Order and
 * Strategies away when a strategy is removed, and a deleted strategy's XML has
 * been recovered out of unallocated space by hand from an export of this kind.
 * No filter can keep that - what it needs is exactly the residue, by
 * definition absent from any SELECT. That capability is gone from the package
 * and is a deliberate trade, not an oversight. db/schema.sql still records
 * that 21 tables existed, and the manifest names the 9 by name.
 *
 * ONE ARTEFACT, NOT TWO. THE JSONL IS GONE.
 *
 * The desk asked for fewer tables in what travels - "que no llenemos eso de
 * tablas". From the day the rebuild landed until this change, db/ carried THE
 * SAME 12 TABLES TWICE: once as NinjaTrader.sqlite and once as tables/*.jsonl.
 * Fourteen files for twelve tables of data, every table stated twice. That is
 * the thing being complained about, and removing one of the two statements is
 * the only reduction available here that is both large and free.
 *
 * FREE BECAUSE THE JSONL WAS DERIVED FROM THE FILE THAT STAYS. The runner
 * dumped it from copyPath - the staged database itself, not the working copy -
 * so it was by construction a projection of the file beside it: the same rows,
 * the same columns in the same order, minus the declared types, minus the 24
 * indexes, and with every blob replaced by a "<blob N bytes>" placeholder.
 * Nothing can leave the package with it that the database does not still hold.
 * That is a property of how it was written, not a hope, and the tests assert it
 * by rebuilding the flat rows out of the shipped database.
 *
 * AND IT WAS THE LESS TRUTHFUL HALF OF THE PAIR. Every timestamp in these
 * tables is a .NET tick: an 18-digit integer, above 2^53. JSON has no integer,
 * only a double, so the obvious reader rounds them. Measured on the big export:
 * 134,371 of 149,126 OrderUpdates.Time values (90.1%) come back as a different
 * number, 87.8% of Orders.Time, 87.8% of Executions.Time, 100% of
 * AccountItems.TimeUtc, and 8 distinct instants collapse into each other.
 * StatementDate survives only because it is a midnight tick whose low bits are
 * zero - so a spot check on that one column reports the format is fine. A
 * SQLite INTEGER is exact. Keeping the JSONL as "the greppable one" would have
 * meant keeping the copy that quietly rounds the trade times.
 *
 * WHAT IT COSTS, PLAINLY: a reader with no SQLite client can no longer grep a
 * table. They get db/schema.sql and the manifest's rowCounts, and they need a
 * client for the rows. That is the trade, said here rather than discovered.
 *
 * A DATABASE IS RELATIONAL AND NESTING IS A DOCUMENT IDEA, which settles the
 * folds instead of only pricing them. What was asked for was fewer tables
 * inside the data: OrderUpdates folded into Orders as a per-order history, the
 * three Strategy2 link tables folded into Strategies as lists, AccountItems
 * folded into Accounts. Each of those is a shape for a document. To put one
 * into a relational artefact the DDL would have to be rewritten and the lists
 * stored as JSON text inside a column - inventing a schema NinjaTrader never
 * had, dropping the indexes of the folded tables, and leaving the shipped
 * Strategies no longer matching the verbatim CREATE TABLE in db/schema.sql,
 * which is the only evidence in the package that the allowlist did anything.
 * CopyAllowedTables already refuses to rewrite someone else's schema to tidy a
 * diagnostic, and this would be the same trade for less.
 *
 * WITH ONE ARTEFACT THE QUESTION DOES NOT ARISE, and that is the better reason
 * to have one than any byte count. Folding the JSONL and not the database would
 * put two different shapes of the same 12 tables in one package and make a
 * reader work out which was which - and the allowlist, one predicate on
 * purpose, would need a paragraph explaining how a single definition governs
 * two shapes. It does not need one. There is one shape, and the predicate
 * decides which tables are in it.
 *
 * THE FOLDS WERE MEASURED BEFORE THEY WERE REFUSED, on both real exports, by
 * generating the nested form and sizing it. Against db/tables at 49,461,338
 * bytes on the big machine:
 *
 *   OrderUpdates into Orders        +1,780,037 B    3.6%
 *   3 link tables into Strategies         +491 B    0.0%
 *   AccountItems into Accounts            -582 B    COSTS bytes
 *   ------------------------------------------------------------
 *   all three together              +1,779,946 B    3.6%
 *   not writing db/tables at all   49,461,338 B     100%
 *
 * AccountItems is negative because 132 of 135 accounts have no items and each
 * one gains an empty list. All three folds together recover 3.6% of a file that
 * is no longer in the package.
 *
 * AND THE PREMISE OF THE LARGEST FOLD WAS FALSE. "OrderUpdates is Orders
 * history and every row repeats OrderId and StatementDate", so hoist those two
 * to the parent. Measured: 18,610 of 18,827 orders (98.8%) carry exactly TWO
 * distinct OrderId values across their updates, and 18,629 (98.9%) span more
 * than one StatementDate. The broker reassigns the id during the order's life.
 * OrderUpdates is the trajectory and Orders is the terminal state, which is why
 * Orders.OrderId equals the last update's for all 18,827 of them. Hoisting
 * OrderId would have deleted the second broker id on 98.8% of orders - the
 * audit trail a prop-firm dispute turns on - and no integrity test would have
 * caught it, because the join is perfect: 0 orphan updates and 0 childless
 * orders on both exports, so every check anyone would think to write passes
 * while the data goes. The column list that request was written from also
 * omitted StopPrice, which AttributionExport reads to recover the stop price
 * before the trail moved it.
 *
 * THE THREE EMPTY TABLES STAY, which is the part that looks like a miss.
 * Positions, Strategy2Execution and User2Account hold 0 rows on both real
 * exports. Dropping them saves ZERO bytes - their JSONL files were already 0
 * bytes and an empty table is a page of DDL - and they are not one decision
 * made three times:
 *
 *   Positions is a live open-position snapshot - Account, Instrument, AvgPrice,
 *     MarketPosition, Quantity, StatementDate - with its own index. Both
 *     exports were taken near the open, 10:31 and 07:15, with the desk flat.
 *     The first export taken mid-session has rows in it. Dropping it would turn
 *     a diagnostic gap into a silent one, and this runs against live accounts.
 *   Strategy2Execution is the only one with a real argument: 0 rows on the
 *     machine that has 12 strategies and every other Strategy2 link populated.
 *   User2Account is Account, User, IsViewOnly - an integer link into the
 *     withheld user table, NOT a broker login. The credential columns are in
 *     that table and it does not ship; this one cannot hold a row while it is
 *     empty. Dropping it for security banks a win that is not there.
 *
 * AND THE ALLOWLIST COULD NOT EXPRESS THE DROP ANYWAY. It is a name match:
 * Positions matches Position, Strategy2Execution matches Strateg, and
 * User2Account matches Account - the same token that keeps Accounts and
 * AccountItems, so no edit to the pattern removes it and keeps those two. It
 * would take a named exception beside the predicate, which is the denylist the
 * paragraph below argues against, in exchange for zero bytes. If the desk wants
 * the empty tables gone on principle, that is a redesign of the predicate and
 * its own change, not a patch smuggled into this one.
 *
 * THE ALLOWLIST IS ONE PREDICATE WITH TWO CALLERS and must stay that way: the
 * filter and the manifest's row counts both ask IsAllowedTable, so they cannot
 * disagree about what shipped. It had three - TablesToDump was the third, and
 * it went with the JSONL, along with DumpTable. A second copy of this rule
 * anywhere is the bug this file already had once.
 *
 * AND IT IS AN INCLUSION HEURISTIC, WHICH IS NOW LOAD-BEARING. It is a name
 * match, not a list: a future NinjaTrader table called TradeJournal or
 * AccountCredentials matches and would ship without anyone deciding it should.
 * That was true before and only cost an extra JSONL file; it now decides what
 * is in the database too. Inverting it into a denylist of the 9 would be
 * worse - Users would stay out and UserPasswords would walk in - so it stays a
 * name match, and this paragraph is the warning that comes with it.
 * ------------------------------------------------------------------------- */
public sealed record SqliteSnapshotResult(
    string CopyMethod,
    long SizeBytes,
    IReadOnlyDictionary<string, long> RowCounts,
    string ExecutionsMin,
    string ExecutionsMax,
    IReadOnlyList<string> Warnings);

/// <summary>Which tables the shipped database holds, and which were left out, by name.</summary>
public sealed record SqliteFilterResult(
    IReadOnlyList<string> TablesShipped,
    IReadOnlyList<string> TablesWithheld);

public static class SqliteSnapshot
{
    // THE ALLOWLIST. One predicate, two callers - CopyAllowedTables and
    // Describe - so the file that ships and the manifest's row counts cannot
    // disagree about what an analyst got. There were three while a per-table
    // JSONL dump shipped beside the database; one artefact needs one fewer.
    // Do not restate this rule anywhere else; see the header.

    /// <summary>Tables worth shipping: the named ones, plus anything whose name says it holds trading records.</summary>
    private static readonly Regex InterestingTable = new(
        "(Account|Execution|Order|Position|Strateg|Trade)", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private static readonly string[] AlwaysDumped = { "Accounts", "Executions", "Orders", "Positions", "Strategies" };

    /// <summary>Copy the live database to <paramref name="destination"/> consistently, or fall back to a raw copy.</summary>
    public static string Copy(string livePath, string destination, IList<string> warnings)
    {
        string directory = Path.GetDirectoryName(destination);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        try
        {
            // ReadOnly and no pooling: this connection must not outlive the
            // backup and must never hold anything the platform could wait on.
            var sourceBuilder = new SqliteConnectionStringBuilder
            {
                DataSource = livePath,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            };
            var destinationBuilder = new SqliteConnectionStringBuilder
            {
                DataSource = destination,
                Mode = SqliteOpenMode.ReadWriteCreate,
                Pooling = false,
            };
            using var source = new SqliteConnection(sourceBuilder.ConnectionString);
            using var target = new SqliteConnection(destinationBuilder.ConnectionString);
            source.Open();
            target.Open();
            source.BackupDatabase(target);
            // The copy inherits the live file's WAL flag. Folding it back to a
            // rollback journal makes the copy one self-contained file that opens
            // anywhere, with no -wal or -shm beside it to lose.
            SingleFile(target, warnings);
            return "backup_api";
        }
        catch (Exception exception) when (exception is SqliteException or IOException or UnauthorizedAccessException)
        {
            warnings.Add($"database backup api failed ({exception.GetType().Name}); fell back to a raw file copy which may be inconsistent");
            foreach (string suffix in new[] { "", "-wal", "-shm" })
            {
                string from = livePath + suffix;
                if (!File.Exists(from)) continue;
                using FileStream input = new(from, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using FileStream output = new(destination + suffix, FileMode.Create, FileAccess.Write, FileShare.None);
                input.CopyTo(output);
            }
            try
            {
                using var copy = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = destination, Pooling = false }.ConnectionString);
                copy.Open();
                SingleFile(copy, warnings);
            }
            catch (SqliteException inner)
            {
                warnings.Add($"raw copy could not be checkpointed: {inner.SqliteErrorCode}");
            }
            return "raw";
        }
    }

    private static void SingleFile(SqliteConnection connection, IList<string> warnings)
    {
        try
        {
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = "PRAGMA journal_mode=DELETE";
            command.ExecuteScalar();
        }
        catch (SqliteException exception)
        {
            warnings.Add($"copy left in WAL mode: {exception.SqliteErrorCode}");
        }
    }

    /// <summary>Everything the manifest needs, read off the copy only.</summary>
    public static SqliteSnapshotResult Describe(string copyPath, string copyMethod, IList<string> warnings)
    {
        var counts = new Dictionary<string, long>(StringComparer.OrdinalIgnoreCase);
        string executionsMin = null;
        string executionsMax = null;
        long size = File.Exists(copyPath) ? new FileInfo(copyPath).Length : 0;
        try
        {
            using SqliteConnection connection = OpenCopy(copyPath);
            foreach (string table in ListTables(connection))
            {
                if (!IsAllowedTable(table)) continue;
                counts[table] = Scalar<long>(connection, $"SELECT COUNT(*) FROM \"{table}\"");
            }
            string executions = counts.Keys.FirstOrDefault(t => string.Equals(t, "Executions", StringComparison.OrdinalIgnoreCase));
            if (executions != null)
            {
                string timeColumn = FindTimeColumn(connection, executions);
                if (timeColumn != null)
                {
                    executionsMin = Scalar<string>(connection, $"SELECT MIN(\"{timeColumn}\") FROM \"{executions}\"");
                    executionsMax = Scalar<string>(connection, $"SELECT MAX(\"{timeColumn}\") FROM \"{executions}\"");
                }
                else
                {
                    warnings.Add("executions table has no recognisable time column; executionsRange not computed");
                }
            }
        }
        catch (SqliteException exception)
        {
            warnings.Add($"could not read the database copy: {exception.SqliteErrorCode}");
        }
        return new SqliteSnapshotResult(copyMethod, size, counts, executionsMin, executionsMax, warnings.ToList());
    }

    /// <summary>The schema, exactly as SQLite holds it.</summary>
    public static string ReadSchema(string copyPath)
    {
        using SqliteConnection connection = OpenCopy(copyPath);
        var builder = new StringBuilder();
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name";
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            builder.Append(reader.GetString(0)).AppendLine(";");
        }
        return builder.ToString();
    }

    /// <summary>The allowlist. The only place this question is answered.</summary>
    public static bool IsAllowedTable(string table)
    {
        return AlwaysDumped.Contains(table, StringComparer.OrdinalIgnoreCase) || InterestingTable.IsMatch(table);
    }

    /// <summary>
    /// Write a NEW database at <paramref name="destination"/> holding only the
    /// allowlisted tables of <paramref name="sourcePath"/>, with their rows and
    /// indexes. Returns null if it could not be built, in which case no database
    /// is in the package at all - never the unfiltered one.
    /// </summary>
    public static SqliteFilterResult CopyAllowedTables(string sourcePath, string destination, IList<string> warnings)
    {
        string directory = Path.GetDirectoryName(destination);
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
        // A FRESH FILE. Anything already here is removed rather than opened and
        // added to, so no page of an earlier attempt can survive into this one.
        Remove(destination);
        try
        {
            // The source is opened READ-ONLY by connection mode, and every
            // statement against it below is a SELECT. That is why this copies
            // row by row instead of ATTACHing the source and letting SQLite do
            // it: an attached database inherits the main connection's flags, so
            // the fast route would mean opening the source writable to read it.
            using SqliteConnection source = OpenCopy(sourcePath);
            var shipped = new List<string>();
            var withheld = new List<string>();
            foreach (string table in ListTables(source))
                (IsAllowedTable(table) ? shipped : withheld).Add(table);

            // A view or a trigger can name a withheld table, so none are copied.
            // Saying so is the point: silence here would look like there were none.
            long derived = Scalar<long>(source, "SELECT COUNT(*) FROM sqlite_master WHERE type IN ('view', 'trigger')");
            if (derived > 0)
                warnings.Add($"{derived} view(s) or trigger(s) were not copied into the database; they can name a withheld table");

            var targetBuilder = new SqliteConnectionStringBuilder
            {
                DataSource = destination,
                Mode = SqliteOpenMode.ReadWriteCreate,
                Pooling = false,
            };
            using var target = new SqliteConnection(targetBuilder.ConnectionString);
            target.Open();
            // LOAD-BEARING, NOT DOCUMENTATION. A kept table's DDL can declare
            // REFERENCES against a withheld one - Orders names Instruments - and
            // Microsoft.Data.Sqlite turns foreign keys ON unless told otherwise,
            // so without this line every Orders row would fail to insert and the
            // package would lose its database. The DDL is still copied VERBATIM,
            // for the same reason DumpTable does not rename a column: rewriting
            // someone else's schema to tidy a diagnostic is a larger risk than
            // the dangling name. foreign_key_check on the shipped file therefore
            // reports those references, which is an honest record of what was
            // withheld rather than a defect.
            Execute(target, "PRAGMA foreign_keys=OFF");
            using (SqliteTransaction transaction = target.BeginTransaction())
            {
                foreach (string table in shipped)
                {
                    string ddl = TableDdl(source, table);
                    if (ddl == null) continue;
                    Execute(target, ddl, transaction);
                    CopyRows(source, target, table, transaction);
                }
                foreach (string ddl in IndexDdl(source, shipped))
                    Execute(target, ddl, transaction);
                transaction.Commit();
            }
            // One self-contained file, as the backup copy is, with no -wal beside it.
            SingleFile(target, warnings);
            return new SqliteFilterResult(shipped, withheld);
        }
        catch (Exception exception) when (exception is SqliteException or IOException or UnauthorizedAccessException)
        {
            // FAIL CLOSED. A half-built database is worse than none, and the
            // unfiltered copy is not a fallback - that is the thing being fixed.
            Remove(destination);
            warnings.Add($"filtered database could not be built ({exception.GetType().Name}); no database is in this package");
            return null;
        }
    }

    private static void Remove(string path)
    {
        foreach (string suffix in new[] { "", "-wal", "-shm" })
        {
            try { if (File.Exists(path + suffix)) File.Delete(path + suffix); }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException) { }
        }
    }

    private static string TableDdl(SqliteConnection connection, string table)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = $name";
        command.Parameters.AddWithValue("$name", table);
        return command.ExecuteScalar() as string;
    }

    /// <summary>The explicit indexes of the kept tables. Auto-indexes arrive with the CREATE TABLE.</summary>
    private static IReadOnlyList<string> IndexDdl(SqliteConnection connection, IReadOnlyList<string> tables)
    {
        var statements = new List<string>();
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL ORDER BY name";
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            if (tables.Contains(reader.GetString(0), StringComparer.OrdinalIgnoreCase))
                statements.Add(reader.GetString(1));
        }
        return statements;
    }

    private static void CopyRows(SqliteConnection source, SqliteConnection target, string table, SqliteTransaction transaction)
    {
        using SqliteCommand read = source.CreateCommand();
        read.CommandText = $"SELECT * FROM \"{table}\"";
        using SqliteDataReader reader = read.ExecuteReader();
        if (reader.FieldCount == 0) return;

        var columns = new string[reader.FieldCount];
        var placeholders = new string[reader.FieldCount];
        for (int i = 0; i < reader.FieldCount; i++)
        {
            columns[i] = "\"" + reader.GetName(i).Replace("\"", "\"\"") + "\"";
            placeholders[i] = "$p" + i;
        }
        using SqliteCommand insert = target.CreateCommand();
        insert.Transaction = transaction;
        insert.CommandText =
            $"INSERT INTO \"{table}\" ({string.Join(", ", columns)}) VALUES ({string.Join(", ", placeholders)})";
        // The parameters are added WITHOUT a declared SqliteType so each value
        // binds as the type SQLite handed back. Declaring one would coerce a
        // blob to text, and Accounts.Data, Orders.Data and Strategies.Userdata
        // are blobs. This is now the ONLY place those values survive - the dump
        // that used to reduce them to a length is gone - so a coercion here is
        // a loss with nothing beside it to notice, which is what
        // NothingTheJsonLinesCarriedLeftThePackageWithIt asserts against. It is
        // also what carries the licence keys the header measures; read that
        // paragraph before treating this line as purely a fidelity win.
        for (int i = 0; i < reader.FieldCount; i++)
            insert.Parameters.Add(new SqliteParameter(placeholders[i], DBNull.Value));

        while (reader.Read())
        {
            for (int i = 0; i < reader.FieldCount; i++)
                insert.Parameters[i].Value = reader.IsDBNull(i) ? DBNull.Value : reader.GetValue(i);
            insert.ExecuteNonQuery();
        }
    }

    private static void Execute(SqliteConnection connection, string sql, SqliteTransaction transaction = null)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }

    private static SqliteConnection OpenCopy(string copyPath)
    {
        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = copyPath,
            Mode = SqliteOpenMode.ReadOnly,
            Pooling = false,
        };
        var connection = new SqliteConnection(builder.ConnectionString);
        connection.Open();
        return connection;
    }

    private static IEnumerable<string> ListTables(SqliteConnection connection)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
        using SqliteDataReader reader = command.ExecuteReader();
        var names = new List<string>();
        while (reader.Read()) names.Add(reader.GetString(0));
        return names;
    }

    private static string FindTimeColumn(SqliteConnection connection, string table)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = $"PRAGMA table_info(\"{table}\")";
        using SqliteDataReader reader = command.ExecuteReader();
        var candidates = new List<string>();
        while (reader.Read()) candidates.Add(reader.GetString(1));
        // NinjaTrader names it Time. Anything else that looks like a timestamp is
        // accepted so a schema change does not silently lose the range.
        return candidates.FirstOrDefault(c => string.Equals(c, "Time", StringComparison.OrdinalIgnoreCase))
            ?? candidates.FirstOrDefault(c => c.IndexOf("time", StringComparison.OrdinalIgnoreCase) >= 0);
    }

    private static T Scalar<T>(SqliteConnection connection, string sql)
    {
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = sql;
        object value = command.ExecuteScalar();
        if (value == null || value is DBNull) return default;
        return (T)Convert.ChangeType(value, typeof(T));
    }
}
