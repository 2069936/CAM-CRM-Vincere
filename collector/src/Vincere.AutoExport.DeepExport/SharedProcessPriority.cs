using System;
using System.Diagnostics;
using System.Threading;

namespace Vincere.AutoExport.Agent.UI.DeepExport;

/* ---------------------------------------------------------------------------
 * Lowering THIS process's priority while an export runs, when there may be more
 * than one of them.
 *
 * WHY THIS TYPE EXISTS. DeepExportRunner used to do it inline: read
 * Process.GetCurrentProcess().PriorityClass into a local, write BelowNormal,
 * and write the local back in its finally. That is correct for exactly one
 * caller at a time and silently wrong for two, because the second caller reads
 * the value the first one installed:
 *
 *   A enters    previousPriority = Normal       process -> BelowNormal
 *   B enters    previousPriority = BelowNormal  process -> BelowNormal
 *   A leaves                                    process -> Normal     (B is still running)
 *   B leaves                                    process -> BelowNormal
 *
 * The process ends at BelowNormal with nothing running, and nothing ever puts
 * it back: the field that remembered Normal belonged to A's stack frame and A is
 * gone. On the WPF Setup window that interleaving cannot happen - every command
 * is dispatched on the one UI thread and DeepExportAsync returns early while
 * IsBusy, so the check and the set cannot straddle - which is why this has never
 * been an incident. The layer move is what changes the odds: this code is now a
 * library the Windows service references, Worker runs six loops in one process
 * with Task.WhenAll, and the first service-side caller that forgets a mutex
 * leaves the scheduler, the uploader and the heartbeat permanently demoted on a
 * box trading live accounts. A guard before the caller, not after the incident.
 *
 * WHAT IT GUARANTEES. The original value is read by the FIRST holder only and
 * written back by the LAST one to let go, so any interleaving of holds ends
 * where it started. Releasing twice releases once. A machine that refuses to
 * report or change its own priority is not an export failure - the drop is a
 * courtesy to the trading platform, not a correctness property - so both the
 * read and the write are swallowed, exactly as the inline version swallowed
 * them, and a hold that could not be taken is handed back as a no-op.
 *
 * WHAT IT IS NOT. It is not a substitute for running the export in a child
 * process of its own, which is the real answer for the service and belongs with
 * the code that spawns one: a child is reaped by the OS when it hangs, its
 * memory goes back on exit rather than in a finally, and demoting it cannot
 * touch the loops. This type is what makes the library safe to call twice in the
 * meantime, and it stays useful afterwards because the child will want the same
 * drop with the same swallowing.
 * ------------------------------------------------------------------------- */
public sealed class SharedProcessPriority
{
    /// <summary>The real process. Resolved per call: GetCurrentProcess() hands back a new object that caches, and a stale one reports the value it was born with.</summary>
    public static SharedProcessPriority ThisProcess { get; } = new(
        () => Process.GetCurrentProcess().PriorityClass,
        value => Process.GetCurrentProcess().PriorityClass = value);

    private readonly Func<ProcessPriorityClass> read;
    private readonly Action<ProcessPriorityClass> write;
    private readonly object gate = new();
    private int holders;
    private ProcessPriorityClass restoreTo;

    /// <summary>Injected so a test can exercise the interleaving without demoting the test runner.</summary>
    internal SharedProcessPriority(Func<ProcessPriorityClass> read, Action<ProcessPriorityClass> write)
    {
        this.read = read ?? throw new ArgumentNullException(nameof(read));
        this.write = write ?? throw new ArgumentNullException(nameof(write));
    }

    /// <summary>How many holds are outstanding. For tests and for a log line, not for a decision.</summary>
    internal int Holders
    {
        get { lock (gate) return holders; }
    }

    /// <summary>
    /// Hold the process at <paramref name="to"/> until every holder has disposed.
    /// The saved value is restored verbatim, so a process that was already at or
    /// below this is left where it was found.
    /// </summary>
    public IDisposable Lower(ProcessPriorityClass to)
    {
        lock (gate)
        {
            if (holders == 0)
            {
                ProcessPriorityClass previous;
                try
                {
                    previous = read();
                    write(to);
                }
                catch (Exception)
                {
                    // Nothing was changed, so nothing is owed. The next caller
                    // tries again rather than inheriting a hold that was never
                    // taken.
                    return NotTaken.Instance;
                }
                restoreTo = previous;
            }
            holders++;
            return new Hold(this);
        }
    }

    private void Release()
    {
        lock (gate)
        {
            if (holders == 0) return;
            if (--holders > 0) return;
            try { write(restoreTo); } catch (Exception) { }
        }
    }

    private sealed class Hold : IDisposable
    {
        private SharedProcessPriority owner;

        public Hold(SharedProcessPriority owner) => this.owner = owner;

        public void Dispose()
        {
            // IDEMPOTENT ON PURPOSE. A using plus an explicit Dispose on the same
            // handle must not drop a hold somebody else is still counting on, and
            // the whole point of this type is that the count is the truth.
            SharedProcessPriority mine = Interlocked.Exchange(ref owner, null);
            mine?.Release();
        }
    }

    private sealed class NotTaken : IDisposable
    {
        public static readonly NotTaken Instance = new();

        public void Dispose() { }
    }
}
