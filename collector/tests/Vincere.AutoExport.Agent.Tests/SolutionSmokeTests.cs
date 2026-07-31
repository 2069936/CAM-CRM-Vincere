using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Versioning;
using System.Xml.Linq;
using Vincere.AutoExport.Contracts;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class SolutionSmokeTests
{
    [Fact]
    public void ContractAssemblyKeepsVersionAndNetStandardBoundary()
    {
        Assembly assembly = typeof(AutoExportSnapshotV1).Assembly;
        Assert.Equal(new Version(1, 0, 0, 0), assembly.GetName().Version);
        TargetFrameworkAttribute framework = Assert.Single(
            assembly.GetCustomAttributes<TargetFrameworkAttribute>());
        Assert.Equal(".NETStandard,Version=v2.0", framework.FrameworkName);
    }

    [Theory]
    [InlineData("Vincere.AutoExport.Agent", "net8.0-windows")]
    [InlineData("Vincere.AutoExport.Agent.UI", "net8.0-windows")]
    [InlineData("Vincere.AutoExport.NinjaTrader", "net48")]
    public void RuntimeProjectsKeepTheirRequiredTargetFramework(string projectName, string targetFramework)
    {
        string collectorRoot = FindCollectorRoot();
        string projectPath = Path.Combine(
            collectorRoot, "src", projectName, projectName + ".csproj");
        XDocument project = XDocument.Load(projectPath);
        string actual = project.Descendants("TargetFramework").SingleOrDefault()?.Value;
        Assert.Equal(targetFramework, actual);
    }

    private static string FindCollectorRoot()
    {
        DirectoryInfo directory = new(AppContext.BaseDirectory);
        while (directory != null)
        {
            string candidate = Path.Combine(directory.FullName, "Directory.Build.props");
            if (File.Exists(candidate)) return directory.FullName;
            directory = directory.Parent;
        }
        throw new DirectoryNotFoundException("Could not locate the collector root.");
    }
}
