using System;
using System.Linq;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Security;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class RedactedAgentStateTests
{
    [Fact]
    public void SerializationCanDescribePairingWithoutAcceptingADeviceToken()
    {
        const string machineId = "4a4f4ed0-2fb1-4d0f-aeaa-d4a44a730c1e";
        AgentOptions options = AgentOptions.CreateDefault() with
        {
            CrmBaseUrl = "https://crm.example.test",
            DeviceId = "device-1",
            ClientName = "Redacted Client",
        };

        RedactedAgentState state = RedactedAgentState.From(
            options,
            hasCredential: true,
            MachineIdentity.HashForDiagnostics(machineId));
        string json = JsonConvert.SerializeObject(state);

        Assert.Contains("\"hasCredential\":true", json);
        Assert.Contains("device-1", json);
        Assert.DoesNotContain(machineId, json, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain(
            state.GetType().GetProperties(),
            property => property.Name.Contains("token", StringComparison.OrdinalIgnoreCase)
                || property.Name.Contains("secret", StringComparison.OrdinalIgnoreCase));
    }
}
