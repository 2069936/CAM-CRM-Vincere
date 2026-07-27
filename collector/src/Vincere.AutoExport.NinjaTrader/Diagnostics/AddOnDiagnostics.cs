using System;
using Vincere.AutoExport.Contracts;

namespace Vincere.AutoExport.NinjaTrader.Diagnostics
{
    public sealed class AddOnStatus
    {
        public string PipeState { get; set; }
        public string LastResult { get; set; }
        public DateTimeOffset? LastResultAt { get; set; }
    }

    public sealed class AddOnDiagnostics
    {
        private readonly object sync = new object();
        private string pipeState = "stopped";
        private string lastResult = "none";
        private DateTimeOffset? lastResultAt;

        public void SetPipeState(string value)
        {
            lock (sync)
                pipeState = String.IsNullOrWhiteSpace(value) ? "unknown" : value;
        }

        public void RecordResponse(CaptureResponse response)
        {
            if (response == null)
                return;
            lock (sync)
            {
                lastResult = response.Ok
                    ? "capture_ok"
                    : String.IsNullOrWhiteSpace(response.ErrorCode) ? "capture_failed" : response.ErrorCode;
                lastResultAt = DateTimeOffset.Now;
            }
        }

        public void RecordFailure(string code)
        {
            lock (sync)
            {
                lastResult = String.IsNullOrWhiteSpace(code) ? "server_failed" : code;
                lastResultAt = DateTimeOffset.Now;
            }
        }

        public AddOnStatus Snapshot()
        {
            lock (sync)
            {
                return new AddOnStatus
                {
                    PipeState = pipeState,
                    LastResult = lastResult,
                    LastResultAt = lastResultAt,
                };
            }
        }
    }
}
