using System;
using System.Buffers.Binary;
using System.IO;
using System.IO.Pipes;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Control;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

// The transport itself, not the command handler.
//
// This exists because the transport was broken in production while every handler
// test passed. The server impersonated the client the instant the pipe connected,
// before the client had written anything. Windows does not publish the caller's
// token that early, so the call threw, the supervisor tore the connection down,
// and Setup reported "The service returned an invalid response" on every attempt.
// The install could not leave step 1 on a clean, correctly privileged machine.
//
// These are Windows-only: the pipe server refuses to run anywhere else by design.
// They are skipped on other platforms rather than deleted, because the defect they
// pin can only exist on the platform that ships.
public sealed class ControlPipeTransportTests
{
    private static bool OnWindows => OperatingSystem.IsWindows();

    [Fact]
    public async Task AnswersAClientThatConnectsAndOnlyWritesAfterAPause()
    {
        if (!OnWindows) return; // The control pipe is Windows-only by design.

        string pipeName = $"Vincere.AutoExport.Control.Test.{Guid.NewGuid():N}";
        EchoHandler handler = new();
        ControlPipeServer server = new(handler, pipeName);
        using CancellationTokenSource lifetime = new(TimeSpan.FromSeconds(15));
        Task serving = server.RunOnceAsync(lifetime.Token);

        using NamedPipeClientStream client = new(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous,
            TokenImpersonationLevel.Impersonation);
        await client.ConnectAsync(lifetime.Token);

        // The pause is the whole point. Setup connects, then builds and serialises
        // its request before sending it, and that gap is what the old ordering
        // raced against. A server that impersonates before the first read fails
        // here and the pipe dies.
        await Task.Delay(TimeSpan.FromMilliseconds(250), lifetime.Token);

        Guid requestId = Guid.NewGuid();
        await WriteFrameAsync(client, new { command = "status", requestId }, lifetime.Token);
        ControlCommandResponse response = await ReadFrameAsync<ControlCommandResponse>(client, lifetime.Token);
        await serving;

        Assert.Equal(requestId, response.RequestId);
        Assert.True(response.Ok);
        Assert.Equal("status", handler.LastCommand);
    }

    [Fact]
    public async Task DoesNotDropTheConnectionWhenTheCallerCannotBeImpersonated()
    {
        if (!OnWindows) return; // The control pipe is Windows-only by design.

        string pipeName = $"Vincere.AutoExport.Control.Test.{Guid.NewGuid():N}";
        EchoHandler handler = new();
        ControlPipeServer server = new(handler, pipeName);
        using CancellationTokenSource lifetime = new(TimeSpan.FromSeconds(15));
        Task serving = server.RunOnceAsync(lifetime.Token);

        // TokenImpersonationLevel.None denies the server the right to impersonate.
        // The connection must still be answered: `status` needs no privilege, and a
        // command that does must come back as a refusal the caller can read, never
        // as a severed pipe.
        using NamedPipeClientStream client = new(
            ".",
            pipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous,
            TokenImpersonationLevel.None);
        await client.ConnectAsync(lifetime.Token);

        Guid requestId = Guid.NewGuid();
        await WriteFrameAsync(client, new { command = "status", requestId }, lifetime.Token);
        ControlCommandResponse response = await ReadFrameAsync<ControlCommandResponse>(client, lifetime.Token);
        await serving;

        Assert.Equal(requestId, response.RequestId);
        Assert.False(handler.LastIsAdministrator);
    }

    private static async Task WriteFrameAsync(Stream stream, object payload, CancellationToken cancellationToken)
    {
        byte[] body = new UTF8Encoding(false, true).GetBytes(JsonConvert.SerializeObject(payload));
        byte[] length = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(length, body.Length);
        await stream.WriteAsync(length, cancellationToken);
        await stream.WriteAsync(body, cancellationToken);
        await stream.FlushAsync(cancellationToken);
    }

    private static async Task<T> ReadFrameAsync<T>(Stream stream, CancellationToken cancellationToken)
    {
        byte[] length = new byte[4];
        await stream.ReadExactlyAsync(length, cancellationToken);
        byte[] body = new byte[BinaryPrimitives.ReadInt32LittleEndian(length)];
        await stream.ReadExactlyAsync(body, cancellationToken);
        return JsonConvert.DeserializeObject<T>(new UTF8Encoding(false, true).GetString(body));
    }

    private sealed class EchoHandler : IControlCommandHandler
    {
        public string LastCommand { get; private set; }
        public bool LastIsAdministrator { get; private set; }

        public Task<ControlCommandResponse> HandleAsync(
            ControlCommandRequest request,
            bool isAdministrator,
            CancellationToken cancellationToken = default)
        {
            LastCommand = request.Command;
            LastIsAdministrator = isAdministrator;
            return Task.FromResult(new ControlCommandResponse(request.RequestId, true, "ok", "ok", null));
        }
    }
}
