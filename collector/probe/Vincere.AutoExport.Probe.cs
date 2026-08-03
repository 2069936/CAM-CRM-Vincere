#region Using declarations
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using NinjaTrader.Cbi;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript;
using Newtonsoft.Json;
#endregion

namespace NinjaTrader.NinjaScript.AddOns
{
    public sealed class VincereAutoExportProbe : AddOnBase
    {
        private const string ProbeVersion = "0.1.0-probe";
        private static readonly TimeZoneInfo EasternTimeZone = LoadEasternTimeZone();
        private NTMenuItem exportMenuItem;
        private NTMenuItem newMenu;
        private int captureInProgress;

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name = "VincereAutoExportProbe";
                Description = "Captures a local supported-API snapshot for field-parity testing.";
            }
        }

        protected override void OnWindowCreated(Window window)
        {
            ControlCenter controlCenter = window as ControlCenter;
            if (controlCenter == null || exportMenuItem != null)
                return;

            newMenu = controlCenter.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
            if (newMenu == null)
                return;

            exportMenuItem = new NTMenuItem
            {
                Header = "Export Vincere Probe Snapshot",
                Style = Application.Current.TryFindResource("MainMenuItem") as Style
            };
            exportMenuItem.Click += OnExportClick;
            newMenu.Items.Add(exportMenuItem);
        }

        protected override void OnWindowDestroyed(Window window)
        {
            if (!(window is ControlCenter) || exportMenuItem == null)
                return;

            exportMenuItem.Click -= OnExportClick;
            if (newMenu != null && newMenu.Items.Contains(exportMenuItem))
                newMenu.Items.Remove(exportMenuItem);
            exportMenuItem = null;
            newMenu = null;
        }

        private void OnExportClick(object sender, RoutedEventArgs eventArgs)
        {
            if (Interlocked.Exchange(ref captureInProgress, 1) == 1)
            {
                MessageBox.Show("A Vincere probe capture is already running.", "Vincere probe");
                return;
            }

            ProbeCapture capture;
            try
            {
                capture = CaptureOnNinjaTraderThread();
            }
            catch (Exception exception)
            {
                Interlocked.Exchange(ref captureInProgress, 0);
                MessageBox.Show("Probe capture failed: " + exception.Message, "Vincere probe");
                return;
            }

            Task.Run(() => WriteCapture(capture)).ContinueWith(task =>
            {
                Application.Current.Dispatcher.BeginInvoke(new Action(() =>
                {
                    Interlocked.Exchange(ref captureInProgress, 0);
                    if (task.IsFaulted)
                    {
                        Exception error = task.Exception == null
                            ? null
                            : task.Exception.GetBaseException();
                        MessageBox.Show(
                            "Probe write failed: " + (error == null ? "unknown error" : error.Message),
                            "Vincere probe");
                        return;
                    }
                    MessageBox.Show(
                        "Probe snapshot written locally:\n" + task.Result,
                        "Vincere probe");
                }));
            });
        }

        private ProbeCapture CaptureOnNinjaTraderThread()
        {
            Guid captureId = Guid.NewGuid();
            DateTimeOffset capturedAt = DateTimeOffset.Now;
            DateTime easternNow = TimeZoneInfo.ConvertTime(capturedAt, EasternTimeZone).DateTime;
            List<ProbeWarning> warnings = new List<ProbeWarning>();
            List<Account> accounts;

            lock (Account.All)
                accounts = Account.All.ToList();

            List<Dictionary<string, object>> accountRows = new List<Dictionary<string, object>>();
            List<Dictionary<string, object>> strategyRows = new List<Dictionary<string, object>>();
            List<Dictionary<string, object>> orderRows = new List<Dictionary<string, object>>();
            List<Dictionary<string, object>> executionRows = new List<Dictionary<string, object>>();

            try
            {
                foreach (Account account in accounts)
                    accountRows.Add(MapAccount(account, warnings));
            }
            catch (Exception exception)
            {
                accountRows.Clear();
                warnings.Add(SectionFailure("accounts", exception));
            }

            try
            {
                foreach (Account account in accounts)
                {
                    List<StrategyBase> strategies;
                    lock (account.Strategies)
                        strategies = account.Strategies.ToList();
                    strategyRows.AddRange(strategies.Select(
                        strategy => MapStrategy(account, strategy, warnings)));
                }
            }
            catch (Exception exception)
            {
                strategyRows.Clear();
                warnings.Add(SectionFailure("strategies", exception));
            }

            try
            {
                foreach (Account account in accounts)
                {
                    List<Order> orders;
                    lock (account.Orders)
                        orders = account.Orders.ToList();
                    orderRows.AddRange(orders.Select(order => MapOrder(account, order)));
                }
            }
            catch (Exception exception)
            {
                orderRows.Clear();
                warnings.Add(SectionFailure("orders", exception));
            }

            try
            {
                foreach (Account account in accounts)
                {
                    List<Execution> executions;
                    lock (account.Executions)
                        executions = account.Executions.ToList();
                    executionRows.AddRange(executions.Select(execution => MapExecution(account, execution)));
                }
            }
            catch (Exception exception)
            {
                executionRows.Clear();
                warnings.Add(SectionFailure("executions", exception));
            }

            warnings.Add(new ProbeWarning(
                "grid_only_account_fields",
                "accounts",
                "Weekly PnL and trailing max drawdown have no documented AccountItem mapping and remain null."));
            warnings.Add(new ProbeWarning(
                "session_only_executions",
                "executions",
                "Account.Executions contains current-session executions; historical local-database retrieval is unsupported."));

            Dictionary<string, object> snapshot = new Dictionary<string, object>
            {
                { "schemaVersion", 1 },
                { "captureId", captureId },
                { "capturedAt", capturedAt },
                { "tradingDate", easternNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture) },
                { "timeZone", "America/New_York" },
                { "source", new Dictionary<string, object>
                    {
                        { "machineId", "probe-only" },
                        { "agentVersion", ProbeVersion },
                        { "addonVersion", ProbeVersion },
                        { "ninjaTraderVersion", typeof(AddOnBase).Assembly.GetName().Version.ToString() }
                    }
                },
                { "accounts", accountRows },
                { "strategies", strategyRows },
                { "orders", orderRows },
                { "executions", executionRows }
            };

            return new ProbeCapture(captureId, snapshot, warnings);
        }

        private static Dictionary<string, object> MapAccount(Account account, IList<ProbeWarning> warnings)
        {
            Currency denomination = account.Denomination;
            string displayName = PublicString(account, "DisplayName");
            if (String.IsNullOrWhiteSpace(displayName))
            {
                warnings.Add(new ProbeWarning(
                    "account_display_name_unavailable",
                    "accounts",
                    "The supported Account object did not expose DisplayName for account " + account.Name + "."));
            }

            return new Dictionary<string, object>
            {
                { "accountName", account.Name },
                { "connectionName", account.Connection == null ? null : account.Connection.Options.Name },
                { "displayName", displayName },
                { "netLiquidation", AccountValue(account, AccountItem.NetLiquidation, denomination, warnings) },
                { "cashValue", AccountValue(account, AccountItem.CashValue, denomination, warnings) },
                { "realizedPnl", AccountValue(account, AccountItem.RealizedProfitLoss, denomination, warnings) },
                { "grossRealizedPnl", AccountValue(account, AccountItem.GrossRealizedProfitLoss, denomination, warnings) },
                { "unrealizedPnl", AccountValue(account, AccountItem.UnrealizedProfitLoss, denomination, warnings) },
                { "totalPnl", null },
                { "weeklyPnl", null },
                { "trailingMaxDrawdown", null },
                { "buyingPower", AccountValue(account, AccountItem.BuyingPower, denomination, warnings) },
                { "excessIntradayMargin", AccountValue(account, AccountItem.ExcessIntradayMargin, denomination, warnings) },
                { "initialMargin", AccountValue(account, AccountItem.InitialMargin, denomination, warnings) },
                { "maintenanceMargin", AccountValue(account, AccountItem.MaintenanceMargin, denomination, warnings) },
                { "currency", denomination.ToString() },
                { "status", PublicString(account, "ConnectionStatus") }
            };
        }

        private static Dictionary<string, object> MapStrategy(
            Account account,
            StrategyBase strategy,
            IList<ProbeWarning> warnings)
        {
            string strategyId = PublicString(strategy, "StrategyId", "Id");
            if (String.IsNullOrWhiteSpace(strategyId))
            {
                warnings.Add(new ProbeWarning(
                    "strategy_id_unavailable",
                    "strategies",
                    "No public strategy identifier was exposed for " + strategy.Name + "."));
                strategyId = String.Empty;
            }

            ParameterCapture parameters = ReadStrategyParameters(strategy, warnings);
            object position = strategy.Position;
            object instrument = strategy.Instruments == null ? null : strategy.Instruments.FirstOrDefault();

            return new Dictionary<string, object>
            {
                { "strategyId", strategyId },
                { "strategyName", strategy.Name },
                { "strategyDisplayName", PublicString(strategy, "DisplayName") ?? strategy.Name },
                { "accountName", account.Name },
                { "instrument", PublicString(instrument, "FullName") },
                { "state", strategy.State.ToString() },
                { "quantity", NullableDecimal(PublicValue(position, "Quantity")) },
                { "position", PublicString(position, "MarketPosition") },
                { "averagePrice", NullableDecimal(PublicValue(position, "AveragePrice")) },
                { "realizedPnl", null },
                { "unrealizedPnl", null },
                { "enabled", true },
                { "sync", NullableBoolean(PublicValue(strategy, "IsInSync", "Sync")) },
                { "dataSeries", PublicString(strategy, "BarsPeriod", "DataSeries") },
                { "connectionName", account.Connection == null ? null : account.Connection.Options.Name },
                { "startedAt", null },
                { "parameters", parameters.Values },
                { "parameterCaptureStatus", parameters.Status }
            };
        }

        private static Dictionary<string, object> MapOrder(Account account, Order order)
        {
            string orderType = order.OrderType.ToString();
            bool hasLimit = orderType == "Limit" || orderType == "StopLimit";
            bool hasStop = orderType == "StopMarket" || orderType == "StopLimit";
            return new Dictionary<string, object>
            {
                { "orderId", order.OrderId ?? String.Empty },
                { "accountName", account.Name },
                { "strategyId", null },
                { "strategyName", null },
                { "instrument", order.Instrument == null ? String.Empty : order.Instrument.FullName },
                { "action", order.OrderAction.ToString() },
                { "orderType", orderType },
                { "quantity", Convert.ToDecimal(order.Quantity, CultureInfo.InvariantCulture) },
                { "filled", Convert.ToDecimal(order.Filled, CultureInfo.InvariantCulture) },
                { "remaining", Convert.ToDecimal(Math.Max(0, order.Quantity - order.Filled), CultureInfo.InvariantCulture) },
                { "limitPrice", hasLimit ? NullableDecimal(order.LimitPrice) : null },
                { "stopPrice", hasStop ? NullableDecimal(order.StopPrice) : null },
                { "averageFillPrice", order.Filled > 0 ? NullableDecimal(order.AverageFillPrice) : null },
                { "state", order.OrderState.ToString() },
                { "time", ToOffset(order.Time) },
                { "tif", order.TimeInForce.ToString() },
                { "oco", String.IsNullOrWhiteSpace(order.Oco) ? null : order.Oco },
                { "name", order.Name },
                { "nativeId", null }
            };
        }

        private static Dictionary<string, object> MapExecution(Account account, Execution execution)
        {
            Order order = execution.Order;
            return new Dictionary<string, object>
            {
                { "executionId", execution.ExecutionId ?? String.Empty },
                { "orderId", execution.OrderId },
                { "accountName", account.Name },
                { "strategyId", null },
                { "strategyName", null },
                { "instrument", execution.Instrument == null ? String.Empty : execution.Instrument.FullName },
                { "action", order == null ? String.Empty : order.OrderAction.ToString() },
                { "quantity", Convert.ToDecimal(execution.Quantity, CultureInfo.InvariantCulture) },
                { "price", NullableDecimal(execution.Price) },
                { "time", ToOffset(execution.Time) },
                { "marketPosition", execution.MarketPosition.ToString() },
                { "entryExit", null },
                { "name", execution.Name },
                { "commission", NullableDecimal(execution.Commission) },
                { "fee", null },
                { "rate", NullableDecimal(execution.Rate) },
                { "realizedPnl", null },
                { "connectionName", account.Connection == null ? null : account.Connection.Options.Name },
                { "nativeId", null }
            };
        }

        private static decimal? AccountValue(
            Account account,
            AccountItem item,
            Currency currency,
            IList<ProbeWarning> warnings)
        {
            try
            {
                return NullableDecimal(account.Get(item, currency));
            }
            catch (Exception exception)
            {
                warnings.Add(new ProbeWarning(
                    "account_item_error",
                    "accounts",
                    item + " failed for " + account.Name + ": " + exception.GetType().Name));
                return null;
            }
        }

        private static ParameterCapture ReadStrategyParameters(
            StrategyBase strategy,
            IList<ProbeWarning> warnings)
        {
            Dictionary<string, object> values = new Dictionary<string, object>();
            bool partial = false;
            foreach (PropertyDescriptor property in TypeDescriptor.GetProperties(strategy))
            {
                if (!property.IsBrowsable || property.Name == "Name" || property.Name == "DisplayName")
                    continue;
                if (IsSecretLike(property.Name))
                {
                    values[property.Name] = null;
                    partial = true;
                    warnings.Add(new ProbeWarning(
                        "strategy_parameter_redacted",
                        "strategies",
                        "A secret-like strategy property name was redacted."));
                    continue;
                }
                try
                {
                    values[property.Name] = SafeScalar(property.GetValue(strategy));
                }
                catch (Exception exception)
                {
                    partial = true;
                    values[property.Name] = null;
                    warnings.Add(new ProbeWarning(
                        "strategy_parameter_error",
                        "strategies",
                        property.Name + " could not be read: " + exception.GetType().Name));
                }
            }
            return new ParameterCapture(values, partial ? "partial" : "captured");
        }

        private static object SafeScalar(object value)
        {
            if (value == null)
                return null;
            Type type = value.GetType();
            if (type.IsEnum)
                return value.ToString();
            if (value is string || value is bool || value is byte || value is sbyte
                || value is short || value is ushort || value is int || value is uint
                || value is long || value is ulong || value is float || value is double
                || value is decimal || value is Guid)
                return value;
            if (value is DateTime)
                return ToOffset((DateTime)value);
            if (value is DateTimeOffset || value is TimeSpan)
                return value.ToString();

            string text = Convert.ToString(value, CultureInfo.InvariantCulture);
            if (String.IsNullOrEmpty(text))
                return null;
            return text.Length <= 512 ? text : text.Substring(0, 512);
        }

        private static bool IsSecretLike(string name)
        {
            string separated = Regex.Replace(name ?? String.Empty, "([a-z0-9])([A-Z])", "$1 $2");
            string[] tokens = Regex.Split(separated.ToLowerInvariant(), "[^a-z0-9]+");
            return tokens.Any(token => token == "password" || token == "secret"
                || token == "token" || token == "key" || token == "license");
        }

        private static ProbeWarning SectionFailure(string section, Exception exception)
        {
            return new ProbeWarning(
                "section_capture_failed",
                section,
                "The section was cleared after " + exception.GetType().Name + ".");
        }

        private static object PublicValue(object source, params string[] names)
        {
            if (source == null)
                return null;
            PropertyDescriptorCollection properties = TypeDescriptor.GetProperties(source);
            foreach (string name in names)
            {
                PropertyDescriptor property = properties.Find(name, true);
                if (property != null)
                {
                    try { return property.GetValue(source); }
                    catch { return null; }
                }
            }
            return null;
        }

        private static string PublicString(object source, params string[] names)
        {
            object value = PublicValue(source, names);
            return value == null ? null : Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        private static decimal? NullableDecimal(object value)
        {
            if (value == null)
                return null;
            try
            {
                double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                if (Double.IsNaN(number) || Double.IsInfinity(number) || number == Double.MinValue)
                    return null;
                return Convert.ToDecimal(number, CultureInfo.InvariantCulture);
            }
            catch
            {
                return null;
            }
        }

        private static bool? NullableBoolean(object value)
        {
            if (value == null)
                return null;
            try
            {
                return Convert.ToBoolean(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return null;
            }
        }

        private static DateTimeOffset ToOffset(DateTime value)
        {
            if (value.Kind == DateTimeKind.Utc)
                return new DateTimeOffset(value);
            if (value.Kind == DateTimeKind.Unspecified)
                value = DateTime.SpecifyKind(value, DateTimeKind.Local);
            return new DateTimeOffset(value);
        }

        private static TimeZoneInfo LoadEasternTimeZone()
        {
            return TimeZoneInfo.FindSystemTimeZoneById("Eastern Standard Time");
        }

        private static string WriteCapture(ProbeCapture capture)
        {
            string directory = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "Vincere", "AutoExport", "probe");
            Directory.CreateDirectory(directory);
            string baseName = capture.CaptureId.ToString("D");
            string snapshotPath = Path.Combine(directory, baseName + ".json");
            string warningsPath = Path.Combine(directory, baseName + ".warnings.json");
            JsonSerializerSettings settings = new JsonSerializerSettings
            {
                Formatting = Formatting.Indented,
                NullValueHandling = NullValueHandling.Include
            };
            WriteAtomic(snapshotPath, JsonConvert.SerializeObject(capture.Snapshot, settings));
            WriteAtomic(warningsPath, JsonConvert.SerializeObject(capture.Warnings, settings));
            return snapshotPath;
        }

        private static void WriteAtomic(string finalPath, string contents)
        {
            string temporaryPath = finalPath + ".tmp";
            try
            {
                using (FileStream stream = new FileStream(
                    temporaryPath,
                    FileMode.CreateNew,
                    FileAccess.Write,
                    FileShare.None,
                    4096,
                    FileOptions.WriteThrough))
                using (StreamWriter writer = new StreamWriter(stream))
                {
                    writer.Write(contents);
                    writer.Flush();
                    stream.Flush(true);
                }
                File.Move(temporaryPath, finalPath);
            }
            catch
            {
                if (File.Exists(temporaryPath))
                    File.Delete(temporaryPath);
                throw;
            }
        }

        private sealed class ProbeCapture
        {
            public ProbeCapture(
                Guid captureId,
                IDictionary<string, object> snapshot,
                IList<ProbeWarning> warnings)
            {
                CaptureId = captureId;
                Snapshot = snapshot;
                Warnings = warnings;
            }

            public Guid CaptureId { get; private set; }
            public IDictionary<string, object> Snapshot { get; private set; }
            public IList<ProbeWarning> Warnings { get; private set; }
        }

        private sealed class ProbeWarning
        {
            public ProbeWarning(string code, string section, string message)
            {
                Code = code;
                Section = section;
                Message = message;
            }

            [JsonProperty("code")]
            public string Code { get; private set; }

            [JsonProperty("section")]
            public string Section { get; private set; }

            [JsonProperty("message")]
            public string Message { get; private set; }
        }

        private sealed class ParameterCapture
        {
            public ParameterCapture(IDictionary<string, object> values, string status)
            {
                Values = values;
                Status = status;
            }

            public IDictionary<string, object> Values { get; private set; }
            public string Status { get; private set; }
        }
    }
}
