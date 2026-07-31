using System;
using System.IO;
using System.IO.Pipes;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.NinjaTrader.Core.Pipe;
using Vincere.AutoExport.NinjaTrader.Diagnostics;

namespace Vincere.AutoExport.NinjaTrader.Pipe
{
    public sealed class CapturePipeServer : IDisposable
    {
        public const string DefaultPipeName = "Vincere.AutoExport.v1";
        private const int MaximumRequestBytes = 16 * 1024;
        private const int MaximumResponseBytes = 64 * 1024 * 1024;
        private readonly object sync = new object();
        private readonly string pipeName;
        private readonly CaptureConnectionHandler connectionHandler;
        private readonly AddOnDiagnostics diagnostics;
        private readonly CancellationTokenSource shutdown = new CancellationTokenSource();
        private NamedPipeServerStream activePipe;
        private Task serverTask;
        private int started;
        private int disposed;

        public CapturePipeServer(
            CaptureRequestProcessor processor,
            AddOnDiagnostics diagnostics,
            string pipeName = DefaultPipeName)
        {
            if (String.IsNullOrWhiteSpace(pipeName))
                throw new ArgumentException("A capture pipe name is required.", nameof(pipeName));
            this.diagnostics = diagnostics ?? throw new ArgumentNullException(nameof(diagnostics));
            this.pipeName = pipeName;
            connectionHandler = new CaptureConnectionHandler(
                new CaptureFrameCodec(MaximumRequestBytes, MaximumResponseBytes),
                processor ?? throw new ArgumentNullException(nameof(processor)),
                diagnostics.RecordResponse);
        }

        public bool IsRunning => Volatile.Read(ref started) == 1 && Volatile.Read(ref disposed) == 0;

        public void Start()
        {
            if (Volatile.Read(ref disposed) != 0)
                throw new ObjectDisposedException(nameof(CapturePipeServer));
            if (Interlocked.CompareExchange(ref started, 1, 0) != 0)
                return;
            diagnostics.SetPipeState("starting");
            serverTask = Task.Run(() => RunAsync(shutdown.Token));
        }

        private async Task RunAsync(CancellationToken cancellationToken)
        {
            while (!cancellationToken.IsCancellationRequested)
            {
                try
                {
                    using (NamedPipeServerStream pipe = CapturePipeSecurity.Create(pipeName))
                    {
                        lock (sync)
                            activePipe = pipe;
                        diagnostics.SetPipeState("listening");
                        await pipe.WaitForConnectionAsync(cancellationToken).ConfigureAwait(false);
                        diagnostics.SetPipeState("connected");
                        await connectionHandler.HandleAsync(pipe, cancellationToken).ConfigureAwait(false);
                    }
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
                catch (ObjectDisposedException) when (cancellationToken.IsCancellationRequested)
                {
                    break;
                }
                catch (IOException)
                {
                    diagnostics.RecordFailure("pipe_connection_failed");
                }
                catch
                {
                    diagnostics.RecordFailure("pipe_server_failed");
                    try
                    {
                        await Task.Delay(TimeSpan.FromSeconds(1), cancellationToken).ConfigureAwait(false);
                    }
                    catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                    {
                        break;
                    }
                }
                finally
                {
                    lock (sync)
                        activePipe = null;
                }
            }
            diagnostics.SetPipeState("stopped");
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref disposed, 1) != 0)
                return;
            shutdown.Cancel();
            lock (sync)
                activePipe?.Dispose();
            Task completion = serverTask;
            if (completion == null)
            {
                shutdown.Dispose();
                diagnostics.SetPipeState("stopped");
                return;
            }
            completion.ContinueWith(
                _ => shutdown.Dispose(),
                CancellationToken.None,
                TaskContinuationOptions.ExecuteSynchronously,
                TaskScheduler.Default);
        }
    }
}
