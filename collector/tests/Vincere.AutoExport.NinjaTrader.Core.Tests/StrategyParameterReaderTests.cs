using System;
using System.Collections.Generic;
using Vincere.AutoExport.NinjaTrader.Core.Capture;
using Xunit;

namespace Vincere.AutoExport.NinjaTrader.Core.Tests;

public sealed class StrategyParameterReaderTests
{
    [Fact]
    public void Read_preserves_supported_scalars_and_redacts_secret_like_names()
    {
        var values = StrategyParameterReader.Read(new[]
        {
            new StrategyParameterSource("Enabled", true),
            new StrategyParameterSource("Contracts", 3),
            new StrategyParameterSource("Risk", 125.50m),
            new StrategyParameterSource("StartAt", new DateTimeOffset(2026, 7, 23, 9, 30, 0, TimeSpan.FromHours(-4))),
            new StrategyParameterSource("Delay", TimeSpan.FromSeconds(5)),
            new StrategyParameterSource("ApiToken", "must-not-leak"),
            new StrategyParameterSource("license_key", "must-not-leak-either"),
        });

        Assert.Equal(true, values.Values["Enabled"]);
        Assert.Equal(3, values.Values["Contracts"]);
        Assert.Equal(125.50m, values.Values["Risk"]);
        Assert.Equal("2026-07-23T09:30:00.0000000-04:00", values.Values["StartAt"]);
        Assert.Equal("00:00:05", values.Values["Delay"]);
        Assert.Null(values.Values["ApiToken"]);
        Assert.Null(values.Values["license_key"]);
        Assert.Equal("partial", values.Status);
    }

    [Fact]
    public void Read_converts_unsupported_values_to_bounded_safe_text()
    {
        var values = StrategyParameterReader.Read(new[]
        {
            new StrategyParameterSource("Custom", new LongDisplayValue()),
            new StrategyParameterSource("Empty", new EmptyDisplayValue()),
        });

        string custom = Assert.IsType<string>(values.Values["Custom"]);
        Assert.Equal(512, custom.Length);
        Assert.Null(values.Values["Empty"]);
        Assert.Equal("captured", values.Status);
    }

    private sealed class LongDisplayValue
    {
        public override string ToString() => new('x', 700);
    }

    private sealed class EmptyDisplayValue
    {
        public override string ToString() => string.Empty;
    }
}
