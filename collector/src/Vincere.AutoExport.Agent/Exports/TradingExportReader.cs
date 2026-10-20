using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Threading;
using Microsoft.Data.Sqlite;
using Vincere.AutoExport.Agent.UI.DeepExport;
using Vincere.AutoExport.NinjaTrader.Core.Capture;

namespace Vincere.AutoExport.Agent.Exports;

/// <summary>A failure the builder reports with a fixed code rather than as an exception type.</summary>
public sealed class TradingExportException : Exception
{
    public TradingExportException(string code) : base(code) => Code = code;

    public string Code { get; }
}

internal sealed class ExecutionLine
{
    public long RowId;
    public object ExecutionId;
    public long? OrderRowId;
    public object OrderId;
    public DateTime? Time;
    public string AccountName;
    public string Instrument;
    public object MarketPosition;
    public object Quantity;
    public object Price;
    public bool? IsEntry;
    public bool? IsExit;
    public object Name;
    public object Commission;
    public object Fee;
    public long? StrategyId;
    public string StrategyName;
}

internal sealed class OrderLine
{
    public long RowId;
    public object OrderId;
    public IReadOnlyList<string> OrderIdHistory;
    public DateTime? Time;
    public string AccountName;
    public string Instrument;
    public object Action;
    public object OrderType;
    public object Quantity;
    public object Filled;
    public object LimitPrice;
    public object StopPrice;
    public object AverageFillPrice;
    public object State;
    public object Oco;
    public object Name;
    public long? StrategyId;
    public string StrategyName;
}

internal sealed class StrategyLine
{
    public long Id;
    public string Name;
    public string Family;
    public bool PropFirm;
    public string Version;
    public string Risk;
    public string AccountName;
    public string Instrument;
    public bool? Enabled;
    public StrategyConfiguration Configuration;
}

internal sealed class TradingExportContent
{
    public List<ExecutionLine> Executions = new();
    public List<OrderLine> Orders = new();
    public List<StrategyLine> Strategies = new();
    public List<AttributionTrade> Trades = new();
    public HashSet<string> SecretValues = new(StringComparer.Ordinal);
    public SortedSet<string> Warnings = new(StringComparer.Ordinal);
}

/* ---------------------------------------------------------------------------
 * THE FOUR DATASETS, READ OFF THE CONSISTENT COPY AND NEVER OFF THE LIVE FILE.
 *
 * WHAT IS READ IS AN ALLOWLIST OF FIELDS, NOT OF TABLES. SqliteSnapshot's
 * allowlist decides which whole tables a database file may carry; this emits no
 * database file, so the question here is narrower: which columns become which
 * JSON fields. Each field below names the NinjaTrader column it comes from, a
 * column that does not exist on this machine's schema is simply absent from the
 * line (null), and a column nobody named here can never reach the file however
 * the schema grows. The tables the values come from are all ones
 * SqliteSnapshot.IsAllowedTable already ships; the instrument and account
 * tables are joined only to turn an integer id into a symbol or a name, which
 * is how AttributionExport resolves them too.
 *
 * TIMES ARE NINJATRADER'S OWN. Every timestamp in these tables is a .NET tick, an
 * 18-digit integer above 2^53 that a JSON reader would round, so each is written
 * as text with seven fractional digits - exact to the tick - and compared with
 * the requested dates as NinjaTrader stored it, without converting time zones.
 * A text timestamp, which the schema allows, is parsed as written. A row whose
 * time cannot be read is left out of a date-bounded export and counted in the
 * manifest's warnings rather than guessed into a day.
 *
 * ENUM COLUMNS ARE WRITTEN AS STORED. Action, order type, order state and market
 * position are NinjaTrader's integer codes in the database; translating them here
 * would be a second, unverified copy of NinjaTrader's enums. The daily capture
 * already carries the names beside the same orders, which is where a reader can
 * learn the mapping.
 *
 * WHICH STRATEGY PLACED AN ORDER: the platform's own Strategy2Order link first,
 * then the attribution ledger AttributionExport keeps across exports, because
 * NinjaTrader cascades the link away when a strategy is removed. An execution
 * takes Strategy2Execution when the platform kept one, else its order's.
 * ------------------------------------------------------------------------- */
internal static class TradingExportReader
{
    private const int CancellationStride = 1000;

    public static TradingExportContent Read(
        string copyPath,
        TradingExportPlan plan,
        AttributionReading attribution,
        CancellationToken cancellationToken)
    {
        var content = new TradingExportContent();
        using SqliteConnection connection = Open(copyPath);
        DatabaseShape shape = DatabaseShape.Read(connection);

        // The secret values first, from every stored configuration, whether or
        // not strategies were asked for: the writer hunts them in every string.
        List<StrategyLine> strategies = ReadStrategies(connection, shape, content.SecretValues, plan.Wants(TradingExportDatasets.Strategies));
        Dictionary<long, string> strategyNames = strategies.ToDictionary(line => line.Id, line => line.Name);
        StrategyLinks links = StrategyLinks.Read(connection, shape, strategyNames, attribution);

        bool needOrders = plan.Wants(TradingExportDatasets.Orders) || plan.Wants(TradingExportDatasets.Strategies);
        List<OrderLine> allOrders = needOrders
            ? ReadOrders(connection, shape, links, required: plan.Wants(TradingExportDatasets.Orders), cancellationToken)
            : new List<OrderLine>();

        if (plan.Wants(TradingExportDatasets.Orders))
            content.Orders = InRange(allOrders, line => line.Time, plan, content.Warnings);

        if (plan.Wants(TradingExportDatasets.Executions))
            content.Executions = InRange(ReadExecutions(connection, shape, links, cancellationToken), line => line.Time, plan, content.Warnings);

        if (plan.Wants(TradingExportDatasets.Strategies))
        {
            Describe(strategies, allOrders, links, attribution);
            content.Strategies = strategies;
            if (strategies.Any(line => line.Configuration.Status == StrategyConfigurationReader.Unreadable))
                content.Warnings.Add("strategy_configuration_unreadable");
        }

        if (plan.Wants(TradingExportDatasets.Trades) && attribution != null)
        {
            content.Trades = InRange(
                attribution.Trades.ToList(),
                trade => TradingExportTime.FromValue(trade.EntryTime),
                plan,
                content.Warnings);
        }
        return content;
    }

    private static List<T> InRange<T>(List<T> rows, Func<T, DateTime?> time, TradingExportPlan plan, ISet<string> warnings)
    {
        if (plan.From == null && plan.To == null) return rows;
        var kept = new List<T>(rows.Count);
        foreach (T row in rows)
        {
            DateTime? at = time(row);
            if (at is DateTime value)
            {
                if (plan.Covers(value)) kept.Add(row);
            }
            else
            {
                warnings.Add("rows_without_time_excluded");
            }
        }
        return kept;
    }

    private static List<StrategyLine> ReadStrategies(
        SqliteConnection connection,
        DatabaseShape shape,
        ISet<string> secretValues,
        bool required)
    {
        var lines = new List<StrategyLine>();
        string table = shape.Table("Strategies");
        string id = shape.Column(table, "Id");
        if (table == null || id == null)
        {
            if (required) throw new TradingExportException(TradingExportErrorCodes.DatabaseUnreadable);
            return lines;
        }
        var select = new Select();
        int idAt = select.Add("s", id);
        int nameAt = select.Add("s", shape.Column(table, "Name"));
        int userdataAt = select.Add("s", shape.Column(table, "Userdata"));
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = select.Sql($"FROM {Q(table)} s ORDER BY s.{Q(id)}");
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            if (reader.GetValue(idAt) is not long strategyId) continue;
            string name = Text(reader, nameAt);
            (string family, bool propFirm) = Family(name);
            lines.Add(new StrategyLine
            {
                Id = strategyId,
                Name = name,
                Family = family,
                PropFirm = propFirm,
                Configuration = StrategyConfigurationReader.ReadCell(Value(reader, userdataAt), secretValues),
            });
        }
        return lines;
    }

    private static List<OrderLine> ReadOrders(
        SqliteConnection connection,
        DatabaseShape shape,
        StrategyLinks links,
        bool required,
        CancellationToken cancellationToken)
    {
        var lines = new List<OrderLine>();
        string table = shape.Table("Orders");
        string id = shape.Column(table, "Id");
        string time = shape.Column(table, "Time");
        if (table == null || id == null || (required && time == null))
        {
            if (required) throw new TradingExportException(TradingExportErrorCodes.DatabaseUnreadable);
            return lines;
        }

        Dictionary<long, List<string>> history = OrderIdHistory(connection, shape);
        var select = new Select();
        int idAt = select.Add("o", id);
        int timeAt = select.Add("o", time);
        Party party = Party.Join(select, shape, table, "o");
        int orderIdAt = select.Add("o", shape.Column(table, "OrderId"));
        int actionAt = select.Add("o", shape.Column(table, "OrderAction", "Action"));
        int typeAt = select.Add("o", shape.Column(table, "OrderType"));
        int quantityAt = select.Add("o", shape.Column(table, "Quantity"));
        int filledAt = select.Add("o", shape.Column(table, "Filled"));
        int limitAt = select.Add("o", shape.Column(table, "LimitPrice"));
        int stopAt = select.Add("o", shape.Column(table, "StopPrice"));
        int averageAt = select.Add("o", shape.Column(table, "AvgFillPrice", "AverageFillPrice"));
        int stateAt = select.Add("o", shape.Column(table, "OrderState"));
        int ocoAt = select.Add("o", shape.Column(table, "Oco"));
        int nameAt = select.Add("o", shape.Column(table, "Name"));

        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = select.Sql($"FROM {Q(table)} o {party.Joins} ORDER BY o.{Q(id)}");
        using SqliteDataReader reader = command.ExecuteReader();
        int read = 0;
        while (reader.Read())
        {
            if (++read % CancellationStride == 0) cancellationToken.ThrowIfCancellationRequested();
            if (reader.GetValue(idAt) is not long rowId) continue;
            (long? strategyId, string strategyName) = links.ForOrder(rowId);
            history.TryGetValue(rowId, out List<string> ids);
            lines.Add(new OrderLine
            {
                RowId = rowId,
                OrderId = Scalar(reader, orderIdAt),
                OrderIdHistory = ids,
                Time = TradingExportTime.FromValue(Value(reader, timeAt)),
                AccountName = party.Account(reader),
                Instrument = party.Instrument(reader),
                Action = Scalar(reader, actionAt),
                OrderType = Scalar(reader, typeAt),
                Quantity = Scalar(reader, quantityAt),
                Filled = Scalar(reader, filledAt),
                LimitPrice = Scalar(reader, limitAt),
                StopPrice = Scalar(reader, stopAt),
                AverageFillPrice = Scalar(reader, averageAt),
                State = Scalar(reader, stateAt),
                Oco = Scalar(reader, ocoAt),
                Name = Scalar(reader, nameAt),
                StrategyId = strategyId,
                StrategyName = strategyName,
            });
        }
        return lines;
    }

    private static List<ExecutionLine> ReadExecutions(
        SqliteConnection connection,
        DatabaseShape shape,
        StrategyLinks links,
        CancellationToken cancellationToken)
    {
        var lines = new List<ExecutionLine>();
        string table = shape.Table("Executions");
        string id = shape.Column(table, "Id");
        string time = shape.Column(table, "Time");
        if (table == null || id == null || time == null)
            throw new TradingExportException(TradingExportErrorCodes.DatabaseUnreadable);

        var select = new Select();
        int idAt = select.Add("e", id);
        int timeAt = select.Add("e", time);
        Party party = Party.Join(select, shape, table, "e");
        int executionIdAt = select.Add("e", shape.Column(table, "ExecutionId"));
        int orderAt = select.Add("e", shape.Column(table, "Order"));
        int orderIdAt = select.Add("e", shape.Column(table, "OrderId"));
        int positionAt = select.Add("e", shape.Column(table, "MarketPosition"));
        int quantityAt = select.Add("e", shape.Column(table, "Quantity"));
        int priceAt = select.Add("e", shape.Column(table, "Price"));
        int entryAt = select.Add("e", shape.Column(table, "IsEntry"));
        int exitAt = select.Add("e", shape.Column(table, "IsExit"));
        int nameAt = select.Add("e", shape.Column(table, "Name"));
        int commissionAt = select.Add("e", shape.Column(table, "Commission"));
        int feeAt = select.Add("e", shape.Column(table, "Fee"));

        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = select.Sql($"FROM {Q(table)} e {party.Joins} ORDER BY e.{Q(id)}");
        using SqliteDataReader reader = command.ExecuteReader();
        int read = 0;
        while (reader.Read())
        {
            if (++read % CancellationStride == 0) cancellationToken.ThrowIfCancellationRequested();
            if (reader.GetValue(idAt) is not long rowId) continue;
            long? orderRowId = Value(reader, orderAt) is long order ? order : null;
            (long? strategyId, string strategyName) = links.ForExecution(rowId, orderRowId);
            lines.Add(new ExecutionLine
            {
                RowId = rowId,
                ExecutionId = Scalar(reader, executionIdAt),
                OrderRowId = orderRowId,
                OrderId = Scalar(reader, orderIdAt),
                Time = TradingExportTime.FromValue(Value(reader, timeAt)),
                AccountName = party.Account(reader),
                Instrument = party.Instrument(reader),
                MarketPosition = Scalar(reader, positionAt),
                Quantity = Scalar(reader, quantityAt),
                Price = Scalar(reader, priceAt),
                IsEntry = Flag(Value(reader, entryAt)),
                IsExit = Flag(Value(reader, exitAt)),
                Name = Scalar(reader, nameAt),
                Commission = Scalar(reader, commissionAt),
                Fee = Scalar(reader, feeAt),
                StrategyId = strategyId,
                StrategyName = strategyName,
            });
        }
        return lines;
    }

    /* The broker ids an order carried over its life, in order. Measured on a real
     * export: 98.8% of orders carry exactly two, because the broker reassigns the
     * id, and the terminal one alone loses the trail a prop-firm dispute turns on. */
    private static Dictionary<long, List<string>> OrderIdHistory(SqliteConnection connection, DatabaseShape shape)
    {
        var history = new Dictionary<long, List<string>>();
        string table = shape.Table("OrderUpdates");
        string order = shape.Column(table, "Order");
        string orderId = shape.Column(table, "OrderId");
        if (table == null || order == null || orderId == null) return history;
        string sequence = shape.Column(table, "Nr");
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = $"SELECT u.{Q(order)}, u.{Q(orderId)} FROM {Q(table)} u ORDER BY u.{Q(order)}, "
            + (sequence == null ? "u.rowid" : "u." + Q(sequence));
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            if (reader.GetValue(0) is not long row) continue;
            string id = Value(reader, 1) switch
            {
                string text => text,
                long number => number.ToString(CultureInfo.InvariantCulture),
                _ => null,
            };
            if (string.IsNullOrEmpty(id)) continue;
            if (!history.TryGetValue(row, out List<string> ids)) history[row] = ids = new List<string>();
            if (!ids.Contains(id, StringComparer.Ordinal)) ids.Add(id);
        }
        return history;
    }

    /* Which account and instrument a strategy instance trades, from the orders
     * linked to it, and which template version it is, from its own declared
     * geometry matched against the machine's catalogue - the matcher
     * AttributionExport uses for trades, asked about the configuration instead.
     * A match whose family is not the instance's own is not used. */
    private static void Describe(
        List<StrategyLine> strategies,
        List<OrderLine> orders,
        StrategyLinks links,
        AttributionReading attribution)
    {
        Dictionary<long, OrderLine> byRow = orders.ToDictionary(order => order.RowId);
        foreach (StrategyLine strategy in strategies)
        {
            var accounts = new List<string>();
            var instruments = new List<string>();
            foreach (long orderRow in links.OrdersOf(strategy.Id))
            {
                if (!byRow.TryGetValue(orderRow, out OrderLine order)) continue;
                if (!string.IsNullOrWhiteSpace(order.AccountName)) accounts.Add(order.AccountName);
                if (!string.IsNullOrWhiteSpace(order.Instrument)) instruments.Add(order.Instrument);
            }
            accounts.AddRange(links.LedgerAccountsOf(strategy.Id));
            strategy.AccountName = MostFrequent(accounts);
            strategy.Instrument = MostFrequent(instruments);

            IReadOnlyList<KeyValuePair<string, string>> parameters = strategy.Configuration.Parameters;
            if (parameters != null)
            {
                strategy.Enabled = parameters
                    .Where(pair => pair.Key is "IsEnabled" or "Enabled")
                    .Select(pair => StrategyConfigurationReader.Switch(pair.Value))
                    .FirstOrDefault(value => value.HasValue);
            }

            if (attribution?.Catalog == null || strategy.Instrument == null) continue;
            IReadOnlyDictionary<string, string> declared = strategy.Configuration.Geometry;
            var geometry = new TradeGeometry(strategy.Instrument) { StopTicks = Number(declared, "StopLossTicks") };
            for (int rung = 1; rung <= 3; rung++)
            {
                int ticks = Number(declared, "ProfitTarget" + rung + "Ticks");
                if (ticks > 0) geometry.AddRung(rung, ticks, Number(declared, "PosSize" + rung));
            }
            FingerprintMatch match = attribution.Catalog.Match(geometry);
            if (match.Matched && string.Equals(match.Family, strategy.Family, StringComparison.OrdinalIgnoreCase))
            {
                strategy.Version = match.Version;
                strategy.Risk = match.Risk;
            }
        }
    }

    /// <summary>StrategyTemplateReader's rule for a family name: the _PF suffix is a prop-firm variant, not an algorithm.</summary>
    private static (string Family, bool PropFirm) Family(string name)
    {
        string family = (name ?? string.Empty).Trim();
        bool propFirm = family.EndsWith("_PF", StringComparison.OrdinalIgnoreCase);
        if (propFirm) family = family.Substring(0, family.Length - 3);
        return (family.Length == 0 ? null : family, propFirm);
    }

    private static int Number(IReadOnlyDictionary<string, string> values, string field)
    {
        if (!values.TryGetValue(field, out string text) || string.IsNullOrWhiteSpace(text)) return 0;
        if (int.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out int whole)) return whole;
        return double.TryParse(text, NumberStyles.Float, CultureInfo.InvariantCulture, out double number)
            && Math.Abs(number - Math.Round(number)) < 0.0001
            ? (int)Math.Round(number)
            : 0;
    }

    private static string MostFrequent(IEnumerable<string> values)
        => values
            .GroupBy(value => value, StringComparer.Ordinal)
            .OrderByDescending(group => group.Count())
            .ThenBy(group => group.Key, StringComparer.Ordinal)
            .Select(group => group.Key)
            .FirstOrDefault();

    private static SqliteConnection Open(string path)
    {
        var connection = new SqliteConnection(new SqliteConnectionStringBuilder
        {
            DataSource = path,
            Mode = SqliteOpenMode.ReadOnly,
            Pooling = false,
        }.ConnectionString);
        connection.Open();
        return connection;
    }

    internal static string Q(string identifier) => "\"" + identifier.Replace("\"", "\"\"") + "\"";

    internal static object Value(SqliteDataReader reader, int ordinal)
        => ordinal < 0 || reader.IsDBNull(ordinal) ? null : reader.GetValue(ordinal);

    /// <summary>A number or a text, as stored. A blob is never a field value.</summary>
    internal static object Scalar(SqliteDataReader reader, int ordinal)
        => Value(reader, ordinal) switch
        {
            long number => number,
            double number => number,
            string text => text,
            _ => null,
        };

    internal static string Text(SqliteDataReader reader, int ordinal)
        => Value(reader, ordinal) switch
        {
            string text => text,
            long number => number.ToString(CultureInfo.InvariantCulture),
            _ => null,
        };

    private static bool? Flag(object value)
        => value switch
        {
            long number => number != 0,
            double number => number != 0,
            string text when bool.TryParse(text, out bool parsed) => parsed,
            _ => null,
        };

    /// <summary>The columns a SELECT reads, each at a known ordinal; a field with no column reads as null.</summary>
    internal sealed class Select
    {
        private readonly List<string> expressions = new();

        public int Add(string alias, string column)
        {
            if (column == null) return -1;
            expressions.Add(alias + "." + Q(column));
            return expressions.Count - 1;
        }

        public string Sql(string from) => "SELECT " + string.Join(", ", expressions) + " " + from;
    }

    /* The account name and the instrument symbol of a row, by the joins
     * AttributionExport makes: Accounts.Id to the account, and Instruments to
     * MasterInstruments to the symbol. A column stored as text instead of an id
     * is used as it stands. */
    private sealed class Party
    {
        private int rawAccount = -1;
        private int accountName = -1;
        private int rawInstrument = -1;
        private int symbol = -1;

        public string Joins { get; private set; } = string.Empty;

        public static Party Join(Select select, DatabaseShape shape, string table, string alias)
        {
            var party = new Party();
            string account = shape.Column(table, "Account");
            string instrument = shape.Column(table, "Instrument");
            party.rawAccount = select.Add(alias, account);
            party.rawInstrument = select.Add(alias, instrument);

            string accounts = shape.Table("Accounts");
            string accountsId = shape.Column(accounts, "Id");
            string accountsName = shape.Column(accounts, "Name");
            if (account != null && accounts != null && accountsId != null && accountsName != null)
            {
                party.Joins += $" LEFT JOIN {Q(accounts)} a ON a.{Q(accountsId)} = {alias}.{Q(account)}";
                party.accountName = select.Add("a", accountsName);
            }

            string instruments = shape.Table("Instruments");
            string instrumentsId = shape.Column(instruments, "Id");
            string master = shape.Column(instruments, "MasterInstrument");
            string masters = shape.Table("MasterInstruments");
            string mastersId = shape.Column(masters, "Id");
            string mastersName = shape.Column(masters, "Name");
            if (instrument != null && instrumentsId != null && master != null && mastersId != null && mastersName != null)
            {
                party.Joins += $" LEFT JOIN {Q(instruments)} i ON i.{Q(instrumentsId)} = {alias}.{Q(instrument)}"
                    + $" LEFT JOIN {Q(masters)} mi ON mi.{Q(mastersId)} = i.{Q(master)}";
                party.symbol = select.Add("mi", mastersName);
            }
            return party;
        }

        public string Account(SqliteDataReader reader)
            => Value(reader, accountName) as string ?? Value(reader, rawAccount) as string;

        public string Instrument(SqliteDataReader reader)
            => Value(reader, symbol) as string ?? Value(reader, rawInstrument) as string;
    }
}

/// <summary>Which strategy an order or an execution belongs to, from the platform's links and the ledger.</summary>
internal sealed class StrategyLinks
{
    private readonly Dictionary<long, long> orderToStrategy = new();
    private readonly Dictionary<long, long> executionToStrategy = new();
    private readonly Dictionary<long, StrategyOrderLink> ledgerByOrder = new();
    private readonly IReadOnlyDictionary<long, string> names;

    private StrategyLinks(IReadOnlyDictionary<long, string> names) => this.names = names;

    public static StrategyLinks Read(
        SqliteConnection connection,
        DatabaseShape shape,
        IReadOnlyDictionary<long, string> names,
        AttributionReading attribution)
    {
        var links = new StrategyLinks(names);
        Load(connection, shape, "Strategy2Order", "Order", links.orderToStrategy);
        Load(connection, shape, "Strategy2Execution", "Execution", links.executionToStrategy);
        foreach (StrategyOrderLink link in attribution?.Ledger ?? Array.Empty<StrategyOrderLink>())
            links.ledgerByOrder.TryAdd(link.OrderId, link);
        return links;
    }

    public (long? Id, string Name) ForOrder(long orderRow)
    {
        if (orderToStrategy.TryGetValue(orderRow, out long strategy))
            return (strategy, names.TryGetValue(strategy, out string name) ? name : null);
        if (ledgerByOrder.TryGetValue(orderRow, out StrategyOrderLink link))
            return (link.StrategyId, string.IsNullOrWhiteSpace(link.StrategyName) ? null : link.StrategyName);
        return (null, null);
    }

    public (long? Id, string Name) ForExecution(long executionRow, long? orderRow)
    {
        if (executionToStrategy.TryGetValue(executionRow, out long strategy))
            return (strategy, names.TryGetValue(strategy, out string name) ? name : null);
        return orderRow is long order ? ForOrder(order) : (null, null);
    }

    public IEnumerable<long> OrdersOf(long strategy)
        => orderToStrategy.Where(pair => pair.Value == strategy).Select(pair => pair.Key)
            .Concat(ledgerByOrder.Values.Where(link => link.StrategyId == strategy).Select(link => link.OrderId))
            .Distinct();

    public IEnumerable<string> LedgerAccountsOf(long strategy)
        => ledgerByOrder.Values
            .Where(link => link.StrategyId == strategy && !orderToStrategy.ContainsKey(link.OrderId) && !string.IsNullOrWhiteSpace(link.AccountName))
            .Select(link => link.AccountName);

    private static void Load(SqliteConnection connection, DatabaseShape shape, string tableName, string keyName, IDictionary<long, long> into)
    {
        string table = shape.Table(tableName);
        string key = shape.Column(table, keyName);
        string strategy = shape.Column(table, "Strategy");
        if (table == null || key == null || strategy == null) return;
        using SqliteCommand command = connection.CreateCommand();
        command.CommandText = $"SELECT l.{TradingExportReader.Q(key)}, l.{TradingExportReader.Q(strategy)} FROM {TradingExportReader.Q(table)} l";
        using SqliteDataReader reader = command.ExecuteReader();
        while (reader.Read())
        {
            if (reader.GetValue(0) is long row && reader.GetValue(1) is long id) into.TryAdd(row, id);
        }
    }
}

/// <summary>The tables and columns this copy actually has, by name without case.</summary>
internal sealed class DatabaseShape
{
    private readonly Dictionary<string, string> tables = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, Dictionary<string, string>> columns = new(StringComparer.OrdinalIgnoreCase);

    public static DatabaseShape Read(SqliteConnection connection)
    {
        var shape = new DatabaseShape();
        using (SqliteCommand command = connection.CreateCommand())
        {
            command.CommandText = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'";
            using SqliteDataReader reader = command.ExecuteReader();
            while (reader.Read()) shape.tables[reader.GetString(0)] = reader.GetString(0);
        }
        foreach (string table in shape.tables.Values.ToList())
        {
            var names = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = $"PRAGMA table_info({TradingExportReader.Q(table)})";
            using SqliteDataReader reader = command.ExecuteReader();
            while (reader.Read()) names[reader.GetString(1)] = reader.GetString(1);
            shape.columns[table] = names;
        }
        return shape;
    }

    /// <summary>The table's name as the database spells it, or null.</summary>
    public string Table(string name) => tables.TryGetValue(name, out string actual) ? actual : null;

    /// <summary>The first of <paramref name="names"/> that the table has, as the database spells it, or null.</summary>
    public string Column(string table, params string[] names)
    {
        if (table == null || !columns.TryGetValue(table, out Dictionary<string, string> known)) return null;
        foreach (string name in names)
        {
            if (known.TryGetValue(name, out string actual)) return actual;
        }
        return null;
    }
}

/// <summary>NinjaTrader's timestamps, read and written without losing a tick.</summary>
internal static class TradingExportTime
{
    public static DateTime? FromValue(object value)
        => value switch
        {
            long ticks when ticks > 0 && ticks <= DateTime.MaxValue.Ticks => new DateTime(ticks, DateTimeKind.Unspecified),
            double ticks when ticks > 0 && ticks <= DateTime.MaxValue.Ticks && Math.Abs(ticks - Math.Round(ticks)) < 1
                => new DateTime((long)Math.Round(ticks), DateTimeKind.Unspecified),
            string text when DateTime.TryParse(text, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind, out DateTime parsed)
                => parsed,
            _ => null,
        };

    public static string Format(DateTime value) => value.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff", CultureInfo.InvariantCulture);
}
