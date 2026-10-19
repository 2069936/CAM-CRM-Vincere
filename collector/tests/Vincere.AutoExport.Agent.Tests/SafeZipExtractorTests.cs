using System;
using System.IO;
using Vincere.AutoExport.Agent.Updates;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/* A SYSTEM PROCESS EXTRACTS THIS ZIP, SO NO ENTRY MAY LAND OUTSIDE ITS FOLDER.
 *
 * Each hostile name is tried with both separators: Windows PowerShell's
 * Compress-Archive writes backslashes, and on Windows a backslash is a separator
 * whatever the zip format says. */
public sealed class SafeZipExtractorTests : IDisposable
{
    private readonly UpdateTempDirectory temp = new();

    public void Dispose() => temp.Dispose();

    [Fact]
    public void A_normal_package_is_extracted_with_its_folders()
    {
        string zip = WriteZip(UpdateFixtures.Package());
        string destination = Path.Combine(temp.Path, "package");

        SafeZipExtractor.Extract(zip, destination, 1024 * 1024, 100);

        Assert.True(File.Exists(Path.Combine(destination, "Agent", "Vincere.AutoExport.Agent.exe")));
        Assert.True(File.Exists(Path.Combine(destination, "update-agent.ps1")));
        Assert.Equal("agent", File.ReadAllText(Path.Combine(destination, "Agent", "Vincere.AutoExport.Agent.exe")));
    }

    [Fact]
    public void Backslash_separated_entries_become_folders()
    {
        string zip = WriteZip(UpdateFixtures.Zip(("Agent\\Vincere.AutoExport.Agent.exe", "agent")));
        string destination = Path.Combine(temp.Path, "package");

        SafeZipExtractor.Extract(zip, destination, 1024 * 1024, 100);

        Assert.True(File.Exists(Path.Combine(destination, "Agent", "Vincere.AutoExport.Agent.exe")));
    }

    [Theory]
    [InlineData("../evil.txt")]
    [InlineData("..\\evil.txt")]
    [InlineData("Agent/../../evil.txt")]
    [InlineData("Agent\\..\\..\\evil.txt")]
    [InlineData("/etc/evil.txt")]
    [InlineData("\\Windows\\evil.txt")]
    [InlineData("\\\\server\\share\\evil.txt")]
    [InlineData("C:/Windows/evil.txt")]
    [InlineData("C:\\Windows\\evil.txt")]
    [InlineData("Agent/file.txt:stream")]
    [InlineData("Agent/./file.txt")]
    [InlineData("Agent//file.txt")]
    [InlineData("Agent./file.txt")]
    [InlineData("Agent /file.txt")]
    [InlineData("Agent/fi|le.txt")]
    [InlineData("..")]
    public void An_entry_that_is_not_a_plain_relative_path_is_refused(string name)
    {
        string zip = WriteZip(UpdateFixtures.Zip(("Agent/ok.txt", "ok"), (name, "evil")));
        string destination = Path.Combine(temp.Path, "package");

        Assert.Throws<UnsafeArchiveException>(() => SafeZipExtractor.Extract(zip, destination, 1024 * 1024, 100));

        Assert.False(File.Exists(Path.Combine(temp.Path, "evil.txt")));
    }

    [Fact]
    public void An_archive_that_expands_past_the_limit_is_refused()
    {
        string zip = WriteZip(UpdateFixtures.Zip(("big.txt", new string('x', 4096))));

        Assert.Throws<UnsafeArchiveException>(() =>
            SafeZipExtractor.Extract(zip, Path.Combine(temp.Path, "package"), 1024, 100));
    }

    [Fact]
    public void Too_many_entries_are_refused()
    {
        string zip = WriteZip(UpdateFixtures.Zip(("a.txt", "a"), ("b.txt", "b"), ("c.txt", "c")));

        Assert.Throws<UnsafeArchiveException>(() =>
            SafeZipExtractor.Extract(zip, Path.Combine(temp.Path, "package"), 1024, 2));
    }

    [Fact]
    public void The_same_file_named_twice_is_refused()
    {
        string zip = WriteZip(UpdateFixtures.Zip(("Agent/a.txt", "first"), ("Agent\\a.txt", "second")));

        Assert.Throws<UnsafeArchiveException>(() =>
            SafeZipExtractor.Extract(zip, Path.Combine(temp.Path, "package"), 1024, 100));
    }

    [Fact]
    public void A_file_that_is_not_a_zip_is_refused()
    {
        string zip = WriteZip(new byte[] { 1, 2, 3, 4 });

        Assert.Throws<UnsafeArchiveException>(() =>
            SafeZipExtractor.Extract(zip, Path.Combine(temp.Path, "package"), 1024, 100));
        Assert.Throws<UnsafeArchiveException>(() => SafeZipExtractor.DeclaredSize(zip));
    }

    private string WriteZip(byte[] bytes)
    {
        string path = Path.Combine(temp.Path, Guid.NewGuid().ToString("n") + ".zip");
        File.WriteAllBytes(path, bytes);
        return path;
    }
}
