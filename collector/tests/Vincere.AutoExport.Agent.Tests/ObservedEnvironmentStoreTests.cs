using System;
using System.IO;
using System.Linq;
using Newtonsoft.Json.Linq;
using Vincere.AutoExport.Agent.Configuration;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* The NinjaTrader version the add-on last reported, kept across a service
 * restart so the first heartbeat afterwards says what the machine runs instead
 * of null until that day's capture. What matters: it reads back what was
 * written, a file that is missing or broken is the same as none, nothing that
 * is not a version ever comes out of it, and a write that fails costs nothing. */
public sealed class ObservedEnvironmentStoreTests : IDisposable
{
    private readonly string folder = Path.Combine(Path.GetTempPath(), "vincere-environment-" + Guid.NewGuid().ToString("n"));

    private string FilePath => Path.Combine(folder, "environment.json");

    private ObservedEnvironmentStore Store() => new(FilePath);

    public void Dispose()
    {
        try { if (Directory.Exists(folder)) Directory.Delete(folder, true); } catch (Exception) { }
    }

    [Fact]
    public void ReadsBackWhatTheCaptureReported()
    {
        ObservedEnvironmentStore store = Store();

        store.Save(new ObservedEnvironment("8.1.6.0", "1.2.1"));

        Assert.Equal(new ObservedEnvironment("8.1.6.0", "1.2.1"), store.Load());
        // A second instance, the way a restarted service reads it.
        Assert.Equal(new ObservedEnvironment("8.1.6.0", "1.2.1"), Store().Load());
    }

    [Fact]
    public void AnswersNothingBeforeAnyCaptureHasReported()
    {
        Assert.Null(Store().Load());
        Assert.False(Directory.Exists(folder));
    }

    [Fact]
    public void TheFileIsPlainJsonUnderTheWireNamesWithNoTemporaryLeftBehind()
    {
        ObservedEnvironmentStore store = Store();

        store.Save(new ObservedEnvironment("8.1.6.0", "1.2.1"));

        JObject document = JObject.Parse(File.ReadAllText(FilePath));
        Assert.Equal("8.1.6.0", document.Value<string>("ninjaTraderVersion"));
        Assert.Equal("1.2.1", document.Value<string>("addonVersion"));
        Assert.NotNull(document["observedAt"]);
        Assert.False(File.Exists(FilePath + ".tmp"));
        Assert.Equal(new[] { "environment.json" }, Directory.GetFiles(folder).Select(Path.GetFileName));
    }

    [Theory]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("not json")]
    [InlineData("{")]
    [InlineData("[]")]
    [InlineData("{\"ninjaTraderVersion\": 8}")]
    [InlineData("{\"something\":\"else\"}")]
    public void ACorruptFileIsTheSameAsNone(string text)
    {
        Directory.CreateDirectory(folder);
        File.WriteAllText(FilePath, text);

        Assert.Null(Store().Load());
    }

    [Theory]
    [InlineData("not-a-version")]
    [InlineData("8.1.6.0-beta")]
    [InlineData("8")]
    [InlineData("<script>")]
    [InlineData("8.1.6.0.1")]
    public void AValueThatIsNotAVersionNeverComesOut(string bad)
    {
        /* CrmClient refuses a heartbeat whose NinjaTrader version does not look
         * like one, so a hand edited or damaged file must not become a refused
         * heartbeat on every machine that restarts. */
        Directory.CreateDirectory(folder);
        File.WriteAllText(FilePath, "{\"ninjaTraderVersion\":\"" + bad + "\",\"addonVersion\":\"1.2.1\"}");

        Assert.Equal(new ObservedEnvironment(null, "1.2.1"), Store().Load());

        Store().Save(new ObservedEnvironment(bad, "1.2.1"));
        Assert.Equal(new ObservedEnvironment(null, "1.2.1"), Store().Load());
    }

    [Fact]
    public void NothingIsWrittenWhenThereIsNothingWorthKeeping()
    {
        ObservedEnvironmentStore store = Store();

        store.Save(null);
        store.Save(new ObservedEnvironment(null, null));
        store.Save(new ObservedEnvironment("  ", "nope"));

        Assert.False(File.Exists(FilePath));
    }

    [Fact]
    public void ALaterCaptureOverwritesAndTrims()
    {
        ObservedEnvironmentStore store = Store();
        store.Save(new ObservedEnvironment("8.1.5.2", "1.2.0"));

        store.Save(new ObservedEnvironment("  8.1.6.0 ", "1.2.1"));

        Assert.Equal(new ObservedEnvironment("8.1.6.0", "1.2.1"), store.Load());
    }

    [Fact]
    public void AWriteThatCannotHappenIsSwallowed()
    {
        // The parent "directory" is a file, so neither the directory nor the
        // temp file can be created. The store answers nothing and throws nothing.
        Directory.CreateDirectory(folder);
        string blocker = Path.Combine(folder, "blocker");
        File.WriteAllText(blocker, "x");
        ObservedEnvironmentStore store = new(Path.Combine(blocker, "environment.json"));

        store.Save(new ObservedEnvironment("8.1.6.0", "1.2.1"));

        Assert.Null(store.Load());
    }

    [Fact]
    public void RefusesABlankPath()
    {
        Assert.Throws<ArgumentException>(() => new ObservedEnvironmentStore(" "));
    }
}
