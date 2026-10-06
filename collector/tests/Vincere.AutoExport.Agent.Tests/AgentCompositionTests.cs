using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Vincere.AutoExport.Agent.Capture;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Service;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/// <summary>
/// THE COMPOSITION ROOT, ASKED RATHER THAN READ.
///
/// The three assertions this file replaces were Assert.Contains against the text
/// of Program.cs. A comment satisfies an Assert.Contains, and that is not a
/// hypothetical: commenting out the one line that registers the account tracker
/// while leaving the asserted string on it left the loop registered nowhere - the
/// tracker running on no VPS, forever - with 344 of 344 tests green. Measured in a
/// shadow build, twice, before and after.
///
/// What follows asks the container instead. It builds the real
/// AgentComposition.Register, resolves the real supervisor out of it, and asks the
/// supervisor which loops it is going to run. A registration that is commented
/// out, deleted, or registered under a different interface fails these. So does a
/// dependency the container cannot satisfy, which before this file threw at
/// service start on a machine in front of nobody.
///
/// ON THE TEMPORARY ProgramData ROOT. The real paths come from
/// Environment.SpecialFolder.CommonApplicationData, which on a VPS is C:\ProgramData
/// and here is somewhere else entirely. AgentPaths.FromProgramData is the seam the
/// paths type already had, and nothing resolved below writes a file at
/// construction - the directory is created so that a future constructor that does
/// write finds a real one rather than failing for an unrelated reason.
/// </summary>
public sealed class AgentCompositionTests : IDisposable
{
    private readonly string programData;

    public AgentCompositionTests()
    {
        programData = Path.Combine(Path.GetTempPath(), "vincere-composition-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(programData);
    }

    public void Dispose()
    {
        try { Directory.Delete(programData, recursive: true); } catch (IOException) { }
    }

    /* THE ONE THAT WOULD HAVE CAUGHT IT.
     *
     * Not "does Program.cs contain this string" but "does the supervisor the host
     * is about to start hold an AccountSampleLoop". Delete or comment out the
     * registration and this fails, because the object is simply not there. */
    [Fact]
    public void The_supervisor_the_host_starts_holds_the_account_sample_loop()
    {
        using ServiceProvider provider = BuildRealContainer();

        Worker supervisor = Assert.Single(
            provider.GetServices<IHostedService>().OfType<Worker>());

        ICollectorLoop[] supervised = SupervisedLoops(supervisor);
        Assert.Contains(supervised, loop => loop is AccountSampleLoop);
        // By name too, because the name is what the supervisor logs a failure under
        // and what the backoff is keyed on. A loop present under the wrong name is
        // a loop whose failures are reported about something else.
        Assert.Contains(supervised, loop => loop.Name == "account-sample");
    }

    /* AND IT IS REGISTERED EXACTLY ONCE.
     *
     * Two registrations would be two instances, each sampling on its own ten
     * minute clock, so the fleet would ask every terminal on the desk to read
     * itself twice as often as the SQL editor says - and LiveAccountMemory, which
     * is the whole relevance filter, would be shared by neither consistently. */
    [Fact]
    public void It_is_registered_exactly_once_and_beside_the_six_loops_that_were_already_there()
    {
        using ServiceProvider provider = BuildRealContainer();

        ICollectorLoop[] loops = provider.GetServices<ICollectorLoop>().ToArray();

        Assert.Single(loops.Where(loop => loop is AccountSampleLoop));
        /* The six that shipped before the tracker, asserted as a set rather than a
         * count: a count passes when one loop is swapped for another. */
        Assert.Equal(
            new[]
            {
                "account-sample", "control", "heartbeat", "quarantine-review",
                "queue-recovery", "report-email", "scheduler", "uploader",
            },
            loops.Select(loop => loop.Name).OrderBy(name => name, StringComparer.Ordinal).ToArray());
    }

    /* EVERY LOOP THE CONTAINER HOLDS IS ONE THE SUPERVISOR WILL ACTUALLY RUN.
     *
     * Worker's constructor refuses a loop whose Interval is not positive, and it
     * reads Interval OUTSIDE its try block on every iteration, so a loop with a
     * bad interval does not fail by itself - it stops the host and takes the
     * heartbeat down with it. Resolving the real Worker from the real container is
     * what proves the real intervals pass that gate. */
    [Fact]
    public void Resolving_the_real_container_is_what_proves_the_intervals_the_supervisor_demands()
    {
        using ServiceProvider provider = BuildRealContainer();

        Worker supervisor = Assert.Single(provider.GetServices<IHostedService>().OfType<Worker>());

        foreach (ICollectorLoop loop in SupervisedLoops(supervisor))
        {
            Assert.False(string.IsNullOrWhiteSpace(loop.Name));
            Assert.True(loop.Interval > TimeSpan.Zero, $"{loop.Name} has interval {loop.Interval}");
        }
    }

    /* THE TRACKER'S PIPE CLIENT IS ITS OWN OBJECT, which is the thing that makes
     * "whatever the tracker does, it cannot reach the close's client" true rather
     * than merely intended. Asked of the container, because this is a fact about
     * two resolutions and not about a line of source. */
    [Fact]
    public void The_tracker_never_shares_an_object_with_the_capture_the_close_depends_on()
    {
        using ServiceProvider provider = BuildRealContainer();

        INinjaTraderCaptureClient close = provider.GetRequiredService<INinjaTraderCaptureClient>();
        INinjaTraderAccountSampleClient sample = provider.GetRequiredService<INinjaTraderAccountSampleClient>();

        Assert.NotNull(close);
        Assert.NotNull(sample);
        Assert.NotSame(close, sample);
    }

    /* THE MEMORY IS ONE OBJECT, OR THE FILTER FORGETS ON EVERY PASS.
     *
     * A transient here would make LiveAccountMemory silently do nothing - the
     * relevance filter would forward every account every time and nobody would see
     * a failure, which is this bug class exactly. Two resolutions, same instance,
     * asked rather than asserted about the text of a registration. */
    [Fact]
    public void The_live_account_memory_is_one_object_for_the_whole_process()
    {
        using ServiceProvider provider = BuildRealContainer();

        Assert.Same(
            provider.GetRequiredService<LiveAccountMemory>(),
            provider.GetRequiredService<LiveAccountMemory>());
        // And the loop got that same one, not a second.
        AccountSampleLoop loop = Assert.Single(
            provider.GetServices<ICollectorLoop>().OfType<AccountSampleLoop>());
        FieldInfo field = typeof(AccountSampleLoop)
            .GetField("liveAccounts", BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(field);
        Assert.Same(provider.GetRequiredService<LiveAccountMemory>(), field.GetValue(loop));
    }

    /* Nothing the loop needs can be quietly left out: an argument that cannot be
     * defaulted cannot be silently omitted. Kept from the suite this file replaces,
     * because the container test above proves the registration resolves TODAY and
     * this proves the next person cannot reintroduce the optional-argument shape
     * that caused the original incident. */
    /* THE STRATEGY READING GOES THROUGH THE TRACKER'S PIPE CLIENT, never the
     * close's, and the loop holds the one process-wide restart memory. */
    [Fact]
    public void The_strategy_reading_uses_the_trackers_client_and_one_restart_memory()
    {
        using ServiceProvider provider = BuildRealContainer();

        INinjaTraderStrategySampleClient strategies = provider.GetRequiredService<INinjaTraderStrategySampleClient>();

        Assert.Same(provider.GetRequiredService<INinjaTraderAccountSampleClient>(), strategies);
        Assert.NotSame(provider.GetRequiredService<INinjaTraderCaptureClient>(), strategies);
        AccountSampleLoop loop = Assert.Single(
            provider.GetServices<ICollectorLoop>().OfType<AccountSampleLoop>());
        FieldInfo memory = typeof(AccountSampleLoop)
            .GetField("strategyRuns", BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(memory);
        Assert.Same(provider.GetRequiredService<StrategyRunMemory>(), memory.GetValue(loop));
    }

    [Fact]
    public void Nothing_the_loop_needs_can_be_quietly_left_out()
    {
        ConstructorInfo constructor = Assert.Single(typeof(AccountSampleLoop).GetConstructors());

        Assert.NotEmpty(constructor.GetParameters());
        Assert.DoesNotContain(
            constructor.GetParameters(),
            parameter => parameter.IsOptional || parameter.HasDefaultValue);
    }

    /// <summary>The real registrations, pointed at a temporary ProgramData.</summary>
    private ServiceProvider BuildRealContainer()
    {
        ServiceCollection services = new();
        AgentComposition.Register(
            services,
            AgentPaths.FromProgramData(programData),
            new ConfigurationStore(Path.Combine(programData, "config.json")),
            new Uri("https://crm.example.test/"),
            "1.1.3");
        return services.BuildServiceProvider(validateScopes: true);
    }

    /// <summary>
    /// The set the supervisor will actually iterate. Private because it is the
    /// supervisor's own business, read by reflection because the question is "what
    /// did the container hand it", which no public surface answers.
    /// </summary>
    private static ICollectorLoop[] SupervisedLoops(Worker supervisor)
    {
        FieldInfo field = typeof(Worker).GetField("loops", BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(field);
        return ((IReadOnlyCollection<ICollectorLoop>)field.GetValue(supervisor)).ToArray();
    }
}
