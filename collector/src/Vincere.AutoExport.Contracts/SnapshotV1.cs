using System;
using System.Collections.Generic;
using Newtonsoft.Json;

namespace Vincere.AutoExport.Contracts
{
    public sealed class AutoExportSnapshotV1
    {
        [JsonProperty("schemaVersion")]
        public int SchemaVersion { get; set; }

        [JsonProperty("captureId")]
        public Guid CaptureId { get; set; }

        [JsonProperty("capturedAt")]
        public DateTimeOffset CapturedAt { get; set; }

        [JsonProperty("tradingDate")]
        public string TradingDate { get; set; }

        [JsonProperty("timeZone")]
        public string TimeZone { get; set; }

        [JsonProperty("source")]
        public SourceMetadataV1 Source { get; set; }

        [JsonProperty("accounts")]
        public IList<AccountRowV1> Accounts { get; set; }

        [JsonProperty("strategies")]
        public IList<StrategyRowV1> Strategies { get; set; }

        [JsonProperty("orders")]
        public IList<OrderRowV1> Orders { get; set; }

        [JsonProperty("executions")]
        public IList<ExecutionRowV1> Executions { get; set; }
    }

    public sealed class SourceMetadataV1
    {
        [JsonProperty("machineId")]
        public string MachineId { get; set; }

        [JsonProperty("agentVersion")]
        public string AgentVersion { get; set; }

        [JsonProperty("addonVersion")]
        public string AddonVersion { get; set; }

        [JsonProperty("ninjaTraderVersion")]
        public string NinjaTraderVersion { get; set; }
    }

    public sealed class AccountRowV1
    {
        [JsonProperty("accountName")]
        public string AccountName { get; set; }

        [JsonProperty("connectionName")]
        public string ConnectionName { get; set; }

        [JsonProperty("displayName")]
        public string DisplayName { get; set; }

        [JsonProperty("netLiquidation")]
        public decimal? NetLiquidation { get; set; }

        [JsonProperty("cashValue")]
        public decimal? CashValue { get; set; }

        [JsonProperty("realizedPnl")]
        public decimal? RealizedPnl { get; set; }

        [JsonProperty("grossRealizedPnl")]
        public decimal? GrossRealizedPnl { get; set; }

        [JsonProperty("unrealizedPnl")]
        public decimal? UnrealizedPnl { get; set; }

        [JsonProperty("totalPnl")]
        public decimal? TotalPnl { get; set; }

        [JsonProperty("weeklyPnl")]
        public decimal? WeeklyPnl { get; set; }

        [JsonProperty("trailingMaxDrawdown")]
        public decimal? TrailingMaxDrawdown { get; set; }

        [JsonProperty("buyingPower")]
        public decimal? BuyingPower { get; set; }

        [JsonProperty("excessIntradayMargin")]
        public decimal? ExcessIntradayMargin { get; set; }

        [JsonProperty("initialMargin")]
        public decimal? InitialMargin { get; set; }

        [JsonProperty("maintenanceMargin")]
        public decimal? MaintenanceMargin { get; set; }

        [JsonProperty("currency")]
        public string Currency { get; set; }

        [JsonProperty("status")]
        public string Status { get; set; }
    }

    public sealed class StrategyRowV1
    {
        [JsonProperty("strategyId")]
        public string StrategyId { get; set; }

        [JsonProperty("strategyName")]
        public string StrategyName { get; set; }

        [JsonProperty("strategyDisplayName")]
        public string StrategyDisplayName { get; set; }

        [JsonProperty("accountName")]
        public string AccountName { get; set; }

        [JsonProperty("instrument")]
        public string Instrument { get; set; }

        [JsonProperty("state")]
        public string State { get; set; }

        [JsonProperty("quantity")]
        public decimal? Quantity { get; set; }

        [JsonProperty("position")]
        public string Position { get; set; }

        [JsonProperty("averagePrice")]
        public decimal? AveragePrice { get; set; }

        [JsonProperty("realizedPnl")]
        public decimal? RealizedPnl { get; set; }

        [JsonProperty("unrealizedPnl")]
        public decimal? UnrealizedPnl { get; set; }

        [JsonProperty("enabled")]
        public bool? Enabled { get; set; }

        [JsonProperty("sync")]
        public bool? Sync { get; set; }

        [JsonProperty("dataSeries")]
        public string DataSeries { get; set; }

        [JsonProperty("connectionName")]
        public string ConnectionName { get; set; }

        [JsonProperty("startedAt")]
        public DateTimeOffset? StartedAt { get; set; }

        [JsonProperty("parameters")]
        public IDictionary<string, object> Parameters { get; set; }

        [JsonProperty("parameterCaptureStatus")]
        public string ParameterCaptureStatus { get; set; }
    }

    public sealed class OrderRowV1
    {
        [JsonProperty("orderId")]
        public string OrderId { get; set; }

        [JsonProperty("accountName")]
        public string AccountName { get; set; }

        [JsonProperty("strategyId")]
        public string StrategyId { get; set; }

        [JsonProperty("strategyName")]
        public string StrategyName { get; set; }

        [JsonProperty("instrument")]
        public string Instrument { get; set; }

        [JsonProperty("action")]
        public string Action { get; set; }

        [JsonProperty("orderType")]
        public string OrderType { get; set; }

        [JsonProperty("quantity")]
        public decimal? Quantity { get; set; }

        [JsonProperty("filled")]
        public decimal? Filled { get; set; }

        [JsonProperty("remaining")]
        public decimal? Remaining { get; set; }

        [JsonProperty("limitPrice")]
        public decimal? LimitPrice { get; set; }

        [JsonProperty("stopPrice")]
        public decimal? StopPrice { get; set; }

        [JsonProperty("averageFillPrice")]
        public decimal? AverageFillPrice { get; set; }

        [JsonProperty("state")]
        public string State { get; set; }

        [JsonProperty("time")]
        public DateTimeOffset? Time { get; set; }

        [JsonProperty("tif")]
        public string Tif { get; set; }

        [JsonProperty("oco")]
        public string Oco { get; set; }

        [JsonProperty("name")]
        public string Name { get; set; }

        [JsonProperty("nativeId")]
        public string NativeId { get; set; }
    }

    public sealed class ExecutionRowV1
    {
        [JsonProperty("executionId")]
        public string ExecutionId { get; set; }

        [JsonProperty("orderId")]
        public string OrderId { get; set; }

        [JsonProperty("accountName")]
        public string AccountName { get; set; }

        [JsonProperty("strategyId")]
        public string StrategyId { get; set; }

        [JsonProperty("strategyName")]
        public string StrategyName { get; set; }

        [JsonProperty("instrument")]
        public string Instrument { get; set; }

        [JsonProperty("action")]
        public string Action { get; set; }

        [JsonProperty("quantity")]
        public decimal? Quantity { get; set; }

        [JsonProperty("price")]
        public decimal? Price { get; set; }

        [JsonProperty("time")]
        public DateTimeOffset Time { get; set; }

        [JsonProperty("marketPosition")]
        public string MarketPosition { get; set; }

        [JsonProperty("entryExit")]
        public string EntryExit { get; set; }

        [JsonProperty("name")]
        public string Name { get; set; }

        [JsonProperty("commission")]
        public decimal? Commission { get; set; }

        [JsonProperty("fee")]
        public decimal? Fee { get; set; }

        [JsonProperty("rate")]
        public decimal? Rate { get; set; }

        [JsonProperty("realizedPnl")]
        public decimal? RealizedPnl { get; set; }

        [JsonProperty("connectionName")]
        public string ConnectionName { get; set; }

        [JsonProperty("nativeId")]
        public string NativeId { get; set; }
    }
}
