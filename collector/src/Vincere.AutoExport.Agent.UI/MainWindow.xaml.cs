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
            copyToClipboard: text => System.Windows.Clipboard.SetText(text));
        DataContext = viewModel;
        Loaded += async (_, _) => await viewModel.InitializeAsync();
    }
}
