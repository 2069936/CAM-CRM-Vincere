using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;

namespace Vincere.AutoExport.Agent.Diagnostics;

public static partial class SensitiveDataRedactor
{
    public static string Redact(string message, IEnumerable<string> knownSecrets = null)
    {
        string redacted = message ?? string.Empty;
        if (knownSecrets != null)
        {
            foreach (string secret in knownSecrets)
            {
                if (!string.IsNullOrEmpty(secret))
                    redacted = redacted.Replace(secret, "[REDACTED]", StringComparison.Ordinal);
            }
        }
        return BearerCredential().Replace(redacted, "Bearer [REDACTED]");
    }

    [GeneratedRegex(@"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+", RegexOptions.CultureInvariant)]
    private static partial Regex BearerCredential();
}
