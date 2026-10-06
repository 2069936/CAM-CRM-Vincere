using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.IO.Pipes;
using System.Text;
using System.Threading.Tasks;
using Newtonsoft.Json;
using Vincere.AutoExport.Agent.Capture;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class StrategySamplePipeClientTests
{
    [Fact]
    public async Task It_asks_for_the_strategy_command_and_reads_the_strategy_member()
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        string observedCommand = null;
        Task serverTask = ServeOnceAsync(server, request =>
        {
            observedCommand = request.Command;
            return new CaptureResponse { Ok = true, RequestId = request.RequestId, StrategySample = Sample() };
        });

        StrategySampleAttempt attempt = await CreateClient(pipeName).SampleStrategiesAsync();
        await serverTask;

        Assert.Equal("sample_strategies", observedCommand);
        Assert.Equal(StrategySampleOutcome.Sampled, attempt.Outcome);
        Assert.Equal(-412.5m, Assert.Single(attempt.Sample.Strategies).RealizedPnl);
        Assert.Null(attempt.Code);
    }

    /* AN ADD-ON OLDER THAN 1.2.0 ANSWERS invalid_request, AND THAT IS UNSUPPORTED,
     * not a failure: the loop stands the strategy reading down for a day and keeps
     * sampling accounts. */
    [Fact]
    public async Task An_addon_that_does_not_know_the_command_is_unsupported()
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        Task serverTask = ServeOnceAsync(server, request => new CaptureResponse
        {
            Ok = false,
            RequestId = request.RequestId,
            ErrorCode = "invalid_request",
        });

        StrategySampleAttempt attempt = await CreateClient(pipeName).SampleStrategiesAsync();
        await serverTask;

        Assert.Equal(StrategySampleOutcome.Unsupported, attempt.Outcome);
        Assert.Equal("invalid_request", attempt.Code);
    }

    [Theory]
    [InlineData("capture_busy")]
    [InlineData("strategy_sample_timeout")]
    [InlineData("strategy_sample_failed")]
    public async Task Any_other_refusal_is_this_reading_lost_under_the_addons_own_word(string code)
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        Task serverTask = ServeOnceAsync(server, request => new CaptureResponse
        {
            Ok = false,
            RequestId = request.RequestId,
            ErrorCode = code,
        });

        StrategySampleAttempt attempt = await CreateClient(pipeName).SampleStrategiesAsync();
        await serverTask;

        Assert.Equal(StrategySampleOutcome.Unavailable, attempt.Outcome);
        Assert.Equal(code, attempt.Code);
    }

    /* A REPLY OF THE WRONG SHAPE IS A CONTRACT MISMATCH FOR THE STRATEGIES ONLY:
     * no strategy member (an account sample answered on this channel), a future
     * version, or no list. */
    [Theory]
    [InlineData("account_reply")]
    [InlineData("version_0")]
    [InlineData("version_2")]
    [InlineData("no_list")]
    public async Task A_reply_of_the_wrong_shape_is_unavailable_as_a_contract_mismatch(string shape)
    {
        string pipeName = PipeName();
        using NamedPipeServerStream server = CreateServer(pipeName);
        Task serverTask = ServeOnceAsync(server, request =>
        {
            CaptureResponse response = new() { Ok = true, RequestId = request.RequestId };
            StrategySampleV1 sample = Sample();
            switch (shape)
            {
                case "account_reply":
                    response.Sample = new AccountSampleV1 { SchemaVersion = 1, Accounts = new List<AccountSampleRowV1>() };
                    return response;
                case "version_0": sample.SchemaVersion = 0; break;
                case "version_2": sample.SchemaVersion = 2; break;
                case "no_list": sample.Strategies = null; break;
            }
            response.StrategySample = sample;
            return response;
        });

        StrategySampleAttempt attempt = await CreateClient(pipeName).SampleStrategiesAsync();
        await serverTask;

        Assert.Equal(StrategySampleOutcome.Unavailable, attempt.Outcome);
        Assert.Equal("contract_mismatch", attempt.Code);
        Assert.Null(attempt.Sample);
    }

    [Fact]
    public async Task A_closed_terminal_or_a_pipe_nobody_serves_is_unavailable_and_never_throws()
    {
        CapturePipeClient closed = new(PipeName(), new FixedProcessDetector(false), connectTimeout: TimeSpan.FromMilliseconds(100));
        CapturePipeClient unserved = new(PipeName(), new FixedProcessDetector(true), connectTimeout: TimeSpan.FromMilliseconds(100));

        StrategySampleAttempt notRunning = await closed.SampleStrategiesAsync();
        StrategySampleAttempt noAddon = await unserved.SampleStrategiesAsync();

        Assert.Equal("ninjatrader_not_running", notRunning.Code);
        Assert.Equal(StrategySampleOutcome.Unavailable, noAddon.Outcome);
        Assert.Equal("addon_unavailable", noAddon.Code);
    }

    private static CapturePipeClient CreateClient(string pipeName) => new(
        pipeName,
        new FixedProcessDetector(true),
        connectTimeout: TimeSpan.FromMilliseconds(500),
        sampleTimeout: TimeSpan.FromSeconds(2));

    private static NamedPipeServerStream CreateServer(string pipeName) => new(
        pipeName,
        PipeDirection.InOut,
        1,
        PipeTransmissionMode.Byte,
        PipeOptions.Asynchronous);

    private static async Task ServeOnceAsync(
        NamedPipeServerStream server,
        Func<CaptureRequest, CaptureResponse> responseFactory)
    {
        await server.WaitForConnectionAsync();
        byte[] lengthBytes = new byte[4];
        await server.ReadExactlyAsync(lengthBytes);
        byte[] payload = new byte[BinaryPrimitives.ReadInt32LittleEndian(lengthBytes)];
        await server.ReadExactlyAsync(payload);
        CaptureRequest request = JsonConvert.DeserializeObject<CaptureRequest>(Encoding.UTF8.GetString(payload));

        byte[] reply = Encoding.UTF8.GetBytes(JsonConvert.SerializeObject(responseFactory(request)));
        byte[] length = new byte[4];
        BinaryPrimitives.WriteInt32LittleEndian(length, reply.Length);
        await server.WriteAsync(length);
        await server.WriteAsync(reply);
        await server.FlushAsync();
    }

    private static string PipeName() => "vss" + Guid.NewGuid().ToString("N")[..8];

    private static StrategySampleV1 Sample() => new()
    {
        SchemaVersion = 1,
        SampledAt = new DateTimeOffset(2026, 10, 6, 10, 10, 2, TimeSpan.FromHours(-4)),
        Strategies = new List<StrategySampleRowV1>
        {
            new()
            {
                AccountName = "SIM-FIXTURE-1",
                StrategyId = "123456789",
                StrategyName = "0 - OGX-PF-2.4",
                Instrument = "MNQ 12-26",
                RealizedPnl = -412.5m,
                UnrealizedPnl = 37.5m,
            },
        },
    };

    private sealed class FixedProcessDetector : INinjaTraderProcessDetector
    {
        private readonly bool isRunning;

        public FixedProcessDetector(bool isRunning) => this.isRunning = isRunning;

        public bool IsRunning() => isRunning;
    }
}
