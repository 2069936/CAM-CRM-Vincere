using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Updates;

namespace Vincere.AutoExport.Agent.Tests;

/// <summary>A folder under the temp directory that is gone after the test.</summary>
internal sealed class UpdateTempDirectory : IDisposable
{
    public UpdateTempDirectory()
    {
        Path = System.IO.Path.Combine(System.IO.Path.GetTempPath(), "vincere-update-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(Path);
    }

    public string Path { get; }

    public void Dispose()
    {
        try
        {
            Directory.Delete(Path, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}

/// <summary>The network, as a dictionary of URLs. Nothing leaves the machine.</summary>
internal sealed class FakeUpdateDownloader : IUpdateDownloader
{
    public Dictionary<string, byte[]> Responses { get; } = new(StringComparer.Ordinal);
    public Dictionary<string, UpdateDownloadFailure> Failures { get; } = new(StringComparer.Ordinal);
    public List<string> Requests { get; } = new();

    public int RequestsFor(string url) => Requests.Count(request => request == url);

    public Task<byte[]> GetBytesAsync(Uri uri, int maximumBytes, TimeSpan timeout, CancellationToken cancellationToken)
    {
        byte[] body = Respond(uri, maximumBytes);
        return Task.FromResult(body.ToArray());
    }

    public async Task<long> CopyToAsync(
        Uri uri,
        Stream destination,
        long maximumBytes,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        byte[] body = Respond(uri, maximumBytes);
        await destination.WriteAsync(body, cancellationToken);
        return body.Length;
    }

    private byte[] Respond(Uri uri, long maximumBytes)
    {
        string url = uri.ToString();
        Requests.Add(url);
        if (Failures.TryGetValue(url, out UpdateDownloadFailure failure))
            throw new UpdateDownloadException(failure, "fake failure");
        if (!Responses.TryGetValue(url, out byte[] body))
            throw new UpdateDownloadException(UpdateDownloadFailure.Unreachable, "not found");
        if (body.Length > maximumBytes)
            throw new UpdateDownloadException(UpdateDownloadFailure.TooLarge, "too large");
        return body;
    }
}

/// <summary>Creates the folder and records the call. The real one sets Windows ACLs.</summary>
internal sealed class RecordingDirectorySecurity : IAgentDirectorySecurity
{
    public List<string> Protected { get; } = new();

    public void EnsureProtected(string path)
    {
        Directory.CreateDirectory(path);
        Protected.Add(path);
    }
}

internal sealed class FixedUpdateDisk : IUpdateDisk
{
    public long FreeBytes { get; set; } = 64L * 1024 * 1024 * 1024;

    public long GetAvailableFreeBytes(string path) => FreeBytes;
}

internal static class UpdateFixtures
{
    public static string Sha256(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();

    public static byte[] Zip(params (string Name, string Content)[] entries)
    {
        using MemoryStream buffer = new();
        using (ZipArchive archive = new(buffer, ZipArchiveMode.Create, leaveOpen: true))
        {
            foreach ((string name, string content) in entries)
            {
                ZipArchiveEntry entry = archive.CreateEntry(name);
                using Stream stream = entry.Open();
                byte[] bytes = Encoding.UTF8.GetBytes(content ?? string.Empty);
                stream.Write(bytes, 0, bytes.Length);
            }
        }
        return buffer.ToArray();
    }

    /// <summary>The layout the CI workflow zips: scripts at the root, Agent\ and Setup\ beside them.</summary>
    public static byte[] Package(params (string Name, string Content)[] extra)
    {
        (string, string)[] entries =
        {
            ("Agent/Vincere.AutoExport.Agent.exe", "agent"),
            ("Agent/Vincere.AutoExport.Agent.dll", "agent dll"),
            ("Setup/Vincere.AutoExport.Agent.UI.exe", "ui"),
            ("install-agent.ps1", "# install"),
            ("update-agent.ps1", "# update"),
            ("uninstall-agent.ps1", "# uninstall"),
            ("installing.md", "# docs"),
        };
        return Zip(entries.Concat(extra).ToArray());
    }

    public static JObject Manifest(string version, byte[] package, string minimumAddonVersion = null)
    {
        JObject manifest = new()
        {
            ["schemaVersion"] = 1,
            ["version"] = version,
            ["minimumAgentVersion"] = "1.2.0",
            ["minimumSchemaVersion"] = 1,
            ["publishedAt"] = "2026-10-13T11:40:42.000Z",
            ["artifacts"] = new JArray
            {
                new JObject
                {
                    ["name"] = "Vincere-AutoExport-Agent.zip",
                    ["url"] = UpdateDirectiveValidator.PackageUrlFor(version),
                    ["sha256"] = Sha256(package),
                    ["size"] = package.LongLength,
                },
            },
        };
        if (minimumAddonVersion != null) manifest["minimumAddonVersion"] = minimumAddonVersion;
        return manifest;
    }

    public static byte[] Bytes(JObject json) => Encoding.UTF8.GetBytes(json.ToString(Formatting.Indented));
}
