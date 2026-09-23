using System;
using System.Collections.Generic;
using System.Linq;
using NodaTime;
using Vincere.AutoExport.Agent.Scheduling;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* WHAT THE SPREAD HAS TO BE, AND WHAT IT MUST NEVER COST.
 *
 * It exists so that 139 VPSes capturing at the same New York minute do not all
 * knock on the CRM in the same second. It must be the same number for the same
 * machine every day, it must fit inside its window, and it must never hold an
 * upload past the moment the capture window closes.
 */
public sealed class UploadSpreadTests
{
    private const string DeviceId = "22222222-2222-4222-8222-222222222222";

    [Fact]
    public void TheSameMachineWaitsTheSameNumberOfSecondsEveryDay()
    {
        // Pinned to the value, not merely to itself twice. string.GetHashCode is
        // randomised per process, so a future author swapping the digest for it
        // would still pass an "equal to itself" assertion while giving every
        // machine a new offset after every service restart.
        Assert.Equal(TimeSpan.FromMilliseconds(90027), UploadSpread.OffsetFor(DeviceId));
        Assert.Equal(UploadSpread.OffsetFor(DeviceId), UploadSpread.OffsetFor(DeviceId));
        Assert.Equal(UploadSpread.OffsetFor(DeviceId), UploadSpread.OffsetFor("  " + DeviceId.ToUpperInvariant() + " "));
    }

    [Fact]
    public void DifferentMachinesLandAtDifferentSeconds()
    {
        List<TimeSpan> offsets = Enumerable.Range(0, 12)
            .Select(index => UploadSpread.OffsetFor($"device-{index}"))
            .ToList();

        Assert.All(offsets, offset =>
        {
            Assert.True(offset >= TimeSpan.Zero);
            Assert.True(offset < UploadSpread.DefaultWindow);
        });
        // Twelve machines, twelve different seconds. One repeated second would
        // still be harmless; a dozen identical ones would mean the spread is not
        // spreading anything.
        Assert.Equal(12, offsets.Select(offset => (int)offset.TotalSeconds).Distinct().Count());
    }

    [Fact]
    public void AMachineWithNoDeviceIdYetWaitsForNothing()
    {
        // Unpaired. It is one machine rather than a fleet, and uploading
        // immediately is exactly what it did before this existed.
        Assert.Equal(TimeSpan.Zero, UploadSpread.OffsetFor(null));
        Assert.Equal(TimeSpan.Zero, UploadSpread.OffsetFor("   "));
        Assert.Null(UploadSpread.HoldUntil(
            null,
            Instant.FromUtc(2026, 7, 23, 20, 35),
            Instant.FromUtc(2026, 7, 23, 21, 0)));
    }

    [Fact]
    public void TheHoldIsTheCaptureInstantPlusThisMachinesOffset()
    {
        Instant captured = Instant.FromUtc(2026, 7, 23, 20, 35);
        Instant cutoff = Instant.FromUtc(2026, 7, 23, 21, 0);

        Assert.Equal(
            captured + Duration.FromMilliseconds(90027),
            UploadSpread.HoldUntil(DeviceId, captured, cutoff));
    }

    [Fact]
    public void AnOffsetIsClampedRatherThanPushedPastTheCaptureCutoff()
    {
        // 21:00 is the cutoff, the capture landed at 20:58, and this machine's
        // own offset is ninety seconds. Held in full the first upload would
        // start at 20:59:30, inside the last minute of the window the scheduler
        // needs for a late capture. It is clamped to a minute before the cutoff.
        Instant captured = Instant.FromUtc(2026, 7, 23, 20, 58);
        Instant cutoff = Instant.FromUtc(2026, 7, 23, 21, 0);

        Instant? hold = UploadSpread.HoldUntil(DeviceId, captured, cutoff);

        Assert.Equal(Instant.FromUtc(2026, 7, 23, 20, 59), hold);
        Assert.True(hold < cutoff);
    }

    [Fact]
    public void ACaptureTakenAtTheCutoffIsNotHeldAtAll()
    {
        Instant cutoff = Instant.FromUtc(2026, 7, 23, 21, 0);

        Assert.Null(UploadSpread.HoldUntil(DeviceId, cutoff, cutoff));
        Assert.Null(UploadSpread.HoldUntil(DeviceId, Instant.FromUtc(2026, 7, 23, 20, 59, 30), cutoff));
        // Past the cutoff there is nothing left to protect and the upload goes.
        Assert.Null(UploadSpread.HoldUntil(DeviceId, Instant.FromUtc(2026, 7, 23, 21, 5), cutoff));
    }
}
