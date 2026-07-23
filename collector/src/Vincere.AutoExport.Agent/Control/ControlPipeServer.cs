using System;
using System.Buffers.Binary;
using System.IO;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Crm;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Scheduling;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Agent.Service;

namespace Vincere.AutoExport.Agent.Control;

public sealed record ControlCommandRequest(
    string Command,
    Guid RequestId,
    string EnrollmentCode = null,
    string ScheduleTime = null,
    bool Confirmed = false);

public sealed record ControlCommandResponse(
    Guid RequestId,
    bool Ok,
    string Code,
    string Message,
    object Data = null);

public sealed record ControlStatusData(
    bool Paired,
    string DeviceId,
    string ClientName,
    string ScheduleTime,
    string TimeZone,
    CollectorStatusSnapshot Runtime,
    QueueStatus Queue);

public interface IDiagnosticsCollector
{
    Task<string> CollectAsync(CancellationToken cancellationToken = default);
}

public interface IControlCommandHandler
{
    Task<ControlCommandResponse> HandleAsync(
        ControlCommandRequest request,
        bool isAdministrator,
        CancellationToken cancellationToken = default);
}

public sealed class ControlCommandHandler : IControlCommandHandler
{
    private readonly IAgentOptionsStore optionsStore;
    private readonly ICollectorCrmClient crm;
    private readonly ICaptureScheduler scheduler;
    private readonly ICollectorClock clock;
    private readonly IDeviceTokenStore tokenStore;
    private readonly ICollectorQueue queue;
    private readonly CollectorState state;
    private readonly IDiagnosticsCollector diagnostics;
    private readonly string agentVersion;
    private readonly string addonVersion;

    public ControlCommandHandler(
        IAgentOptionsStore optionsStore,
        ICollectorCrmClient crm,
        ICaptureScheduler scheduler,
        ICollectorClock clock,
        IDeviceTokenStore tokenStore,
        ICollectorQueue queue,
        CollectorState state,
        IDiagnosticsCollector diagnostics,
        string agentVersion,
        string addonVersion)
    {
        this.optionsStore = optionsStore ?? throw new ArgumentNullException(nameof(optionsStore));
        this.crm = crm ?? throw new ArgumentNullException(nameof(crm));
        this.scheduler = scheduler ?? throw new ArgumentNullException(nameof(scheduler));
        this.clock = clock ?? throw new ArgumentNullException(nameof(clock));
        this.tokenStore = tokenStore ?? throw new ArgumentNullException(nameof(tokenStore));
        this.queue = queue ?? throw new ArgumentNullException(nameof(queue));
        this.state = state ?? throw new ArgumentNullException(nameof(state));
        this.diagnostics = diagnostics ?? throw new ArgumentNullException(nameof(diagnostics));
        this.agentVersion = agentVersion ?? throw new ArgumentNullException(nameof(agentVersion));
        this.addonVersion = addonVersion ?? throw new ArgumentNullException(nameof(addonVersion));
    }

    public async Task<ControlCommandResponse> HandleAsync(
        ControlCommandRequest request,
        bool isAdministrator,
        CancellationToken cancellationToken = default)
    {
        if (request == null || request.RequestId == Guid.Empty || string.IsNullOrWhiteSpace(request.Command))
            return Failure(request?.RequestId ?? Guid.Empty, "control_request_invalid", "The control request is invalid.");
        string command = request.Command.Trim();
        if (command != "status" && !isAdministrator)
            return Failure(request.RequestId, "administrator_required", "Administrator approval is required.");

        try
        {
            return command switch
            {
                "status" => await StatusAsync(request.RequestId, cancellationToken).ConfigureAwait(false),
                "pair" => await PairAsync(request, cancellationToken).ConfigureAwait(false),
                "testCapture" or "captureNow" => await CaptureAsync(request.RequestId, cancellationToken).ConfigureAwait(false),
                "updateSchedule" => await UpdateScheduleAsync(request, cancellationToken).ConfigureAwait(false),
                "collectDiagnostics" => Success(
                    request.RequestId,
                    "diagnostics_ready",
                    "The redacted diagnostics package is ready.",
                    new { path = await diagnostics.CollectAsync(cancellationToken).ConfigureAwait(false) }),
                "forgetDevice" => await ForgetDeviceAsync(request, cancellationToken).ConfigureAwait(false),
                _ => Failure(request.RequestId, "control_command_unknown", "The control command is not supported."),
            };
        }
        catch (CrmClientException exception)
        {
            return Failure(request.RequestId, exception.Code, exception.Message);
        }
        catch (AgentConfigurationException exception)
        {
            return Failure(request.RequestId, exception.Code, exception.Message);
        }
        catch (CaptureAttemptException exception)
        {
            return Failure(request.RequestId, exception.Code, exception.Message);
        }
    }

    private async Task<ControlCommandResponse> StatusAsync(Guid requestId, CancellationToken cancellationToken)
    {
        AgentOptions options = (await optionsStore.LoadAsync(cancellationToken).ConfigureAwait(false)).Options;
        QueueStatus queueStatus = await queue.GetStatusAsync(cancellationToken).ConfigureAwait(false);
        bool paired = !string.IsNullOrWhiteSpace(await tokenStore.LoadTokenAsync(cancellationToken).ConfigureAwait(false));
        return Success(
            requestId,
            "status_ok",
            "Collector status is available.",
            new ControlStatusData(
                paired,
                options.DeviceId,
                options.ClientName,
                options.ScheduleTime,
                options.TimeZone,
                state.Snapshot(),
                queueStatus));
    }

    private async Task<ControlCommandResponse> PairAsync(
        ControlCommandRequest request,
        CancellationToken cancellationToken)
    {
        PairingResult result = await crm.PairAsync(
            request.EnrollmentCode,
            agentVersion,
            addonVersion,
            cancellationToken).ConfigureAwait(false);
        try
        {
            AgentOptions options = (await optionsStore.LoadAsync(cancellationToken).ConfigureAwait(false)).Options;
            await optionsStore.SaveAsync(options with
            {
                DeviceId = result.DeviceId,
                ClientName = result.ClientName,
                ScheduleTime = result.ScheduleTime,
                TimeZone = result.TimeZone,
            }, cancellationToken).ConfigureAwait(false);
        }
        catch
        {
            await tokenStore.DeleteTokenAsync(CancellationToken.None).ConfigureAwait(false);
            throw;
        }
        return Success(
            request.RequestId,
            "paired",
            "This VPS is connected to the CRM.",
            new { result.DeviceId, result.ClientName, result.ScheduleTime, result.TimeZone });
    }

    private async Task<ControlCommandResponse> CaptureAsync(Guid requestId, CancellationToken cancellationToken)
    {
        CaptureRunResult result = await scheduler.RunManualAsync(clock.GetCurrentInstant(), cancellationToken)
            .ConfigureAwait(false);
        state.RecordCapture(result, clock.GetCurrentDateTimeOffset());
        return result.CaptureQueued
            ? Success(requestId, "capture_queued", "NinjaTrader data was captured and queued.")
            : Failure(requestId, result.ErrorCode ?? "capture_failed", "NinjaTrader data could not be captured.");
    }

    private async Task<ControlCommandResponse> UpdateScheduleAsync(
        ControlCommandRequest request,
        CancellationToken cancellationToken)
    {
        AgentOptions options = (await optionsStore.LoadAsync(cancellationToken).ConfigureAwait(false)).Options;
        await optionsStore.SaveAsync(options with { ScheduleTime = request.ScheduleTime }, cancellationToken)
            .ConfigureAwait(false);
        return Success(request.RequestId, "schedule_updated", "The New York capture time was updated.");
    }

    private async Task<ControlCommandResponse> ForgetDeviceAsync(
        ControlCommandRequest request,
        CancellationToken cancellationToken)
    {
        if (!request.Confirmed)
            return Failure(request.RequestId, "confirmation_required", "Explicit confirmation is required.");
        await tokenStore.DeleteTokenAsync(cancellationToken).ConfigureAwait(false);
        AgentOptions options = (await optionsStore.LoadAsync(cancellationToken).ConfigureAwait(false)).Options;
        await optionsStore.SaveAsync(options with { DeviceId = null, ClientName = null }, cancellationToken)
            .ConfigureAwait(false);
        state.RecordUnpaired();
        return Success(
            request.RequestId,
            "device_forgotten_with_orphan_warning",
            "The local credential was deleted. Revoke the old device in CRM Manager if it is still active.");
    }

    private static ControlCommandResponse Success(Guid requestId, string code, string message, object data = null)
        => new(requestId, true, code, message, data);

    private static ControlCommandResponse Failure(Guid requestId, string code, string message)
        => new(requestId, false, code, message);
}

public sealed class ControlPipeServer : ICollectorLoop
{
    public const string DefaultPipeName = "Vincere.AutoExport.Control.v1";
    private const int MaximumFrameBytes = 64 * 1024;
    private static readonly UTF8Encoding Utf8WithoutBom = new(false, true);
    private readonly string pipeName;
    private readonly IControlCommandHandler handler;

    public ControlPipeServer(IControlCommandHandler handler, string pipeName = DefaultPipeName)
    {
        this.handler = handler ?? throw new ArgumentNullException(nameof(handler));
        if (string.IsNullOrWhiteSpace(pipeName)) throw new ArgumentException("A control pipe name is required.", nameof(pipeName));
        this.pipeName = pipeName;
    }

    public string Name => "control";
    public TimeSpan Interval => TimeSpan.FromMilliseconds(10);

    public async Task RunOnceAsync(CancellationToken cancellationToken)
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("The secured control pipe requires Windows.");
        using NamedPipeServerStream pipe = CreatePipe();
        await pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
        bool administrator = IsAdministrator(pipe);
        ControlCommandRequest request = await ReadFrameAsync<ControlCommandRequest>(pipe, cancellationToken)
            .ConfigureAwait(false);
        ControlCommandResponse response = await handler.HandleAsync(request, administrator, cancellationToken)
            .ConfigureAwait(false);
        await WriteFrameAsync(pipe, response, cancellationToken).ConfigureAwait(false);
    }

    private NamedPipeServerStream CreatePipe()
    {
        SecurityIdentifier system = new(WellKnownSidType.LocalSystemSid, null);
        SecurityIdentifier administrators = new(WellKnownSidType.BuiltinAdministratorsSid, null);
        PipeSecurity security = new();
        security.SetAccessRuleProtection(isProtected: true, preserveInheritance: false);
        security.AddAccessRule(new PipeAccessRule(system, PipeAccessRights.FullControl, AccessControlType.Allow));
        security.AddAccessRule(new PipeAccessRule(administrators, PipeAccessRights.ReadWrite, AccessControlType.Allow));
        return NamedPipeServerStreamAcl.Create(
            pipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous,
            4096,
            4096,
            security);
    }

    private static bool IsAdministrator(NamedPipeServerStream pipe)
    {
        bool administrator = false;
        pipe.RunAsClient(() =>
        {
            using WindowsIdentity identity = WindowsIdentity.GetCurrent();
            WindowsPrincipal principal = new(identity);
            administrator = identity.IsSystem || principal.IsInRole(WindowsBuiltInRole.Administrator);
        });
        return administrator;
    }

    private static async Task<T> ReadFrameAsync<T>(Stream stream, CancellationToken cancellationToken)
    {
        byte[] lengthBytes = new byte[4];
        await stream.ReadExactlyAsync(lengthBytes, cancellationToken).ConfigureAwait(false);
        int length = BinaryPrimitives.ReadInt32LittleEndian(lengthBytes);
        if (length <= 0 || length > MaximumFrameBytes) throw new InvalidDataException("The control frame length is invalid.");
        byte[] payload = new byte[length];
        await stream.ReadExactlyAsync(payload, cancellationToken).ConfigureAwait(false);
        try
        {
            return JsonConvert.DeserializeObject<T>(Utf8WithoutBom.GetString(payload))
                ?? throw new InvalidDataException("The control frame is empty.");
        }
        catch (JsonException)
        {
            throw new InvalidDataException("The control frame is invalid.");
        }
    }

    private static async Task WriteFrameAsync<T>(Stream stream, T value, CancellationToken cancellationToken)
    {
        byte[] payload = Utf8WithoutBom.GetBytes(JsonConvert.SerializeObject(value, Formatting.None));
        if (payload.Length > MaximumFrameBytes) throw new InvalidDataException("The control response is too large.");
        byte[] length = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(length, payload.Length);
        await stream.WriteAsync(length, cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }
}
