using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Xml;
using Vincere.AutoExport.Agent.Updates;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* THE TASK THAT REPLACES THE SERVICE: WHO IT RUNS AS, WHAT IT RUNS, AND HOW IT IS
 * HANDED TO WINDOWS. Read back as XML, the way Task Scheduler reads it. */
public sealed class UpdateTaskTests
{
    private const string Package = @"C:\ProgramData\Vincere\AutoExport\updates\1.3.1\package";

    [Fact]
    public void It_runs_as_system_with_no_trigger_for_at_most_thirty_minutes()
    {
        (XmlDocument task, XmlNamespaceManager ns) = Parse(UpdateTaskXml.Build(Package, "1.3.1"));

        Assert.Equal("1.2", task.DocumentElement.GetAttribute("version"));
        Assert.Equal("S-1-5-18", task.SelectSingleNode("/t:Task/t:Principals/t:Principal/t:UserId", ns).InnerText);
        Assert.Equal("HighestAvailable", task.SelectSingleNode("/t:Task/t:Principals/t:Principal/t:RunLevel", ns).InnerText);
        Assert.Null(task.SelectSingleNode("/t:Task/t:Triggers", ns));
        Assert.Equal("PT30M", task.SelectSingleNode("/t:Task/t:Settings/t:ExecutionTimeLimit", ns).InnerText);
        Assert.Equal("IgnoreNew", task.SelectSingleNode("/t:Task/t:Settings/t:MultipleInstancesPolicy", ns).InnerText);
        Assert.Equal("true", task.SelectSingleNode("/t:Task/t:Settings/t:AllowStartOnDemand", ns).InnerText);
        Assert.Equal("false", task.SelectSingleNode("/t:Task/t:Settings/t:DisallowStartIfOnBatteries", ns).InnerText);
    }

    [Fact]
    public void Its_one_action_is_windows_powershell_running_update_agent_from_the_package()
    {
        (XmlDocument task, XmlNamespaceManager ns) = Parse(UpdateTaskXml.Build(Package, "1.3.1"));

        XmlNodeList actions = task.SelectNodes("/t:Task/t:Actions/*", ns);
        Assert.Equal(1, actions.Count);
        Assert.Equal("Exec", actions[0].LocalName);
        Assert.Equal(
            @"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe",
            task.SelectSingleNode("/t:Task/t:Actions/t:Exec/t:Command", ns).InnerText);
        Assert.Equal(
            "-NoProfile -NonInteractive -ExecutionPolicy Bypass"
            + " -File \"C:\\ProgramData\\Vincere\\AutoExport\\updates\\1.3.1\\package\\update-agent.ps1\""
            + " -PackagePath \"C:\\ProgramData\\Vincere\\AutoExport\\updates\\1.3.1\\package\""
            + " -ExpectedVersion \"1.3.1\"",
            task.SelectSingleNode("/t:Task/t:Actions/t:Exec/t:Arguments", ns).InnerText);
        Assert.Equal("LocalSystem", ((XmlElement)task.SelectSingleNode("/t:Task/t:Actions", ns)).GetAttribute("Context"));
    }

    [Fact]
    public void A_path_with_spaces_stays_one_argument()
    {
        string arguments = UpdateTaskXml.BuildArguments(@"C:\Program Data\Vincere AutoExport\updates\1.3.1\package", "1.3.1");

        Assert.Contains("-PackagePath \"C:\\Program Data\\Vincere AutoExport\\updates\\1.3.1\\package\"", arguments);
        Assert.Contains("-File \"C:\\Program Data\\Vincere AutoExport\\updates\\1.3.1\\package\\update-agent.ps1\"", arguments);
    }

    [Fact]
    public void Characters_that_would_matter_to_xml_are_escaped_not_interpreted()
    {
        string xml = UpdateTaskXml.Build(@"C:\Data\A&B <x>\updates\1.3.1\package", "1.3.1");

        (XmlDocument task, XmlNamespaceManager ns) = Parse(xml);
        Assert.Contains(
            @"-PackagePath ""C:\Data\A&B <x>\updates\1.3.1\package""",
            task.SelectSingleNode("/t:Task/t:Actions/t:Exec/t:Arguments", ns).InnerText);
    }

    [Theory]
    [InlineData(@"C:\Data\a""b\package")]       // a quote would close the argument
    [InlineData(@"C:\Data\package\")]           // a trailing backslash escapes the closing quote
    [InlineData(@"C:\Data\%TEMP%\package")]     // Task Scheduler expands %VARIABLES%
    [InlineData(@"package")]                    // relative
    [InlineData("")]
    [InlineData(null)]
    public void A_path_the_command_line_could_misread_is_refused(string path)
    {
        Assert.Throws<ArgumentException>(() => UpdateTaskXml.Build(path, "1.3.1"));
    }

    [Theory]
    [InlineData("1.3")]
    [InlineData("1.3.1\" -Evil \"")]
    [InlineData(null)]
    public void A_version_that_is_not_x_y_z_is_refused(string version)
    {
        Assert.Throws<ArgumentException>(() => UpdateTaskXml.Build(Package, version));
    }

    [Fact]
    public void The_file_is_utf16_with_a_byte_order_mark_and_says_so()
    {
        using UpdateTempDirectory temp = new();
        string path = Path.Combine(temp.Path, "update-task.xml");

        UpdateTaskXml.Write(path, Package, "1.3.1");

        byte[] bytes = File.ReadAllBytes(path);
        Assert.Equal(0xFF, bytes[0]);
        Assert.Equal(0xFE, bytes[1]);
        string text = Encoding.Unicode.GetString(bytes, 2, bytes.Length - 2);
        Assert.StartsWith("<?xml version=\"1.0\" encoding=\"utf-16\"?>", text, StringComparison.OrdinalIgnoreCase);
        Parse(text);
    }

    [Fact]
    public async Task Schtasks_is_asked_to_create_the_task_from_the_file_and_then_to_run_it()
    {
        RecordingRunner runner = new();
        SchtasksUpdateTaskScheduler scheduler = new(runner, @"C:\Windows\System32\schtasks.exe");

        string error = await scheduler.CreateAndRunAsync(@"C:\updates\1.3.1\update-task.xml", CancellationToken.None);

        Assert.Null(error);
        Assert.Equal(2, runner.Calls.Count);
        Assert.All(runner.Calls, call => Assert.Equal(@"C:\Windows\System32\schtasks.exe", call.FileName));
        Assert.Equal(
            new[] { "/Create", "/TN", "Vincere Auto Export update", "/XML", @"C:\updates\1.3.1\update-task.xml", "/F" },
            runner.Calls[0].Arguments);
        Assert.Equal(new[] { "/Run", "/TN", "Vincere Auto Export update" }, runner.Calls[1].Arguments);
    }

    [Fact]
    public async Task A_task_that_could_not_be_created_is_never_run()
    {
        RecordingRunner runner = new() { ExitCodes = { 1 } };
        SchtasksUpdateTaskScheduler scheduler = new(runner, "schtasks.exe");

        string error = await scheduler.CreateAndRunAsync("task.xml", CancellationToken.None);

        Assert.Equal(UpdateErrorCodes.ScheduleFailed, error);
        Assert.Single(runner.Calls);
    }

    [Fact]
    public async Task A_task_that_would_not_start_is_schedule_failed()
    {
        RecordingRunner runner = new() { ExitCodes = { 0, 2 } };
        SchtasksUpdateTaskScheduler scheduler = new(runner, "schtasks.exe");

        Assert.Equal(UpdateErrorCodes.ScheduleFailed, await scheduler.CreateAndRunAsync("task.xml", CancellationToken.None));
        Assert.Equal(2, runner.Calls.Count);
    }

    [Fact]
    public async Task Schtasks_that_will_not_start_at_all_is_schedule_failed()
    {
        RecordingRunner runner = new() { Throw = new Win32Exception(2) };
        SchtasksUpdateTaskScheduler scheduler = new(runner, "schtasks.exe");

        Assert.Equal(UpdateErrorCodes.ScheduleFailed, await scheduler.CreateAndRunAsync("task.xml", CancellationToken.None));
    }

    [Fact]
    public void The_real_schtasks_is_the_one_under_system32()
    {
        if (!OperatingSystem.IsWindows()) return; // Environment.SystemDirectory is a Windows answer.

        Assert.Equal(
            Path.Combine(Environment.SystemDirectory, "schtasks.exe"),
            SchtasksUpdateTaskScheduler.DefaultSchtasksPath);
        Assert.True(File.Exists(SchtasksUpdateTaskScheduler.DefaultSchtasksPath));
    }

    private static (XmlDocument Document, XmlNamespaceManager Namespaces) Parse(string xml)
    {
        XmlDocument document = new();
        document.LoadXml(xml.TrimStart('\uFEFF'));
        XmlNamespaceManager ns = new(document.NameTable);
        ns.AddNamespace("t", UpdateTaskXml.TaskNamespace);
        return (document, ns);
    }

    private sealed class RecordingRunner : IProcessRunner
    {
        public List<(string FileName, string[] Arguments)> Calls { get; } = new();
        public List<int> ExitCodes { get; } = new();
        public Exception Throw { get; set; }

        public Task<int> RunAsync(string fileName, IReadOnlyList<string> arguments, TimeSpan timeout, CancellationToken cancellationToken)
        {
            Calls.Add((fileName, arguments.ToArray()));
            if (Throw != null) throw Throw;
            int index = Calls.Count - 1;
            return Task.FromResult(index < ExitCodes.Count ? ExitCodes[index] : 0);
        }
    }
}
