using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json;

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
 * NOTHING BELOW READS THE LIVE FILE. Row counts, the schema, the table dumps:
 * all of it comes off the copy. NinjaTrader is opened read-only, once, for the
 * duration of the backup, and never touched again.
 *
 * The raw copy fallback exists because a backup can fail for reasons that are
 * not ours (a corrupt WAL, an odd permission), and a possibly inconsistent copy
 * with a warning on it is still better than no database. The manifest says
 * which method produced the file, so the analyst knows what they are reading.
 *
 * WHY THE SHIPPED DATABASE IS BUILT RATHER THAN COPIED.
 *
 * This file has always chosen which tables an analyst gets. IsAllowedTable is
 * that choice and it was honoured for db/tables/*.jsonl - and then undone by
 * the file lying next to them, because the runner also copied the whole
 * database into the package. Measured on one real export: 21 tables in the
 * file, 12 dumped as JSONL, and the other 9 shipped anyway inside it -
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
 * IT COSTS THE EXPORT NOTHING. 319,488 bytes is smaller than the 536,599 bytes
 * of db/tables/*.jsonl already beside it, and unlike the JSONL it carries real
 * column types, the indexes, and blob VALUES rather than DumpTable's
 * "<blob N bytes>" placeholder. An analyst can open it and join.
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
 * THE ALLOWLIST IS ONE PREDICATE WITH THREE CALLERS and must stay that way:
 * the filter, the JSONL dump and the manifest's row counts all ask
 * IsAllowedTable, so they cannot disagree about what shipped. A second copy of
 * this rule anywhere is the bug this file already had once.
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
    // THE ALLOWLIST. One predicate, three callers - CopyAllowedTables,
    // TablesToDump and Describe - so the file that ships, the JSONL beside it
    // and the manifest's row counts cannot disagree about what an analyst got.
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

    /// <summary>Dump one table as JSON Lines, every column as SQLite returns it, nothing renamed.</summary>
    public static void DumpTable(string copyPath, string table, Stream output)
    {
        using SqliteConnection connection = OpenCopy(copyPath);
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = $"SELECT * FROM \"{table}\"";
        using SqliteDataReader reader = command.ExecuteReader();
        using var writer = new StreamWriter(output, new UTF8Encoding(false), leaveOpen: true);
        var serializer = JsonSerializer.CreateDefault();
        while (reader.Read())
        {
            var row = new Dictionary<string, object>(reader.FieldCount);
            for (int i = 0; i < reader.FieldCount; i++)
            {
                object value = reader.IsDBNull(i) ? null : reader.GetValue(i);
                // Blobs are not analysable as text and can be large. Their size
                // is kept so the analyst knows a value was there.
                if (value is byte[] bytes) value = $"<blob {bytes.Length} bytes>";
                row[reader.GetName(i)] = value;
            }
            serializer.Serialize(writer, row);
            writer.Write('\n');
        }
    }

    public static IReadOnlyList<string> TablesToDump(string copyPath)
    {
        using SqliteConnection connection = OpenCopy(copyPath);
        return ListTables(connection).Where(IsAllowedTable).ToList();
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
        // are blobs; the JSONL already loses those and this file must not.
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
