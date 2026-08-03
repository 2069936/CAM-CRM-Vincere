using System;
using System.Buffers.Binary;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Vincere.AutoExport.Agent.UI;

public sealed record UiControlResponse(
    Guid RequestId,
    bool Ok,
    string Code,
    string Message,
    JObject Data);

public interface IControlPipeClient
{
    Task<UiControlResponse> SendAsync(
        string command,
        string enrollmentCode = null,
        string scheduleTime = null,
        bool confirmed = false,
        CancellationToken cancellationToken = default);
}

public sealed class ControlPipeClient : IControlPipeClient
{
    public const string DefaultPipeName = "Vincere.AutoExport.Control.v1";
    private const int MaximumFrameBytes = 64 * 1024;
    private static readonly UTF8Encoding Utf8WithoutBom = new(false, true);
    private readonly string pipeName;
    private readonly TimeSpan connectTimeout;

    public ControlPipeClient(string pipeName = DefaultPipeName, TimeSpan? connectTimeout = null)
    {
        if (string.IsNullOrWhiteSpace(pipeName)) throw new ArgumentException("A control pipe name is required.", nameof(pipeName));
        this.pipeName = pipeName;
        this.connectTimeout = connectTimeout ?? TimeSpan.FromSeconds(3);
    }

    public async Task<UiControlResponse> SendAsync(
        string command,
        string enrollmentCode = null,
        string scheduleTime = null,
        bool confirmed = false,
        CancellationToken cancellationToken = default)
    {
        using NamedPipeClientStream pipe = new(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        using CancellationTokenSource timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(connectTimeout);
        try
        {
            await pipe.ConnectAsync(timeout.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new ControlPipeUnavailableException("The Vincere Auto Export service is not available.");
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException or TimeoutException)
        {
            throw new ControlPipeUnavailableException("Open this setup app as an administrator and confirm the service is running.");
        }

        Guid requestId = Guid.NewGuid();
        await WriteFrameAsync(pipe, new
        {
            command,
            requestId,
            enrollmentCode,
            scheduleTime,
            confirmed,
        }, cancellationToken).ConfigureAwait(false);
        UiControlResponse response = await ReadFrameAsync<UiControlResponse>(pipe, cancellationToken).ConfigureAwait(false);
        if (response.RequestId != requestId)
            throw new InvalidDataException("The service response did not match this request.");
        return response;
    }

    private static async Task<T> ReadFrameAsync<T>(Stream stream, CancellationToken cancellationToken)
    {
        byte[] lengthBytes = new byte[4];
        await stream.ReadExactlyAsync(lengthBytes, cancellationToken).ConfigureAwait(false);
        int length = BinaryPrimitives.ReadInt32LittleEndian(lengthBytes);
        if (length <= 0 || length > MaximumFrameBytes) throw new InvalidDataException("The service response is too large.");
        byte[] payload = new byte[length];
        await stream.ReadExactlyAsync(payload, cancellationToken).ConfigureAwait(false);
        return JsonConvert.DeserializeObject<T>(Utf8WithoutBom.GetString(payload))
            ?? throw new InvalidDataException("The service returned an empty response.");
    }

    private static async Task WriteFrameAsync<T>(Stream stream, T value, CancellationToken cancellationToken)
    {
        byte[] payload = Utf8WithoutBom.GetBytes(JsonConvert.SerializeObject(value, Formatting.None));
        if (payload.Length > MaximumFrameBytes) throw new InvalidDataException("The setup request is too large.");
        byte[] length = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(length, payload.Length);
        await stream.WriteAsync(length, cancellationToken).ConfigureAwait(false);
        await stream.WriteAsync(payload, cancellationToken).ConfigureAwait(false);
        await stream.FlushAsync(cancellationToken).ConfigureAwait(false);
    }
}

public sealed class ControlPipeUnavailableException : Exception
{
    public ControlPipeUnavailableException(string message) : base(message)
    {
    }
}
