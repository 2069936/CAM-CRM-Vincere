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

    /* ONE MACHINE, DECIDED BY MORE THAN THE MachineGuid.
     *
     * The CRM enforces one active device per machine and decides what a machine
     * is from this string. Two CAMs were blocked on the same evening by devices
     * on other VPSes, from agents on different builds, which is what a fleet
     * cloned from one Windows image looks like. */

    private sealed class FakeGuid : IMachineGuidSource
    {
        public string Value { get; init; } = "{4A4F4ED0-2FB1-4D0F-AEAA-D4A44A730C1E}";
        public string ReadMachineGuid() => Value;
    }

    private sealed class FakeName : IMachineNameSource
    {
        public string Value { get; init; } = "VPS-ONE";
        public Exception Throws { get; init; }
        public string ReadMachineName() => Throws == null ? Value : throw Throws;
    }

    [Fact]
    public void TwoClonesOfOneImageAreTwoMachines()
    {
        // THE CASE THIS EXISTS FOR. Same MachineGuid, because the image was
        // cloned without sysprep. Different boxes, so different names.
        var guid = new FakeGuid();
        string first = MachineIdentity.ReadNormalized(guid, new FakeName { Value = "VPS-ONE" });
        string second = MachineIdentity.ReadNormalized(guid, new FakeName { Value = "VPS-TWO" });
        Assert.NotEqual(first, second);
    }

    [Fact]
    public void TheSameMachineAnswersTheSameEveryTime()
    {
        var guid = new FakeGuid();
        var name = new FakeName();
        Assert.Equal(
            MachineIdentity.ReadNormalized(guid, name),
            MachineIdentity.ReadNormalized(guid, name));
    }

    [Fact]
    public void KeepsItsShapeWhenTheNameCannotBeRead()
    {
        // A machine that cannot say its own name still has a MachineGuid, and
        // refusing to collect over this would be worse than the collision. The
        // shape stays fixed so one machine cannot answer two different ways.
        string thrown = MachineIdentity.ReadNormalized(
            new FakeGuid(), new FakeName { Throws = new InvalidOperationException("no name") });
        string blank = MachineIdentity.ReadNormalized(new FakeGuid(), new FakeName { Value = "   " });
        Assert.Equal(blank, thrown);
        Assert.EndsWith("|", thrown);
    }

    [Fact]
    public void CarriesTheMachineGuidUnchanged()
    {
        Assert.StartsWith("4a4f4ed0-2fb1-4d0f-aeaa-d4a44a730c1e", MachineIdentity.ReadNormalized(
            new FakeGuid { Value = "  4A4F4ED0-2FB1-4D0F-AEAA-D4A44A730C1E  " }, new FakeName()));
    }

    [Fact]
    public void ANameCannotForgeASecondComponent()
    {
        // The separator is stripped, so a machine named with one cannot make
        // itself look like a different guid and name pair.
        Assert.Equal("vpsone", MachineIdentity.NormalizeComponent("VPS|ONE"));
        Assert.Equal("vpsone", MachineIdentity.NormalizeComponent("  vps\u0007one  "));
    }

    [Fact]
    public void BoundsTheNameSoTheWholeIdentityStaysAcceptable()
    {
        // The server refuses a machine id over 256 characters.
        string identity = MachineIdentity.ReadNormalized(
            new FakeGuid(), new FakeName { Value = new string('n', 400) });
        Assert.True(identity.Length < 256);
        Assert.Equal(64, MachineIdentity.NormalizeComponent(new string('n', 400)).Length);
    }
}
