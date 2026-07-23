using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Newtonsoft.Json.Serialization;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Contracts.Tests
{
    public sealed class SnapshotSerializationTests
    {
        [Fact]
        public void SnapshotV1_round_trip_preserves_the_canonical_fixture_json_shape()
        {
            var fixtureJson = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "snapshot-v1.json"));
            var snapshot = JsonConvert.DeserializeObject<AutoExportSnapshotV1>(fixtureJson);
            var serializedJson = JsonConvert.SerializeObject(
                snapshot,
                new JsonSerializerSettings
                {
                    ContractResolver = new DefaultContractResolver
                    {
                        NamingStrategy = new CamelCaseNamingStrategy
                        {
                            ProcessDictionaryKeys = false,
                        },
                    },
                    NullValueHandling = NullValueHandling.Include,
                });

            AssertJsonShapeEqual(JToken.Parse(fixtureJson), JToken.Parse(serializedJson), "$");
        }

        private static void AssertJsonShapeEqual(JToken expected, JToken actual, string path)
        {
            Assert.True(
                AreSameJsonShapeType(expected, actual),
                path + " expected " + expected.Type + " but was " + actual.Type);

            var expectedObject = expected as JObject;
            if (expectedObject != null)
            {
                var actualObject = Assert.IsType<JObject>(actual);
                Assert.Equal(expectedObject.Properties().Count(), actualObject.Properties().Count());
                foreach (var property in expectedObject.Properties())
                {
                    var actualProperty = actualObject.Property(property.Name);
                    Assert.True(actualProperty != null, path + "." + property.Name + " is missing");
                    AssertJsonShapeEqual(property.Value, actualProperty.Value, path + "." + property.Name);
                }

                return;
            }

            var expectedArray = expected as JArray;
            if (expectedArray != null)
            {
                var actualArray = Assert.IsType<JArray>(actual);
                Assert.Equal(expectedArray.Count, actualArray.Count);
                for (var index = 0; index < expectedArray.Count; index++)
                {
                    AssertJsonShapeEqual(expectedArray[index], actualArray[index], path + "[" + index + "]");
                }
            }
        }

        private static bool AreSameJsonShapeType(JToken expected, JToken actual)
        {
            return expected.Type == actual.Type || (IsNumber(expected) && IsNumber(actual));
        }

        private static bool IsNumber(JToken token)
        {
            return token.Type == JTokenType.Integer || token.Type == JTokenType.Float;
        }
    }
}
