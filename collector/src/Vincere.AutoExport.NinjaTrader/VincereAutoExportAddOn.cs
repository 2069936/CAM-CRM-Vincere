using System;
using System.Globalization;
using System.Reflection;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Threading;
using NinjaTrader.Gui;
using NinjaTrader.Gui.Tools;
using NinjaTrader.NinjaScript;
using Vincere.AutoExport.Contracts;
using Vincere.AutoExport.NinjaTrader.Capture;
using Vincere.AutoExport.NinjaTrader.Core.Capture;
using Vincere.AutoExport.NinjaTrader.Core.Pipe;
using Vincere.AutoExport.NinjaTrader.Diagnostics;
using Vincere.AutoExport.NinjaTrader.Pipe;

namespace NinjaTrader.NinjaScript.AddOns
{
    public sealed class VincereAutoExportAddOn : AddOnBase
    {
        private const string EasternTimeZoneId = "Eastern Standard Time";
        private static VincereAutoExportAddOn runtimeOwner;
        private readonly AddOnDiagnostics diagnostics = new AddOnDiagnostics();
        private CapturePipeServer server;
        private NTMenuItem statusMenuItem;
        private NTMenuItem newMenu;
        private ControlCenter attachedControlCenter;

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Name = "VincereAutoExportAddOn";
                Description = "Provides supported-API NinjaTrader captures to the local Vincere collector.";
            }
            else if (State == State.Terminated)
            {
                StopRuntime();
            }
        }

        protected override void OnWindowCreated(Window window)
        {
            ControlCenter controlCenter = window as ControlCenter;
            if (controlCenter == null || attachedControlCenter != null)
                return;
            if (!ReferenceEquals(Interlocked.CompareExchange(ref runtimeOwner, this, null), null)
                && !ReferenceEquals(runtimeOwner, this))
                return;

            attachedControlCenter = controlCenter;
            StartRuntime();
            AttachStatusMenu(controlCenter);
        }

        protected override void OnWindowDestroyed(Window window)
        {
            if (!ReferenceEquals(window, attachedControlCenter))
                return;
            DetachStatusMenu();
            attachedControlCenter = null;
            StopRuntime();
        }

        private void StartRuntime()
        {
            if (server != null)
                return;
            var processor = new CaptureRequestProcessor(CaptureAsync, TimeSpan.FromSeconds(25));
            server = new CapturePipeServer(processor, diagnostics);
            server.Start();
        }

        private void StopRuntime()
        {
            CapturePipeServer current = server;
            server = null;
            current?.Dispose();
            Interlocked.CompareExchange(ref runtimeOwner, null, this);
        }

        private Task<AutoExportSnapshotV1> CaptureAsync(CancellationToken cancellationToken)
        {
            if (Application.Current == null)
                throw new InvalidOperationException("NinjaTrader has no application dispatcher.");
            var completion = new TaskCompletionSource<AutoExportSnapshotV1>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            CancellationTokenRegistration registration = cancellationToken.Register(
                () => completion.TrySetCanceled());
            completion.Task.ContinueWith(
                _ => registration.Dispose(),
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            Application.Current.Dispatcher.BeginInvoke(
                new Action(() => CaptureOnDispatcher(completion, cancellationToken)),
                DispatcherPriority.Background);
            return completion.Task;
        }

        private static void CaptureOnDispatcher(
            TaskCompletionSource<AutoExportSnapshotV1> completion,
            CancellationToken cancellationToken)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                completion.TrySetCanceled();
                return;
            }
            try
            {
                DateTimeOffset capturedAt = DateTimeOffset.Now;
                TimeZoneInfo eastern = TimeZoneInfo.FindSystemTimeZoneById(EasternTimeZoneId);
                DateTimeOffset easternNow = TimeZoneInfo.ConvertTime(capturedAt, eastern);
                string addOnVersion = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
                string ninjaTraderVersion = typeof(AddOnBase).Assembly.GetName().Version.ToString();
                var snapshot = new SnapshotBuilder(new NinjaTraderFacade()).Build(
                    new SnapshotBuildContext
                    {
                        CaptureId = Guid.NewGuid(),
                        CapturedAt = capturedAt,
                        TradingDate = easternNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                        AddonVersion = addOnVersion,
                        NinjaTraderVersion = ninjaTraderVersion,
                    });
                completion.TrySetResult(snapshot);
            }
            catch (Exception exception)
            {
                completion.TrySetException(exception);
            }
        }

        private void AttachStatusMenu(ControlCenter controlCenter)
        {
            newMenu = controlCenter.FindFirst("ControlCenterMenuItemNew") as NTMenuItem;
            if (newMenu == null)
                return;
            statusMenuItem = new NTMenuItem
            {
                Header = "Vincere Auto Export Status",
                Style = Application.Current.TryFindResource("MainMenuItem") as Style,
            };
            statusMenuItem.Click += OnStatusClick;
            newMenu.Items.Add(statusMenuItem);
        }

        private void DetachStatusMenu()
        {
            if (statusMenuItem != null)
            {
                statusMenuItem.Click -= OnStatusClick;
                if (newMenu != null && newMenu.Items.Contains(statusMenuItem))
                    newMenu.Items.Remove(statusMenuItem);
            }
            statusMenuItem = null;
            newMenu = null;
        }

        private void OnStatusClick(object sender, RoutedEventArgs eventArgs)
        {
            AddOnStatus status = diagnostics.Snapshot();
            string version = Assembly.GetExecutingAssembly().GetName().Version.ToString(3);
            string lastAt = status.LastResultAt.HasValue
                ? status.LastResultAt.Value.ToString("u", CultureInfo.InvariantCulture)
                : "never";
            MessageBox.Show(
                "Version: " + version
                + "\nPipe: " + status.PipeState
                + "\nLast capture: " + status.LastResult
                + "\nLast result at: " + lastAt,
                "Vincere Auto Export Status",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
        }
    }
}
