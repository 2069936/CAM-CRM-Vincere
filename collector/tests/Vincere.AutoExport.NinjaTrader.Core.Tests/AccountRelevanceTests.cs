using Vincere.AutoExport.NinjaTrader.Core.Capture;
using Xunit;

namespace Vincere.AutoExport.NinjaTrader.Core.Tests
{
    public class AccountRelevanceTests
    {
        [Theory]
        [InlineData("Backtest")]
        [InlineData("Playback101")]
        [InlineData("playback202")]
        public void PlatformFixturesAreNeverClientAccounts(string accountName)
        {
            // Backtest reports a six-figure balance on every install, so a
            // balance check alone would keep letting it through.
            Assert.False(AccountRelevance.IsRelevant(accountName, false, 100000m, 0m));
            Assert.False(AccountRelevance.IsRelevant(accountName, true, 100000m, 100000m));
        }

        [Fact]
        public void ConnectedAccountsAreAlwaysKept()
        {
            Assert.True(AccountRelevance.IsRelevant("1745458", true, 28782.86m, 28782.86m));
            // Connected and empty is still a real account that simply has no money.
            Assert.True(AccountRelevance.IsRelevant("1745458", true, 0m, 0m));
            Assert.True(AccountRelevance.IsRelevant("1745458", true, null, null));
        }

        [Fact]
        public void DisconnectedAndEmptyAccountsAreDropped()
        {
            // The leftovers from connections that no longer exist.
            Assert.False(AccountRelevance.IsRelevant("APEX4683210000002", false, 0m, 0m));
            Assert.False(AccountRelevance.IsRelevant("DEMO5289161", false, null, null));
        }

        [Fact]
        public void DisconnectedAccountsHoldingMoneySurvive()
        {
            // A real account that is merely offline right now must not vanish
            // from a close.
            Assert.True(AccountRelevance.IsRelevant("1665298", false, 38791.26m, 0m));
            Assert.True(AccountRelevance.IsRelevant("1665298", false, 0m, 38791.26m));
        }

        [Fact]
        public void AnUnnamedAccountIsNotTreatedAsAPlatformFixture()
        {
            Assert.False(AccountRelevance.IsPlatformAccount(null));
            Assert.False(AccountRelevance.IsPlatformAccount("   "));
        }
    }
}
