using System;
using System.Diagnostics;
using System.Runtime.Versioning;
using Vincere.AutoExport.Agent.Service;

namespace Vincere.AutoExport.Agent.Diagnostics;

public sealed class EventLogReporter : IServiceReporter
{
    public const string EventSource = "Vincere Auto Export";
    private readonly IRedactingLogger logger;

    public EventLogReporter(IRedactingLogger logger)
    {
        this.logger = logger ?? throw new ArgumentNullException(nameof(logger));
    }

    public void LoopFailed(string loopName, string errorCode)
    {
        string message = $"Collector loop '{loopName}' recovered after '{errorCode}'.";
        logger.Write("ERROR", errorCode, message);
        if (!OperatingSystem.IsWindows()) return;
        TryWriteWindowsEvent(message);
    }

    [SupportedOSPlatform("windows")]
    private static void TryWriteWindowsEvent(string message)
    {
        try
        {
            EventLog.WriteEntry(EventSource, message, EventLogEntryType.Error, 1001);
        }
        catch (Exception exception) when (exception is InvalidOperationException or System.ComponentModel.Win32Exception)
        {
            // The installer owns event-source creation; local file logging remains authoritative.
        }
    }
}
