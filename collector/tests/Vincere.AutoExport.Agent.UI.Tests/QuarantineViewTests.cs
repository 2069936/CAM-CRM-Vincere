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

    /* THE ROWS, STACKED.
     *
     * Twenty refused closes used to be twenty amber rows saying the same
     * sentence. They are now one row per code and tone, with the count and
     * the span of days, and the rows themselves behind it. Items is untouched:
     * the detail is still the service's list in the service's order. */

    [Fact]
    public void CapturesWithTheSameCodeAndToneFoldIntoOneGroup()
    {
        QuarantineView view = QuarantineView.Parse(Status(
            Item("2026-07-20", "snapshot_processing_failed", 1, true),
            Item("2026-07-22", "snapshot_processing_failed", 1, true),
            Item("2026-07-21", "snapshot_processing_failed", 1, true)));

        QuarantineGroupView group = Assert.Single(view.Groups);
        Assert.True(view.IsGrouped);
        Assert.Equal(3, group.Count);
        Assert.Equal("snapshot_processing_failed", group.Code);
        Assert.Equal("pending", group.Tone);
        Assert.Contains("could not process", group.Reason);
        Assert.Equal("Mon 20 Jul to Wed 22 Jul", group.DateRange);
        Assert.Equal("3 captures, Mon 20 Jul to Wed 22 Jul", group.Headline);
        Assert.Equal("Will be retried at 12:00 PM New York", group.Disposition);
        Assert.Equal("1 of 3 retries used", group.Retry);
        Assert.True(group.HasDetails);
        Assert.Equal("Show or hide the 3 captures with code snapshot_processing_failed", group.DetailsName);
        // The rows behind the toggle read newest first.
        Assert.Equal(new[] { "Wed 22 Jul", "Tue 21 Jul", "Mon 20 Jul" }, group.Items.Select(row => row.DateLabel).ToArray());
        // The service's list is still the service's list.
        Assert.Equal(new[] { "Mon 20 Jul", "Wed 22 Jul", "Tue 21 Jul" }, view.Items.Select(row => row.DateLabel).ToArray());
        Assert.Equal("3 captures in quarantine · 3 will be sent again at 12:00 PM New York", view.Summary);
    }

    [Fact]
    public void GroupsReadRetriedFirstThenNewest()
    {
        // The newest capture overall is final; it still comes after every
        // group the button can do something about, because that is the order
        // the Summary already uses.
        QuarantineView view = QuarantineView.Parse(Status(
            Item("2026-07-23", "capture_conflict", 0, false),
            Item("2026-07-20", "snapshot_processing_failed", 0, true),
            Item("2026-07-22", "capture_requires_replay", 1, true),
            Item("2026-07-21", "snapshot_rejected", 0, false)));

        Assert.Equal(
            new[] { "capture_requires_replay", "snapshot_processing_failed", "capture_conflict", "snapshot_rejected" },
            view.Groups.Select(group => group.Code).ToArray());
        Assert.Equal(new[] { "pending", "pending", "bad", "bad" }, view.Groups.Select(group => group.Tone).ToArray());
        Assert.Equal("4 captures in quarantine · 2 will be sent again at 12:00 PM New York, 2 waiting for the desk", view.Summary);
    }

    [Fact]
    public void TheSameCodeInTwoTonesIsTwoGroups()
    {
        // A 422 with retries left and one that has used all three ask
        // different things of the reader, so they do not share a row.
        QuarantineView view = QuarantineView.Parse(Status(
            Item("2026-07-21", "unsupported_schema_version", 3, false),
            Item("2026-07-22", "unsupported_schema_version", 1, true)));

        Assert.Equal(2, view.Groups.Count);
        Assert.Equal("pending", view.Groups[0].Tone);
        Assert.Equal("1 of 3 retries used", view.Groups[0].Retry);
        Assert.Equal("Will be retried at 12:00 PM New York", view.Groups[0].Disposition);
        Assert.Equal("bad", view.Groups[1].Tone);
        Assert.Equal("3 of 3 retries used", view.Groups[1].Retry);
        Assert.Equal("Retried 3 times, waiting for the desk", view.Groups[1].Disposition);
        Assert.All(view.Groups, group => Assert.False(group.HasDetails));
    }

    [Fact]
    public void AGroupWhoseRowsDifferInAttemptsSaysTheRange()
    {
        QuarantineView view = QuarantineView.Parse(Status(
            Item("2026-07-22", "snapshot_processing_failed", 2, true),
            Item("2026-07-21", "snapshot_processing_failed", 1, true),
            Item("2026-07-20", "capture_requires_replay", 4, true),
            Item("2026-07-17", "capture_requires_replay", 0, true),
            Item("2026-07-16", "snapshot_rejected", 0, false),
            Item("2026-07-15", "snapshot_rejected", 0, false)));

        Assert.Equal("1 to 2 of 3 retries used", view.Groups[0].Retry);
        Assert.Equal("Sent again up to 4 times", view.Groups[1].Retry);
        Assert.Equal(string.Empty, view.Groups[2].Retry);
    }

    [Fact]
    public void AGroupWhoseRowsDisagreeOnWhatHappensNextSaysThePlainThing()
    {
        // One row was retried three times before it was given up on, the other
        // was final from the start. The group does not claim either story.
        QuarantineView view = QuarantineView.Parse(Status(
            Item("2026-07-22", "unsupported_schema_version", 3, false),
            Item("2026-07-21", "unsupported_schema_version", 0, false)));

        QuarantineGroupView group = Assert.Single(view.Groups);
        Assert.Equal("Waiting for the desk", group.Disposition);
        Assert.Equal("0 to 3 of 3 retries used", group.Retry);
    }

    [Fact]
    public void ASingleCaptureIsNotGroupedAndItsGroupIsItself()
    {
        QuarantineView view = QuarantineView.Parse(Status(
            Item("2026-07-22", "snapshot_processing_failed", 1, true)));

        Assert.False(view.IsGrouped);
        QuarantineGroupView group = Assert.Single(view.Groups);
        QuarantineItemView row = Assert.Single(view.Items);
        Assert.Equal(1, group.Count);
        Assert.False(group.HasDetails);
        Assert.Equal("Wed 22 Jul", group.DateRange);
        Assert.Equal("1 capture, Wed 22 Jul", group.Headline);
        Assert.Equal(row.Disposition, group.Disposition);
        Assert.Equal(row.Attempts, group.Retry);
        Assert.Equal("1 capture in quarantine · 1 will be sent again at 12:00 PM New York", view.Summary);
    }

    [Fact]
    public void TwoCapturesOnOneDayNameTheDayOnce()
    {
        QuarantineView view = QuarantineView.Parse(Status(
            Item("2026-07-22", "capture_conflict", 0, false),
            Item("2026-07-22", "capture_conflict", 0, false)));

        QuarantineGroupView group = Assert.Single(view.Groups);
        Assert.Equal("Wed 22 Jul", group.DateRange);
        Assert.Equal("2 captures, Wed 22 Jul", group.Headline);
    }

    [Fact]
    public void ARowWithoutAReadableDateSortsLastInItsGroup()
    {
        QuarantineView view = QuarantineView.Parse(Status(
            Item("not-a-date", "capture_conflict", 0, false),
            Item("2026-07-22", "capture_conflict", 0, false)));

        QuarantineGroupView group = Assert.Single(view.Groups);
        Assert.Equal("Wed 22 Jul", group.Items[0].DateLabel);
        Assert.Equal("not-a-date", group.Items[1].DateLabel);
    }

    [Fact]
    public void NothingInTheFolderHasNoGroups()
    {
        Assert.Empty(QuarantineView.Parse(null).Groups);
        Assert.False(QuarantineView.Parse(null).IsGrouped);
    }
}
