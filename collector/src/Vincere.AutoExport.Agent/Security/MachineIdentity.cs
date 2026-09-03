using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
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

/// <summary>An identifier belonging to this installation and no other.</summary>
public interface IInstallIdSource
{
    string ReadInstallId();
}

/* THE COMPONENT THAT DOES NOT DEPEND ON THE HOSTING PROVIDER.
 *
 * The MachineGuid was not unique: two VPSes belonging to different clients both
 * reported 67731bcc-9934-4bec-b548-0fd0e57c20a5, because the fleet is deployed
 * from one Windows image without sysprep. Adding the machine name did not help
 * either: both of those boxes are also named SERVER. Measured on the machines,
 * not assumed.
 *
 * So the identity needs one component that no image can carry, and the only way
 * to get one is to make it here, on first use, and keep it. A value written by
 * this installation is different in every installation by construction.
 *
 * It lives in ProgramData beside config.json and secret.bin, which the installer
 * preserves across a reinstall, so updating the agent does not change what
 * machine it claims to be. It is not a secret and it is not a credential: it
 * identifies a machine, it does not authorise anything, and the server only ever
 * sees an HMAC of it.
 *
 * A machine imaged AFTER the agent was installed still carries this, and that is
 * correct: such a clone also carries the device credential, so it genuinely is
 * the same device as far as anything here can tell.
 */
public sealed class FileInstallIdSource : IInstallIdSource
{
    private readonly string path;

    public FileInstallIdSource(string path = null)
    {
        this.path = string.IsNullOrWhiteSpace(path) ? DefaultPath() : path;
    }

    public static string DefaultPath()
    {
        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "Vincere",
            "AutoExport",
            "install-id");
    }

    public string ReadInstallId()
    {
        string existing = TryRead();
        if (existing.Length > 0) return existing;
        try
        {
            string directory = Path.GetDirectoryName(path);
            if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            // CreateNew, not Create: the service and a second process starting at
            // the same moment must not each write a different id and have the
            // last one win. Whoever loses the race reads what the winner wrote.
            using (FileStream stream = new(path, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            using (StreamWriter writer = new(stream))
            {
                writer.Write(Guid.NewGuid().ToString("D"));
            }
        }
        catch (IOException)
        {
            // Already there, written by whoever won the race.
        }
        catch (Exception exception) when (exception is UnauthorizedAccessException
            or ArgumentException
            or NotSupportedException)
        {
            // Nothing writable here. Fall through: an empty component leaves the
            // identity exactly as strong as it was before this existed, which is
            // worse than intended but never worse than not collecting at all.
            return string.Empty;
        }
        return TryRead();
    }

    private string TryRead()
    {
        try
        {
            return File.Exists(path) ? File.ReadAllText(path).Trim() : string.Empty;
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            return string.Empty;
        }
    }
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

    public static string ReadNormalized(
        IMachineGuidSource source,
        IMachineNameSource nameSource = null,
        IInstallIdSource installIdSource = null)
    {
        ArgumentNullException.ThrowIfNull(source);
        string guid = Normalize(source.ReadMachineGuid());
        string name = NormalizeComponent(ReadName(nameSource));
        string installId = NormalizeComponent(ReadInstallId(installIdSource));
        // Always the same shape, whether or not each part was readable, so the
        // identity of one machine cannot change between two calls.
        return guid + ComponentSeparator + name + ComponentSeparator + installId;
    }

    /* WHAT HAS TO BE SCRUBBED OUT OF AN ERROR MESSAGE.
     *
     * The identity is now three components joined by a separator, and an error
     * message quoting "the machine id" almost always quotes one component, not
     * the join. Redacting only the joined value silently stopped scrubbing the
     * bare MachineGuid. Every non-empty part is returned, longest first, so a
     * component that contains another is replaced before its substring is. */
    public static IEnumerable<string> RedactionTerms(string machineId)
    {
        string joined = (machineId ?? string.Empty).Trim();
        if (joined.Length == 0) return Array.Empty<string>();
        return joined
            .Split(ComponentSeparator)
            .Append(joined)
            .Where(part => part.Length > 0)
            .Distinct(StringComparer.Ordinal)
            .OrderByDescending(part => part.Length)
            .ToArray();
    }

    private static string ReadInstallId(IInstallIdSource installIdSource)
    {
        try
        {
            return (installIdSource ?? new FileInstallIdSource()).ReadInstallId();
        }
        catch (Exception)
        {
            return string.Empty;
        }
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
