using System;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32;

namespace Vincere.AutoExport.Agent.Security;

public interface IMachineGuidSource
{
    string ReadMachineGuid();
}

/// <summary>The machine's own name. Separated so a test can supply one.</summary>
public interface IMachineNameSource
{
    string ReadMachineName();
}

public sealed class EnvironmentMachineNameSource : IMachineNameSource
{
    public string ReadMachineName() => Environment.MachineName;
}

public static class MachineIdentity
{
    /* WHY THIS IS NOT JUST THE MachineGuid ANY MORE.
     *
     * The CRM enforces one active device per machine, and it decides what "a
     * machine" is from this string. It was the Windows MachineGuid alone, which
     * is only unique if every machine's Windows was installed separately.
     *
     * These VPSes are not. Two CAMs hit it on the same evening: one connected a
     * client and the next VPS he opened reported the machine as already
     * collecting for the client he had connected ten minutes earlier, and
     * another was blocked by a client belonging to a different CAM entirely. The
     * two refusals came from agents on different builds, 1.0.2 and 1.0.1, so
     * they were different machines. An image cloned without sysprep carries the
     * MachineGuid of the machine it was captured from, and a fleet built that
     * way is one machine as far as this was concerned. Every pairing then
     * blocked or displaced the one before it.
     *
     * The machine name is added because a provider that clones an image still
     * gives each box its own name, and reading it costs nothing and stores
     * nothing. It is not a secret: it never leaves the machine in the clear,
     * the server only ever sees an HMAC of it.
     *
     * THIS CHANGES EVERY EXISTING DEVICE'S IDENTITY. deviceAuth compares the
     * stored machine hash on every authenticated request, so a device paired
     * before this update authenticates as a different machine and has to be
     * paired again. That is the cost of the fix and it is paid once.
     */
    private const char ComponentSeparator = '|';

    public static string ReadNormalized(IMachineGuidSource source, IMachineNameSource nameSource = null)
    {
        ArgumentNullException.ThrowIfNull(source);
        string guid = Normalize(source.ReadMachineGuid());
        string name = NormalizeComponent(ReadName(nameSource));
        // Always the same shape, whether or not a name was readable, so the
        // identity of one machine cannot change between two calls.
        return guid + ComponentSeparator + name;
    }

    private static string ReadName(IMachineNameSource nameSource)
    {
        try
        {
            return (nameSource ?? new EnvironmentMachineNameSource()).ReadMachineName();
        }
        catch (Exception)
        {
            // A machine that cannot say its own name still has a MachineGuid,
            // and refusing to collect over this would be worse than the
            // collision it is here to avoid.
            return string.Empty;
        }
    }

    /// <summary>
    /// Trimmed, lowercased, and stripped of the separator and of control
    /// characters, so no name can forge a second component.
    /// </summary>
    public static string NormalizeComponent(string value)
    {
        string trimmed = (value ?? string.Empty).Trim().ToLowerInvariant();
        var builder = new StringBuilder(trimmed.Length);
        foreach (char character in trimmed)
        {
            if (character == ComponentSeparator || char.IsControl(character)) continue;
            builder.Append(character);
        }
        return builder.Length > 64 ? builder.ToString(0, 64) : builder.ToString();
    }

    public static string Normalize(string value)
    {
        string normalized = (value ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0 || normalized.Length > 256 || ContainsControlCharacter(normalized))
            throw new MachineIdentityException("machine_id_invalid", "The Windows machine identifier is invalid.");
        return normalized;
    }

    public static string HashForDiagnostics(string value)
    {
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(Normalize(value)));
        return Convert.ToHexString(digest).ToLowerInvariant();
    }

    private static bool ContainsControlCharacter(string value)
    {
        foreach (char character in value)
        {
            if (char.IsControl(character)) return true;
        }
        return false;
    }
}

[SupportedOSPlatform("windows")]
public sealed class WindowsMachineGuidSource : IMachineGuidSource
{
    public string ReadMachineGuid()
    {
        using RegistryKey key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Cryptography", writable: false);
        object value = key?.GetValue("MachineGuid", null, RegistryValueOptions.DoNotExpandEnvironmentNames);
        if (value is not string machineGuid)
            throw new MachineIdentityException("machine_id_unavailable", "The Windows machine identifier is unavailable.");
        return machineGuid;
    }
}

public sealed class MachineIdentityException : Exception
{
    public MachineIdentityException(string code, string message) : base(message)
    {
        Code = code;
    }

    public string Code { get; }
}
