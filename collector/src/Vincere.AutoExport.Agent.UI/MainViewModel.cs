using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using System.Threading.Tasks;
using System.Windows.Input;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace Vincere.AutoExport.Agent.UI;

public sealed class MainViewModel : INotifyPropertyChanged
{
    private static readonly Regex EnrollmentPattern = new("^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{10}$", RegexOptions.CultureInvariant);
    private readonly IControlPipeClient client;
    private int currentStep = 1;
    private bool isBusy;
    private bool serviceAvailable;
    private bool requiresRestart;
    private bool isComplete;
    private bool updateRequired;
    private string enrollmentCode = string.Empty;
    private string clientName;
    private string scheduleTime = "16:45";
    private string statusMessage = "Checking the Windows service…";
    private string queueSummary;
    private string diagnosticsPath;

    public MainViewModel(IControlPipeClient client)
    {
        this.client = client ?? throw new ArgumentNullException(nameof(client));
        PairCommand = new AsyncCommand(PairAsync, () => !IsBusy);
        TestCaptureCommand = new AsyncCommand(TestCaptureAsync, () => !IsBusy);
        SaveScheduleCommand = new AsyncCommand(SaveScheduleAsync, () => !IsBusy);
        CollectDiagnosticsCommand = new AsyncCommand(CollectDiagnosticsAsync, () => !IsBusy);
    }

    public event PropertyChangedEventHandler PropertyChanged;

    public IReadOnlyList<string> ScheduleChoices { get; } = new[]
    {
        "16:30", "16:35", "16:40", "16:45", "16:50", "16:55",
    };

    public int CurrentStep
    {
        get => currentStep;
        private set
        {
            if (Set(ref currentStep, value))
                PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(CurrentStepIndex)));
        }
    }
    public int CurrentStepIndex => CurrentStep - 1;
    public bool IsBusy { get => isBusy; private set { if (Set(ref isBusy, value)) RaiseCommands(); } }
    public bool ServiceAvailable { get => serviceAvailable; private set => Set(ref serviceAvailable, value); }
    public bool RequiresRestart { get => requiresRestart; private set => Set(ref requiresRestart, value); }
    public bool IsComplete { get => isComplete; private set => Set(ref isComplete, value); }
    public bool UpdateRequired { get => updateRequired; private set => Set(ref updateRequired, value); }
    public string EnrollmentCode { get => enrollmentCode; set => Set(ref enrollmentCode, value ?? string.Empty); }
    public string ClientName { get => clientName; private set => Set(ref clientName, value); }
    public string ScheduleTime { get => scheduleTime; set => Set(ref scheduleTime, value); }
    public string StatusMessage { get => statusMessage; private set => Set(ref statusMessage, value); }
    public string QueueSummary { get => queueSummary; private set => Set(ref queueSummary, value); }
    public string DiagnosticsPath { get => diagnosticsPath; private set => Set(ref diagnosticsPath, value); }
    public ICommand PairCommand { get; }
    public ICommand TestCaptureCommand { get; }
    public ICommand SaveScheduleCommand { get; }
    public ICommand CollectDiagnosticsCommand { get; }

    public async Task InitializeAsync()
    {
        await RunAsync(async () =>
        {
            UiControlResponse response = await client.SendAsync("status");
            if (!response.Ok)
            {
                ServiceAvailable = false;
                StatusMessage = response.Message;
                return;
            }
            ServiceAvailable = true;
            JObject data = response.Data ?? new JObject();
            bool paired = data.Value<bool?>("Paired") ?? data.Value<bool?>("paired") ?? false;
            ClientName = Value(data, "ClientName", "clientName");
            ScheduleTime = Value(data, "ScheduleTime", "scheduleTime") ?? "16:45";
            JObject runtime = ObjectValue(data, "Runtime", "runtime");
            UpdateRequired = runtime?.Value<bool?>("UpdateRequired")
                ?? runtime?.Value<bool?>("updateRequired")
                ?? false;
            JObject queue = ObjectValue(data, "Queue", "queue");
            int pending = queue?.Value<int?>("PendingCount") ?? queue?.Value<int?>("pendingCount") ?? 0;
            QueueSummary = pending == 0 ? "No uploads waiting" : $"{pending} upload{(pending == 1 ? string.Empty : "s")} waiting";
            CurrentStep = paired ? 3 : 2;
            StatusMessage = paired
                ? $"Connected to {ClientName}. Restart NinjaTrader, then test the connection."
                : "Service ready. Enter the one-time code from the CRM.";
        }, "The Windows service is unavailable. Open setup as administrator or repair the installation.");
    }

    public async Task PairAsync()
    {
        string canonical = CanonicalEnrollmentCode(EnrollmentCode);
        if (!EnrollmentPattern.IsMatch(canonical))
        {
            StatusMessage = "Enter the 10-character one-time code shown in the CRM.";
            return;
        }
        await RunAsync(async () =>
        {
            UiControlResponse response = await client.SendAsync("pair", enrollmentCode: canonical);
            if (!response.Ok)
            {
                StatusMessage = response.Code == "invalid_or_expired_code"
                    ? "This code is invalid or expired. Generate a new code in the CRM."
                    : response.Message;
                return;
            }
            ClientName = Value(response.Data, "ClientName", "clientName");
            ScheduleTime = Value(response.Data, "ScheduleTime", "scheduleTime") ?? "16:45";
            CurrentStep = 3;
            RequiresRestart = true;
            StatusMessage = $"Connected to {ClientName}. Restart NinjaTrader before the test.";
        }, "The service could not complete pairing.");
    }

    public async Task TestCaptureAsync()
    {
        await RunAsync(async () =>
        {
            UiControlResponse response = await client.SendAsync("testCapture");
            if (!response.Ok)
            {
                RequiresRestart = response.Code is "addon_unavailable" or "ninjatrader_not_running";
                StatusMessage = RequiresRestart
                    ? "Open or restart NinjaTrader, sign in, and run the test again."
                    : response.Message;
                return;
            }
            RequiresRestart = false;
            IsComplete = true;
            CurrentStep = 4;
            StatusMessage = "Test capture queued. Automatic collection is ready.";
        }, "The service could not run the NinjaTrader test.");
    }

    public async Task SaveScheduleAsync()
    {
        if (!ScheduleChoices.Contains(ScheduleTime, StringComparer.Ordinal))
        {
            StatusMessage = "Choose a time between 4:30 PM and 4:55 PM New York time.";
            return;
        }
        await RunAsync(async () =>
        {
            UiControlResponse response = await client.SendAsync("updateSchedule", scheduleTime: ScheduleTime);
            StatusMessage = response.Ok
                ? $"Daily capture set for {DisplayTime(ScheduleTime)} New York time."
                : response.Message;
        }, "The service could not update the schedule.");
    }

    public async Task CollectDiagnosticsAsync()
    {
        await RunAsync(async () =>
        {
            UiControlResponse response = await client.SendAsync("collectDiagnostics");
            if (!response.Ok) { StatusMessage = response.Message; return; }
            DiagnosticsPath = Value(response.Data, "Path", "path");
            StatusMessage = "Redacted diagnostics package created.";
        }, "The service could not create diagnostics.");
    }

    public static string CanonicalEnrollmentCode(string value)
    {
        return Regex.Replace((value ?? string.Empty).ToUpperInvariant(), "[\\s-]+", string.Empty);
    }

    private async Task RunAsync(Func<Task> action, string unavailableMessage)
    {
        if (IsBusy) return;
        IsBusy = true;
        try
        {
            await action();
        }
        catch (ControlPipeUnavailableException)
        {
            ServiceAvailable = false;
            StatusMessage = unavailableMessage;
        }
        catch (Exception exception) when (exception is IOException or InvalidDataException or JsonException)
        {
            StatusMessage = "The service returned an invalid response. Repair or restart the collector.";
        }
        finally
        {
            IsBusy = false;
        }
    }

    private static string Value(JObject data, string first, string second)
        => data?.Value<string>(first) ?? data?.Value<string>(second);

    private static JObject ObjectValue(JObject data, string first, string second)
        => data?[first] as JObject ?? data?[second] as JObject;

    private static string DisplayTime(string time)
    {
        TimeOnly parsed = TimeOnly.ParseExact(time, "HH:mm");
        return parsed.ToString("h:mm tt");
    }

    private bool Set<T>(ref T field, T value, [CallerMemberName] string propertyName = null)
    {
        if (EqualityComparer<T>.Default.Equals(field, value)) return false;
        field = value;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(propertyName));
        return true;
    }

    private void RaiseCommands()
    {
        foreach (AsyncCommand command in new[] { PairCommand, TestCaptureCommand, SaveScheduleCommand, CollectDiagnosticsCommand }.OfType<AsyncCommand>())
            command.RaiseCanExecuteChanged();
    }
}

public sealed class AsyncCommand : ICommand
{
    private readonly Func<Task> execute;
    private readonly Func<bool> canExecute;

    public AsyncCommand(Func<Task> execute, Func<bool> canExecute)
    {
        this.execute = execute;
        this.canExecute = canExecute;
    }

    public event EventHandler CanExecuteChanged;
    public bool CanExecute(object parameter) => canExecute();
    public async void Execute(object parameter) => await execute();
    public void RaiseCanExecuteChanged() => CanExecuteChanged?.Invoke(this, EventArgs.Empty);
}
