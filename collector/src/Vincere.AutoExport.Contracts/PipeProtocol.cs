using System;
using Newtonsoft.Json;

namespace Vincere.AutoExport.Contracts
{
    public sealed class CaptureRequest
    {
        [JsonProperty("command")]
        public string Command { get; set; }

        [JsonProperty("requestId")]
        public Guid RequestId { get; set; }
    }

    public sealed class CaptureResponse
    {
        [JsonProperty("ok")]
        public bool Ok { get; set; }

        [JsonProperty("requestId")]
        public Guid RequestId { get; set; }

        [JsonProperty("snapshot")]
        public AutoExportSnapshotV1 Snapshot { get; set; }

        [JsonProperty("errorCode")]
        public string ErrorCode { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }
}
