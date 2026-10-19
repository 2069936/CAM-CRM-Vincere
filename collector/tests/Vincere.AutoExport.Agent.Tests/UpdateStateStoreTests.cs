using System;
using System.IO;
using Vincere.AutoExport.Agent.Updates;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* state.json survives the restart an update causes; last-result.json is what
 * update-agent.ps1 leaves behind, read as untrusted text. */
public sealed class UpdateStateStoreTests : IDisposable
{
    private readonly UpdateTempDirectory temp = new();
    private readonly UpdateLayout layout;
    private readonly UpdateStateStore store;

    public UpdateStateStoreTests()
    {
        layout = new UpdateLayout(Path.Combine(temp.Path, "updates"));
        store = new UpdateStateStore(layout);
    }

    public void Dispose() => temp.Dispose();

    [Fact]
    public void State_survives_a_restart()
    {
        AgentUpdateState state = AgentUpdateState.Empty with
        {
            BudgetVersion = "1.3.1",
            BudgetRequestedAt = "2026-10-19T14:00:00.000Z",
            Attempts = 2,
            State = "applying",
            TargetVersion = "1.3.1",
            StagedSha256 = new string('a', 64),
            StagedSize = 1234,
            MinimumAddonVersion = "1.3.0",
            ApplyStartedAt = new DateTimeOffset(2026, 10, 19, 18, 0, 0, TimeSpan.Zero),
        };

        store.Save(state);

        Assert.Equal(state, new UpdateStateStore(layout).Load());
        Assert.False(File.Exists(layout.StateFile + ".tmp"));
    }

    [Fact]
    public void The_requested_at_text_comes_back_exactly_as_the_crm_sent_it()
    {
        store.Save(AgentUpdateState.Empty with { BudgetRequestedAt = "2026-10-19T14:00:00.000Z" });

        Assert.Equal("2026-10-19T14:00:00.000Z", store.Load().BudgetRequestedAt);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[]")]
    public void A_damaged_state_file_is_an_empty_state(string text)
    {
        Directory.CreateDirectory(layout.Root);
        File.WriteAllText(layout.StateFile, text);

        Assert.Equal(AgentUpdateState.Empty, store.Load());
    }

    [Fact]
    public void A_state_edited_into_something_the_poll_cannot_send_is_cleaned()
    {
        Directory.CreateDirectory(layout.Root);
        File.WriteAllText(layout.StateFile, """
            {"state":"exploded","errorCode":"Has Spaces","targetVersion":"latest","attempts":-4}
            """);

        AgentUpdateState loaded = store.Load();

        Assert.Null(loaded.State);
        Assert.Null(loaded.ErrorCode);
        Assert.Null(loaded.TargetVersion);
        Assert.Equal(0, loaded.Attempts);
    }

    [Fact]
    public void A_rolled_back_result_carries_its_code()
    {
        WriteResult("""{"version":"1.3.1","outcome":"rolled_back","errorCode":"service_not_running","at":"2026-10-19T18:03:00.0000000Z"}""");

        AgentUpdateLastResult result = store.ReadLastResult();

        Assert.Equal("1.3.1", result.Version);
        Assert.Equal(AgentUpdateLastResult.RolledBack, result.Outcome);
        Assert.Equal("service_not_running", result.ErrorCode);
        Assert.Equal(new DateTimeOffset(2026, 10, 19, 18, 3, 0, TimeSpan.Zero), result.At);
    }

    [Theory]
    [InlineData("null")]
    [InlineData("\"Something Broke: C:\\\\Users\\\\x\"")]
    [InlineData("\"\"")]
    public void A_rolled_back_code_that_is_not_a_code_becomes_install_failed(string code)
    {
        WriteResult("{\"version\":\"1.3.1\",\"outcome\":\"rolled_back\",\"errorCode\":" + code + ",\"at\":\"2026-10-19T18:03:00Z\"}");

        Assert.Equal(UpdateErrorCodes.InstallFailed, store.ReadLastResult().ErrorCode);
    }

    [Fact]
    public void An_installed_result_carries_no_code()
    {
        WriteResult("""{"version":"1.3.1","outcome":"installed","errorCode":"anything","at":"2026-10-19T18:03:00Z"}""");

        AgentUpdateLastResult result = store.ReadLastResult();

        Assert.Equal(AgentUpdateLastResult.Installed, result.Outcome);
        Assert.Null(result.ErrorCode);
    }

    [Theory]
    [InlineData("""{"version":"latest","outcome":"installed","at":"2026-10-19T18:03:00Z"}""")]
    [InlineData("""{"version":"1.3.1","outcome":"maybe","at":"2026-10-19T18:03:00Z"}""")]
    [InlineData("""{"version":"1.3.1","outcome":"installed","at":"soon"}""")]
    [InlineData("""{"version":"1.3.1","outcome":"installed"}""")]
    [InlineData("not json")]
    public void A_result_that_does_not_fit_is_no_result(string text)
    {
        WriteResult(text);

        Assert.Null(store.ReadLastResult());
    }

    [Fact]
    public void A_result_file_written_with_a_byte_order_mark_is_still_read()
    {
        Directory.CreateDirectory(layout.Root);
        File.WriteAllText(
            layout.LastResultFile,
            """{"version":"1.3.1","outcome":"installed","errorCode":null,"at":"2026-10-19T18:03:00Z"}""",
            new System.Text.UTF8Encoding(true));

        Assert.NotNull(store.ReadLastResult());
    }

    [Fact]
    public void No_result_file_is_no_result()
    {
        Assert.Null(store.ReadLastResult());
    }

    private void WriteResult(string text)
    {
        Directory.CreateDirectory(layout.Root);
        File.WriteAllText(layout.LastResultFile, text);
    }
}
