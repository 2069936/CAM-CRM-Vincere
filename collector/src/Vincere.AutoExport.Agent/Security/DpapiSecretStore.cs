using System;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

namespace Vincere.AutoExport.Agent.Security;

public interface ISecretProtector
{
    byte[] Protect(byte[] plaintext);
    byte[] Unprotect(byte[] ciphertext);
}

public interface IAgentDirectorySecurity
{
    void EnsureProtected(string path);
}

public sealed class DpapiSecretStore
{
    private static readonly UTF8Encoding Utf8WithoutBom = new(false);
    private readonly ISecretProtector protector;
    private readonly IAgentDirectorySecurity directorySecurity;
    private readonly SemaphoreSlim gate = new(1, 1);

    public DpapiSecretStore(string secretPath)
        : this(secretPath, new DpapiSecretProtector(), new WindowsAgentDirectorySecurity())
    {
    }

    public DpapiSecretStore(
        string secretPath,
        ISecretProtector protector,
        IAgentDirectorySecurity directorySecurity)
    {
        if (string.IsNullOrWhiteSpace(secretPath))
            throw new ArgumentException("A secret path is required.", nameof(secretPath));
        this.protector = protector ?? throw new ArgumentNullException(nameof(protector));
        this.directorySecurity = directorySecurity ?? throw new ArgumentNullException(nameof(directorySecurity));
        SecretPath = Path.GetFullPath(secretPath);
        TemporaryPath = SecretPath + ".tmp";
    }

    public string SecretPath { get; }
    public string TemporaryPath { get; }

    public async Task SaveTokenAsync(string token, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(token))
            throw new SecretStoreException("credential_empty", "A non-empty device credential is required.");
        if (token.Length > 8192)
            throw new SecretStoreException("credential_oversized", "The device credential exceeds the supported limit.");

        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        byte[] plaintext = null;
        byte[] protectedBytes = null;
        try
        {
            string directory = RequireDirectory();
            directorySecurity.EnsureProtected(directory);
            plaintext = Utf8WithoutBom.GetBytes(token);
            protectedBytes = protector.Protect(plaintext);
            if (protectedBytes == null || protectedBytes.Length == 0)
                throw new SecretStoreException("credential_protect_failed", "Credential protection returned no data.");

            DeleteIfPresent(TemporaryPath);
            await WriteThroughAsync(TemporaryPath, protectedBytes, cancellationToken).ConfigureAwait(false);
            File.Move(TemporaryPath, SecretPath, true);
        }
        catch (SecretStoreException)
        {
            throw;
        }
        catch (Exception exception) when (
            exception is CryptographicException
            or IOException
            or UnauthorizedAccessException
            or PlatformNotSupportedException)
        {
            throw new SecretStoreException("credential_store_failed", "The protected device credential could not be stored.", exception);
        }
        finally
        {
            try
            {
                DeleteIfPresent(TemporaryPath);
            }
            finally
            {
                if (plaintext != null) CryptographicOperations.ZeroMemory(plaintext);
                if (protectedBytes != null && !ReferenceEquals(protectedBytes, plaintext))
                    CryptographicOperations.ZeroMemory(protectedBytes);
                gate.Release();
            }
        }
    }

    public async Task<string> LoadTokenAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        byte[] ciphertext = null;
        byte[] plaintext = null;
        try
        {
            string directory = RequireDirectory();
            directorySecurity.EnsureProtected(directory);
            if (!File.Exists(SecretPath)) return null;
            ciphertext = await File.ReadAllBytesAsync(SecretPath, cancellationToken).ConfigureAwait(false);
            plaintext = protector.Unprotect(ciphertext);
            string token = Utf8WithoutBom.GetString(plaintext);
            if (string.IsNullOrWhiteSpace(token))
                throw new CryptographicException("Empty credential payload.");
            return token;
        }
        catch (Exception exception) when (
            exception is CryptographicException
            or IOException
            or UnauthorizedAccessException
            or PlatformNotSupportedException
            or InvalidOperationException)
        {
            throw new SecretStoreException("credential_unprotect_failed", "The device credential cannot be read on this machine.", exception);
        }
        finally
        {
            if (ciphertext != null) CryptographicOperations.ZeroMemory(ciphertext);
            if (plaintext != null && !ReferenceEquals(plaintext, ciphertext))
                CryptographicOperations.ZeroMemory(plaintext);
            gate.Release();
        }
    }

    public async Task DeleteTokenAsync(CancellationToken cancellationToken = default)
    {
        await gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            directorySecurity.EnsureProtected(RequireDirectory());
            DeleteIfPresent(SecretPath);
            DeleteIfPresent(TemporaryPath);
        }
        finally
        {
            gate.Release();
        }
    }

    private string RequireDirectory()
    {
        return Path.GetDirectoryName(SecretPath)
            ?? throw new SecretStoreException("credential_path_invalid", "The credential directory is invalid.");
    }

    private static async Task WriteThroughAsync(string path, byte[] bytes, CancellationToken cancellationToken)
    {
        await using FileStream stream = new(
            path,
            FileMode.CreateNew,
            FileAccess.Write,
            FileShare.None,
            4096,
            FileOptions.Asynchronous | FileOptions.WriteThrough);
        await stream.WriteAsync(bytes, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
        stream.Flush(true);
    }

    private static void DeleteIfPresent(string path)
    {
        if (File.Exists(path)) File.Delete(path);
    }
}

public sealed class DpapiSecretProtector : ISecretProtector
{
    private static readonly byte[] Entropy = SHA256.HashData(
        Encoding.UTF8.GetBytes("Vincere.AutoExport.DeviceToken.v1"));

    public byte[] Protect(byte[] plaintext)
    {
        return ProtectedData.Protect(plaintext, Entropy, DataProtectionScope.LocalMachine);
    }

    public byte[] Unprotect(byte[] ciphertext)
    {
        return ProtectedData.Unprotect(ciphertext, Entropy, DataProtectionScope.LocalMachine);
    }
}

public sealed class SecretStoreException : Exception
{
    public SecretStoreException(string code, string message, Exception innerException = null)
        : base(message, innerException)
    {
        Code = code;
    }

    public string Code { get; }
}
