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
        public void DisconnectedAccountsAreDropped()
        {
            // The leftovers from connections that no longer exist.
            Assert.False(AccountRelevance.IsRelevant("APEX4683210000002", false, 0m, 0m));
            Assert.False(AccountRelevance.IsRelevant("DEMO5289161", false, null, null));
        }

        [Fact]
        public void ADisconnectedAccountStillShowingMoneyIsAlsoDropped()
        {
            // This is the shape of an old prop-firm account left configured
            // after the client moved on: disconnected for months, holding a
            // frozen balance. Keeping it because the balance is non-zero sent a
            // number nobody measured today, and once in the CRM it is
            // indistinguishable from a live account.
            Assert.False(AccountRelevance.IsRelevant("1665298", false, 38791.26m, 0m));
            Assert.False(AccountRelevance.IsRelevant("1665298", false, 0m, 38791.26m));
        }

        [Fact]
        public void AConnectedAccountSurvivesWhateverItHolds()
        {
            // The trade this makes: a real account offline at capture time is
            // absent for that day and raises a missing-account flag the CAM can
            // see. Absent and flagged beats present and silently stale.
            Assert.True(AccountRelevance.IsRelevant("1665298", true, 0m, 0m));
            Assert.True(AccountRelevance.IsRelevant("1665298", true, null, null));
        }

        [Fact]
        public void AnUnnamedAccountIsNotTreatedAsAPlatformFixture()
        {
            Assert.False(AccountRelevance.IsPlatformAccount(null));
            Assert.False(AccountRelevance.IsPlatformAccount("   "));
        }
    }
}
