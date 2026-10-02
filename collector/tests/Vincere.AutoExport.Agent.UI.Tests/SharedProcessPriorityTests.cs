using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.UI.DeepExport;
using Xunit;

namespace Vincere.AutoExport.Agent.UI.Tests;

/* THE PRIORITY DROP, EXERCISED RATHER THAN REASONED ABOUT.
 *
 * The export lowers the process to BelowNormal so a trading machine keeps its
 * CPU. For one caller a local variable and a finally are enough; for two they are
 * the bug, and the bug is not visible by reading either caller - it needs the
 * second hold to be taken while the first is still out. So these tests take the
 * holds in the orders that matter and assert on the EXACT sequence of writes,
 * through an injected reader and writer: the real process is never touched, which
 * is the only way this can be asserted without demoting the test runner and
 * everything it goes on to run. */
public sealed class SharedProcessPriorityTests
{
    /// <summary>A process whose priority is a variable, and every write to it in order.</summary>
    private sealed class FakeProcess
    {
        private readonly object gate = new();
        public ProcessPriorityClass Value = ProcessPriorityClass.Normal;
        public readonly List<ProcessPriorityClass> Writes = new();
        public int Reads;
        public Func<bool> FailWrite = () => false;

        public SharedProcessPriority Priority() => new(Read, Write);

        private ProcessPriorityClass Read()
        {
            lock (gate)
            {
                Reads++;
                return Value;
            }
        }

        private void Write(ProcessPriorityClass value)
        {
            lock (gate)
            {
                if (FailWrite()) throw new InvalidOperationException("the platform refused");
                Writes.Add(value);
                Value = value;
            }
        }
    }

    [Fact]
    public void TwoOverlappingHoldsLeaveTheProcessWhereTheyFoundIt()
    {
        // THE DEFECT, IN FOUR LINES. The old code read the current value into a
        // local on the way in and wrote the local back on the way out, so the
        // second export read BelowNormal as "what it was before", the first one
        // restored Normal while the second was still running, and the second one
        // then put BelowNormal back for good. Nothing afterwards ever raised it:
        // the frame that remembered Normal had returned. On a service running six
        // loops in one process that is the scheduler, the uploader and the
        // heartbeat permanently demoted on a box trading live accounts.
        var process = new FakeProcess();
        SharedProcessPriority priority = process.Priority();

        IDisposable first = priority.Lower(ProcessPriorityClass.BelowNormal);
        IDisposable second = priority.Lower(ProcessPriorityClass.BelowNormal);
        Assert.Equal(ProcessPriorityClass.BelowNormal, process.Value);

        first.Dispose();
        // STILL LOWERED, because somebody is still running. This is the half the
        // old code got wrong in the other direction, and it is not cosmetic: the
        // second export would have run at Normal beside a live trading session.
        Assert.Equal(ProcessPriorityClass.BelowNormal, process.Value);

        second.Dispose();
        // AND BACK WHERE IT STARTED. The old shape ends here at BelowNormal, for
        // the rest of the process's life.
        Assert.Equal(ProcessPriorityClass.Normal, process.Value);

        // One write down and one write up, whatever the interleaving. The count
        // is the assertion: a second drop on the way in would mean a second
        // restore is owed, and that is the whole family of this bug.
        Assert.Equal(new[] { ProcessPriorityClass.BelowNormal, ProcessPriorityClass.Normal }, process.Writes);
        // And the original value was read ONCE, by the first holder only. Reading
        // it twice is how the wrong value gets saved.
        Assert.Equal(1, process.Reads);
        Assert.Equal(0, priority.Holders);
    }

    [Fact]
    public void NestedHoldsRestoreOnceAndNotPerHold()
    {
        // Nesting is the easy order and it still has to be checked, because the
        // fix must not restore on the inner Dispose either.
        var process = new FakeProcess();
        SharedProcessPriority priority = process.Priority();
        using (priority.Lower(ProcessPriorityClass.BelowNormal))
        {
            using (priority.Lower(ProcessPriorityClass.BelowNormal))
            {
                Assert.Equal(ProcessPriorityClass.BelowNormal, process.Value);
            }
            Assert.Equal(ProcessPriorityClass.BelowNormal, process.Value);
        }
        Assert.Equal(ProcessPriorityClass.Normal, process.Value);
        Assert.Equal(new[] { ProcessPriorityClass.BelowNormal, ProcessPriorityClass.Normal }, process.Writes);
    }

    [Fact]
    public void ReleasingTheSameHoldTwiceReleasesOnce()
    {
        // A using over a handle somebody also disposed by hand must not drop a
        // hold another export is still counting on. Counted state plus a Dispose
        // that is not idempotent is the same defect with extra steps.
        var process = new FakeProcess();
        SharedProcessPriority priority = process.Priority();
        IDisposable first = priority.Lower(ProcessPriorityClass.BelowNormal);
        using IDisposable second = priority.Lower(ProcessPriorityClass.BelowNormal);

        first.Dispose();
        first.Dispose();
        first.Dispose();

        Assert.Equal(1, priority.Holders);
        Assert.Equal(ProcessPriorityClass.BelowNormal, process.Value);
        Assert.Equal(new[] { ProcessPriorityClass.BelowNormal }, process.Writes);
    }

    [Fact]
    public async Task ManyThreadsTakingAndDroppingHoldsEndAtTheOriginalValue()
    {
        // The interleaving the service actually produces: six loops under
        // Task.WhenAll, no two of them agreeing on an order. Hammered rather than
        // staged, because the failure is a race and a staged order can pass while
        // a race does not.
        var process = new FakeProcess();
        SharedProcessPriority priority = process.Priority();
        using var start = new ManualResetEventSlim(false);

        Task[] runners = new Task[12];
        for (int i = 0; i < runners.Length; i++)
        {
            runners[i] = Task.Run(() =>
            {
                start.Wait();
                for (int pass = 0; pass < 200; pass++)
                {
                    using IDisposable hold = priority.Lower(ProcessPriorityClass.BelowNormal);
                    Thread.SpinWait(20);
                }
            });
        }
        start.Set();
        await Task.WhenAll(runners);

        Assert.Equal(0, priority.Holders);
        Assert.Equal(ProcessPriorityClass.Normal, process.Value);
        // Every drop was paid for by exactly one restore, so the writes alternate
        // and there is an even number of them.
        Assert.Equal(0, process.Writes.Count % 2);
        for (int i = 0; i < process.Writes.Count; i++)
        {
            Assert.Equal(
                i % 2 == 0 ? ProcessPriorityClass.BelowNormal : ProcessPriorityClass.Normal,
                process.Writes[i]);
        }
    }

    [Fact]
    public void AMachineThatRefusesToChangeItsPriorityStillExports()
    {
        // The drop is a courtesy to the platform, not a correctness property, so
        // a process that cannot set its own priority must not fail an export -
        // and must not come away holding a hold it never took, which would make
        // the next caller skip the drop it could have had.
        var process = new FakeProcess { FailWrite = () => true };
        SharedProcessPriority priority = process.Priority();

        using IDisposable refused = priority.Lower(ProcessPriorityClass.BelowNormal);

        Assert.Equal(0, priority.Holders);
        Assert.Empty(process.Writes);
        Assert.Equal(ProcessPriorityClass.Normal, process.Value);
    }
}
