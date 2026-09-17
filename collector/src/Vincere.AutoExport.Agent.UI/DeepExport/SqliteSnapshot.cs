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
 * A consistent copy of NinjaTrader's database, and what is in it.
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
 * ------------------------------------------------------------------------- */
public sealed record SqliteSnapshotResult(
    string CopyMethod,
    long SizeBytes,
    IReadOnlyDictionary<string, long> RowCounts,
    string ExecutionsMin,
    string ExecutionsMax,
    IReadOnlyList<string> Warnings);

public static class SqliteSnapshot
{
    /// <summary>Tables worth dumping: the named ones, plus anything whose name says it holds trading records.</summary>
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
                if (!ShouldDump(table)) continue;
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
        return ListTables(connection).Where(ShouldDump).ToList();
    }

    private static bool ShouldDump(string table)
    {
        return AlwaysDumped.Contains(table, StringComparer.OrdinalIgnoreCase) || InterestingTable.IsMatch(table);
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
