using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Globalization;
using System.Linq;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript;
using Vincere.AutoExport.NinjaTrader.Core.Capture;

namespace Vincere.AutoExport.NinjaTrader.Capture
{
    /// <summary>
    /// Reads documented NinjaTrader account collections. Callers must invoke this
    /// facade on NinjaTrader's application dispatcher; returned DTOs no longer hold
    /// live collection enumerators.
    /// </summary>
    public sealed class NinjaTraderFacade : INinjaTraderFacade
    {
        public IEnumerable<AccountCaptureSource> ReadAccounts()
        {
            return SnapshotAccounts().Select(MapAccount).ToList();
        }

        public IEnumerable<StrategyCaptureSource> ReadStrategies()
        {
            var rows = new List<StrategyCaptureSource>();
            foreach (Account account in SnapshotAccounts())
            {
                List<StrategyBase> strategies;
                lock (account.Strategies)
                    strategies = account.Strategies.ToList();
                rows.AddRange(strategies.Select(strategy => MapStrategy(account, strategy)));
            }
            return rows;
        }

        public IEnumerable<OrderCaptureSource> ReadOrders()
        {
            var rows = new List<OrderCaptureSource>();
            foreach (Account account in SnapshotAccounts())
            {
                StrategyAttributionMap attribution = Attribution(account);
                List<Order> orders;
                lock (account.Orders)
                    orders = account.Orders.ToList();
                rows.AddRange(orders.Select(order => MapOrder(account, order, attribution)));
            }
            return rows;
        }

        public IEnumerable<ExecutionCaptureSource> ReadExecutions()
        {
            var rows = new List<ExecutionCaptureSource>();
            foreach (Account account in SnapshotAccounts())
            {
                StrategyAttributionMap attribution = Attribution(account);
                List<Execution> executions;
                lock (account.Executions)
                    executions = account.Executions.ToList();
                rows.AddRange(executions.Select(execution => MapExecution(account, execution, attribution)));
            }
            return rows;
        }

        // EVALUATED ONCE PER CAPTURE, NOT ONCE PER SECTION.
        //
        // This is the single gate for all four sections: an account filtered
        // here also stops contributing strategies, orders and executions, so a
        // close never carries trades belonging to an account it does not list.
        //
        // It used to be a static method the four readers each called, and the
        // filter reads LIVE state: ConnectionStatus, CashValue, NetLiquidation.
        // Four evaluations milliseconds apart against a connection that is
        // reconnecting do not have to agree. When they disagreed, the close
        // carried strategies, orders or executions belonging to an account the
        // accounts section had dropped, and the CRM rejected the WHOLE snapshot
        // with "strategies[i].accountName does not reference an account". The
        // file was unusable by hand as well as automatically, and it looked
        // random because it depended on where the flap landed.
        //
        // One facade is constructed per capture (VincereAutoExportAddOn.cs:133),
        // so memoising on the instance gives every section the same list and
        // costs nothing beyond the capture it belongs to.
        private List<Account> snapshotAccounts;

        private List<Account> SnapshotAccounts()
        {
            if (snapshotAccounts != null) return snapshotAccounts;
            snapshotAccounts = BuildSnapshotAccounts();
            return snapshotAccounts;
        }

        private static List<Account> BuildSnapshotAccounts()
        {
            List<Account> all;
            lock (Account.All)
                all = Account.All.ToList();

            var relevant = new List<Account>(all.Count);
            foreach (Account account in all)
            {
                Currency denomination = account.Denomination;
                bool connected = String.Equals(
                    PublicString(account, "ConnectionStatus"), "Connected", StringComparison.OrdinalIgnoreCase);
                if (AccountRelevance.IsRelevant(
                        account.Name,
                        connected,
                        AccountValue(account, AccountItem.CashValue, denomination),
                        AccountValue(account, AccountItem.NetLiquidation, denomination)))
                {
                    relevant.Add(account);
                }
            }
            return relevant;
        }

        // WHO PLACED THE ORDER, ASKED ONCE PER CAPTURE.
        //
        // An Order and an Execution do not name their strategy, but a strategy
        // names its orders and its fills, so the link is read in that direction
        // and inverted here. See StrategyAttributionMap for what the automatic
        // path was shipping without it.
        //
        // Memoised on the instance for the same reason snapshotAccounts is: the
        // orders section and the executions section must see ONE answer. Built
        // twice, a strategy that stops between the two sections would attribute
        // an order and then leave its own fill unattributed, and the CRM would
        // hold a close whose parts disagree about who traded.
        private Dictionary<Account, StrategyAttributionMap> attributionByAccount;

        private StrategyAttributionMap Attribution(Account account)
        {
            if (attributionByAccount == null)
            {
                attributionByAccount = new Dictionary<Account, StrategyAttributionMap>();
                foreach (Account relevant in SnapshotAccounts())
                    attributionByAccount[relevant] = StrategyAttributionMap.Build(ReadOwnership(relevant));
            }
            StrategyAttributionMap attribution;
            return attributionByAccount.TryGetValue(account, out attribution)
                ? attribution
                : StrategyAttributionMap.Empty;
        }

        /// <summary>
        /// What each of the account's strategies says it owns.
        ///
        /// The two collections are reached through the reflection helpers rather
        /// than against StrategyBase.Orders and StrategyBase.Executions directly:
        /// the AddOn is compiled once and loaded by whatever NinjaTrader the
        /// client runs, 8.1.6 through 8.1.8 across the fleet, and a member one of
        /// them does not expose has to degrade to no attribution rather than to a
        /// type the assembly cannot bind.
        ///
        /// All of it happens under the lock ReadStrategies already takes, and
        /// every collection is copied before it is read, because the platform can
        /// add an order to a strategy while we walk it.
        /// </summary>
        private static List<StrategyOrderOwnership> ReadOwnership(Account account)
        {
            var owned = new List<StrategyOrderOwnership>();
            lock (account.Strategies)
            {
                foreach (StrategyBase strategy in account.Strategies.ToList())
                {
                    List<object> orders = PublicCollection(strategy, "Orders");
                    List<object> executions = PublicCollection(strategy, "Executions");

                    var orderIds = new List<string>(orders.Count + executions.Count);
                    foreach (object order in orders)
                        orderIds.Add(PublicString(order, "OrderId"));
                    // A fill carries the id of the order it filled, and a strategy
                    // can still list a fill whose order has already left its Orders
                    // collection, so that order id is claimed here too.
                    foreach (object execution in executions)
                        orderIds.Add(PublicString(execution, "OrderId"));

                    var executionIds = new List<string>(executions.Count);
                    foreach (object execution in executions)
                        executionIds.Add(PublicString(execution, "ExecutionId"));

                    // The same two members MapStrategy reports the strategy under,
                    // so an order's strategyId and strategyName are the strings the
                    // strategies section of this very snapshot carries.
                    owned.Add(new StrategyOrderOwnership(
                        PublicString(strategy, "StrategyId", "Id"),
                        strategy.Name,
                        orderIds,
                        executionIds));
                }
            }
            return owned;
        }

        /// <summary>
        /// A named collection property, copied out before anything reads it. Same
        /// contract as PublicValue, which it asks first: a member this NinjaTrader
        /// version does not have yields an empty list, and a collection that
        /// changes mid copy yields what was copied before it changed, rather than
        /// throwing and costing the capture its whole orders section.
        /// </summary>
        private static List<object> PublicCollection(object source, string name)
        {
            var items = new List<object>();
            object value = PublicValue(source, name) ?? ReflectedValue(source, name);
            if (!(value is System.Collections.IEnumerable collection))
                return items;
            try
            {
                foreach (object item in collection)
                    items.Add(item);
            }
            catch
            {
                // Mutated underneath the copy. Keep the part that was copied: it
                // attributes the rows it names and says nothing about the rest.
                return items;
            }
            return items;
        }

        private static AccountCaptureSource MapAccount(Account account)
        {
            Currency denomination = account.Denomination;
            IDictionary<string, decimal?> accountValues = AllAccountValues(account, denomination);
            decimal? realized = AccountValue(account, AccountItem.RealizedProfitLoss, denomination);
            decimal? grossRealized = AccountValue(account, AccountItem.GrossRealizedProfitLoss, denomination);
            decimal? unrealized = AccountValue(account, AccountItem.UnrealizedProfitLoss, denomination);
            return new AccountCaptureSource
            {
                AccountName = account.Name,
                ConnectionName = ConnectionName(account),
                DisplayName = PublicString(account, "DisplayName"),
                NetLiquidation = AccountValue(account, AccountItem.NetLiquidation, denomination),
                CashValue = AccountValue(account, AccountItem.CashValue, denomination),
                RealizedPnl = realized,
                GrossRealizedPnl = grossRealized,
                UnrealizedPnl = unrealized,
                TotalPnl = realized.HasValue && unrealized.HasValue ? realized + unrealized : null,
                // Read out of the enumerated account values rather than named
                // here. NinjaTrader's published AccountItem list does not mention
                // either, but a real install reports both — enumerating the enum
                // found WeeklyProfitLoss and TrailingMaxDrawdown alongside 29
                // others. Looking them up by name keeps this compiling against
                // versions whose enum lacks the members, and yields null there
                // instead of failing to build.
                WeeklyPnl = accountValues.TryGetValue("WeeklyProfitLoss", out decimal? weekly) ? weekly : null,
                TrailingMaxDrawdown = accountValues.TryGetValue("TrailingMaxDrawdown", out decimal? trailing) ? trailing : null,
                BuyingPower = AccountValue(account, AccountItem.BuyingPower, denomination),
                ExcessIntradayMargin = AccountValue(account, AccountItem.ExcessIntradayMargin, denomination),
                InitialMargin = AccountValue(account, AccountItem.InitialMargin, denomination),
                MaintenanceMargin = AccountValue(account, AccountItem.MaintenanceMargin, denomination),
                Currency = denomination.ToString(),
                Status = PublicString(account, "ConnectionStatus"),
                AccountValues = accountValues,
            };
        }

        /// <summary>
        /// Every AccountItem NinjaTrader will report, by enumerating the enum
        /// instead of naming values one at a time. The named properties above only
        /// cover a third of them, and a hand-picked list silently goes stale when
        /// NinjaTrader adds a value. Items a connection does not answer for are
        /// skipped rather than stored as null noise.
        /// </summary>
        private static IDictionary<string, decimal?> AllAccountValues(Account account, Currency denomination)
        {
            var values = new Dictionary<string, decimal?>(StringComparer.Ordinal);
            foreach (object item in Enum.GetValues(typeof(AccountItem)))
            {
                var accountItem = (AccountItem)item;
                decimal? value = AccountValue(account, accountItem, denomination);
                if (value.HasValue)
                    values[accountItem.ToString()] = value;
            }
            return values;
        }

        private static StrategyCaptureSource MapStrategy(Account account, StrategyBase strategy)
        {
            object position = strategy.Position;
            object instrument = strategy.Instruments == null
                ? null
                : strategy.Instruments.FirstOrDefault();
            return new StrategyCaptureSource
            {
                StrategyId = PublicString(strategy, "StrategyId", "Id") ?? String.Empty,
                StrategyName = strategy.Name,
                StrategyDisplayName = PublicString(strategy, "DisplayName") ?? strategy.Name,
                AccountName = account.Name,
                Instrument = PublicString(instrument, "FullName"),
                State = strategy.State.ToString(),
                Quantity = NullableDecimal(PublicValue(position, "Quantity")),
                Position = PublicString(position, "MarketPosition"),
                AveragePrice = NullableDecimal(PublicValue(position, "AveragePrice")),
                RealizedPnl = null,
                UnrealizedPnl = null,
                Enabled = true,
                Sync = NullableBoolean(PublicValue(strategy, "IsInSync", "Sync")),
                DataSeries = PublicString(strategy, "BarsPeriod", "DataSeries"),
                ConnectionName = ConnectionName(account),
                StartedAt = null,
                Parameters = ReadParameters(strategy),
                ExtraValues = ReadExtraValues(strategy),
            };
        }

        private static OrderCaptureSource MapOrder(
            Account account, Order order, StrategyAttributionMap attribution)
        {
            string type = order.OrderType.ToString();
            bool hasLimit = type == "Limit" || type == "StopLimit";
            bool hasStop = type == "StopMarket" || type == "StopLimit";
            // Null when no strategy on this account claims the order, which is
            // what every order carried before the lookup existed: a manual trade,
            // and an order whose strategy the platform will not name, both say
            // nothing here rather than something invented.
            StrategyAttribution strategy = attribution.ResolveOrder(order.OrderId);
            return new OrderCaptureSource
            {
                OrderId = order.OrderId ?? String.Empty,
                AccountName = account.Name,
                StrategyId = strategy?.StrategyId,
                StrategyName = strategy?.StrategyName,
                Instrument = order.Instrument == null ? String.Empty : order.Instrument.FullName,
                Action = order.OrderAction.ToString(),
                OrderType = type,
                Quantity = NullableDecimal(order.Quantity),
                Filled = NullableDecimal(order.Filled),
                Remaining = NullableDecimal(Math.Max(0, order.Quantity - order.Filled)),
                LimitPrice = hasLimit ? NullableDecimal(order.LimitPrice) : null,
                StopPrice = hasStop ? NullableDecimal(order.StopPrice) : null,
                AverageFillPrice = order.Filled > 0 ? NullableDecimal(order.AverageFillPrice) : null,
                State = order.OrderState.ToString(),
                Time = ToOffset(order.Time),
                Tif = order.TimeInForce.ToString(),
                Oco = String.IsNullOrWhiteSpace(order.Oco) ? null : order.Oco,
                Name = order.Name,
                NativeId = null,
                ExtraValues = ReadExtraValues(order),
            };
        }

        private static ExecutionCaptureSource MapExecution(
            Account account, Execution execution, StrategyAttributionMap attribution)
        {
            Order order = execution.Order;
            // A fill the strategy lists answers for itself; one it does not list
            // falls back to the order it filled. This is the field the CRM reads
            // to attribute an account day, and the one that was empty on 98% of
            // the automatic path's fills.
            StrategyAttribution strategy = attribution.ResolveExecution(
                execution.ExecutionId, execution.OrderId);
            return new ExecutionCaptureSource
            {
                ExecutionId = execution.ExecutionId ?? String.Empty,
                OrderId = execution.OrderId,
                AccountName = account.Name,
                StrategyId = strategy?.StrategyId,
                StrategyName = strategy?.StrategyName,
                Instrument = execution.Instrument == null ? String.Empty : execution.Instrument.FullName,
                Action = order == null ? String.Empty : order.OrderAction.ToString(),
                Quantity = NullableDecimal(execution.Quantity),
                Price = NullableDecimal(execution.Price),
                Time = ToOffset(execution.Time),
                MarketPosition = execution.MarketPosition.ToString(),
                EntryExit = null,
                Name = execution.Name,
                Commission = NullableDecimal(execution.Commission),
                Fee = null,
                Rate = NullableDecimal(execution.Rate),
                RealizedPnl = null,
                ConnectionName = ConnectionName(account),
                NativeId = null,
                ExtraValues = ReadExtraValues(execution),
            };
        }

        private static IEnumerable<StrategyParameterSource> ReadParameters(StrategyBase strategy)
        {
            var parameters = new List<StrategyParameterSource>();
            foreach (PropertyDescriptor property in TypeDescriptor.GetProperties(strategy))
            {
                if (property.Name == "Name" || property.Name == "DisplayName")
                    continue;
                object value;
                try
                {
                    value = property.GetValue(strategy);
                }
                catch
                {
                    value = new FailedParameterValue();
                }
                parameters.Add(new StrategyParameterSource(property.Name, value, property.IsBrowsable));
            }
            return parameters;
        }


        /// <summary>
        /// Every readable scalar property on a NinjaTrader object, by reflection,
        /// so a column the CRM does not name today is still captured. Reading is
        /// guarded per property: a strategy backed by a proprietary indicator can
        /// throw when a property is touched, and one bad property must not cost us
        /// the whole row. Only scalars are kept — following object graphs would
        /// pull in live collections and risk touching NinjaTrader state.
        /// </summary>
        private static IDictionary<string, object> ReadExtraValues(object source)
        {
            var values = new Dictionary<string, object>(StringComparer.Ordinal);
            if (source == null)
                return values;

            foreach (PropertyDescriptor property in TypeDescriptor.GetProperties(source))
            {
                object value;
                try
                {
                    value = property.GetValue(source);
                }
                catch
                {
                    continue;
                }

                object scalar = AsScalar(value);
                if (scalar != null)
                    values[property.Name] = scalar;
            }
            return values;
        }

        private static object AsScalar(object value)
        {
            if (value == null)
                return null;

            if (value is string text)
                return text.Length > 512 ? text.Substring(0, 512) : text;
            if (value is bool || value is int || value is long || value is short
                || value is byte || value is float || value is double || value is decimal)
                return value;
            if (value is DateTime dateTime)
                return dateTime.ToString("O", CultureInfo.InvariantCulture);
            if (value.GetType().IsEnum)
                return value.ToString();
            return null;
        }

        private static decimal? AccountValue(Account account, AccountItem item, Currency currency)
        {
            try
            {
                return NullableDecimal(account.Get(item, currency));
            }
            catch
            {
                return null;
            }
        }

        private static string ConnectionName(Account account)
        {
            return account.Connection == null || account.Connection.Options == null
                ? null
                : account.Connection.Options.Name;
        }

        private static object PublicValue(object source, params string[] names)
        {
            if (source == null)
                return null;
            PropertyDescriptorCollection properties = TypeDescriptor.GetProperties(source);
            foreach (string name in names)
            {
                PropertyDescriptor property = properties.Find(name, true);
                if (property == null)
                    continue;
                try
                {
                    return property.GetValue(source);
                }
                catch
                {
                    return null;
                }
            }
            return null;
        }

        /// <summary>
        /// The same read as PublicValue, through plain reflection, for a member
        /// TypeDescriptor does not list. A NinjaScript object can carry a custom
        /// type descriptor, which is how the platform shows a strategy's
        /// parameters and nothing else in its own grids, and a collection kept out
        /// of that view is still an ordinary public property on the type. Absent,
        /// ambiguous or unreadable, it is null here, exactly as PublicValue leaves
        /// a member that does not exist.
        /// </summary>
        private static object ReflectedValue(object source, string name)
        {
            if (source == null)
                return null;
            try
            {
                System.Reflection.PropertyInfo property = source.GetType().GetProperty(name);
                return property == null || !property.CanRead
                    ? null
                    : property.GetValue(source, null);
            }
            catch
            {
                return null;
            }
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

        private sealed class FailedParameterValue
        {
            public override string ToString()
            {
                throw new InvalidOperationException("The parameter value could not be read.");
            }
        }
    }
}
