using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Capture;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class AccountSamplePipeClientTests
{
    [Fact]
    public async Task A_sample_asks_for_the_light_command_and_never_for_a_capture()
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        string observedCommand = null;
        Task serverTask = ServeOnceAsync(server, request =>
        {
            observedCommand = request.Command;
            return new CaptureResponse
            {
                Ok = true,
                RequestId = request.RequestId,
                Sample = Sample(),
            };
        });

        AccountSampleAttempt attempt = await CreateClient(pipeName, running: true).SampleAccountsAsync();
        await serverTask;

        Assert.Equal("sample_accounts", observedCommand);
        Assert.Equal(AccountSampleOutcome.Sampled, attempt.Outcome);
        Assert.Equal("APEX-1111", Assert.Single(attempt.Sample.Accounts).AccountName);
        Assert.Null(attempt.Code);
    }

    /* THE TEST THIS WHOLE METHOD EXISTS FOR.
     *
     * CaptureAsync answers "capture_failed" for every unsuccessful response and
     * discards the add-on's own ErrorCode - ServerFailureBecomesStableCaptureFailedCode
     * locks that in, and for a close it is right. For the tracker that discarded
     * field IS the version negotiation, because the pipe has no handshake and an
     * add-on that predates this command answers "invalid_request" cleanly. Flatten
     * it and an old fleet is indistinguishable from a broken one, the misdiagnosis
     * rides onto the heartbeat under a code the heartbeat accepts, and the loop
     * retries a command the add-on will never take, every ten minutes, forever.
     *
     * Unsupported is what earns a day of silence instead. */
    [Fact]
    public async Task An_addon_that_does_not_know_the_command_is_unsupported_and_not_a_failure()
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        Task serverTask = ServeOnceAsync(server, request => new CaptureResponse
        {
            Ok = false,
            RequestId = request.RequestId,
            ErrorCode = "invalid_request",
            Message = "The capture request is invalid.",
        });

        AccountSampleAttempt attempt = await CreateClient(pipeName, running: true).SampleAccountsAsync();
        await serverTask;

        Assert.Equal(AccountSampleOutcome.Unsupported, attempt.Outcome);
        Assert.Equal("invalid_request", attempt.Code);
        Assert.Null(attempt.Sample);
    }

    /* AND EVERY OTHER REFUSAL IS MERELY THIS READING LOST. capture_busy is the
     * interesting one: it is what the add-on says when the day's close is already
     * on the dispatcher. Not Unsupported - the add-on is perfectly capable, it is
     * just busy with something that matters more - so the next tick asks again. */
    [Theory]
    [InlineData("capture_busy")]
    [InlineData("sample_timeout")]
    [InlineData("sample_failed")]
    [InlineData(null)]
    public async Task Any_other_refusal_is_unavailable_and_keeps_the_addons_own_word(string code)
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        Task serverTask = ServeOnceAsync(server, request => new CaptureResponse
        {
            Ok = false,
            RequestId = request.RequestId,
            ErrorCode = code,
        });

        AccountSampleAttempt attempt = await CreateClient(pipeName, running: true).SampleAccountsAsync();
        await serverTask;

        Assert.Equal(AccountSampleOutcome.Unavailable, attempt.Outcome);
        Assert.Equal(code ?? "sample_failed", attempt.Code);
    }

    [Fact]
    public async Task A_closed_terminal_costs_no_connect_attempt_at_all()
    {
        AccountSampleAttempt attempt = await CreateClient(PipeName(), running: false).SampleAccountsAsync();

        Assert.Equal(AccountSampleOutcome.Unavailable, attempt.Outcome);
        Assert.Equal("ninjatrader_not_running", attempt.Code);
    }

    /* THE DAY'S CLOSE HOLDING THE PIPE, which is the collision the design has to
     * answer. CapturePipeServer serves one connection at a time and creates the
     * next pipe only after the previous handler returns, so a sample that arrives
     * mid-capture never reaches the add-on's busy gate - it waits on ConnectAsync
     * and gives up. Here there is no server listening at all, which is the same
     * observable. The close never loses to a sample; the sample is forgotten. */
    [Fact]
    public async Task A_pipe_nobody_is_serving_is_unavailable_rather_than_an_exception()
    {
        AccountSampleAttempt attempt = await CreateClient(PipeName(), running: true).SampleAccountsAsync();

        Assert.Equal(AccountSampleOutcome.Unavailable, attempt.Outcome);
        Assert.Equal("addon_unavailable", attempt.Code);
    }

    [Fact]
    public async Task A_server_that_never_answers_gives_up_under_the_samples_own_timeout()
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        using CancellationTokenSource serverStop = new();
        Task serverTask = Task.Run(async () =>
        {
            await server.WaitForConnectionAsync(serverStop.Token);
            await Task.Delay(Timeout.InfiniteTimeSpan, serverStop.Token);
        });
        CapturePipeClient client = new(
            pipeName,
            new FixedProcessDetector(true),
            connectTimeout: TimeSpan.FromSeconds(1),
            sampleTimeout: TimeSpan.FromMilliseconds(100));

        AccountSampleAttempt attempt = await client.SampleAccountsAsync();
        serverStop.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => serverTask);

        Assert.Equal(AccountSampleOutcome.Unavailable, attempt.Outcome);
        Assert.Equal("sample_timeout", attempt.Code);
    }

    [Fact]
    public async Task A_reply_for_someone_elses_request_is_not_a_sample()
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        Task serverTask = ServeOnceAsync(server, _ => new CaptureResponse
        {
            Ok = true,
            RequestId = Guid.NewGuid(),
            Sample = Sample(),
        });

        AccountSampleAttempt attempt = await CreateClient(pipeName, running: true).SampleAccountsAsync();
        await serverTask;

        Assert.Equal(AccountSampleOutcome.Unavailable, attempt.Outcome);
        Assert.Equal("contract_mismatch", attempt.Code);
    }

    /* A SUCCESSFUL RESPONSE CARRYING A SNAPSHOT AND NO SAMPLE IS NOT A SAMPLE, and
     * this is the assertion that the two shapes cannot be confused. If the tracker
     * had reused AutoExportSnapshotV1 with empty lists there would be nothing here
     * to assert: a sample and a close would be structurally identical, and one
     * wrong call site would turn a 10:15 reading into the day's import. */
    [Fact]
    public async Task A_close_arriving_on_the_sample_channel_is_refused()
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        Task serverTask = ServeOnceAsync(server, request => new CaptureResponse
        {
            Ok = true,
            RequestId = request.RequestId,
            Snapshot = new AutoExportSnapshotV1
            {
                SchemaVersion = 1,
                Accounts = new List<AccountRowV1>(),
                Strategies = new List<StrategyRowV1>(),
                Orders = new List<OrderRowV1>(),
                Executions = new List<ExecutionRowV1>(),
            },
        });

        AccountSampleAttempt attempt = await CreateClient(pipeName, running: true).SampleAccountsAsync();
        await serverTask;

        Assert.Equal(AccountSampleOutcome.Unavailable, attempt.Outcome);
        Assert.Equal("contract_mismatch", attempt.Code);
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    public async Task A_sample_from_a_future_schema_is_refused(int schemaVersion)
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        AccountSampleV1 sample = Sample();
        sample.SchemaVersion = schemaVersion;
        Task serverTask = ServeOnceAsync(server, request => new CaptureResponse
        {
            Ok = true,
            RequestId = request.RequestId,
            Sample = sample,
        });

        AccountSampleAttempt attempt = await CreateClient(pipeName, running: true).SampleAccountsAsync();
        await serverTask;

        Assert.Equal("contract_mismatch", attempt.Code);
    }

    /* A CLOSE'S RESPONSE IS BYTE FOR BYTE WHAT IT WAS BEFORE THE TRACKER EXISTED.
     *
     * `sample` is declared NullValueHandling.Ignore, and this is why that matters
     * rather than being tidiness: every other member of CaptureResponse serialises
     * its null, so a plain new property added fourteen bytes of `"sample":null,` to
     * EVERY response including the day's capture. A frame-limit test sitting on
     * that boundary is what caught it. This asserts the add-on's own wire format
     * for a close is untouched. */
    [Fact]
    public void The_sample_field_is_absent_from_a_response_that_has_none()
    {
        string json = JsonConvert.SerializeObject(new CaptureResponse
        {
            Ok = false,
            RequestId = Guid.NewGuid(),
            ErrorCode = "capture_busy",
            Message = "busy",
        });

        Assert.DoesNotContain("sample", json, StringComparison.Ordinal);
        // And the pre-existing null that the close has always carried is still
        // carried: this change does not quietly reformat the irreplaceable path.
        Assert.Contains("\"snapshot\":null", json, StringComparison.Ordinal);
    }

    private static CapturePipeClient CreateClient(string pipeName, bool running)
    {
        return new CapturePipeClient(
            pipeName,
            new FixedProcessDetector(running),
            connectTimeout: TimeSpan.FromMilliseconds(100),
            sampleTimeout: TimeSpan.FromSeconds(2));
    }

    private static NamedPipeServerStream CreateServer(string pipeName)
    {
        return new NamedPipeServerStream(
            pipeName,
            PipeDirection.InOut,
            1,
            PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous);
    }

    private static async Task ServeOnceAsync(
        NamedPipeServerStream server,
        Func<CaptureRequest, CaptureResponse> responseFactory)
    {
        await server.WaitForConnectionAsync();
        CaptureRequest request = await ReadFrameAsync<CaptureRequest>(server);
        await WriteFrameAsync(server, responseFactory(request));
    }

    private static async Task<T> ReadFrameAsync<T>(Stream stream)
    {
        byte[] lengthBytes = new byte[4];
        await stream.ReadExactlyAsync(lengthBytes);
        int length = BinaryPrimitives.ReadInt32LittleEndian(lengthBytes);
        byte[] payload = new byte[length];
        await stream.ReadExactlyAsync(payload);
        return JsonConvert.DeserializeObject<T>(Encoding.UTF8.GetString(payload));
    }

    private static async Task WriteFrameAsync<T>(Stream stream, T value)
    {
        byte[] payload = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(value));
        byte[] length = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(length, payload.Length);
        await stream.WriteAsync(length);
        await stream.WriteAsync(payload);
        await stream.FlushAsync();
    }

    private static string PipeName() => "vas" + Guid.NewGuid().ToString("N")[..8];

    private static AccountSampleV1 Sample()
    {
        return new AccountSampleV1
        {
            SchemaVersion = 1,
            SampledAt = new DateTimeOffset(2026, 10, 5, 10, 15, 0, TimeSpan.FromHours(-4)),
            Accounts = new List<AccountSampleRowV1>
            {
                new()
                {
                    AccountName = "APEX-1111",
                    Connected = true,
                    Status = "Connected",
                    StrategyCount = 2,
                    EnabledStrategyCount = 1,
                },
            },
        };
    }

    private sealed class FixedProcessDetector : INinjaTraderProcessDetector
    {
        private readonly bool isRunning;

        public FixedProcessDetector(bool isRunning) => this.isRunning = isRunning;

        public bool IsRunning() => isRunning;
    }
}
