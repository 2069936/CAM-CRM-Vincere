using System;
using Vincere.AutoExport.Agent.Security;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class MachineIdentityTests
{
    [Fact]
    public void NormalizationMatchesTheServerContract()
    {
        Assert.Equal(
            "{4a4f4ed0-2fb1-4d0f-aeaa-d4a44a730c1e}",
            MachineIdentity.Normalize("  {4A4F4ED0-2FB1-4D0F-AEAA-D4A44A730C1E}  "));
    }

    [Fact]
    public void InvalidMachineGuidReturnsStableCodeWithoutEchoingInput()
    {
        const string raw = "raw-sensitive\nidentifier";
        MachineIdentityException error = Assert.Throws<MachineIdentityException>(
            () => MachineIdentity.Normalize(raw));

        Assert.Equal("machine_id_invalid", error.Code);
        Assert.DoesNotContain(raw, error.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void DiagnosticHashIsStableAndDoesNotContainTheRawIdentifier()
    {
        const string machineId = "4a4f4ed0-2fb1-4d0f-aeaa-d4a44a730c1e";

        string first = MachineIdentity.HashForDiagnostics(machineId);

        Assert.Equal(64, first.Length);
        Assert.Equal(first, MachineIdentity.HashForDiagnostics(machineId.ToUpperInvariant()));
        Assert.DoesNotContain(machineId, first, StringComparison.OrdinalIgnoreCase);
    }
}
