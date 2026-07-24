using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;

namespace Vincere.AutoExport.Agent.Diagnostics;

public interface IRedactingLogger
{
    void Write(string level, string eventCode, string message, IEnumerable<string> knownSecrets = null);
}

public sealed class RedactingLogger : IRedactingLogger
{
    private static readonly UTF8Encoding Utf8WithoutBom = new(false);
    private readonly object gate = new();
    private readonly string directory;
    private readonly int retainedFiles;
    private readonly long maximumFileBytes;
    private readonly Func<DateTimeOffset> utcNow;

    public RedactingLogger(
        string directory,
        int retainedFiles = 14,
        long maximumFileBytes = 5 * 1024 * 1024,
        Func<DateTimeOffset> utcNow = null)
    {
        if (string.IsNullOrWhiteSpace(directory)) throw new ArgumentException("A log directory is required.", nameof(directory));
        if (retainedFiles <= 0) throw new ArgumentOutOfRangeException(nameof(retainedFiles));
        if (maximumFileBytes <= 0) throw new ArgumentOutOfRangeException(nameof(maximumFileBytes));
        this.directory = Path.GetFullPath(directory);
        this.retainedFiles = retainedFiles;
        this.maximumFileBytes = maximumFileBytes;
        this.utcNow = utcNow ?? (() => DateTimeOffset.UtcNow);
    }

    public void Write(string level, string eventCode, string message, IEnumerable<string> knownSecrets = null)
    {
        string safeLevel = NormalizeToken(level, "INFO");
        string safeCode = NormalizeToken(eventCode, "unspecified");
        string safeMessage = SensitiveDataRedactor.Redact(message, knownSecrets)
            .Replace('\r', ' ')
            .Replace('\n', ' ');
        if (safeMessage.Length > 2048) safeMessage = safeMessage[..2048];
        DateTimeOffset now = utcNow();
        string line = $"{now:O}\t{safeLevel}\t{safeCode}\t{safeMessage}{Environment.NewLine}";
        byte[] bytes = Utf8WithoutBom.GetBytes(line);

        lock (gate)
        {
            Directory.CreateDirectory(directory);
            string path = SelectPath(now.UtcDateTime.Date, bytes.LongLength);
            using FileStream stream = new(path, FileMode.Append, FileAccess.Write, FileShare.Read);
            stream.Write(bytes, 0, bytes.Length);
            stream.Flush(true);
            Prune();
        }
    }

    private string SelectPath(DateTime date, long incomingBytes)
    {
        string prefix = $"agent-{date:yyyyMMdd}";
        for (int index = 0; ; index++)
        {
            string suffix = index == 0 ? string.Empty : $"-{index:D2}";
            string path = Path.Combine(directory, prefix + suffix + ".log");
            if (!File.Exists(path) || new FileInfo(path).Length + incomingBytes <= maximumFileBytes)
                return path;
        }
    }

    private void Prune()
    {
        foreach (string path in Directory.EnumerateFiles(directory, "agent-*.log")
            .OrderByDescending(File.GetLastWriteTimeUtc)
            .ThenByDescending(path => path, StringComparer.Ordinal)
            .Skip(retainedFiles))
        {
            File.Delete(path);
        }
    }

    private static string NormalizeToken(string value, string fallback)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0 || normalized.Any(character => !(char.IsLetterOrDigit(character) || character is '_' or '-')))
            return fallback;
        return normalized.Length <= 64 ? normalized : normalized[..64];
    }
}
