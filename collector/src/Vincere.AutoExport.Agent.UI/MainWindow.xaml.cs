using System.Windows;

namespace Vincere.AutoExport.Agent.UI;

public partial class MainWindow : Window
{
    private readonly MainViewModel viewModel;

    public MainWindow()
    {
        InitializeComponent();
        // Clipboard is passed in rather than reached for inside the view model,
        // which is compiled into a plain net8.0 test assembly where WPF is not
        // available.
        viewModel = new MainViewModel(
            new ControlPipeClient(),
            copyToClipboard: text => System.Windows.Clipboard.SetText(text),
            runElevatedScript: RunElevatedScript);
        DataContext = viewModel;
        Loaded += async (_, _) => await viewModel.InitializeAsync();
    
    /* Runs the update as administrator, from a file rather than an inline
     * command: a hundred-character URL and a checksum threaded through nested
     * quoting is how an install line becomes a bug nobody can read.
     *
     * UseShellExecute with runas is what raises the Windows prompt. Declining
     * that prompt throws, and the caller reports it as "not started, nothing
     * has changed", which is exactly what happened. */
    private static bool RunElevatedScript(string script)
    {
        string path = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(),
            "vincere-auto-export-update.ps1");
        System.IO.File.WriteAllText(path, script);
        var startInfo = new System.Diagnostics.ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = $"-NoProfile -ExecutionPolicy Bypass -NoExit -File \"{path}\"",
            UseShellExecute = true,
            Verb = "runas",
        };
        try
        {
            return System.Diagnostics.Process.Start(startInfo) != null;
        }
        catch (System.ComponentModel.Win32Exception)
        {
            // The elevation prompt was declined. Nothing ran.
            return false;
        }
    }
}
}
