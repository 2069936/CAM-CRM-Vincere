using System;

namespace Vincere.AutoExport.Agent.Updates;

/* NEVER DURING THE CLOSE.
 *
 * Applying an update stops this service for a minute or two. Between 15:45 and
 * 17:45 New York time on a weekday that minute is the day's capture and upload:
 * the scheduler fires at 16:30 by default, the upload follows, and a service
 * that is being replaced at that moment is a client with no daily close. So a
 * staged update waits for the window to end. Weekends have no close and are
 * always allowed. A trading holiday is treated as a weekday, which only costs a
 * two-hour wait.
 *
 * New York is resolved through TimeZoneInfo, "Eastern Standard Time" on Windows,
 * so the window follows daylight saving the way the desk's clock does. If the
 * zone cannot be resolved at all, nothing is ever applied: an update that waits
 * forever is safer than one that might land at 16:30. */
public sealed class UpdateApplyWindow
{
    public static readonly TimeSpan WindowStart = new(15, 45, 0);
    public static readonly TimeSpan WindowEnd = new(17, 45, 0);

    private readonly TimeZoneInfo newYork;

    public UpdateApplyWindow()
        : this(ResolveNewYork())
    {
    }

    /// <param name="newYork">Null means the zone could not be found, and nothing is applied.</param>
    public UpdateApplyWindow(TimeZoneInfo newYork)
    {
        this.newYork = newYork;
    }

    public bool IsApplyAllowed(DateTimeOffset now)
    {
        if (newYork == null) return false;
        DateTimeOffset local = TimeZoneInfo.ConvertTime(now, newYork);
        if (local.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) return true;
        TimeSpan time = local.TimeOfDay;
        return time < WindowStart || time >= WindowEnd;
    }

    public static TimeZoneInfo ResolveNewYork()
    {
        string[] ids = OperatingSystem.IsWindows()
            ? new[] { "Eastern Standard Time", "America/New_York" }
            : new[] { "America/New_York", "Eastern Standard Time" };
        foreach (string id in ids)
        {
            try
            {
                return TimeZoneInfo.FindSystemTimeZoneById(id);
            }
            catch (Exception exception) when (exception is TimeZoneNotFoundException or InvalidTimeZoneException)
            {
            }
        }
        return null;
    }
}
