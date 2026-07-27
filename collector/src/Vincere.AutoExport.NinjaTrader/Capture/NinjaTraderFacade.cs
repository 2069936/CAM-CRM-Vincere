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
                List<Order> orders;
                lock (account.Orders)
                    orders = account.Orders.ToList();
                rows.AddRange(orders.Select(order => MapOrder(account, order)));
            }
            return rows;
        }

        public IEnumerable<ExecutionCaptureSource> ReadExecutions()
        {
            var rows = new List<ExecutionCaptureSource>();
            foreach (Account account in SnapshotAccounts())
            {
                List<Execution> executions;
                lock (account.Executions)
                    executions = account.Executions.ToList();
                rows.AddRange(executions.Select(execution => MapExecution(account, execution)));
            }
            return rows;
        }

        private static List<Account> SnapshotAccounts()
        {
            lock (Account.All)
                return Account.All.ToList();
        }

        private static AccountCaptureSource MapAccount(Account account)
        {
            Currency denomination = account.Denomination;
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
                WeeklyPnl = null,
                TrailingMaxDrawdown = null,
                BuyingPower = AccountValue(account, AccountItem.BuyingPower, denomination),
                ExcessIntradayMargin = AccountValue(account, AccountItem.ExcessIntradayMargin, denomination),
                InitialMargin = AccountValue(account, AccountItem.InitialMargin, denomination),
                MaintenanceMargin = AccountValue(account, AccountItem.MaintenanceMargin, denomination),
                Currency = denomination.ToString(),
                Status = PublicString(account, "ConnectionStatus"),
            };
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
            };
        }

        private static OrderCaptureSource MapOrder(Account account, Order order)
        {
            string type = order.OrderType.ToString();
            bool hasLimit = type == "Limit" || type == "StopLimit";
            bool hasStop = type == "StopMarket" || type == "StopLimit";
            return new OrderCaptureSource
            {
                OrderId = order.OrderId ?? String.Empty,
                AccountName = account.Name,
                StrategyId = null,
                StrategyName = null,
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
            };
        }

        private static ExecutionCaptureSource MapExecution(Account account, Execution execution)
        {
            Order order = execution.Order;
            return new ExecutionCaptureSource
            {
                ExecutionId = execution.ExecutionId ?? String.Empty,
                OrderId = execution.OrderId,
                AccountName = account.Name,
                StrategyId = null,
                StrategyName = null,
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
