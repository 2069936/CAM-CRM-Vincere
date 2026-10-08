using System;
using System.IO;
using Microsoft.Extensions.DependencyInjection;
using Vincere.AutoExport.Agent.Capture;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Control;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Diagnostics;
using Vincere.AutoExport.Agent.History;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Scheduling;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Service;

namespace Vincere.AutoExport.Agent;

/// <summary>
/// THE COMPOSITION ROOT, AS A METHOD A TEST CAN CALL.
///
/// It used to be the body of Program.cs, which is a top-level program: there is
/// no entry point to call, so nothing could ask the real container a question and
/// the only thing a test could do was read the file as text. That is not a
/// cosmetic gap. A loop here once took a store as an optional last argument,
/// Program.cs forgot to pass it, it compiled, the heartbeat kept succeeding, and
/// no report was ever mailed again - silently, forever, with nothing anywhere to
/// say so. The guard written for that was three Assert.Contains calls against
/// Program.cs's text, and a comment satisfies an Assert.Contains: commenting out
/// `AddSingleton&lt;ICollectorLoop, AccountSampleLoop&gt;()` while leaving the
/// same string on the line left the whole account tracker unregistered, running
/// on no machine, with 344 of 344 tests green. Measured, not supposed.
///
/// So the registrations live here instead, and AgentCompositionTests builds this
/// exact collection, resolves the supervisor out of it, and asks the supervisor
/// which loops it holds. A commented-out registration fails that; so does a
/// dependency the container cannot satisfy, which previously threw at service
/// start on a VPS in front of nobody.
///
/// NOTHING ELSE MOVED. The order, the lambdas, the two DPAPI files, the literals
/// and every comment below are what Program.cs had. Program.cs keeps the three
/// things that genuinely cannot be done anywhere else - reading ProgramData,
/// loading config.json, and refusing to start without a CRM endpoint - and hands
/// the results in.
/// </summary>
public static class AgentComposition
{
    /// <param name="services">The host builder's own collection, or a bare one in a test.</param>
    /// <param name="paths">Where this machine keeps its state. A test points this at a temporary directory.</param>
    /// <param name="optionsStore">The configuration store Program.cs has already loaded from.</param>
    /// <param name="crmBaseUri">Validated by the caller: a service with no endpoint must not start at all.</param>
    /// <param name="version">This build's own version, which several registrations report.</param>
    public static IServiceCollection Register(
        IServiceCollection services,
        AgentPaths paths,
        IAgentOptionsStore optionsStore,
        Uri crmBaseUri,
        string version)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(paths);
        ArgumentNullException.ThrowIfNull(optionsStore);
        ArgumentNullException.ThrowIfNull(crmBaseUri);
        if (string.IsNullOrWhiteSpace(version))
            throw new ArgumentException("A version is required.", nameof(version));

        string queueRoot = Path.GetDirectoryName(paths.PendingQueue)
            ?? throw new InvalidOperationException("The queue root is invalid.");

        services.AddSingleton<IAgentOptionsStore>(optionsStore);
        services.AddSingleton<IDeviceTokenStore>(new DpapiSecretStore(paths.Secret));
        services.AddSingleton<IMachineGuidSource, WindowsMachineGuidSource>();
        services.AddSingleton<ICollectorQueue>(_ => new SnapshotQueue(
            queueRoot,
            new WindowsAgentDirectorySecurity()));
        services.AddSingleton<ICaptureHistoryStore>(new CaptureHistoryStore(paths.History));
        // The last account classification the CRM was able to send. Written after every
        // accepted upload, read by the Setup window's local report when the CRM cannot
        // be reached. See RosterStore for why the machine needs it at all.
        services.AddSingleton<IRosterStore>(new RosterStore(paths.Roster, new WindowsAgentDirectorySecurity()));
        services.AddSingleton<IStrategyObservationStore>(
            new StrategyObservationStore(Path.Combine(paths.Root, "strategies.json")));
        /* What the add-on last said it and NinjaTrader were. Written at the capture
         * that reports it, read when the service starts, so the first heartbeat
         * after an update or a reboot carries the real NinjaTrader version instead
         * of null until that day's close. The path has a trailing default on
         * AgentPaths for the callers that build the record by hand. */
        services.AddSingleton<IObservedEnvironmentStore>(new ObservedEnvironmentStore(
            paths.ObservedEnvironment ?? Path.Combine(paths.Root, "environment.json"),
            new WindowsAgentDirectorySecurity()));
        services.AddSingleton<INinjaTraderCaptureClient, CapturePipeClient>();
        /* THE TRACKER'S PIPE CLIENT, DELIBERATELY A SECOND INSTANCE OF THE SAME CLASS.
         *
         * CapturePipeClient holds no mutable state - it opens a pipe per call - so the
         * two instances cost nothing and share nothing. That is the reason to have two:
         * whatever the tracker does to its client, it provably cannot reach the object
         * the day's close depends on. Resolving one instance under both interfaces would
         * have been tidier and would have put the irreplaceable path and the disposable
         * one on the same object. */
        services.AddSingleton<INinjaTraderAccountSampleClient, CapturePipeClient>();
        /* The per strategy reading goes through the tracker's instance, not the
         * close's: it is the same disposable kind of read, and the close's client
         * stays an object nothing else touches. The cast fails at resolution, which
         * AgentCompositionTests performs, if that registration ever stops being a
         * CapturePipeClient. */
        services.AddSingleton<INinjaTraderStrategySampleClient>(provider =>
            (INinjaTraderStrategySampleClient)provider.GetRequiredService<INinjaTraderAccountSampleClient>());
        /* Which strategy instances have been switched off and on again today. In
         * memory and a singleton for the reason LiveAccountMemory is one: a fresh
         * instance per resolution would forget on every pass. */
        services.AddSingleton<StrategyRunMemory>();
        /* Which accounts this machine has seen working. In memory, per process, and a
         * singleton because it is the memory itself: a new one per resolution would
         * forget on every pass and the filter would do nothing. LiveAccountMemory says
         * why it must not survive a restart. */
        services.AddSingleton<LiveAccountMemory>();
        services.AddSingleton<ICaptureWorkflow>(provider => new CaptureAndQueueWorkflow(
            provider.GetRequiredService<INinjaTraderCaptureClient>(),
            provider.GetRequiredService<ICollectorQueue>(),
            provider.GetRequiredService<IMachineGuidSource>(),
            provider.GetRequiredService<ICaptureHistoryStore>(),
            version,
            // Every capture carries what the add-on and NinjaTrader actually are.
            // Recording it here is what lets the heartbeat report the truth instead of
            // the literal that used to be hardcoded below.
            (ninjaTraderVersion, addonVersion) => provider
                .GetRequiredService<CollectorState>()
                .RecordEnvironment(ninjaTraderVersion, addonVersion),
            // The strategies, kept from when they were still running. NinjaTrader
            // disables them around 16:30 and a disabled strategy leaves the account
            // entirely, so the capture timed to get the money right finds none.
            provider.GetRequiredService<IStrategyObservationStore>()));
        services.AddSingleton<ICaptureScheduler, CaptureScheduler>();
        services.AddSingleton<ICollectorCrmClient>(provider => CrmClient.CreateProduction(
            crmBaseUri,
            provider.GetRequiredService<IDeviceTokenStore>(),
            provider.GetRequiredService<IMachineGuidSource>()));
        /* THE STATE STARTS FROM WHAT THE LAST CAPTURE SAID. A bare CollectorState
         * knows no NinjaTrader version until the add-on reports one at the close;
         * this one reads the file the store above keeps, and RecordEnvironment
         * writes it, so both readers of the state (the heartbeat and the Setup
         * window over the control pipe) see the version from the first minute. */
        services.AddSingleton<CollectorState>(provider =>
            new CollectorState(provider.GetRequiredService<IObservedEnvironmentStore>()));
        services.AddSingleton<ICollectorClock, SystemCollectorClock>();
        services.AddSingleton<ICollectorDelay, SystemCollectorDelay>();
        services.AddSingleton<IRedactingLogger>(new RedactingLogger(paths.Logs));
        services.AddSingleton<IServiceReporter, EventLogReporter>();
        services.AddSingleton<IDiagnosticsCollector>(provider => new DiagnosticsCollector(
            paths,
            provider.GetRequiredService<IAgentOptionsStore>(),
            provider.GetRequiredService<IDeviceTokenStore>(),
            provider.GetRequiredService<IMachineGuidSource>(),
            provider.GetRequiredService<ICollectorQueue>(),
            provider.GetRequiredService<CollectorState>(),
            version,
            "1.0.0"));
        services.AddSingleton<IControlCommandHandler>(provider => new ControlCommandHandler(
            provider.GetRequiredService<IAgentOptionsStore>(),
            provider.GetRequiredService<ICollectorCrmClient>(),
            provider.GetRequiredService<ICaptureScheduler>(),
            provider.GetRequiredService<ICollectorClock>(),
            provider.GetRequiredService<IDeviceTokenStore>(),
            provider.GetRequiredService<ICollectorQueue>(),
            provider.GetRequiredService<CollectorState>(),
            provider.GetRequiredService<IDiagnosticsCollector>(),
            provider.GetRequiredService<ICaptureHistoryStore>(),
            version,
            "1.0.0",
            provider.GetRequiredService<IServiceReporter>(),
            provider.GetRequiredService<IQuarantineReviewer>()));
        // One instance wearing two hats: the loop the supervisor runs at midday, and
        // the reviewer the Setup window's button reaches through the control pipe.
        // The report backoff lives in that instance, so the button and the schedule
        // must share it or a 404 would be logged twice and offered twice a day.
        services.AddSingleton<QuarantineReviewLoop>(provider => new QuarantineReviewLoop(
            provider.GetRequiredService<ICollectorQueue>(),
            provider.GetRequiredService<ICollectorCrmClient>(),
            provider.GetRequiredService<IDeviceTokenStore>(),
            provider.GetRequiredService<IAgentOptionsStore>(),
            provider.GetRequiredService<ICollectorClock>(),
            provider.GetRequiredService<CollectorState>(),
            provider.GetRequiredService<IServiceReporter>(),
            provider.GetRequiredService<IRedactingLogger>()));
        services.AddSingleton<IQuarantineReviewer>(provider => provider.GetRequiredService<QuarantineReviewLoop>());
        services.AddSingleton<ICollectorLoop>(provider => provider.GetRequiredService<QuarantineReviewLoop>());
        /* THE ACCOUNT TRACKER, REGISTERED BY TYPE AND NOT BY FACTORY, ON PURPOSE.
         *
         * Three of the loops below are built by a hand-written lambda, because each needs
         * an argument the container does not hold - a version string, a second DPAPI file,
         * a queue reader rooted at a path. In that form every argument is typed out by a
         * person, and an omitted optional one still compiles: that is exactly how the
         * report-email loop once shipped without the secret store it needed and mailed
         * nothing, silently, forever, with nothing in the build or the tests to say so.
         *
         * This loop needs nothing that is not already a registered service, so it takes
         * the registration that cannot have that bug. AccountSampleLoop's constructor has
         * no defaulted parameters either, so the container must satisfy all ten or
         * resolution throws - and AgentCompositionTests resolves this collection, so it
         * throws there rather than at service start on a VPS in front of nobody. */
        services.AddSingleton<ICollectorLoop, AccountSampleLoop>();
        services.AddSingleton<ICollectorLoop, QueueRecoveryLoop>();
        services.AddSingleton<ICollectorLoop, ScheduledCaptureLoop>();
        services.AddSingleton<ICollectorLoop, UploadLoop>();
        services.AddSingleton<ICollectorLoop>(provider => new HeartbeatLoop(
            provider.GetRequiredService<ICollectorQueue>(),
            provider.GetRequiredService<ICollectorCrmClient>(),
            provider.GetRequiredService<IDeviceTokenStore>(),
            provider.GetRequiredService<CollectorState>(),
            version,
            // Fallbacks until the first capture reports the real ones. The add-on
            // contract version is genuinely 1.0.0; the NinjaTrader version is not
            // knowable before a capture, and inventing one put "8.1.0" on every
            // machine on the desk regardless of what was installed. A real one reads
            // 8.1.6.0. Null now, and the server accepts null.
            "1.0.0",
            null,
            provider.GetRequiredService<IServiceReporter>(),
            // Writes the relay secret the response carries. Without this the loop
            // below never finds one and mails nothing, silently, forever.
            new DpapiSecretStore(paths.RelaySecret),
            provider.GetRequiredService<IAgentOptionsStore>()));
        /* MAILING THIS MACHINE'S OWN CLOSE, EVERY TRADING DAY.
         *
         * Keyed on its own DPAPI file rather than the device token's: the two are
         * different credentials with different lifetimes, and unpairing a machine
         * deletes the token while leaving this one, which is correct - a machine that
         * has been unpaired can still tell the desk what its last close was.
         *
         * Registered after the upload loop so that on a normal day the capture is
         * already on its way before this reads it. Nothing depends on that order; it
         * just avoids two things opening the same file in the same second. */
        services.AddSingleton<ICollectorLoop>(provider => new ReportEmailLoop(
            new QueueCaptureReader(queueRoot),
            provider.GetRequiredService<ICollectorCrmClient>(),
            provider.GetRequiredService<IRosterStore>(),
            new DpapiSecretStore(paths.RelaySecret),
            provider.GetRequiredService<IAgentOptionsStore>(),
            provider.GetRequiredService<ICollectorClock>(),
            provider.GetRequiredService<IServiceReporter>()));
        services.AddSingleton<ICollectorLoop, ControlPipeServer>();
        services.AddHostedService<Worker>();
        return services;
    }
}
