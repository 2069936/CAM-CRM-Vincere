using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Text.RegularExpressions;

namespace Vincere.AutoExport.NinjaTrader.Core.Capture
{
    public sealed class StrategyParameterCapture
    {
        public StrategyParameterCapture(IDictionary<string, object> values, string status)
        {
            Values = values;
            Status = status;
        }

        public IDictionary<string, object> Values { get; private set; }
        public string Status { get; private set; }
    }

    public static class StrategyParameterReader
    {
        private const int MaximumTextLength = 512;

        public static StrategyParameterCapture Read(IEnumerable<StrategyParameterSource> parameters)
        {
            var values = new Dictionary<string, object>(StringComparer.Ordinal);
            bool partial = false;
            foreach (StrategyParameterSource parameter in parameters ?? Enumerable.Empty<StrategyParameterSource>())
            {
                if (parameter == null || !parameter.IsBrowsable || String.IsNullOrWhiteSpace(parameter.Name))
                    continue;

                if (IsSecretLike(parameter.Name))
                {
                    values[parameter.Name] = null;
                    partial = true;
                    continue;
                }

                try
                {
                    values[parameter.Name] = SafeScalar(parameter.Value);
                }
                catch
                {
                    values[parameter.Name] = null;
                    partial = true;
                }
            }

            return new StrategyParameterCapture(values, partial ? "partial" : "captured");
        }

        private static object SafeScalar(object value)
        {
            if (value == null)
                return null;

            Type type = value.GetType();
            if (type.IsEnum)
                return value.ToString();
            if (value is string || value is bool || value is byte || value is sbyte
                || value is short || value is ushort || value is int || value is uint
                || value is long || value is ulong || value is float || value is double
                || value is decimal)
                return value;
            if (value is DateTimeOffset offset)
                return offset.ToString("O", CultureInfo.InvariantCulture);
            if (value is DateTime dateTime)
                return dateTime.ToString("O", CultureInfo.InvariantCulture);
            if (value is TimeSpan timeSpan)
                return timeSpan.ToString("c", CultureInfo.InvariantCulture);
            if (value is Guid guid)
                return guid.ToString("D");

            string text = Convert.ToString(value, CultureInfo.InvariantCulture);
            if (String.IsNullOrEmpty(text))
                return null;
            return text.Length <= MaximumTextLength
                ? text
                : text.Substring(0, MaximumTextLength);
        }

        private static bool IsSecretLike(string name)
        {
            string separated = Regex.Replace(name ?? String.Empty, "([a-z0-9])([A-Z])", "$1 $2");
            string[] tokens = Regex.Split(separated.ToLowerInvariant(), "[^a-z0-9]+");
            return tokens.Any(token => token == "password" || token == "secret"
                || token == "token" || token == "key" || token == "license");
        }
    }
}
