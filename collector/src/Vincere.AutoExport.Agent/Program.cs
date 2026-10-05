using System;
using System.Reflection;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Vincere.AutoExport.Agent;
using Vincere.AutoExport.Agent.Configuration;

/* WHAT IS LEFT HERE, AND WHY EVERY REGISTRATION MOVED OUT.
 *
 * This is a top-level program: it has no entry point anything can call, so for as
 * long as the registrations lived here the only question a test could ask about
 * the composition root was what the FILE SAID. That is not the question. The loop
 * registration was commented out while the asserted string stayed on the line, the
 * account tracker was registered on no machine, and 344 of 344 tests passed.
 *
 * So the registrations are in AgentComposition.Register, which a test builds,
 * resolves and interrogates. What remains here is the three things that genuinely
 * cannot happen anywhere else: finding ProgramData, loading config.json, and
 * refusing to start a service that has no CRM endpoint to talk to. */
HostApplicationBuilder builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options => options.ServiceName = "Vincere Auto Export");

AgentPaths paths = AgentPaths.FromEnvironment();
ConfigurationStore configurationStore = new(paths.Configuration);
ConfigurationLoadResult loaded = await configurationStore.LoadAsync();
AgentOptions options = loaded.Options;
if (!Uri.TryCreate(options.CrmBaseUrl, UriKind.Absolute, out Uri crmBaseUri))
    throw new AgentConfigurationException("configuration_endpoint_missing", "The CRM endpoint has not been configured.");

string version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(3) ?? "1.0.0";

AgentComposition.Register(builder.Services, paths, configurationStore, crmBaseUri, version);

await builder.Build().RunAsync();
