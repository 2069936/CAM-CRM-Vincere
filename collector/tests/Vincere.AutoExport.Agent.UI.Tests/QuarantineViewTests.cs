using System.Linq;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.UI;
using Xunit;

namespace Vincere.AutoExport.Agent.UI.Tests;

/* THE CARD SAYS WHETHER PRESSING THE BUTTON WILL HELP.
 *
 * A 422 is retried by the service once a fix lands on the CRM side; a close
 * the CRM already holds is sent again until the desk has replayed it there;
 * a 400, a 413 or a conflict never is. The row says which, in a sentence, so
 * the button is pressed when it can do something and left alone when it
 * cannot. */
public sealed class QuarantineViewTests
{
    private static JObject Status(params object[] items) => JObject.FromObject(new
    {
        Count = items.Length,
        Items = items,
        ReviewTime = "12:00",
    });

    private static object Item(string date, string code, int attempts, bool willRetry) => new
    {
        TradingDate = date,
        CaptureId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        Code = code,
        Attempts = attempts,
        WillRetry = willRetry,
        QuarantinedAt = "2026-07-22T20:46:00+00:00",
        LastAttemptAt = (string)null,
    };

    [Fact]
    public void NothingInTheFolderReadsAsNothing()
    {
        QuarantineView view = QuarantineView.Parse(null);

        Assert.False(view.HasItems);
        Assert.Equal(0, view.Count);
        Assert.Equal("No captures in quarantine", view.Summary);
    }

    [Fact]
    public void ARetryableRowSaysWhenAndHowManyTriesAreLeft()
    {
        QuarantineView view = QuarantineView.Parse(Status(
            Item("2026-07-22", "snapshot_processing_failed", 1, true)));

        QuarantineItemView row = Assert.Single(view.Items);
        Assert.Equal("Wed 22 Jul", row.DateLabel);
        Assert.Equal("snapshot_processing_failed", row.Code);
        Assert.Contains("could not process", row.Reason);
        Assert.Equal("1 of 3 retries used", row.Attempts);
        Assert.Equal("Will be retried at 12:00 PM New York", row.Disposition);
        Assert.Equal("pending", row.Tone);
        Assert.Equal("1 capture in quarantine · 1 will be sent again at 12:00 PM New York", view.Summary);
    }

    [Fact]
    public void ARowTheCrmAlreadyHoldsSaysItIsSentAgainUntilTheDeskReplaysIt()
    {
        // The CRM of today answers a resend of a 422 with 409 and keeps the
        // failed close for the desk to replay. The service sends it again at
        // every review, and the row says so rather than promising a retry that
        // could succeed on its own.
        QuarantineView view = QuarantineView.Parse(Status(
            Item("2026-07-22", "capture_requires_replay", 2, true),
            Item("2026-07-21", "capture_requires_replay", 1, true),
            Item("2026-07-20", "capture_requires_replay", 0, true)));

        QuarantineItemView row = view.Items[0];
        Assert.Contains("desk has to replay it", row.Reason);
        Assert.Equal("Sent again 2 times", row.Attempts);
        Assert.Equal("Sent again at 12:00 PM New York until the desk replays it", row.Disposition);
        Assert.Equal("pending", row.Tone);
        Assert.Equal("Sent again once", view.Items[1].Attempts);
        Assert.Equal(string.Empty, view.Items[2].Attempts);
        Assert.Equal("3 captures in quarantine · 3 will be sent again at 12:00 PM New York", view.Summary);
    }

    [Fact]
    public void AFinalRowSaysItWaitsForTheDesk()
    {
        QuarantineView view = QuarantineView.Parse(Status(
            Item("2026-07-21", "snapshot_rejected", 0, false),
            Item("2026-07-20", "unsupported_schema_version", 3, false)));

        Assert.Equal("bad", view.Items[0].Tone);
        Assert.Equal("Waiting for the desk", view.Items[0].Disposition);
        Assert.Equal(string.Empty, view.Items[0].Attempts);
        Assert.Equal("Retried 3 times, waiting for the desk", view.Items[1].Disposition);
        Assert.Equal("3 of 3 retries used", view.Items[1].Attempts);
        Assert.Equal("2 captures in quarantine · 2 waiting for the desk", view.Summary);
    }

    [Fact]
    public void TheSummaryCountsBothKinds()
    {
        QuarantineView view = QuarantineView.Parse(Status(
            Item("2026-07-22", "snapshot_processing_failed", 0, true),
            Item("2026-07-21", "capture_conflict", 0, false)));

        Assert.Equal("2 captures in quarantine · 1 will be sent again at 12:00 PM New York, 1 waiting for the desk", view.Summary);
    }

    [Fact]
    public void TheCountIsTheFolderEvenWhenTheListIsCapped()
    {
        // The service lists at most fifty rows in a status frame. The headline
        // number is still the whole folder.
        JObject status = Status(Item("2026-07-22", "snapshot_processing_failed", 0, true));
        status["Count"] = 80;

        QuarantineView view = QuarantineView.Parse(status);

        Assert.Equal(80, view.Count);
        Assert.Single(view.Items);
    }

    [Fact]
    public void AcceptsTheCamelCaseSpellingToo()
    {
        QuarantineView view = QuarantineView.Parse(JObject.FromObject(new
        {
            count = 1,
            reviewTime = "13:30",
            items = new[]
            {
                new { tradingDate = "2026-07-22", code = "snapshot_processing_failed", attempts = 2, willRetry = true },
            },
        }));

        Assert.Equal(1, view.Count);
        Assert.Equal("Will be retried at 1:30 PM New York", Assert.Single(view.Items).Disposition);
    }

    [Fact]
    public void ARowWithoutACodeIsDroppedRatherThanGuessedAt()
    {
        QuarantineView view = QuarantineView.Parse(Status(
            new { TradingDate = "2026-07-22" },
            Item("2026-07-21", "payload_too_large", 0, false)));

        Assert.Equal("payload_too_large", Assert.Single(view.Items).Code);
        Assert.Equal(2, view.Count);
    }

    [Fact]
    public void AnUnknownCodeIsShownAsItself()
    {
        QuarantineView view = QuarantineView.Parse(Status(Item("2026-07-22", "something_new", 0, false)));

        Assert.Equal("something_new", view.Items.Single().Reason);
    }
}
