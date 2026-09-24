using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using Microsoft.Data.Sqlite;
using Newtonsoft.Json;
using Vincere.AutoExport.NinjaTrader.Core.Capture;

namespace Vincere.AutoExport.Agent.UI.DeepExport;

/* ---------------------------------------------------------------------------
 * THE DEEP EXPORT ANSWERING "WHICH ALGORITHM", NOT JUST HANDING OVER TABLES.
 *
 * The export already carried Orders, Executions and Strategy2Order as raw
 * JSONL, and answering the desk's question from them meant a join nobody on
 * the receiving end could be expected to write. Worse, the join mostly fails:
 * on a real VPS Strategy2Order held 29 rows against 18,827 orders, because
 * NinjaTrader cascades that link away every time a strategy is removed.
 *
 * So this computes the answer HERE, where the data is, and ships the
 * conclusion. Three files, all small:
 *
 *   attribution/trades.jsonl    one row per reconstructed trade, with the
 *                               algorithm it matched, the version when the
 *                               geometry settles it, and the basis.
 *   attribution/catalog.jsonl   the machine's template library reduced to
 *                               fingerprints - 886 XML files as one file.
 *   attribution/ledger.jsonl    every strategy-to-order link the platform has
 *                               asserted, accumulated across exports so the
 *                               cascade cannot take back what we have seen.
 *
 * EVERY DECISION IS IN THE CORE LIBRARY, not here. This file opens files and
 * a database and nothing else, because it is the half that cannot be compiled
 * or tested anywhere but Windows.
 * ------------------------------------------------------------------------- */
internal static class AttributionExport
{
    /// <summary>Never let a courtesy read cost the export its database copy.</summary>
    public static AttributionSummary Write(
        string stagingRoot,
        string ninjaTraderRoot,
        string databaseCopyPath,
        string ledgerPath,
        IList<string> warnings)
    {
        try
        {
            return Run(stagingRoot, ninjaTraderRoot, databaseCopyPath, ledgerPath, warnings);
        }
        catch (Exception exception) when (exception is not OperationCanceledException)
        {
            warnings.Add($"attribution skipped: {exception.GetType().Name}");
            return null;
        }
    }

    private static AttributionSummary Run(
        string stagingRoot,
        string ninjaTraderRoot,
        string databaseCopyPath,
        string ledgerPath,
        IList<string> warnings)
    {
        if (!File.Exists(databaseCopyPath)) return null;
        string folder = Path.Combine(stagingRoot, "attribution");
        Directory.CreateDirectory(folder);

        IList<StrategyTemplate> templates = ReadTemplates(ninjaTraderRoot, warnings);
        WriteLines(Path.Combine(folder, "catalog.jsonl"), templates.Select(template => new
        {
            family = template.Family,
            version = template.Version,
            risk = template.Risk,
            propFirm = template.PropFirm,
            instrument = template.Fingerprint.Instrument,
            sizes = new[] { template.Fingerprint.Size1, template.Fingerprint.Size2, template.Fingerprint.Size3 },
            stopTicks = template.Fingerprint.StopTicks,
            targetTicks = new[]
            {
                template.Fingerprint.Target1Ticks,
                template.Fingerprint.Target2Ticks,
                template.Fingerprint.Target3Ticks,
            },
        }));

        var catalog = new StrategyCatalog(templates);
        AttributionTables tables = ReadTables(databaseCopyPath);

        IList<StrategyOrderLink> ledger = StrategyLinkLedger.Merge(ReadLedger(ledgerPath, warnings), tables.Links);
        WriteLedger(ledgerPath, ledger, warnings);
        WriteLines(Path.Combine(folder, "ledger.jsonl"), ledger.Select(link => new
        {
            orderId = link.OrderId,
            strategyId = link.StrategyId,
            strategy = link.StrategyName,
            account = link.AccountName,
            firstSeenUtc = link.FirstSeenUtc,
        }));

        var recorded = new Dictionary<long, string>();
        foreach (StrategyOrderLink link in ledger)
        {
            if (!string.IsNullOrWhiteSpace(link.StrategyName)) recorded[link.OrderId] = link.StrategyName;
        }

        var rows = new List<object>();
        int matched = 0;
        int versioned = 0;
        int trades = 0;
        foreach (KeyValuePair<string, List<TradeOrder>> group in tables.OrdersByGroup)
        {
            double tick;
            if (!tables.TickByGroup.TryGetValue(group.Key, out tick)) tick = 0;
            foreach (ReconstructedTrade trade in TradeReconstruction.FromOrders(group.Value, tick))
            {
                StrategyFingerprint print = trade.Fingerprint();
                if (print == null) continue;
                trades++;

                string fromLedger = null;
                foreach (long id in trade.OrderIds)
                {
                    string name;
                    if (recorded.TryGetValue(id, out name)) { fromLedger = name; break; }
                }

                var geometry = new TradeGeometry(print.Instrument) { StopTicks = print.StopTicks };
                if (print.Target1Ticks > 0) geometry.AddRung(1, print.Target1Ticks, print.Size1);
                if (print.Target2Ticks > 0) geometry.AddRung(2, print.Target2Ticks, print.Size2);
                if (print.Target3Ticks > 0) geometry.AddRung(3, print.Target3Ticks, print.Size3);
                FingerprintMatch match = catalog.Match(geometry);

                // RECORD ALWAYS BEATS INFERENCE. The ledger is what the platform
                // itself asserted; the geometry is what we worked out.
                string basis = fromLedger != null ? "record" : (match.Matched ? "inferred" : "none");
                if (fromLedger == null && match.Matched) matched++;
                if (fromLedger == null && match.VersionCertain) versioned++;

                rows.Add(new
                {
                    account = trade.Entry.AccountName,
                    instrument = print.Instrument,
                    entryOrderId = trade.Entry.OrderId,
                    entryTime = trade.Entry.Time,
                    entryQuantity = trade.Entry.Quantity,
                    exits = trade.Exits.Count,
                    geometry = geometry.ToString(),
                    basis,
                    strategy = fromLedger,
                    family = fromLedger == null ? match.Family : null,
                    version = fromLedger == null ? match.Version : null,
                    risk = fromLedger == null ? match.Risk : null,
                    candidates = match.Candidates,
                });
            }
        }

        WriteLines(Path.Combine(folder, "trades.jsonl"), rows);
        LedgerCoverage coverage = StrategyLinkLedger.Coverage(ledger, tables.OrderCount);
        return new AttributionSummary(
            templates.Count, trades, matched, versioned, recorded.Count,
            coverage.Orders, tables.OrderCount);
    }

    private static IList<StrategyTemplate> ReadTemplates(string ninjaTraderRoot, IList<string> warnings)
    {
        var templates = new List<StrategyTemplate>();
        string root = Path.Combine(ninjaTraderRoot ?? string.Empty, "templates", "Strategy");
        if (!Directory.Exists(root)) return templates;
        foreach (string folder in Directory.GetDirectories(root))
        {
            foreach (string file in Directory.GetFiles(folder, "*.xml"))
            {
                try
                {
                    StrategyTemplate template = StrategyTemplateReader.Read(
                        Path.GetFileName(folder), Path.GetFileName(file), File.ReadAllText(file));
                    if (template != null) templates.Add(template);
                }
                catch (IOException)
                {
                    warnings.Add("a strategy template could not be read");
                }
            }
        }
        return templates;
    }

    private sealed class AttributionTables
    {
        public Dictionary<string, List<TradeOrder>> OrdersByGroup = new Dictionary<string, List<TradeOrder>>(StringComparer.Ordinal);
        public Dictionary<string, double> TickByGroup = new Dictionary<string, double>(StringComparer.Ordinal);
        public List<StrategyOrderLink> Links = new List<StrategyOrderLink>();
        public long OrderCount;
    }

    private static AttributionTables ReadTables(string databaseCopyPath)
    {
        var tables = new AttributionTables();
        var builder = new SqliteConnectionStringBuilder
        {
            DataSource = databaseCopyPath,
            Mode = SqliteOpenMode.ReadOnly,
            Pooling = false,
        };
        using var connection = new SqliteConnection(builder.ConnectionString);
        connection.Open();

        // THE PRICE BEFORE THE TRAIL MOVED IT. A template declares the stop at
        // its original distance and NinjaTrader rewrites the price as the trail
        // walks it up, so the order's current price measures the trail.
        var original = new Dictionary<long, double?>();
        using (SqliteCommand command = connection.CreateCommand())
        {
            command.CommandText = @"select u.[Order], u.LimitPrice, u.StopPrice from OrderUpdates u
                join (select [Order], min(Nr) as n from OrderUpdates group by [Order]) m
                  on m.[Order] = u.[Order] and m.n = u.Nr";
            using SqliteDataReader reader = command.ExecuteReader();
            while (reader.Read()) original[reader.GetInt64(0)] = Price(reader, 1) ?? Price(reader, 2);
        }

        using (SqliteCommand command = connection.CreateCommand())
        {
            command.CommandText = @"select a.Name, mi.Name, mi.TickSize, o.Name, o.Quantity,
                       o.AvgFillPrice, o.Time, o.Id
                from ""Orders"" o
                join Accounts a on a.Id = o.Account
                join Instruments i on i.Id = o.Instrument
                join MasterInstruments mi on mi.Id = i.MasterInstrument";
            using SqliteDataReader reader = command.ExecuteReader();
            while (reader.Read())
            {
                string account = Text(reader, 0);
                string instrument = Text(reader, 1);
                double tick = reader.IsDBNull(2) ? 0 : reader.GetDouble(2);
                long id = reader.GetInt64(7);
                double? fill = Price(reader, 5);
                double? first;
                original.TryGetValue(id, out first);

                string key = account + "\u0000" + instrument;
                List<TradeOrder> bucket;
                if (!tables.OrdersByGroup.TryGetValue(key, out bucket))
                {
                    bucket = new List<TradeOrder>();
                    tables.OrdersByGroup[key] = bucket;
                    tables.TickByGroup[key] = tick;
                }
                bucket.Add(new TradeOrder(
                    id, account, instrument, Text(reader, 3),
                    reader.IsDBNull(4) ? 0 : reader.GetInt32(4),
                    fill, first, reader.IsDBNull(6) ? 0 : reader.GetInt64(6)));
                tables.OrderCount++;
            }
        }

        string seen = DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture);
        using (SqliteCommand command = connection.CreateCommand())
        {
            command.CommandText = @"select s.[Order], s.Strategy, st.Name, a.Name
                from Strategy2Order s
                join Strategies st on st.Id = s.Strategy
                left join ""Orders"" o on o.Id = s.[Order]
                left join Accounts a on a.Id = o.Account";
            using SqliteDataReader reader = command.ExecuteReader();
            while (reader.Read())
            {
                tables.Links.Add(new StrategyOrderLink(
                    reader.GetInt64(0), reader.GetInt64(1), Text(reader, 2), Text(reader, 3), seen));
            }
        }

        return tables;
    }

    /// <summary>
    /// A zero is not a price. An order row holds 0 in the column it does not
    /// use, so a reader that takes it measures every stop from the instrument's
    /// own price: on crude that produced stops 6,411 ticks away and matched
    /// nothing at all.
    /// </summary>
    private static double? Price(SqliteDataReader reader, int ordinal)
    {
        if (reader.IsDBNull(ordinal)) return null;
        double value = reader.GetDouble(ordinal);
        return value > 0 ? value : (double?)null;
    }

    private static string Text(SqliteDataReader reader, int ordinal)
    {
        return reader.IsDBNull(ordinal) ? string.Empty : reader.GetString(ordinal);
    }

    private static IList<StrategyOrderLink> ReadLedger(string path, IList<string> warnings)
    {
        var held = new List<StrategyOrderLink>();
        if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return held;
        try
        {
            foreach (string line in File.ReadAllLines(path))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                LedgerRow row = JsonConvert.DeserializeObject<LedgerRow>(line);
                if (row == null) continue;
                held.Add(new StrategyOrderLink(row.orderId, row.strategyId, row.strategy, row.account, row.firstSeenUtc));
            }
        }
        catch (Exception exception) when (exception is IOException or JsonException)
        {
            // A ledger we cannot read is a ledger we start again, and the
            // export still ships what this machine holds right now.
            warnings.Add("attribution ledger unreadable; starting a new one");
            return new List<StrategyOrderLink>();
        }
        return held;
    }

    private static void WriteLedger(string path, IEnumerable<StrategyOrderLink> ledger, IList<string> warnings)
    {
        if (string.IsNullOrWhiteSpace(path)) return;
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            string temporary = path + ".tmp";
            WriteLines(temporary, ledger.Select(link => new LedgerRow
            {
                orderId = link.OrderId,
                strategyId = link.StrategyId,
                strategy = link.StrategyName,
                account = link.AccountName,
                firstSeenUtc = link.FirstSeenUtc,
            }));
            if (File.Exists(path)) File.Delete(path);
            File.Move(temporary, path);
        }
        catch (IOException)
        {
            warnings.Add("attribution ledger could not be saved");
        }
    }

    private static void WriteLines(string path, IEnumerable<object> rows)
    {
        using StreamWriter writer = File.CreateText(path);
        foreach (object row in rows) writer.WriteLine(JsonConvert.SerializeObject(row));
    }

    private sealed class LedgerRow
    {
        public long orderId { get; set; }
        public long strategyId { get; set; }
        public string strategy { get; set; }
        public string account { get; set; }
        public string firstSeenUtc { get; set; }
    }
}

internal sealed class AttributionSummary
{
    public AttributionSummary(int templates, int trades, int inferred, int versioned, int recorded, int ledgerOrders, long orders)
    {
        Templates = templates;
        Trades = trades;
        Inferred = inferred;
        Versioned = versioned;
        Recorded = recorded;
        LedgerOrders = ledgerOrders;
        Orders = orders;
    }

    public int Templates { get; }
    public int Trades { get; }
    public int Inferred { get; }
    public int Versioned { get; }
    public int Recorded { get; }
    public int LedgerOrders { get; }
    public long Orders { get; }
}
