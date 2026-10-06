using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Contracts.Tests
{
    /* THE WIRE CONTRACT WITH POST /api/ingest/strategies, held by the same fixture
     * the CRM route's own test embeds. Serialized here exactly as CrmClient
     * serializes it: JsonConvert with no settings, so nulls are written. */
    public sealed class StrategySampleV1Tests
    {
        public const string Fixture = @"{
  ""schemaVersion"": 1,
  ""sampledAt"": ""2026-10-06T10:10:02.5-04:00"",
  ""strategies"": [
    { ""accountName"": ""SIM-FIXTURE-1"", ""strategyId"": ""123456789"", ""strategyName"": ""0 - OGX-PF-2.4"", ""instrument"": ""MNQ 12-26"", ""realizedPnl"": -412.5, ""unrealizedPnl"": 37.5, ""restartedAt"": null },
    { ""accountName"": ""SIM-FIXTURE-1"", ""strategyId"": ""123456790"", ""strategyName"": ""1 - ALPHA-1.2"", ""instrument"": ""NQ 12-26"", ""realizedPnl"": null, ""unrealizedPnl"": null, ""restartedAt"": ""2026-10-06T09:50:01-04:00"" }
  ]
}";

        [Fact]
        public void A_sample_built_in_code_serializes_to_the_shared_fixture_nulls_included()
        {
            var sample = new StrategySampleV1
            {
                SchemaVersion = 1,
                SampledAt = new DateTimeOffset(2026, 10, 6, 10, 10, 2, 500, TimeSpan.FromHours(-4)),
                Strategies = new List<StrategySampleRowV1>
                {
                    new StrategySampleRowV1
                    {
                        AccountName = "SIM-FIXTURE-1",
                        StrategyId = "123456789",
                        StrategyName = "0 - OGX-PF-2.4",
                        Instrument = "MNQ 12-26",
                        RealizedPnl = -412.5m,
                        UnrealizedPnl = 37.5m,
                        RestartedAt = null,
                    },
                    new StrategySampleRowV1
                    {
                        AccountName = "SIM-FIXTURE-1",
                        StrategyId = "123456790",
                        StrategyName = "1 - ALPHA-1.2",
                        Instrument = "NQ 12-26",
                        RealizedPnl = null,
                        UnrealizedPnl = null,
                        RestartedAt = new DateTimeOffset(2026, 10, 6, 9, 50, 1, TimeSpan.FromHours(-4)),
                    },
                },
            };

            JToken written = Parse(JsonConvert.SerializeObject(sample, Formatting.None));

            Assert.True(
                JToken.DeepEquals(Parse(Fixture), written),
                "Serialized: " + written.ToString(Formatting.None));
        }

        [Fact]
        public void The_fixture_round_trips_unchanged()
        {
            StrategySampleV1 sample = JsonConvert.DeserializeObject<StrategySampleV1>(Fixture);

            Assert.True(JToken.DeepEquals(Parse(Fixture), Parse(JsonConvert.SerializeObject(sample))));
        }

        /* NULL IS NOT MEASURED, AND IT HAS TO REACH THE CRM AS A NULL. A missing key
         * would read the same to the route, but an omitted member is exactly what a
         * serializer setting changed somewhere else would silently produce, and the
         * fixture says the nulls are written. */
        [Fact]
        public void An_unmeasured_row_writes_its_nulls_rather_than_omitting_them()
        {
            var row = new StrategySampleRowV1
            {
                AccountName = "SIM-FIXTURE-1",
                StrategyId = "1",
                StrategyName = "0 - OGX-PF-2.4",
                Instrument = "MNQ 12-26",
            };

            JObject written = (JObject)Parse(JsonConvert.SerializeObject(row));

            Assert.Equal(JTokenType.Null, written["realizedPnl"].Type);
            Assert.Equal(JTokenType.Null, written["unrealizedPnl"].Type);
            Assert.Equal(JTokenType.Null, written["restartedAt"].Type);
        }

        /* AN OLD ADD-ON'S REPLY, AND A NEW ADD-ON'S REPLY TO AN OLD AGENT. Neither
         * side has to know about the other's members for the pipe to keep working. */
        [Fact]
        public void A_capture_response_without_a_strategy_sample_still_reads()
        {
            CaptureResponse response = JsonConvert.DeserializeObject<CaptureResponse>(
                @"{""ok"":false,""requestId"":""7f6f2b0e-2f6c-4a52-9b1c-0f6c1d4d2a11"",""snapshot"":null,""errorCode"":""invalid_request"",""message"":""x""}");

            Assert.False(response.Ok);
            Assert.Null(response.StrategySample);
            Assert.Equal("invalid_request", response.ErrorCode);
        }

        [Fact]
        public void A_response_with_no_strategy_sample_does_not_carry_the_member()
        {
            string json = JsonConvert.SerializeObject(new CaptureResponse
            {
                Ok = true,
                RequestId = Guid.NewGuid(),
                Sample = new AccountSampleV1 { SchemaVersion = 1, Accounts = new List<AccountSampleRowV1>() },
            });

            Assert.DoesNotContain("strategySample", json, StringComparison.Ordinal);
        }

        /* THE ACCOUNT SAMPLE IS UNTOUCHED. PR 68 agents refuse an account sample
         * whose schemaVersion is not 1 and drop every account row, so neither its
         * members nor its version may move to make room for strategies. */
        [Fact]
        public void The_account_sample_keeps_its_three_members_and_its_rows_keep_theirs()
        {
            var sample = new AccountSampleV1
            {
                SchemaVersion = 1,
                SampledAt = new DateTimeOffset(2026, 10, 6, 10, 10, 2, TimeSpan.FromHours(-4)),
                Accounts = new List<AccountSampleRowV1> { new AccountSampleRowV1 { AccountName = "SIM-FIXTURE-1" } },
            };

            JObject written = (JObject)Parse(JsonConvert.SerializeObject(sample));

            Assert.Equal(
                new[] { "accounts", "sampledAt", "schemaVersion" },
                written.Properties().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal));
            Assert.Equal(1, written.Value<int>("schemaVersion"));
            Assert.Equal(
                new[]
                {
                    "accountName", "connected", "connectionName", "enabledStrategyCount",
                    "realizedPnl", "status", "strategyCount", "totalPnl", "unrealizedPnl",
                },
                ((JObject)written["accounts"][0]).Properties().Select(p => p.Name).OrderBy(n => n, StringComparer.Ordinal));
        }

        private static JToken Parse(string json)
        {
            using (var reader = new JsonTextReader(new StringReader(json)) { DateParseHandling = DateParseHandling.None })
                return JToken.Load(reader);
        }
    }
}
