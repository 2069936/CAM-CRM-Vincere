using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Runtime.CompilerServices;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Input;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.UI.DeepExport;

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
    private string scheduleTime = "16:30";
    private string statusMessage = "Checking the Windows service…";
    private string queueSummary;
    private string diagnosticsPath;
    private string collectionSummary = "No collection history yet";
    private string collectionAlert;
    private IReadOnlyList<CaptureDayView> days = Array.Empty<CaptureDayView>();
    private QuarantineView quarantine = QuarantineView.Empty;

    private readonly ReleaseCheck releaseCheck;

    // Injected rather than called directly, because System.Windows.Clipboard is
    // WPF and this file is compiled into a plain net8.0 test assembly.
    private readonly Action<string> copyToClipboard;

    /* Injected so a test can assert what would be launched without launching
     * it. Runs an elevated PowerShell over a script file: the installer needs
     * administrator, and it replaces this window's own files, so it cannot be
     * hosted inside the process it is about to overwrite. */
    private readonly Func<string, bool> runElevatedScript;

    /* Injected so a test can run the export over a folder it built, and so a
     * test of this window can hand back a result without touching a disk. The
     * default builds a runner over the real NinjaTrader and agent folders. */
    private readonly Func<DeepExportEnvironment, IProgress<DeepExportProgress>, CancellationToken, Task<DeepExportResult>> deepExport;

    // Injectable so the tests can answer without a network, which is the only
    // way to assert what happens when there is not one.
    public MainViewModel(
        IControlPipeClient client,
        ReleaseCheck releaseCheck = null,
        Action<string> copyToClipboard = null,
        Func<string, bool> runElevatedScript = null,
        Func<DeepExportEnvironment, IProgress<DeepExportProgress>, CancellationToken, Task<DeepExportResult>> deepExport = null)
    {
        this.runElevatedScript = runElevatedScript;
        this.client = client ?? throw new ArgumentNullException(nameof(client));
        this.releaseCheck = releaseCheck ?? new ReleaseCheck();
        this.copyToClipboard = copyToClipboard;
        this.deepExport = deepExport ?? RunDeepExportOnThisMachineAsync;
        DeepExportCommand = new AsyncCommand(DeepExportAsync, () => !IsBusy);
        OpenDeepExportFolderCommand = new AsyncCommand(OpenDeepExportFolderAsync, () => HasDeepExport);
        CopyDeepExportShaCommand = new AsyncCommand(CopyDeepExportShaAsync, () => HasDeepExport);
        PairCommand = new AsyncCommand(PairAsync, () => !IsBusy);
        TestCaptureCommand = new AsyncCommand(TestCaptureAsync, () => !IsBusy);
        SaveScheduleCommand = new AsyncCommand(SaveScheduleAsync, () => !IsBusy);
        CollectDiagnosticsCommand = new AsyncCommand(CollectDiagnosticsAsync, () => !IsBusy);
        OpenQueueFolderCommand = new AsyncCommand(OpenQueueFolderAsync, () => true);
        CheckForUpdateCommand = new AsyncCommand(CheckForUpdateAsync, () => !IsBusy);
        CopyInstallCommandCommand = new AsyncCommand(CopyInstallCommandAsync, () => !string.IsNullOrEmpty(UpdateInstallCommand));
        InstallUpdateCommand = new AsyncCommand(InstallUpdateAsync, () => CanInstallUpdate && !IsBusy);
        RetryQuarantineCommand = new AsyncCommand(RetryQuarantineAsync, () => !IsBusy && HasQuarantine);
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
    public bool UpdateRequired
    {
        get => updateRequired;
        private set
        {
            if (!Set(ref updateRequired, value)) return;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(UpdateHint)));
        }
    }

    // NAMING A STATE IS NOT TELLING SOMEONE WHAT TO DO.
    //
    // This was the word UPDATE REQUIRED on its own. Correct, and useless: the
    // reader learns something is out of date and still has to ask what to run.
    // The action is the same install line the CRM already shows, so it says
    // that, and the window stops being a dead end.
    //
    // Nothing here downloads or installs anything. An agent that replaces
    // itself from the internet, on machines carrying live client accounts, is a
    // decision for the people who own those accounts, not something to grow
    // quietly out of a status badge.
    public string UpdateHint => UpdateRequired
        ? "UPDATE AVAILABLE · re-run the install line from the CRM"
        : string.Empty;
    public string EnrollmentCode { get => enrollmentCode; set => Set(ref enrollmentCode, value ?? string.Empty); }
    public string ClientName { get => clientName; private set => Set(ref clientName, value); }
    public string ScheduleTime { get => scheduleTime; set => Set(ref scheduleTime, value); }
    public string StatusMessage { get => statusMessage; private set => Set(ref statusMessage, value); }
    public string QueueSummary { get => queueSummary; private set => Set(ref queueSummary, value); }
    public string DiagnosticsPath { get => diagnosticsPath; private set => Set(ref diagnosticsPath, value); }

    /// <summary>One line answering "did the last trading day land?".</summary>
    public string CollectionSummary { get => collectionSummary; private set => Set(ref collectionSummary, value); }

    /// <summary>Null when nothing needs attention, so the banner stays hidden.</summary>
    public string CollectionAlert { get => collectionAlert; private set => Set(ref collectionAlert, value); }

    public bool HasCollectionAlert => !string.IsNullOrEmpty(CollectionAlert);

    /// <summary>The seven-day strip, oldest first.</summary>
    public IReadOnlyList<CaptureDayView> Days
    {
        get => days;
        private set
        {
            if (Set(ref days, value))
                PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(HasDays)));
        }
    }

    public bool HasDays => Days.Count > 0;

    /* QUARANTINE, ON THE SCREEN THAT CAN DO SOMETHING ABOUT IT.
     *
     * A capture the CRM refused with a 422 used to sit in a hidden folder
     * until someone with the path went looking. The service now retries the
     * ones a server side fix can rescue, once a day, and this card says what
     * is there, which rows will be retried and when, and offers the same
     * review now rather than at midday. The cap on attempts is the service's
     * and the button does not get around it. */
    public QuarantineView Quarantine
    {
        get => quarantine;
        private set
        {
            if (!Set(ref quarantine, value)) return;
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(HasQuarantine)));
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(QuarantineSummary)));
            PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(QuarantineItems)));
            (RetryQuarantineCommand as AsyncCommand)?.RaiseCanExecuteChanged();
        }
    }

    public bool HasQuarantine => Quarantine.HasItems;
    public string QuarantineSummary => Quarantine.Summary;
    public IReadOnlyList<QuarantineItemView> QuarantineItems => Quarantine.Items;
    public ICommand RetryQuarantineCommand { get; }
    public ICommand PairCommand { get; }
    public ICommand TestCaptureCommand { get; }
    public ICommand SaveScheduleCommand { get; }
    public ICommand CollectDiagnosticsCommand { get; }
    public ICommand OpenQueueFolderCommand { get; }
    public ICommand CheckForUpdateCommand { get; }
    public ICommand CopyInstallCommandCommand { get; }
    public ICommand InstallUpdateCommand { get; }
    public ICommand DeepExportCommand { get; }
    public ICommand OpenDeepExportFolderCommand { get; }
    public ICommand CopyDeepExportShaCommand { get; }

    /* DEEP EXPORT. ONE PACKAGE WITH EVERYTHING THIS NinjaTrader REMEMBERS.
     *
     * The daily capture is a snapshot of one day. When a client's history has
     * to be reconstructed, the desk needs the whole database, the logs, the
     * workspaces, and every snapshot this agent already sent, and it needs it
     * from a machine nobody on the desk can log into. This button builds that
     * package on the VPS and leaves it on the Desktop for the client to send.
     *
     * It runs in this window rather than in the service because the service
     * runs as LocalSystem and NinjaTrader's files belong to the logged-in user.
     * Nothing is uploaded. Nothing that authenticates goes in. See
     * DeepExport/DeepExportRunner.cs for what is and is not included. */
    private string deepExportProgressText = string.Empty;
    private int deepExportPercent;
    private string deepExportPath;
    private string deepExportSha256;
    private string deepExportMessage;
    private string deepExportCopyConfirmation;

    public string DeepExportProgressText
    {
        get => deepExportProgressText;
        private set => Set(ref deepExportProgressText, value);
    }

    public int DeepExportPercent
    {
        get => deepExportPercent;
        private set => Set(ref deepExportPercent, value);
    }

    /// <summary>Where the package landed. Null until a run has finished.</summary>
    public string DeepExportPath
    {
        get => deepExportPath;
        private set
        {
            if (Set(ref deepExportPath, value))
            {
                PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(HasDeepExport)));
                (OpenDeepExportFolderCommand as AsyncCommand)?.RaiseCanExecuteChanged();
                (CopyDeepExportShaCommand as AsyncCommand)?.RaiseCanExecuteChanged();
            }
        }
    }

    public string DeepExportSha256
    {
        get => deepExportSha256;
        private set => Set(ref deepExportSha256, value);
    }

    public bool HasDeepExport => !string.IsNullOrEmpty(DeepExportPath);

    /// <summary>The outcome in a sentence: size, warnings, or why it did not run.</summary>
    public string DeepExportMessage
    {
        get => deepExportMessage;
        private set => Set(ref deepExportMessage, value);
    }

    public string DeepExportCopyConfirmation
    {
        get => deepExportCopyConfirmation;
        private set => Set(ref deepExportCopyConfirmation, value);
    }

    // What the status reply told us, kept for the manifest.
    private string deviceId;
    private string timeZone;
    private string ninjaTraderVersion;
    private string addonVersion;

    internal DeepExportEnvironment DescribeEnvironment()
    {
        bool ninjaTraderRunning = false;
        try { ninjaTraderRunning = Process.GetProcessesByName("NinjaTrader").Length > 0; } catch (Exception) { }
        return new DeepExportEnvironment(
            string.IsNullOrWhiteSpace(deviceId) ? Environment.MachineName : deviceId,
            Environment.MachineName,
            InstalledVersion,
            addonVersion,
            ninjaTraderVersion,
            ninjaTraderRunning,
            timeZone ?? "America/New_York");
    }

    internal async Task DeepExportAsync()
    {
        if (IsBusy) return;
        IsBusy = true;
        DeepExportPath = null;
        DeepExportSha256 = null;
        DeepExportCopyConfirmation = null;
        DeepExportPercent = 0;
        DeepExportProgressText = "Starting…";
        DeepExportMessage = null;
        try
        {
            var progress = new Progress<DeepExportProgress>(p =>
            {
                DeepExportPercent = p.Total == 0 ? 0 : (int)Math.Round(100.0 * p.Completed / p.Total);
                DeepExportProgressText = $"{p.Source} ({p.Completed}/{p.Total})";
            });
            DeepExportResult result = await deepExport(DescribeEnvironment(), progress, CancellationToken.None).ConfigureAwait(true);
            DeepExportPercent = 100;
            DeepExportProgressText = "Done";
            DeepExportPath = result.ZipPath;
            DeepExportSha256 = result.Sha256;
            // Invariant: the number is read by a desk in New York off a screen
            // in Bogotá, and "2,4 MB" reads as two thousand somewhere.
            string size = result.SizeBytes >= 1024 * 1024
                ? string.Format(CultureInfo.InvariantCulture, "{0:0.#} MB", result.SizeBytes / (1024.0 * 1024.0))
                : $"{Math.Max(1, result.SizeBytes / 1024)} KB";
            DeepExportMessage = result.Warnings.Count == 0
                ? $"Package ready ({size}). A copy is on the Desktop. Send that file to the desk."
                : $"Package ready ({size}) with {result.Warnings.Count} warning{(result.Warnings.Count == 1 ? string.Empty : "s")}: {string.Join("; ", result.Warnings)}. A copy is on the Desktop.";
        }
        catch (DeepExportUnavailableException exception)
        {
            DeepExportProgressText = string.Empty;
            DeepExportMessage = exception.Message;
        }
        catch (Exception exception)
        {
            // Anything from a locked file to the SQLite native library refusing
            // to load. The button is the whole feature, so the reason goes on
            // screen rather than into an unobserved async void.
            DeepExportProgressText = string.Empty;
            DeepExportMessage = $"The export did not finish. {exception.GetType().Name}: {exception.Message}";
        }
        finally
        {
            IsBusy = false;
        }
    }

    /// <summary>The default: NinjaTrader's Documents folder, the agent's ProgramData folder, the package under NinjaTrader 8\AutoExport\deep.</summary>
    private static Task<DeepExportResult> RunDeepExportOnThisMachineAsync(
        DeepExportEnvironment environment, IProgress<DeepExportProgress> progress, CancellationToken cancellationToken)
    {
        string ninjaTrader = NinjaTraderFolder.Resolve();
        if (ninjaTrader == null)
        {
            throw new DeepExportUnavailableException(
                "NinjaTrader 8 was not found under this user's Documents. Sign in as the user who runs NinjaTrader and try again.");
        }
        string agentRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Vincere", "AutoExport");
        string outputRoot = Path.Combine(ninjaTrader, "AutoExport", "deep");
        string desktop = null;
        try { desktop = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory); } catch (Exception) { }
        var runner = new DeepExportRunner(ninjaTrader, agentRoot, outputRoot, desktop, environment);
        return Task.Run(() => runner.RunAsync(progress, cancellationToken), cancellationToken);
    }

    private Task OpenDeepExportFolderAsync()
    {
        if (!HasDeepExport) return Task.CompletedTask;
        string folder = Path.GetDirectoryName(DeepExportPath);
        try
        {
            Process.Start(new ProcessStartInfo(folder) { UseShellExecute = true })?.Dispose();
        }
        catch (Exception exception)
        {
            DeepExportMessage = $"Could not open {folder}. {exception.Message}";
        }
        return Task.CompletedTask;
    }

    internal Task CopyDeepExportShaAsync()
    {
        if (string.IsNullOrEmpty(DeepExportSha256)) return Task.CompletedTask;
        if (copyToClipboard == null)
        {
            DeepExportCopyConfirmation = "Select the checksum above and copy it.";
            return Task.CompletedTask;
        }
        try
        {
            copyToClipboard(DeepExportSha256);
            DeepExportCopyConfirmation = "Checksum copied.";
        }
        catch (Exception)
        {
            DeepExportCopyConfirmation = "Could not reach the clipboard. Select the checksum above and copy it.";
        }
        return Task.CompletedTask;
    }

    // ASKING, RATHER THAN WAITING TO BE TOLD.
    //
    // UpdateRequired only ever arrives inside a heartbeat response. Heartbeats
    // have been failing with a 500 all week, which is exactly when someone wants
    // to know whether their agent is current, so the notice was dark precisely
    // when it mattered. This asks the release manifest directly and works
    // whether or not the CRM does.
    //
    // Reads a version and says a sentence. It does not download and it does not
    // install; see ReleaseCheck for why that line is where it is.
    // internal, not private: the UI test project compiles this file into its own
    // assembly and awaits this directly. ICommand.Execute is `async void`, which
    // a test cannot await.
    internal async Task CheckForUpdateAsync()
    {
        // Refuse to compare a version we are only guessing at. Comparing this
        // window's own assembly against the published manifest is what produced
        // a permanent "an update is available" on machines that were already
        // current, and a notice everyone learns to ignore is worse than none.
        if (!InstalledVersionIsFromService)
        {
            LatestVersionMessage = "Cannot check yet: the collector service has not reported its version.";
            StatusMessage = LatestVersionMessage;
            return;
        }
        StatusMessage = "Checking for updates...";
        ReleaseCheckResult result = await releaseCheck.CheckAsync(InstalledVersion).ConfigureAwait(true);
        LatestVersionMessage = result.Message;
        StatusMessage = result.Message;
        UpdateInstallCommand = result.InstallCommand;
        CopyConfirmation = null;
        pendingUpdate = result;
        CanInstallUpdate = result.CanInstall;
    }

    private string updateInstallCommand;
    private string copyConfirmation;
    private bool canInstallUpdate;
    private ReleaseCheckResult pendingUpdate;

    /* THE BUTTON, AND WHY IT IS ONLY SOMETIMES THERE.
     *
     * Copying a command was still an errand: the reader had to find a
     * PowerShell, paste, and know what they were looking at. This does the same
     * install from the window they are already in.
     *
     * It is NOT an auto-update. A person presses it, Windows asks them to
     * elevate, and a console shows them what happens. Software that replaces
     * itself unattended on a machine carrying live client prop-firm accounts is
     * a different decision, and it is not this one.
     *
     * It appears only when the published checksum is known, because the script
     * behind it downloads a package and runs it as administrator. Where the
     * checksum cannot be trusted the window still hands over the command, which
     * keeps a person in front of the install rather than pretending. */
    public bool CanInstallUpdate
    {
        get => canInstallUpdate;
        private set
        {
            if (Set(ref canInstallUpdate, value))
                (InstallUpdateCommand as AsyncCommand)?.RaiseCanExecuteChanged();
        }
    }

    internal Task InstallUpdateAsync()
    {
        ReleaseCheckResult update = pendingUpdate;
        if (update == null || !update.CanInstall)
        {
            StatusMessage = "Check for updates first.";
            return Task.CompletedTask;
        }
        string script = ReleaseCheck.BuildVerifiedInstallScript(update.DownloadUrl, update.Sha256);
        if (string.IsNullOrEmpty(script))
        {
            StatusMessage = "This update cannot be installed from here. Copy the command below instead.";
            return Task.CompletedTask;
        }
        if (runElevatedScript == null)
        {
            StatusMessage = "Installing is not available in this window. Copy the command below instead.";
            return Task.CompletedTask;
        }
        try
        {
            // The installer stops the service this window talks to and replaces
            // the window's own files, so a console owns the rest of it. Saying
            // that here is kinder than a window that stops answering.
            StatusMessage = runElevatedScript(script)
                ? $"Installing {update.LatestVersion}. A console window is doing the work; this window will close when it replaces itself."
                : "The update was not started. Nothing has changed.";
        }
        catch (Exception)
        {
            StatusMessage = "Could not start the installer. Copy the command below and run it in PowerShell as administrator.";
        }
        return Task.CompletedTask;
    }


    /* THE COMMAND ITSELF, BECAUSE THERE IS NO WAY BACK TO THE CRM SCREEN.
     *
     * The notice used to end "re-run the install line from the CRM", which is
     * only actionable for someone who can reach the screen that prints that
     * line. Once a client is past setup the CRM offers no way back to it, so
     * the one instruction this window gave was one the reader could not follow.
     *
     * This is the same command the CRM builds, assembled from the manifest the
     * check already downloaded. The window does NOT run it: a person pastes it
     * into an elevated PowerShell and watches it. These machines carry live
     * client accounts, and software that replaces itself unattended on one of
     * them is not this window's call to make. */
    public string UpdateInstallCommand
    {
        get => updateInstallCommand;
        private set
        {
            if (Set(ref updateInstallCommand, value))
            {
                PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(HasUpdateInstallCommand)));
                (CopyInstallCommandCommand as AsyncCommand)?.RaiseCanExecuteChanged();
            }
        }
    }

    public bool HasUpdateInstallCommand => !string.IsNullOrEmpty(UpdateInstallCommand);

    /// <summary>What the reader is told after pressing Copy.</summary>
    public string CopyConfirmation
    {
        get => copyConfirmation;
        private set => Set(ref copyConfirmation, value);
    }

    internal Task CopyInstallCommandAsync()
    {
        if (string.IsNullOrEmpty(UpdateInstallCommand)) return Task.CompletedTask;
        if (copyToClipboard == null)
        {
            // No clipboard in this host. The command is on screen and
            // selectable, so say that rather than claim it was copied.
            CopyConfirmation = "Select the command above and copy it.";
            return Task.CompletedTask;
        }
        try
        {
            copyToClipboard(UpdateInstallCommand);
            CopyConfirmation = "Copied. Paste it into PowerShell as administrator.";
        }
        catch (Exception)
        {
            // Another process holding the clipboard is the ordinary reason, and
            // the command stays on screen either way.
            CopyConfirmation = "Could not reach the clipboard. Select the command above and copy it.";
        }
        return Task.CompletedTask;
    }

    /* THE VERSION OF THE SERVICE, NOT OF THIS WINDOW.
     *
     * This used to read typeof(MainViewModel).Assembly, which is the Setup
     * window's own assembly. Only the service project declares a <Version>, so
     * the window said 1.0.0 while the service beside it was 1.0.2, and someone
     * who had just reinstalled was told the update had not taken. Worse, the
     * update check then compared 1.0.0 against the published manifest and
     * announced an update that was already installed, every time, forever.
     *
     * The service reports its own version over the control pipe now. This
     * assembly value survives only as the answer before the pipe replies, and
     * the check refuses to run until it has been replaced. */
    public string InstalledVersion { get; set; } =
        typeof(MainViewModel).Assembly.GetName().Version?.ToString(3) ?? "1.0.0";

    /// <summary>True once the service has told us what it is running.</summary>
    public bool InstalledVersionIsFromService { get; private set; }

    private string latestVersionMessage = string.Empty;
    public string LatestVersionMessage
    {
        get => latestVersionMessage;
        private set => Set(ref latestVersionMessage, value);
    }

    // THE FOLDER NOBODY COULD NAVIGATE TO.
    //
    // The queue lives under ProgramData, which is hidden, inside a folder tree
    // restricted to SYSTEM and Administrators. Reaching it meant knowing the
    // path and pasting it into the address bar, so a CAM who needed to copy a
    // capture out by hand, which is the whole fallback while uploads are
    // failing, had to be told the path every time.
    //
    // Opens the pending folder rather than the queue root: that is where the
    // files that have not made it to the CRM are, and it is the only one anyone
    // has ever needed to open.
    private Task OpenQueueFolderAsync()
    {
        string pending = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
            "Vincere", "AutoExport", "queue", "pending");
        try
        {
            // Created rather than reported missing: an empty queue folder is the
            // normal state and an error about it would read as a fault.
            Directory.CreateDirectory(pending);
            Process.Start(new ProcessStartInfo(pending) { UseShellExecute = true })?.Dispose();
        }
        catch (Exception exception)
        {
            StatusMessage = $"Could not open {pending}. {exception.Message}";
        }
        return Task.CompletedTask;
    }

    // WHY THIS IS A LIST AND NOT ONE SENTENCE.
    //
    // Nine different refusals used to read "This code is invalid or expired.
    // Generate a new code in the CRM." Two of them are fixed by a new code. The
    // rest are not, and the desk generated code after code against a machine
    // that already had a device, being told each time to try another one.
    //
    // Each line says what to do, because a name for the fault with no next step
    // is only a better looking dead end.
    private static string PairingRefusalMessage(string code) => code switch
    {
        "invalid_or_expired_code" => "This code is not valid. Generate a new code in the CRM.",
        "code_expired" => "This code has expired. Generate a new one in the CRM.",
        "code_consumed" => "This code was already used. Generate a new one in the CRM.",
        "code_revoked" => "This code was revoked in the CRM. Generate a new one.",
        "machine_conflict" =>
            "This VPS is already connected to a client. Revoke it in the CRM before connecting it to another one. A new code will not help.",
        "device_revoked" =>
            "This VPS was revoked in the CRM. Rebind it there before connecting again.",
        "client_ineligible" =>
            "This client is not ready for automatic collection. Check its status and product key in the CRM.",
        "credential_conflict" or "nonce_or_credential_conflict" =>
            "A different pairing is already in progress for this code. Generate a new one in the CRM.",
        _ => null,
    };

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
            ScheduleTime = Value(data, "ScheduleTime", "scheduleTime") ?? "16:30";
            deviceId = Value(data, "DeviceId", "deviceId");
            timeZone = Value(data, "TimeZone", "timeZone");
            addonVersion = Value(data, "AddonVersion", "addonVersion");
            string reportedVersion = Value(data, "AgentVersion", "agentVersion");
            if (!string.IsNullOrWhiteSpace(reportedVersion))
            {
                InstalledVersion = reportedVersion.Trim();
                InstalledVersionIsFromService = true;
            }
            JObject runtime = ObjectValue(data, "Runtime", "runtime");
            UpdateRequired = runtime?.Value<bool?>("UpdateRequired")
                ?? runtime?.Value<bool?>("updateRequired")
                ?? false;
            ninjaTraderVersion = Value(runtime, "NinjaTraderVersion", "ninjaTraderVersion");
            addonVersion ??= Value(runtime, "AddonVersion", "addonVersion");
            JObject queue = ObjectValue(data, "Queue", "queue");
            int pending = queue?.Value<int?>("PendingCount") ?? queue?.Value<int?>("pendingCount") ?? 0;
            QueueSummary = pending == 0 ? "No uploads waiting" : $"{pending} upload{(pending == 1 ? string.Empty : "s")} waiting";
            ApplyTimeline(data);
            ApplyQuarantine(data);
            CurrentStep = paired ? 3 : 2;
            StatusMessage = paired
                ? $"Connected to {ClientName}. Restart NinjaTrader, then test the connection."
                : "Service ready. Enter the one-time code from the CRM.";
        }, "The Windows service is unavailable. Open setup as administrator or repair the installation.");
    }

    private void ApplyTimeline(JObject data)
    {
        IReadOnlyList<CaptureDayView> parsed = CaptureTimeline.Parse(
            data["Timeline"] ?? data["timeline"]);
        Days = parsed;
        CollectionSummary = CaptureTimeline.Summarize(parsed);
        string alert = CaptureTimeline.Alert(parsed);
        CollectionAlert = alert;
        PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(HasCollectionAlert)));
    }

    private void ApplyQuarantine(JObject data)
    {
        Quarantine = QuarantineView.Parse(data?["Quarantine"] ?? data?["quarantine"]);
    }

    // internal, not private, for the same reason as CheckForUpdateAsync: the
    // test project awaits this directly, and ICommand.Execute cannot be awaited.
    internal async Task RetryQuarantineAsync()
    {
        await RunAsync(async () =>
        {
            UiControlResponse response = await client.SendAsync("retryQuarantine");
            StatusMessage = response.Message;
            if (!response.Ok) return;
            // What moved is now in the queue and what stayed is still here.
            // Ask again rather than guess, so the list and the summary read as
            // the folder actually is.
            UiControlResponse status = await client.SendAsync("status");
            if (status.Ok) ApplyQuarantine(status.Data ?? new JObject());
        }, "The service could not review the quarantine.");
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
                StatusMessage = PairingRefusalMessage(response.Code) ?? response.Message;
                return;
            }
            ClientName = Value(response.Data, "ClientName", "clientName");
            ScheduleTime = Value(response.Data, "ScheduleTime", "scheduleTime") ?? "16:30";
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
        foreach (AsyncCommand command in new[] { PairCommand, TestCaptureCommand, SaveScheduleCommand, CollectDiagnosticsCommand, OpenQueueFolderCommand, CheckForUpdateCommand, DeepExportCommand, RetryQuarantineCommand }.OfType<AsyncCommand>())
            command.RaiseCanExecuteChanged();
    }
}

/// <summary>The export could not start on this machine, for a reason a person can act on.</summary>
public sealed class DeepExportUnavailableException : Exception
{
    public DeepExportUnavailableException(string message) : base(message) { }
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
