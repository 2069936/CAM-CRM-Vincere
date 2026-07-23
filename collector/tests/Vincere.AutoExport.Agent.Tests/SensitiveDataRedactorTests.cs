using Vincere.AutoExport.Agent.Diagnostics;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

public sealed class SensitiveDataRedactorTests
{
    [Fact]
    public void RemovesKnownSecretsAndBearerCredentialsFromDiagnosticText()
    {
        const string enrollmentCode = "ABCD-EFGH-JK";
        const string deviceToken = "c2VjcmV0LWRldmljZS10b2tlbg";
        const string machineId = "4a4f4ed0-2fb1-4d0f-aeaa-d4a44a730c1e";
        string input = $"pair={enrollmentCode} Authorization: Bearer {deviceToken}; machine={machineId}";

        string redacted = SensitiveDataRedactor.Redact(
            input,
            new[] { enrollmentCode, deviceToken, machineId });

        Assert.DoesNotContain(enrollmentCode, redacted);
        Assert.DoesNotContain(deviceToken, redacted);
        Assert.DoesNotContain(machineId, redacted);
        Assert.Contains("[REDACTED]", redacted);
    }

    [Fact]
    public void NullAndHarmlessMessagesRemainSafe()
    {
        Assert.Equal(string.Empty, SensitiveDataRedactor.Redact(null));
        Assert.Equal("capture queued", SensitiveDataRedactor.Redact("capture queued"));
    }
}
