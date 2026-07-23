using System;
using System.IO;
using System.Reflection;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Vincere.AutoExport.Agent.Capture;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Control;
using Vincere.AutoExport.Agent.Crm;
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
builder.Services.AddSingleton<INinjaTraderCaptureClient, CapturePipeClient>();
builder.Services.AddSingleton<ICaptureWorkflow>(provider => new CaptureAndQueueWorkflow(
    provider.GetRequiredService<INinjaTraderCaptureClient>(),
    provider.GetRequiredService<ICollectorQueue>(),
    provider.GetRequiredService<IMachineGuidSource>(),
    version));
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
    version,
    "1.0.0"));
builder.Services.AddSingleton<ICollectorLoop, QueueRecoveryLoop>();
builder.Services.AddSingleton<ICollectorLoop, ScheduledCaptureLoop>();
builder.Services.AddSingleton<ICollectorLoop, UploadLoop>();
builder.Services.AddSingleton<ICollectorLoop>(provider => new HeartbeatLoop(
    provider.GetRequiredService<ICollectorQueue>(),
    provider.GetRequiredService<ICollectorCrmClient>(),
    provider.GetRequiredService<IDeviceTokenStore>(),
    provider.GetRequiredService<CollectorState>(),
    version,
    "1.0.0",
    "8.1.0"));
builder.Services.AddSingleton<ICollectorLoop, ControlPipeServer>();
builder.Services.AddHostedService<Worker>();

await builder.Build().RunAsync();
