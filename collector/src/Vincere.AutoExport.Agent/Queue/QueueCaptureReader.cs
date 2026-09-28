using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;

namespace Vincere.AutoExport.Agent.Queue;

/* ---------------------------------------------------------------------------
 * Reading a capture back out of the queue without disturbing it.
 *
 * ICollectorQueue is built for moving an item through pending, uploading and
 * sent, and every method on it that reaches a payload also changes its state.
 * The report email needs the opposite: to read today's capture and leave the
 * queue exactly as it found it, because the upload of that same file is the
 * thing that must not be lost.
 *
 * ACROSS EVERY FOLDER, NEWEST WINS. A day can be captured more than once - the
 * scheduler retries inside its window - and the copies do not all sit in one
 * place: today's is usually in pending, yesterday's in sent, and one mid-flight
 * in uploading. Picking by folder would mail a stale close on the day an upload
 * happens to be in progress.
 *
 * Quarantine is deliberately not read. A quarantined capture failed our own
 * contract, and a report built from one would be wrong in a way nobody
 * reading it could see.
 * ------------------------------------------------------------------------- */
public interface ICaptureReader
{
    /// <summary>The newest capture for that trading date, or null when there is none.</summary>
    Task<string> ReadNewestAsync(string tradingDate, CancellationToken cancellationToken = default);
}

public sealed class QueueCaptureReader : ICaptureReader
{
    private static readonly string[] Folders = { "pending", "uploading", "sent" };
    private readonly string queueRoot;

    public QueueCaptureReader(string queueRoot)
    {
        if (string.IsNullOrWhiteSpace(queueRoot))
            throw new ArgumentException("A queue root is required.", nameof(queueRoot));
        this.queueRoot = Path.GetFullPath(queueRoot);
    }

    public async Task<string> ReadNewestAsync(string tradingDate, CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(tradingDate)) return null;

        FileInfo newest = null;
        foreach (string folder in Folders)
        {
            string path = Path.Combine(queueRoot, folder);
            if (!Directory.Exists(path)) continue;
            FileInfo[] files;
            try
            {
                // The queue names a payload "<tradingDate>_<captureId>.json", so
                // the day is answerable without opening 200 files.
                files = new DirectoryInfo(path).GetFiles($"{tradingDate}_*.json");
            }
            catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
            {
                continue;
            }
            foreach (FileInfo file in files)
            {
                if (newest == null || file.LastWriteTimeUtc > newest.LastWriteTimeUtc) newest = file;
            }
        }

        if (newest == null) return null;
        try
        {
            return await File.ReadAllTextAsync(newest.FullName, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            /* Being written, or locked by a scanner. Answering null rather than
             * throwing means the loop tries again on its next pass instead of
             * the day's email being lost to a moment's contention. */
            return null;
        }
    }
}
