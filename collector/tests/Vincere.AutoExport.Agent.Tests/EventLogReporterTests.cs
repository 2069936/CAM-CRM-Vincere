using System;
using System.Collections.Generic;
using Vincere.AutoExport.Agent.Diagnostics;
using Vincere.AutoExport.Agent.Service;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

// What a failed loop is allowed to say in the log.
//
// This exists because the opposite was shipped: the supervisor discarded the
// exception, so every control-pipe crash on a client VPS logged the same eight
// words and the fault could not be identified from the machine it happened on.
// The fix is to write the exception, and these tests fix HOW MUCH of it: enough
// to name the fault, not enough to leak a payload.
public sealed class EventLogReporterTests
{
    [Fact]
    public void NamesTheExceptionTypeAndMessageSoAFailureCanBeDiagnosed()
    {
        RecordingLogger logger = new();
        EventLogReporter reporter = new(logger);

        reporter.LoopFailed("control", "unexpected_loop_failure", new UnauthorizedAccessException("access denied"));

        (string level, string code, string message) = Assert.Single(logger.Entries);
        Assert.Equal("ERROR", level);
        Assert.Equal("unexpected_loop_failure", code);
        Assert.Contains("control", message);
        Assert.Contains(typeof(UnauthorizedAccessException).FullName, message);
        Assert.Contains("access denied", message);
    }

    [Fact]
    public void DoesNotWriteTheStackTrace()
    {
        RecordingLogger logger = new();
        EventLogReporter reporter = new(logger);
        Exception thrown;
        try
        {
            throw new InvalidOperationException("boom");
        }
        catch (Exception exception)
        {
            thrown = exception;
        }

        reporter.LoopFailed("control", "unexpected_loop_failure", thrown);

        // The stack trace is the part most likely to carry a path or an argument,
        // and it is not needed to name the fault. The type and message are.
        (string _, string _, string message) = Assert.Single(logger.Entries);
        Assert.NotNull(thrown.StackTrace);
        Assert.DoesNotContain(nameof(DoesNotWriteTheStackTrace), message);
        Assert.DoesNotContain("   at ", message);
    }

    [Fact]
    public void StillReportsALoopFailureWhenThereIsNoException()
    {
        RecordingLogger logger = new();
        EventLogReporter reporter = new(logger);

        reporter.LoopFailed("uploader", "unexpected_loop_failure");

        (string _, string _, string message) = Assert.Single(logger.Entries);
        Assert.Equal("Collector loop 'uploader' recovered after 'unexpected_loop_failure'.", message);
    }

    private sealed class RecordingLogger : IRedactingLogger
    {
        public List<(string Level, string EventCode, string Message)> Entries { get; } = new();

        public void Write(string level, string eventCode, string message, IEnumerable<string> knownSecrets = null)
        {
            Entries.Add((level, eventCode, message));
        }
    }
}
