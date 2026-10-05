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
        private NTMenuItem exportFileMenuItem;
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
            /* Five seconds for the sample against twenty-five for the close, and
             * the gap is the point. The close is irreplaceable and worth waiting
             * for; a tracker reading is worthless five minutes later, so one that
             * cannot be had quickly should be abandoned rather than waited for. */
            var processor = new CaptureRequestProcessor(
                CaptureAsync,
                TimeSpan.FromSeconds(25),
                SampleAccountsAsync,
                TimeSpan.FromSeconds(5));
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
                completion.TrySetResult(BuildSnapshot(capturedAt, easternNow, addOnVersion, ninjaTraderVersion));
            }
            catch (Exception exception)
            {
                completion.TrySetException(exception);
            }
        }

        /* THE TRACKER READING, ON THE SAME THREAD AND AT THE SAME PRIORITY.
         *
         * It has to be the dispatcher: NinjaTraderFacade's own summary says
         * "Callers must invoke this facade on NinjaTrader's application
         * dispatcher", and that is not negotiable for a sample any more than for a
         * close. DispatcherPriority.Background is what keeps it honest - the work
         * queues BEHIND render and input, so a sample can never make the Control
         * Center stutter, it can only ever be made to wait by one. On a terminal
         * busy enough to delay it past five seconds the processor abandons it and
         * the tracker degrades to nothing, which is the correct outcome: the desk
         * loses one dot for ten minutes and the machine loses nothing.
         *
         * WHAT MAKES IT CHEAP IS ReadAccountsForSample, not this. That method
         * takes neither account.Orders nor account.Executions - the two
         * collections the trading path writes on every fill - and runs no
         * per-row TypeDescriptor walk. See it for the full list of what it
         * does not do.
         *
         * A MIRROR OF CaptureAsync RATHER THAN A SHARED GENERIC HELPER. The two
         * are the same twelve lines and factoring them together was tempting.
         * This file compiles in exactly one place on earth - the self-hosted
         * Windows runner with NinjaTrader installed - so a refactor of the close's
         * marshalling to accommodate the tracker is a change to the irreplaceable
         * path that cannot be compiled where it is written. The duplication is the
         * cheaper risk, and it is deliberate. */
        private Task<AccountSampleV1> SampleAccountsAsync(CancellationToken cancellationToken)
        {
            if (Application.Current == null)
                throw new InvalidOperationException("NinjaTrader has no application dispatcher.");
            var completion = new TaskCompletionSource<AccountSampleV1>(
                TaskCreationOptions.RunContinuationsAsynchronously);
            CancellationTokenRegistration registration = cancellationToken.Register(
                () => completion.TrySetCanceled());
            completion.Task.ContinueWith(
                _ => registration.Dispose(),
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
            Application.Current.Dispatcher.BeginInvoke(
                new Action(() => SampleOnDispatcher(completion, cancellationToken)),
                DispatcherPriority.Background);
            return completion.Task;
        }

        private static void SampleOnDispatcher(
            TaskCompletionSource<AccountSampleV1> completion,
            CancellationToken cancellationToken)
        {
            if (cancellationToken.IsCancellationRequested)
            {
                completion.TrySetCanceled();
                return;
            }
            try
            {
                completion.TrySetResult(BuildAccountSample(DateTimeOffset.Now));
            }
            catch (Exception exception)
            {
                completion.TrySetException(exception);
            }
        }

        /* No capture id, no trading date, no add-on version, no NinjaTrader
         * version. A sample is not filed against a trading day and is never
         * replayed, so it needs none of the bookkeeping a close is identified by -
         * and the heartbeat already tells the CRM what this machine is running. */
        private static AccountSampleV1 BuildAccountSample(DateTimeOffset sampledAt)
        {
            return new AccountSampleBuilder(new NinjaTraderFacade()).Build(
                new AccountSampleBuildContext { SampledAt = sampledAt });
        }

        private static AutoExportSnapshotV1 BuildSnapshot(
            DateTimeOffset capturedAt,
            DateTimeOffset easternNow,
            string addOnVersion,
            string ninjaTraderVersion)
        {
            return new SnapshotBuilder(new NinjaTraderFacade()).Build(
                new SnapshotBuildContext
                {
                    CaptureId = Guid.NewGuid(),
                    CapturedAt = capturedAt,
                    TradingDate = easternNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                    AddonVersion = addOnVersion,
                    NinjaTraderVersion = ninjaTraderVersion,
                });
        }

        /// <summary>
        /// Captures exactly what the collector would send and writes it to a file
        /// instead, without contacting the CRM. Lets a capture be verified against
        /// a real NinjaTrader before any pairing or service install exists.
        /// </summary>
        private void OnExportToFileClick(object sender, RoutedEventArgs eventArgs)
        {
            try
            {
                DateTimeOffset capturedAt = DateTimeOffset.Now;
                TimeZoneInfo eastern;
                try { eastern = TimeZoneInfo.FindSystemTimeZoneById(EasternTimeZoneId); }
                catch { eastern = TimeZoneInfo.Local; }

                AutoExportSnapshotV1 snapshot = BuildSnapshot(
                    capturedAt,
                    TimeZoneInfo.ConvertTime(capturedAt, eastern),
                    Assembly.GetExecutingAssembly().GetName().Version.ToString(3),
                    typeof(AddOnBase).Assembly.GetName().Version.ToString());

                string folder = System.IO.Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments),
                    "VincereAutoExport");
                System.IO.Directory.CreateDirectory(folder);
                string path = System.IO.Path.Combine(
                    folder,
                    "snapshot-" + capturedAt.ToString("yyyy-MM-dd-HHmmss", CultureInfo.InvariantCulture) + ".json");

                // Same serializer settings the collector uploads with, so what is
                // inspected here is byte-for-byte what the CRM would receive.
                string json = Newtonsoft.Json.JsonConvert.SerializeObject(
                    snapshot,
                    Newtonsoft.Json.Formatting.Indented,
                    new Newtonsoft.Json.JsonSerializerSettings
                    {
                        NullValueHandling = Newtonsoft.Json.NullValueHandling.Include,
                    });
                System.IO.File.WriteAllText(path, json, new System.Text.UTF8Encoding(false));

                MessageBox.Show(
                    "Saved to:\n" + path
                    + "\n\nAccounts: " + snapshot.Accounts.Count
                    + "\nStrategies: " + snapshot.Strategies.Count
                    + "\nOrders: " + snapshot.Orders.Count
                    + "\nExecutions: " + snapshot.Executions.Count
                    + "\n\nNothing was sent to the CRM.",
                    "Vincere Auto Export - local test",
                    MessageBoxButton.OK,
                    MessageBoxImage.Information);
            }
            catch (Exception exception)
            {
                MessageBox.Show(
                    "Capture failed: " + exception.Message,
                    "Vincere Auto Export - local test",
                    MessageBoxButton.OK,
                    MessageBoxImage.Error);
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

            exportFileMenuItem = new NTMenuItem
            {
                Header = "Vincere: Export Snapshot to File (local test)",
                Style = Application.Current.TryFindResource("MainMenuItem") as Style,
            };
            exportFileMenuItem.Click += OnExportToFileClick;
            newMenu.Items.Add(exportFileMenuItem);
        }

        private void DetachStatusMenu()
        {
            if (statusMenuItem != null)
            {
                statusMenuItem.Click -= OnStatusClick;
                if (newMenu != null && newMenu.Items.Contains(statusMenuItem))
                    newMenu.Items.Remove(statusMenuItem);
            }
            if (exportFileMenuItem != null)
            {
                exportFileMenuItem.Click -= OnExportToFileClick;
                if (newMenu != null && newMenu.Items.Contains(exportFileMenuItem))
                    newMenu.Items.Remove(exportFileMenuItem);
            }
            statusMenuItem = null;
            exportFileMenuItem = null;
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
