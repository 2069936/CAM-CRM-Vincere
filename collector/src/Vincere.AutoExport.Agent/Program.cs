using System;
using System.IO;
using System.Reflection;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Vincere.AutoExport.Agent.Capture;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Control;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.History;
using Vincere.AutoExport.Agent.Diagnostics;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Scheduling;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Service;

HostApplicationBuilder builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "Vincere Auto Export");

AgentPaths paths = AgentPaths.FromEnvironment();
ConfigurationStore configurationStore = new(paths.Configuration);
ConfigurationLoadResult loaded = await configurationStore.LoadAsync();
AgentOptions options = loaded.Options;
if (!Uri.TryCreate(options.CrmBaseUrl, UriKind.Absolute, out Uri crmBaseUri))
    throw new AgentConfigurationException("configuration_endpoint_missing", "The CRM endpoint has not been configured.");

string version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.0.0";
string queueRoot = Path.GetDirectoryName(paths.PendingQueue)
    ?? throw new InvalidOperationException("The queue root is invalid.");

builder.Services.AddSingleton<IAgentOptionsStore>(configurationStore);
builder.Services.AddSingleton<IDeviceTokenStore>(new DpapiSecretStore(paths.Secret));
builder.Services.AddSingleton<IMachineGuidSource, WindowsMachineGuidSource>();
builder.Services.AddSingleton<ICollectorQueue>(_ => new SnapshotQueue(
    queueRoot,
    new WindowsAgentDirectorySecurity()));
builder.Services.AddSingleton<ICaptureHistoryStore>(new CaptureHistoryStore(paths.History));
// The last account classification the CRM was able to send. Written after every
// accepted upload, read by the Setup window's local report when the CRM cannot
// be reached. See RosterStore for why the machine needs it at all.
builder.Services.AddSingleton<IRosterStore>(new RosterStore(paths.Roster, new WindowsAgentDirectorySecurity()));
builder.Services.AddSingleton<IStrategyObservationStore>(
    new StrategyObservationStore(System.IO.Path.Combine(paths.Root, "strategies.json")));
builder.Services.AddSingleton<INinjaTraderCaptureClient, CapturePipeClient>();
/* THE TRACKER'S PIPE CLIENT, DELIBERATELY A SECOND INSTANCE OF THE SAME CLASS.
 *
 * CapturePipeClient holds no mutable state - it opens a pipe per call - so the
 * two instances cost nothing and share nothing. That is the reason to have two:
 * whatever the tracker does to its client, it provably cannot reach the object
 * the day's close depends on. Resolving one instance under both interfaces would
 * have been tidier and would have put the irreplaceable path and the disposable
 * one on the same object. */
builder.Services.AddSingleton<INinjaTraderAccountSampleClient, CapturePipeClient>();
/* Which accounts this machine has seen working. In memory, per process, and a
 * singleton because it is the memory itself: a new one per resolution would
 * forget on every pass and the filter would do nothing. LiveAccountMemory says
 * why it must not survive a restart. */
builder.Services.AddSingleton<LiveAccountMemory>();
builder.Services.AddSingleton<ICaptureWorkflow>(provider => new CaptureAndQueueWorkflow(
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
builder.Services.AddSingleton<ICaptureScheduler, CaptureScheduler>();
builder.Services.AddSingleton<ICollectorCrmClient>(provider => CrmClient.CreateProduction(
    crmBaseUri,
    provider.GetRequiredService<IDeviceTokenStore>(),
    provider.GetRequiredService<IMachineGuidSource>()));
builder.Services.AddSingleton<CollectorState>();
builder.Services.AddSingleton<ICollectorClock, SystemCollectorClock>();
builder.Services.AddSingleton<ICollectorDelay, SystemCollectorDelay>();
builder.Services.AddSingleton<IRedactingLogger>(new RedactingLogger(paths.Logs));
builder.Services.AddSingleton<IServiceReporter, EventLogReporter>();
builder.Services.AddSingleton<IDiagnosticsCollector>(provider => new DiagnosticsCollector(
    paths,
    provider.GetRequiredService<IAgentOptionsStore>(),
    provider.GetRequiredService<IDeviceTokenStore>(),
    provider.GetRequiredService<IMachineGuidSource>(),
    provider.GetRequiredService<ICollectorQueue>(),
    provider.GetRequiredService<CollectorState>(),
    version,
    "1.0.0"));
builder.Services.AddSingleton<IControlCommandHandler>(provider => new ControlCommandHandler(
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
builder.Services.AddSingleton<QuarantineReviewLoop>(provider => new QuarantineReviewLoop(
    provider.GetRequiredService<ICollectorQueue>(),
    provider.GetRequiredService<ICollectorCrmClient>(),
    provider.GetRequiredService<IDeviceTokenStore>(),
    provider.GetRequiredService<IAgentOptionsStore>(),
    provider.GetRequiredService<ICollectorClock>(),
    provider.GetRequiredService<CollectorState>(),
    provider.GetRequiredService<IServiceReporter>(),
    provider.GetRequiredService<IRedactingLogger>()));
builder.Services.AddSingleton<IQuarantineReviewer>(provider => provider.GetRequiredService<QuarantineReviewLoop>());
builder.Services.AddSingleton<ICollectorLoop>(provider => provider.GetRequiredService<QuarantineReviewLoop>());
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
 * no defaulted parameters either, so the container must satisfy all eight or
 * resolution throws at startup where somebody will see it. AccountSampleLoopTests
 * asserts both halves of that - by-type here, and no optional arguments there -
 * so the next person who adds a dependency cannot quietly reintroduce it. */
builder.Services.AddSingleton<ICollectorLoop, AccountSampleLoop>();
builder.Services.AddSingleton<ICollectorLoop, QueueRecoveryLoop>();
builder.Services.AddSingleton<ICollectorLoop, ScheduledCaptureLoop>();
builder.Services.AddSingleton<ICollectorLoop, UploadLoop>();
builder.Services.AddSingleton<ICollectorLoop>(provider => new HeartbeatLoop(
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
builder.Services.AddSingleton<ICollectorLoop>(provider => new ReportEmailLoop(
    new QueueCaptureReader(queueRoot),
    provider.GetRequiredService<ICollectorCrmClient>(),
    provider.GetRequiredService<IRosterStore>(),
    new DpapiSecretStore(paths.RelaySecret),
    provider.GetRequiredService<IAgentOptionsStore>(),
    provider.GetRequiredService<ICollectorClock>(),
    provider.GetRequiredService<IServiceReporter>()));
builder.Services.AddSingleton<ICollectorLoop, ControlPipeServer>();
builder.Services.AddHostedService<Worker>();

await builder.Build().RunAsync();
