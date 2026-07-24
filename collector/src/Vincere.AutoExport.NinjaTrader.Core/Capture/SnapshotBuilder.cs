using System;
using System.Collections.Generic;
using System.Linq;
using Vincere.AutoExport.Contracts;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{
    public sealed class SnapshotCaptureException : Exception
    {
        public SnapshotCaptureException(string section)
            : base("NinjaTrader could not capture the " + section + " section.")
        {
            Code = "section_capture_failed";
            Section = section;
        }

        public string Code { get; private set; }
        public string Section { get; private set; }
    }

    public sealed class SnapshotBuilder
    {
        private readonly INinjaTraderFacade facade;

        public SnapshotBuilder(INinjaTraderFacade facade)
        {
            this.facade = facade ?? throw new ArgumentNullException(nameof(facade));
        }

        public AutoExportSnapshotV1 Build(SnapshotBuildContext context)
        {
            if (context == null) throw new ArgumentNullException(nameof(context));

            List<AccountCaptureSource> accounts = SnapshotSection("accounts", facade.ReadAccounts);
            List<StrategyCaptureSource> strategies = SnapshotSection("strategies", facade.ReadStrategies);
            List<OrderCaptureSource> orders = SnapshotSection("orders", facade.ReadOrders);
            List<ExecutionCaptureSource> executions = SnapshotSection("executions", facade.ReadExecutions);

            return new AutoExportSnapshotV1
            {
                SchemaVersion = 1,
                CaptureId = context.CaptureId,
                CapturedAt = context.CapturedAt,
                TradingDate = context.TradingDate,
                TimeZone = "America/New_York",
                Source = new SourceMetadataV1
                {
                    MachineId = null,
                    AgentVersion = null,
                    AddonVersion = context.AddonVersion,
                    NinjaTraderVersion = context.NinjaTraderVersion,
                },
                Accounts = MapSection("accounts", accounts, MapAccount),
                Strategies = MapSection("strategies", strategies, MapStrategy),
                Orders = MapSection("orders", orders, MapOrder),
                Executions = MapSection("executions", executions, MapExecution),
            };
        }

        private static List<T> SnapshotSection<T>(string section, Func<IEnumerable<T>> read)
        {
            try
            {
                IEnumerable<T> values = read();
                return values == null ? new List<T>() : values.ToList();
            }
            catch
            {
                throw new SnapshotCaptureException(section);
            }
        }

        private static List<TResult> MapSection<TSource, TResult>(
            string section,
            IEnumerable<TSource> sources,
            Func<TSource, TResult> map)
        {
            try
            {
                return sources.Select(map).ToList();
            }
            catch
            {
                throw new SnapshotCaptureException(section);
            }
        }

        private static AccountRowV1 MapAccount(AccountCaptureSource source)
        {
            return new AccountRowV1
            {
                AccountName = source.AccountName,
                ConnectionName = source.ConnectionName,
                DisplayName = source.DisplayName,
                NetLiquidation = source.NetLiquidation,
                CashValue = source.CashValue,
                RealizedPnl = source.RealizedPnl,
                GrossRealizedPnl = source.GrossRealizedPnl,
                UnrealizedPnl = source.UnrealizedPnl,
                TotalPnl = source.TotalPnl,
                WeeklyPnl = source.WeeklyPnl,
                TrailingMaxDrawdown = source.TrailingMaxDrawdown,
                BuyingPower = source.BuyingPower,
                ExcessIntradayMargin = source.ExcessIntradayMargin,
                InitialMargin = source.InitialMargin,
                MaintenanceMargin = source.MaintenanceMargin,
                Currency = source.Currency,
                Status = source.Status,
            };
        }

        private static StrategyRowV1 MapStrategy(StrategyCaptureSource source)
        {
            StrategyParameterCapture parameters = StrategyParameterReader.Read(source.Parameters);
            return new StrategyRowV1
            {
                StrategyId = source.StrategyId,
                StrategyName = source.StrategyName,
                StrategyDisplayName = source.StrategyDisplayName,
                AccountName = source.AccountName,
                Instrument = source.Instrument,
                State = source.State,
                Quantity = source.Quantity,
                Position = source.Position,
                AveragePrice = source.AveragePrice,
                RealizedPnl = source.RealizedPnl,
                UnrealizedPnl = source.UnrealizedPnl,
                Enabled = source.Enabled,
                Sync = source.Sync,
                DataSeries = source.DataSeries,
                ConnectionName = source.ConnectionName,
                StartedAt = source.StartedAt,
                Parameters = parameters.Values,
                ParameterCaptureStatus = parameters.Status,
            };
        }

        private static OrderRowV1 MapOrder(OrderCaptureSource source)
        {
            return new OrderRowV1
            {
                OrderId = source.OrderId,
                AccountName = source.AccountName,
                StrategyId = source.StrategyId,
                StrategyName = source.StrategyName,
                Instrument = source.Instrument,
                Action = source.Action,
                OrderType = source.OrderType,
                Quantity = source.Quantity,
                Filled = source.Filled,
                Remaining = source.Remaining,
                LimitPrice = source.LimitPrice,
                StopPrice = source.StopPrice,
                AverageFillPrice = source.AverageFillPrice,
                State = source.State,
                Time = source.Time,
                Tif = source.Tif,
                Oco = source.Oco,
                Name = source.Name,
                NativeId = source.NativeId,
            };
        }

        private static ExecutionRowV1 MapExecution(ExecutionCaptureSource source)
        {
            return new ExecutionRowV1
            {
                ExecutionId = source.ExecutionId,
                OrderId = source.OrderId,
                AccountName = source.AccountName,
                StrategyId = source.StrategyId,
                StrategyName = source.StrategyName,
                Instrument = source.Instrument,
                Action = source.Action,
                Quantity = source.Quantity,
                Price = source.Price,
                Time = source.Time,
                MarketPosition = source.MarketPosition,
                EntryExit = source.EntryExit,
                Name = source.Name,
                Commission = source.Commission,
                Fee = source.Fee,
                Rate = source.Rate,
                RealizedPnl = source.RealizedPnl,
                ConnectionName = source.ConnectionName,
                NativeId = source.NativeId,
            };
        }
    }
}
