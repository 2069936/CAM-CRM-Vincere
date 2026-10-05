using System;
using Newtonsoft.Json;

namespace Vincere.AutoExport.Contracts
{
    public sealed class CaptureRequest
    {
        /// <summary>
        /// What the caller is asking for. "capture" is the day's close; the
        /// add-on has answered exactly that one word since it shipped.
        /// "sample_accounts" is the tracker reading, and the field needed no
        /// change to carry it - which is the whole reason a new command costs an
        /// add-on release and not a wire version.
        /// </summary>
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

        /// <summary>
        /// The tracker reading, when the command was "sample_accounts". Beside
        /// <see cref="Snapshot"/> and never in it: exactly one of the two is ever
        /// populated, and the pair being separate properties is what stops a
        /// sample being read as a close by code that only checks for null.
        ///
        /// OMITTED WHEN NULL, WHICH MAKES THIS PROPERTY FREE FOR THE CLOSE. Every
        /// other member here serialises its null, so adding a plain one grew EVERY
        /// response by the fourteen bytes of `"sample":null,` - including the day's
        /// capture, which this change has no business touching. A frame-limit test
        /// sitting on that boundary is what caught it. With Ignore, a close's
        /// response is byte for byte what it was before the tracker existed, and
        /// only a sample pays for the field. Snapshot is deliberately left as it
        /// was: changing the wire format of the irreplaceable path to tidy up a
        /// null would be a risk taken for nothing.
        /// </summary>
        [JsonProperty("sample", NullValueHandling = NullValueHandling.Ignore)]
        public AccountSampleV1 Sample { get; set; }

        /// <summary>
        /// The add-on's own word for what went wrong. Worth saying out loud
        /// because the daily capture path throws this away and reports
        /// "capture_failed" for every refusal: see CapturePipeClient. The account
        /// sample reads this field, because "invalid_request" from an add-on that
        /// predates the tracker is the only version negotiation the pipe has.
        /// </summary>
        [JsonProperty("errorCode")]
        public string ErrorCode { get; set; }

        [JsonProperty("message")]
        public string Message { get; set; }
    }
}
