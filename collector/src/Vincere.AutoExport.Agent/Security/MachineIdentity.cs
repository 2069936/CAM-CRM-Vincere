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

public static class MachineIdentity
{
    public static string ReadNormalized(IMachineGuidSource source)
    {
        ArgumentNullException.ThrowIfNull(source);
        return Normalize(source.ReadMachineGuid());
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
