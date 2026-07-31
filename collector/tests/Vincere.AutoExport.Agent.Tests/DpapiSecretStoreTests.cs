using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Security;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class DpapiSecretStoreTests : IDisposable
{
    private readonly string directory = Path.Combine(
        Path.GetTempPath(), "vincere-secret-tests", Guid.NewGuid().ToString("N"));

    [Fact]
    public async Task MissingCredentialReturnsNullAfterSecuringDirectory()
    {
        List<string> calls = new();
        DpapiSecretStore store = CreateStore(calls);

        string token = await store.LoadTokenAsync();

        Assert.Null(token);
        Assert.Equal(new[] { "secure-directory" }, calls);
    }

    [Fact]
    public async Task ProtectsBeforeWritingAndRoundTripsWithoutPlaintextBackup()
    {
        List<string> calls = new();
        DpapiSecretStore store = CreateStore(calls);
        const string token = "device-token-super-secret";

        await store.SaveTokenAsync(token);
        string loaded = await store.LoadTokenAsync();

        Assert.Equal(token, loaded);
        Assert.Equal("secure-directory", calls[0]);
        Assert.Equal("protect", calls[1]);
        byte[] stored = await File.ReadAllBytesAsync(store.SecretPath);
        Assert.DoesNotContain(token, Encoding.UTF8.GetString(stored));
        Assert.False(File.Exists(store.TemporaryPath));
        Assert.DoesNotContain(
            Directory.EnumerateFiles(directory),
            path => path.EndsWith(".bak", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task UnprotectFailureReturnsStableCodeWithoutLeakingCiphertext()
    {
        List<string> calls = new();
        DpapiSecretStore store = CreateStore(calls);
        Directory.CreateDirectory(directory);
        await File.WriteAllBytesAsync(store.SecretPath, Encoding.UTF8.GetBytes("wrong-machine-bytes"));

        SecretStoreException error = await Assert.ThrowsAsync<SecretStoreException>(
            () => store.LoadTokenAsync());

        Assert.Equal("credential_unprotect_failed", error.Code);
        Assert.DoesNotContain("wrong-machine-bytes", error.Message);
    }

    [Fact]
    public async Task ReplacementLeavesOnlyTheLatestProtectedCredential()
    {
        List<string> calls = new();
        DpapiSecretStore store = CreateStore(calls);

        await store.SaveTokenAsync("first-token");
        await store.SaveTokenAsync("second-token");

        Assert.Equal("second-token", await store.LoadTokenAsync());
        Assert.Single(Directory.EnumerateFiles(directory));
    }

    public void Dispose()
    {
        if (Directory.Exists(directory)) Directory.Delete(directory, recursive: true);
    }

    private DpapiSecretStore CreateStore(List<string> calls)
    {
        return new DpapiSecretStore(
            Path.Combine(directory, "secret.bin"),
            new ReversingProtector(calls),
            new RecordingDirectorySecurity(calls));
    }

    private sealed class ReversingProtector : ISecretProtector
    {
        private readonly List<string> calls;

        public ReversingProtector(List<string> calls) => this.calls = calls;

        public byte[] Protect(byte[] plaintext)
        {
            calls.Add("protect");
            return Enumerable.Reverse(plaintext).Select(value => (byte)(value ^ 0x5A)).ToArray();
        }

        public byte[] Unprotect(byte[] ciphertext)
        {
            calls.Add("unprotect");
            if (Encoding.UTF8.GetString(ciphertext).Contains("wrong-machine"))
                throw new InvalidOperationException("wrong context");
            return Enumerable.Reverse(ciphertext.Select(value => (byte)(value ^ 0x5A))).ToArray();
        }
    }

    private sealed class RecordingDirectorySecurity : IAgentDirectorySecurity
    {
        private readonly List<string> calls;

        public RecordingDirectorySecurity(List<string> calls) => this.calls = calls;

        public void EnsureProtected(string path)
        {
            Directory.CreateDirectory(path);
            calls.Add("secure-directory");
        }
    }
}
