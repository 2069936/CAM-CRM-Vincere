using System;
using System.IO;
using System.Linq;
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

    private sealed class FakeInstallId : IInstallIdSource
    {
        public string Value { get; init; } = "11111111-1111-4111-8111-111111111111";
        public Exception Throws { get; init; }
        public string ReadInstallId() => Throws == null ? Value : throw Throws;
    }

    [Fact]
    public void TwoClonesOfOneImageAreTwoMachines()
    {
        // THE REAL FLEET, MEASURED. Two VPSes belonging to different clients
        // both report MachineGuid 67731bcc-9934-4bec-b548-0fd0e57c20a5 AND are
        // both named SERVER, because the image was deployed without sysprep.
        // Neither the guid nor the name separates them. Only something this
        // installation made can.
        var guid = new FakeGuid { Value = "{67731BCC-9934-4BEC-B548-0FD0E57C20A5}" };
        var name = new FakeName { Value = "SERVER" };
        string first = MachineIdentity.ReadNormalized(guid, name, new FakeInstallId { Value = "install-a" });
        string second = MachineIdentity.ReadNormalized(guid, name, new FakeInstallId { Value = "install-b" });
        Assert.NotEqual(first, second);
    }

    [Fact]
    public void KeepsItsShapeWhenTheInstallIdCannotBeRead()
    {
        // No writable ProgramData. The identity is then exactly as strong as it
        // was before the install id existed, which is weak, but the agent still
        // collects. The shape is fixed so one machine cannot answer two ways.
        string thrown = MachineIdentity.ReadNormalized(
            new FakeGuid(), new FakeName(), new FakeInstallId { Throws = new UnauthorizedAccessException() });
        string blank = MachineIdentity.ReadNormalized(
            new FakeGuid(), new FakeName(), new FakeInstallId { Value = "  " });
        Assert.Equal(blank, thrown);
        Assert.EndsWith("|", thrown);
    }

    [Fact]
    public void TheInstallIdIsWrittenOnceAndReadBackAfterwards()
    {
        string directory = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        string path = Path.Combine(directory, "install-id");
        try
        {
            FileInstallIdSource source = new(path);
            string first = source.ReadInstallId();
            string second = source.ReadInstallId();
            Assert.False(string.IsNullOrWhiteSpace(first));
            Assert.Equal(first, second);
            Assert.Equal(first, new FileInstallIdSource(path).ReadInstallId());
        }
        finally
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void TwoInstallsProduceDifferentIds()
    {
        string root = Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"));
        try
        {
            string a = new FileInstallIdSource(Path.Combine(root, "a", "install-id")).ReadInstallId();
            string b = new FileInstallIdSource(Path.Combine(root, "b", "install-id")).ReadInstallId();
            Assert.NotEqual(a, b);
        }
        finally
        {
            if (Directory.Exists(root)) Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void TheInstallIdLivesBesideTheSettingsTheInstallerPreserves()
    {
        // ProgramData\Vincere\AutoExport, the same folder as config.json and
        // secret.bin, which install-agent.ps1 keeps across a reinstall. If it
        // went anywhere else, every update would change what machine this is.
        string path = FileInstallIdSource.DefaultPath();
        Assert.EndsWith(Path.Combine("Vincere", "AutoExport", "install-id"), path);
    }

    [Fact]
    public void TheSameMachineAnswersTheSameEveryTime()
    {
        var guid = new FakeGuid();
        var name = new FakeName();
        Assert.Equal(
            MachineIdentity.ReadNormalized(guid, name, new FakeInstallId()),
            MachineIdentity.ReadNormalized(guid, name, new FakeInstallId()));
    }

    [Fact]
    public void KeepsItsShapeWhenTheNameCannotBeRead()
    {
        // A machine that cannot say its own name still has a MachineGuid, and
        // refusing to collect over this would be worse than the collision. The
        // shape stays fixed so one machine cannot answer two different ways.
        string thrown = MachineIdentity.ReadNormalized(
            new FakeGuid(), new FakeName { Throws = new InvalidOperationException("no name") }, new FakeInstallId());
        string blank = MachineIdentity.ReadNormalized(
            new FakeGuid(), new FakeName { Value = "   " }, new FakeInstallId());
        Assert.Equal(blank, thrown);
        Assert.Contains("|", thrown);
    }

    [Fact]
    public void CarriesTheMachineGuidUnchanged()
    {
        Assert.StartsWith("4a4f4ed0-2fb1-4d0f-aeaa-d4a44a730c1e", MachineIdentity.ReadNormalized(
            new FakeGuid { Value = "  4A4F4ED0-2FB1-4D0F-AEAA-D4A44A730C1E  " }, new FakeName(), new FakeInstallId()));
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
            new FakeGuid(), new FakeName { Value = new string('n', 400) }, new FakeInstallId());
        Assert.True(identity.Length < 256);
        Assert.Equal(64, MachineIdentity.NormalizeComponent(new string('n', 400)).Length);
    }

    [Fact]
    public void RedactionCoversEveryComponentAndNotJustTheJoin()
    {
        // An error message quoting "the machine id" almost always quotes ONE
        // component, and usually the bare MachineGuid. Redacting only the joined
        // value silently stopped scrubbing it.
        string[] terms = MachineIdentity.RedactionTerms("the-guid|server|install-abc").ToArray();
        Assert.Contains("the-guid", terms);
        Assert.Contains("server", terms);
        Assert.Contains("install-abc", terms);
        Assert.Contains("the-guid|server|install-abc", terms);
    }

    [Fact]
    public void RedactsTheLongestTermFirstSoNothingIsLeftBehind()
    {
        // Replacing "server" before "server-01" would leave "-01" sitting in the
        // message.
        string[] terms = MachineIdentity.RedactionTerms("guid|server|server-01").ToArray();
        Assert.True(terms.Length >= 2);
        for (int index = 1; index < terms.Length; index++)
            Assert.True(terms[index - 1].Length >= terms[index].Length);
    }

    [Fact]
    public void RedactionSkipsEmptyComponents()
    {
        // A machine with no readable name must not put "" on the redaction list,
        // which would match everywhere.
        string[] terms = MachineIdentity.RedactionTerms("guid||").ToArray();
        Assert.DoesNotContain(string.Empty, terms);
        Assert.Contains("guid", terms);
        Assert.Empty(MachineIdentity.RedactionTerms(null));
        Assert.Empty(MachineIdentity.RedactionTerms("   "));
    }
}
