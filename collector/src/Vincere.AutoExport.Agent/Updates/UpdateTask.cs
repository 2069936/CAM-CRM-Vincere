using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Xml.Linq;

namespace Vincere.AutoExport.Agent.Updates;

/* THE TASK THAT REPLACES THIS SERVICE, AS TASK SCHEDULER XML.
 *
 * WHY A SCHEDULED TASK AND NOT A CHILD PROCESS. install-agent.ps1 stops and
 * deletes this service. A process this service started would be torn down with
 * it, halfway through the install, by the very step it was running. Task
 * Scheduler starts the script outside this service's process tree, as SYSTEM,
 * and it outlives the stop.
 *
 * No triggers: it runs when the agent says /Run and at no other time. Thirty
 * minutes is far more than an update takes and stops a hung one from holding the
 * task forever. IgnoreNew so a second /Run while one is running does nothing.
 *
 * Built with XDocument, so a path cannot break out of the XML, and the command
 * line is built here from validated parts so a path cannot break out of its
 * quotes either. */
public static class UpdateTaskXml
{
    public const string TaskNamespace = "http://schemas.microsoft.com/windows/2004/02/mit/task";
    public const string PowerShellCommand = @"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe";

    public static string BuildArguments(string packagePath, string version)
    {
        RequireSafePath(packagePath);
        if (!UpdateVersion.IsTriple(version))
            throw new ArgumentException("A version in x.y.z form is required.", nameof(version));
        string script = packagePath + @"\update-agent.ps1";
        return "-NoProfile -NonInteractive -ExecutionPolicy Bypass"
            + " -File \"" + script + "\""
            + " -PackagePath \"" + packagePath + "\""
            + " -ExpectedVersion \"" + version + "\"";
    }

    public static string Build(string packagePath, string version)
    {
        XNamespace ns = TaskNamespace;
        XDocument document = new(
            new XDeclaration("1.0", "UTF-16", null),
            new XElement(ns + "Task",
                new XAttribute("version", "1.2"),
                new XElement(ns + "RegistrationInfo",
                    new XElement(ns + "Author", "Vincere"),
                    new XElement(ns + "Description",
                        "Installs Vincere Auto Export agent " + version
                        + " and rolls back if it does not start. Started by the agent; never on a schedule.")),
                new XElement(ns + "Principals",
                    new XElement(ns + "Principal",
                        new XAttribute("id", "LocalSystem"),
                        new XElement(ns + "UserId", "S-1-5-18"),
                        new XElement(ns + "RunLevel", "HighestAvailable"))),
                new XElement(ns + "Settings",
                    new XElement(ns + "MultipleInstancesPolicy", "IgnoreNew"),
                    new XElement(ns + "DisallowStartIfOnBatteries", "false"),
                    new XElement(ns + "StopIfGoingOnBatteries", "false"),
                    new XElement(ns + "AllowHardTerminate", "true"),
                    new XElement(ns + "StartWhenAvailable", "false"),
                    new XElement(ns + "RunOnlyIfNetworkAvailable", "false"),
                    new XElement(ns + "IdleSettings",
                        new XElement(ns + "StopOnIdleEnd", "false"),
                        new XElement(ns + "RestartOnIdle", "false")),
                    new XElement(ns + "AllowStartOnDemand", "true"),
                    new XElement(ns + "Enabled", "true"),
                    new XElement(ns + "Hidden", "false"),
                    new XElement(ns + "RunOnlyIfIdle", "false"),
                    new XElement(ns + "WakeToRun", "false"),
                    new XElement(ns + "ExecutionTimeLimit", "PT30M"),
                    new XElement(ns + "Priority", "7")),
                new XElement(ns + "Actions",
                    new XAttribute("Context", "LocalSystem"),
                    new XElement(ns + "Exec",
                        new XElement(ns + "Command", PowerShellCommand),
                        new XElement(ns + "Arguments", BuildArguments(packagePath, version))))));
        using Utf16StringWriter writer = new();
        document.Save(writer);
        return writer.ToString();
    }

    /// <summary>UTF-16 with a byte order mark, which is what schtasks /XML reads without guessing.</summary>
    public static void Write(string path, string packagePath, string version)
    {
        string xml = Build(packagePath, version);
        File.WriteAllText(path, xml, new UnicodeEncoding(bigEndian: false, byteOrderMark: true));
    }

    /* An absolute path with nothing in it that the command line could read as
     * something else: no quote (it would close the argument), no trailing
     * backslash (before a closing quote it escapes it), no percent sign (Task
     * Scheduler expands %VARIABLES% in arguments), no control characters. */
    private static void RequireSafePath(string path)
    {
        if (string.IsNullOrWhiteSpace(path)
            || !(DrivePath.IsMatch(path) || Path.IsPathFullyQualified(path))
            || path.EndsWith('\\')
            || path.EndsWith('/')
            || path.Any(character => character is '"' or '%' || char.IsControl(character)))
            throw new ArgumentException("The package path cannot be passed to the update task.", nameof(path));
    }

    // C:\something, checked as text so the rule is the same wherever it is tested.
    private static readonly Regex DrivePath = new(@"^[A-Za-z]:\\[^\\]", RegexOptions.CultureInvariant);

    private sealed class Utf16StringWriter : StringWriter
    {
        public override Encoding Encoding => Encoding.Unicode;
    }
}

/// <summary>Runs a program and reports its exit code. A seam so tests never start one.</summary>
public interface IProcessRunner
{
    /// <returns>The exit code, or -1 when it did not finish within <paramref name="timeout"/>.</returns>
    Task<int> RunAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        TimeSpan timeout,
        CancellationToken cancellationToken);
}

public sealed class SystemProcessRunner : IProcessRunner
{
    public async Task<int> RunAsync(
        string fileName,
        IReadOnlyList<string> arguments,
        TimeSpan timeout,
        CancellationToken cancellationToken)
    {
        ProcessStartInfo start = new(fileName)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        // ArgumentList quotes each argument itself; nothing is joined by hand.
        foreach (string argument in arguments) start.ArgumentList.Add(argument);
        using Process process = Process.Start(start)
            ?? throw new InvalidOperationException("The process did not start.");
        // Drained and discarded: a full pipe would block the child, and what
        // schtasks prints is localized text this agent has no use for.
        Task<string> output = process.StandardOutput.ReadToEndAsync(cancellationToken);
        Task<string> error = process.StandardError.ReadToEndAsync(cancellationToken);
        using CancellationTokenSource limit = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        limit.CancelAfter(timeout);
        try
        {
            await process.WaitForExitAsync(limit.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                process.Kill(entireProcessTree: true);
            }
            catch (InvalidOperationException)
            {
            }
            return -1;
        }
        await Task.WhenAll(output, error).ConfigureAwait(false);
        return process.ExitCode;
    }
}

public interface IUpdateTaskScheduler
{
    /// <returns>Null when the task was registered and started; otherwise an error code.</returns>
    Task<string> CreateAndRunAsync(string taskXmlPath, CancellationToken cancellationToken);
}

/* schtasks.exe, by its full path under System32, so nothing earlier on PATH can
 * stand in for it. /F replaces a task left by an earlier attempt. Any non-zero
 * exit is schedule_failed and nothing else is tried: the service keeps running
 * the version it has. */
public sealed class SchtasksUpdateTaskScheduler : IUpdateTaskScheduler
{
    public const string TaskName = "Vincere Auto Export update";
    private static readonly TimeSpan CommandTimeout = TimeSpan.FromSeconds(60);
    private readonly IProcessRunner runner;
    private readonly string schtasksPath;

    public SchtasksUpdateTaskScheduler(IProcessRunner runner, string schtasksPath)
    {
        this.runner = runner ?? throw new ArgumentNullException(nameof(runner));
        if (string.IsNullOrWhiteSpace(schtasksPath)) throw new ArgumentException("schtasks.exe is required.", nameof(schtasksPath));
        this.schtasksPath = schtasksPath;
    }

    public static string DefaultSchtasksPath => Path.Combine(Environment.SystemDirectory, "schtasks.exe");

    public async Task<string> CreateAndRunAsync(string taskXmlPath, CancellationToken cancellationToken)
    {
        try
        {
            int created = await runner.RunAsync(
                schtasksPath,
                new[] { "/Create", "/TN", TaskName, "/XML", taskXmlPath, "/F" },
                CommandTimeout,
                cancellationToken).ConfigureAwait(false);
            if (created != 0) return UpdateErrorCodes.ScheduleFailed;
            int started = await runner.RunAsync(
                schtasksPath,
                new[] { "/Run", "/TN", TaskName },
                CommandTimeout,
                cancellationToken).ConfigureAwait(false);
            return started == 0 ? null : UpdateErrorCodes.ScheduleFailed;
        }
        catch (Exception exception) when (exception is Win32Exception or InvalidOperationException or IOException)
        {
            return UpdateErrorCodes.ScheduleFailed;
        }
    }
}
