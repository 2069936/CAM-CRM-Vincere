using System;
using System.Buffers.Binary;
using System.Security.Cryptography;
using System.Text;
using NodaTime;

namespace Vincere.AutoExport.Agent.Scheduling;

/* THE FLEET ARRIVES AT ONE SECOND, AND NOTHING SPREADS IT OUT.
 *
 * Every paired VPS captures at the same New York minute and the uploader loop
 * runs every ten seconds, so the whole desk knocks on the CRM's door together.
 * At today's handful of machines that is fine; at the desk's target of 139 it
 * is roughly 12,500 rows arriving inside one second.
 *
 * THE CAPTURE TIME IS NOT NEGOTIABLE AND IS NOT TOUCHED HERE. It was moved to
 * 16:35 this week because a close taken at 16:30:00 read -$2,064 for a day that
 * was really -$1,319: the fills landed at 16:32. The capture is load bearing.
 * What waits is the FIRST UPLOAD of that capture, which nothing depends on to
 * the second.
 *
 * DETERMINISTIC, NOT RANDOM. The same machine waits the same number of seconds
 * every day, so a machine that looks late can be checked against its own offset
 * instead of against a dice roll. SHA-256 of the identifier rather than
 * GetHashCode, which is randomised per process and would give one machine a
 * different offset after every service restart.
 *
 * WHY FOUR MINUTES. The server's door admits a small number of uploads at once
 * (migration step 45 defaults it to 4) and one upload takes roughly a second
 * when the instance is healthy, so 139 machines need one to two minutes of pure
 * service time. Spread over 240 seconds they arrive about 1.7 seconds apart,
 * which is longer than an upload takes, so the door should rarely have to fire
 * at all. It is also far inside the 25 minutes between the capture and its
 * cutoff, so a delayed first attempt never eats the window the scheduler needs
 * to retry the capture itself.
 */
public static class UploadSpread
{
    /// <summary>How far apart two machines' first upload attempts can land.</summary>
    public static readonly TimeSpan DefaultWindow = TimeSpan.FromMinutes(4);

    /* The hold always ends before the capture cutoff, with a minute to spare.
     * The cutoff is the moment the scheduler stops trying to capture the day;
     * an upload held past it would be waiting on a window that has closed. */
    private static readonly Duration CutoffMargin = Duration.FromMinutes(1);

    /// <summary>
    /// This machine's own place in the window. Stable for a given identifier,
    /// and inside [0, window).
    /// </summary>
    public static TimeSpan OffsetFor(string deviceKey, TimeSpan? window = null)
    {
        TimeSpan span = window ?? DefaultWindow;
        if (span <= TimeSpan.Zero) return TimeSpan.Zero;
        string normalized = (deviceKey ?? string.Empty).Trim().ToLowerInvariant();
        // An unpaired machine has no device id yet. No identifier means no
        // offset: uploading straight away is what it did before this existed,
        // and it is one machine rather than a fleet.
        if (normalized.Length == 0) return TimeSpan.Zero;
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes(normalized));
        ulong sample = BinaryPrimitives.ReadUInt64BigEndian(digest);
        long milliseconds = (long)(sample % (ulong)Math.Max(1, (long)span.TotalMilliseconds));
        return TimeSpan.FromMilliseconds(milliseconds);
    }

    /// <summary>
    /// When this machine's first upload of a scheduled capture may start, or
    /// null when it may start immediately.
    /// </summary>
    public static Instant? HoldUntil(
        string deviceKey,
        Instant capturedAt,
        Instant cutoff,
        TimeSpan? window = null)
    {
        Duration room = cutoff - capturedAt - CutoffMargin;
        if (room <= Duration.Zero) return null;
        Duration offset = Duration.FromTimeSpan(OffsetFor(deviceKey, window));
        if (offset > room) offset = room;
        return offset <= Duration.Zero ? (Instant?)null : capturedAt + offset;
    }
}
