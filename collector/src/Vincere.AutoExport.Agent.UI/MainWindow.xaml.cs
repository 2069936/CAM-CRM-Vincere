using System.Windows;

namespace Vincere.AutoExport.Agent.UI;

public partial class MainWindow : Window
{
    private readonly MainViewModel viewModel;

    public MainWindow()
    {
        InitializeComponent();
        viewModel = new MainViewModel(new ControlPipeClient());
        DataContext = viewModel;
        Loaded += async (_, _) => await viewModel.InitializeAsync();
    }
}
