using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Linq;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript;
using Vincere.AutoExport.NinjaTrader.Core.Capture;

namespace Vincere.AutoExport.NinjaTrader.Capture
{
    /// <summary>
    /// Reads documented NinjaTrader account collections. Callers must invoke this
    /// facade on NinjaTrader's application dispatcher; returned DTOs no longer hold
    /// live collection enumerators.
    /// </summary>
    public sealed class NinjaTraderFacade : INinjaTraderFacade, IAccountSampleFacade, IStrategySampleFacade
    {
        /// <summary>
        /// How long the per strategy reading may spend reading P&amp;L, across all
        /// accounts together. The add-on gives the whole command five seconds; this
        /// keeps the P&amp;L part to two of them.
        /// </summary>
        public static readonly TimeSpan DefaultStrategyPnlBudget = TimeSpan.FromSeconds(2);

        private readonly TimeSpan strategyPnlBudget;

        public NinjaTraderFacade()
            : this(DefaultStrategyPnlBudget)
        {
        }

        /// <param name="strategyPnlBudget">
        /// The P&amp;L read budget for <see cref="ReadStrategiesForSample"/>. Only a
        /// test passes anything else.
        /// </param>
        public NinjaTraderFacade(TimeSpan strategyPnlBudget)
        {
            this.strategyPnlBudget = strategyPnlBudget;
        }

        public IEnumerable<AccountCaptureSource> ReadAccounts()
        {
            return SnapshotAccounts().Select(MapAccount).ToList();
        }

        /* THE TRACKER READING. Everything about this method is about what it does
         * NOT touch, because it runs every ten minutes on a machine trading live
         * prop-firm accounts, on NinjaTrader's own UI thread.
         *
         * IT DOES NOT GO THROUGH SnapshotAccounts(). That property is memoised
         * for the close and, more importantly, it filters on `isConnected`, so a
         * disconnected account never reaches a caller. A tracker that inherited
         * that filter would turn "this account went dark" into an absent row,
         * which is indistinguishable from an unreachable machine - see
         * AccountSampleRelevance. So the account list is built here, from
         * Account.All, under the one lock this read takes.
         *
         * IT DOES NOT LOCK account.Orders OR account.Executions. Those are the
         * two collections the trading path writes to on every fill, and not
         * touching them is the whole point of having a second command.
         *
         * IT DOES NOT CALL MapAccount. That reads ~31 account values by
         * enumerating the whole AccountItem enum, to fill a dictionary this sample
         * does not carry. Two Get calls answer the traffic light, so two is what it
         * makes - counted by a test rather than asserted here.
         *
         * IT DOES NOT CALL MapStrategy, AND TOUCHES NO PER-ROW REFLECTION.
         * MapStrategy runs ReadParameters and ReadExtraValues per strategy, which is
         * a custom type descriptor answering platform code property by property -
         * exactly the work the summary below warns can stop a capture "being
         * something that merely fails" and start it "being something that can stall
         * the terminal it is reading". This reads one string per strategy.
         *
         * It does still go through PublicString ONCE PER ACCOUNT, for
         * ConnectionStatus, and that does reach TypeDescriptor. Deliberate: the
         * close reads that same field the same way, because it is not reliably a
         * plain string across the NinjaTrader versions on this fleet, and matching
         * the close is worth more than saving one lookup against a handful of
         * accounts. The cost that mattered was per ORDER and per FILL, not per
         * account.
         *
         * The one lock it does take beyond Account.All is account.Strategies, for
         * the copy and nothing after it, the same discipline ReadStrategies and
         * ReadOwnership keep. That collection changes when the desk enables or
         * disables an algorithm, not on every trade. */
        public IEnumerable<AccountSampleCaptureSource> ReadAccountsForSample()
        {
            List<Account> all;
            lock (Account.All)
                all = Account.All.ToList();

            var rows = new List<AccountSampleCaptureSource>(all.Count);
            foreach (Account account in all)
            {
                if (!AccountSampleRelevance.IsRelevant(account.Name))
                    continue;

                Currency denomination = account.Denomination;
                decimal? realized = AccountValue(account, AccountItem.RealizedProfitLoss, denomination);
                decimal? unrealized = AccountValue(account, AccountItem.UnrealizedProfitLoss, denomination);
                string status = PublicString(account, "ConnectionStatus");
                rows.Add(new AccountSampleCaptureSource
                {
                    AccountName = account.Name,
                    ConnectionName = ConnectionName(account),
                    Connected = String.Equals(status, "Connected", StringComparison.OrdinalIgnoreCase),
                    Status = status,
                    RealizedPnl = realized,
                    UnrealizedPnl = unrealized,
                    // The same rule MapAccount uses: a total only exists when both
                    // halves do. Adding a null as a zero would publish a confident
                    // figure about a number half of which was never reported.
                    TotalPnl = realized.HasValue && unrealized.HasValue ? realized + unrealized : null,
                    StrategyStates = ReadStrategyStates(account),
                });
            }
            return rows;
        }

        /// <summary>
        /// Each strategy's State word, and nothing else about it.
        ///
        /// Null when the collection could not be read, which StrategyLiveCount
        /// keeps distinct from an account holding no strategies: the first means
        /// nobody looked, the second means nothing is on, and they lead to
        /// different actions.
        /// </summary>
        private static List<string> ReadStrategyStates(Account account)
        {
            List<StrategyBase> strategies;
            try
            {
                lock (account.Strategies)
                    strategies = account.Strategies.ToList();
            }
            catch
            {
                return null;
            }

            var states = new List<string>(strategies.Count);
            foreach (StrategyBase strategy in strategies)
            {
                /* AGAINST THE DECLARED MEMBER, NOT THROUGH PublicString.
                 *
                 * The reflection helpers exist for members some NinjaTrader
                 * version on the fleet may not expose, and State is not one of
                 * them: MapStrategy has always bound strategy.State directly, so
                 * every version this add-on loads on already answers it.
                 *
                 * And PublicString would defeat the purpose of this whole method.
                 * It calls PublicValue, which calls TypeDescriptor.GetProperties -
                 * a custom type descriptor running platform code to enumerate
                 * every property - and it would do that once per strategy. That is
                 * the per-row reflection the second command exists to avoid.
                 *
                 * Convert.ToString rather than .ToString() because it is null-safe:
                 * the member is a non-nullable enum on the real platform but a
                 * plain string on the test stubs, and an unset one there must read
                 * as unmeasured rather than throw. */
                states.Add(Convert.ToString(strategy.State, CultureInfo.InvariantCulture));
            }
            return states;
        }

        /* THE PER STRATEGY READING: each strategy instance with the Realized and
         * Unrealized the Strategies tab shows for it.
         *
         * THE SAME ACCOUNTS AS ReadAccountsForSample, from Account.All under its
         * lock, with AccountSampleRelevance dropping the platform's own fixtures.
         * The agent then keeps only the accounts it is reporting as connected.
         *
         * IDENTITY THE WAY THE CLOSE READS IT. The id goes through the same
         * PublicString(strategy, "StrategyId", "Id") MapStrategy and ReadOwnership
         * use, the name is strategy.Name like MapStrategy, the instrument is the
         * first instrument's FullName, so a live row and the close's row for the
         * same instance carry the same identity.
         *
         * ONE LOCK BEYOND Account.All, account.Strategies, for the copy and nothing
         * after it. account.Orders and account.Executions are never touched.
         *
         * P&L IS READ ONLY FOR LIVE INSTANCES AND ONLY INSIDE A BUDGET. The builder
         * drops the others, so their P&L would be read for nothing. Past the budget
         * the remaining rows keep their identity and carry null P&L, which the CRM
         * shows as "not measured": a reading that ran long loses numbers, never
         * rows, and never holds the dispatcher past the add-on's own limit. */
        public IEnumerable<StrategySampleCaptureSource> ReadStrategiesForSample()
        {
            List<Account> all;
            lock (Account.All)
                all = Account.All.ToList();

            Stopwatch elapsed = Stopwatch.StartNew();
            var rows = new List<StrategySampleCaptureSource>();
            foreach (Account account in all)
            {
                if (!AccountSampleRelevance.IsRelevant(account.Name))
                    continue;

                List<StrategyBase> strategies;
                try
                {
                    lock (account.Strategies)
                        strategies = account.Strategies.ToList();
                }
                catch
                {
                    continue;
                }

                foreach (StrategyBase strategy in strategies)
                {
                    StrategySampleCaptureSource row = ReadStrategyForSample(
                        account,
                        strategy,
                        elapsed.Elapsed < strategyPnlBudget);
                    if (row != null)
                        rows.Add(row);
                }
            }
            return rows;
        }

        private static StrategySampleCaptureSource ReadStrategyForSample(
            Account account,
            StrategyBase strategy,
            bool readPnl)
        {
            try
            {
                object instrument = strategy.Instruments == null
                    ? null
                    : strategy.Instruments.FirstOrDefault();
                string state = Convert.ToString(strategy.State, CultureInfo.InvariantCulture);
                bool measure = readPnl && StrategyLiveCount.IsLive(state);
                return new StrategySampleCaptureSource
                {
                    AccountName = account.Name,
                    StrategyId = PublicString(strategy, "StrategyId", "Id"),
                    StrategyName = strategy.Name,
                    Instrument = PublicString(instrument, "FullName"),
                    State = state,
                    RealizedPnl = measure ? StrategyPnlRead.Realized(strategy) : null,
                    UnrealizedPnl = measure ? StrategyPnlRead.Unrealized(strategy) : null,
                    RealtimeTradeCount = measure ? StrategyPnlRead.RealtimeTradeCount(strategy) : null,
                    MarketPosition = measure ? StrategyPnlRead.MarketPosition(strategy) : null,
                    PositionQuantity = measure ? StrategyPnlRead.PositionQuantity(strategy) : null,
                };
            }
            catch
            {
                // One instance that cannot even be named is left out; the rest of
                // the account still reads.
                return null;
            }
        }

        /* THE TWO NUMBERS THE STRATEGIES TAB SHOWS, READ THROUGH CANDIDATE MEMBERS.
         *
         * Realized: strategy.SystemPerformance.RealTimeTrades.TradesPerformance
         * .Currency.CumProfit, the strategy's own real time trades since it was
         * enabled. Unrealized: 0 when Position.MarketPosition is Flat, otherwise
         * Position.GetUnrealizedProfitLoss(PerformanceUnit.Currency, last price),
         * with the last price from the position's instrument market data.
         *
         * BY REFLECTION, NOT AGAINST THE DECLARED TYPES, and on purpose. This file
         * compiles against NinjaTrader's licensed assemblies only on a VPS and on
         * the self-hosted runner, and against stubs everywhere else, and which of
         * these members each platform version on the fleet declares is not visible
         * from here. A member that is missing, throws, or answers something that is
         * not a number makes that half null, which reads "not measured" on the
         * screen. Shipping with nulls is the documented fallback if the release
         * check on a VPS shows these members do not reproduce the grid: nothing
         * else breaks.
         *
         * Each half has its own try, so a realized figure survives an unreadable
         * position and the reverse. ReflectedValue is used rather than PublicValue
         * because it does not walk the type descriptor, which on a NinjaScript
         * object is platform code answering property by property.
         *
         * THE POSITION ITSELF, SINCE 1.2.1: Position.MarketPosition as a word and
         * Position.Quantity as a count, read the same way and under the same rule,
         * each in its own try. The CAMs ask each other in the team chat whether
         * BulletBot fired long or short today; the strategy catalogue cannot say,
         * so the reading has to. A word that is not long, short or flat, and a
         * quantity that is not a whole non-negative number, read null. */
        private static class StrategyPnlRead
        {
            /* The three words the wire accepts, lower case. NinjaTrader.Cbi
             * .MarketPosition is an enum (Flat, Long, Short) and Convert.ToString
             * on an enum gives its name, which is what the Unrealized read has
             * compared against "Flat" since 1.2.0. Anything else is null: an
             * answer the desk cannot act on must not be dressed as one. */
            public static string MarketPosition(StrategyBase strategy)
            {
                try
                {
                    object position = ReflectedValue(strategy, "Position");
                    if (position == null)
                        return null;
                    string word = Convert.ToString(
                        ReflectedValue(position, "MarketPosition"),
                        CultureInfo.InvariantCulture);
                    if (String.IsNullOrWhiteSpace(word))
                        return null;
                    word = word.Trim().ToLowerInvariant();
                    switch (word)
                    {
                        case "long":
                        case "short":
                        case "flat":
                            return word;
                        default:
                            return null;
                    }
                }
                catch
                {
                    return null;
                }
            }

            /* Position.Quantity is an int on the platform (contracts held, zero
             * when flat). The same rule as the run count: an int that is not
             * negative, or null. */
            public static int? PositionQuantity(StrategyBase strategy)
            {
                try
                {
                    object position = ReflectedValue(strategy, "Position");
                    if (position == null)
                        return null;
                    object value = ReflectedValue(position, "Quantity");
                    if (!(value is int quantity) || quantity < 0)
                        return null;
                    return quantity;
                }
                catch
                {
                    return null;
                }
            }

            public static decimal? Realized(StrategyBase strategy)
            {
                try
                {
                    object value = strategy;
                    foreach (string member in new[]
                    {
                        "SystemPerformance", "RealTimeTrades", "TradesPerformance", "Currency", "CumProfit",
                    })
                    {
                        value = ReflectedValue(value, member);
                        if (value == null)
                            return null;
                    }
                    return NullableDecimal(value);
                }
                catch
                {
                    return null;
                }
            }

            /* THE RUN MARKER: strategy.SystemPerformance.RealTimeTrades.Count, the
             * trades this run has completed. It only grows within a run and starts
             * again at zero on a re-enable, so a count lower than the previous
             * reading's is a restart the agent would otherwise miss: most measured
             * re-enables are a disable and enable inside one minute, which no ten
             * minute reading sees as an absence. Same member chain as the realized
             * candidate and the same rule: anything unreadable is null, and a null
             * makes the agent fall back to absence alone, never to a restart.
             * The release check on a VPS adds one line for it: disable and enable a
             * strategy that has traded, and the count read next is 0. If the
             * platform kept the old run's trades instead, the count would never go
             * down and nothing would be flagged that absence does not flag today. */
            public static int? RealtimeTradeCount(StrategyBase strategy)
            {
                try
                {
                    object value = strategy;
                    foreach (string member in new[] { "SystemPerformance", "RealTimeTrades", "Count" })
                    {
                        value = ReflectedValue(value, member);
                        if (value == null)
                            return null;
                    }
                    if (!(value is int count) || count < 0)
                        return null;
                    return count;
                }
                catch
                {
                    return null;
                }
            }

            public static decimal? Unrealized(StrategyBase strategy)
            {
                try
                {
                    object position = ReflectedValue(strategy, "Position");
                    if (position == null)
                        return null;
                    string marketPosition = Convert.ToString(
                        ReflectedValue(position, "MarketPosition"),
                        CultureInfo.InvariantCulture);
                    if (String.IsNullOrWhiteSpace(marketPosition))
                        return null;
                    if (String.Equals(marketPosition.Trim(), "Flat", StringComparison.OrdinalIgnoreCase))
                        return 0m;

                    object lastPrice = position;
                    foreach (string member in new[] { "Instrument", "MarketData", "Last", "Price" })
                    {
                        lastPrice = ReflectedValue(lastPrice, member);
                        if (lastPrice == null)
                            return null;
                    }
                    double price = Convert.ToDouble(lastPrice, CultureInfo.InvariantCulture);
                    if (Double.IsNaN(price) || Double.IsInfinity(price) || price <= 0)
                        return null;

                    foreach (System.Reflection.MethodInfo method in position.GetType().GetMethods())
                    {
                        if (!String.Equals(method.Name, "GetUnrealizedProfitLoss", StringComparison.Ordinal))
                            continue;
                        System.Reflection.ParameterInfo[] parameters = method.GetParameters();
                        if (parameters.Length != 2
                            || !parameters[0].ParameterType.IsEnum
                            || parameters[1].ParameterType != typeof(double))
                            continue;
                        object currency = Enum.Parse(parameters[0].ParameterType, "Currency");
                        return NullableDecimal(method.Invoke(position, new[] { currency, (object)price }));
                    }
                    return null;
                }
                catch
                {
                    return null;
                }
            }
        }

        public IEnumerable<StrategyCaptureSource> ReadStrategies()
        {
            var rows = new List<StrategyCaptureSource>();
            foreach (Account account in SnapshotAccounts())
            {
                List<StrategyBase> strategies;
                lock (account.Strategies)
                    strategies = account.Strategies.ToList();
                rows.AddRange(strategies.Select(strategy => MapStrategy(account, strategy)));
            }
            return rows;
        }

        public IEnumerable<OrderCaptureSource> ReadOrders()
        {
            var rows = new List<OrderCaptureSource>();
            foreach (Account account in SnapshotAccounts())
            {
                StrategyAttributionMap attribution = Attribution(account);
                List<Order> orders;
                lock (account.Orders)
                    orders = account.Orders.ToList();
                rows.AddRange(orders.Select(order => MapOrder(account, order, attribution)));
            }
            return rows;
        }

        public IEnumerable<ExecutionCaptureSource> ReadExecutions()
        {
            var rows = new List<ExecutionCaptureSource>();
            foreach (Account account in SnapshotAccounts())
            {
                StrategyAttributionMap attribution = Attribution(account);
                List<Execution> executions;
                lock (account.Executions)
                    executions = account.Executions.ToList();
                rows.AddRange(executions.Select(execution => MapExecution(account, execution, attribution)));
            }
            return rows;
        }

        // EVALUATED ONCE PER CAPTURE, NOT ONCE PER SECTION.
        //
        // This is the single gate for all four sections: an account filtered
        // here also stops contributing strategies, orders and executions, so a
        // close never carries trades belonging to an account it does not list.
        //
        // It used to be a static method the four readers each called, and the
        // filter reads LIVE state: ConnectionStatus, CashValue, NetLiquidation.
        // Four evaluations milliseconds apart against a connection that is
        // reconnecting do not have to agree. When they disagreed, the close
        // carried strategies, orders or executions belonging to an account the
        // accounts section had dropped, and the CRM rejected the WHOLE snapshot
        // with "strategies[i].accountName does not reference an account". The
        // file was unusable by hand as well as automatically, and it looked
        // random because it depended on where the flap landed.
        //
        // One facade is constructed per capture (VincereAutoExportAddOn.cs:133),
        // so memoising on the instance gives every section the same list and
        // costs nothing beyond the capture it belongs to.
        private List<Account> snapshotAccounts;

        private List<Account> SnapshotAccounts()
        {
            if (snapshotAccounts != null) return snapshotAccounts;
            snapshotAccounts = BuildSnapshotAccounts();
            return snapshotAccounts;
        }

        private static List<Account> BuildSnapshotAccounts()
        {
            List<Account> all;
            lock (Account.All)
                all = Account.All.ToList();

            var relevant = new List<Account>(all.Count);
            foreach (Account account in all)
            {
                Currency denomination = account.Denomination;
                bool connected = String.Equals(
                    PublicString(account, "ConnectionStatus"), "Connected", StringComparison.OrdinalIgnoreCase);
                if (AccountRelevance.IsRelevant(
                        account.Name,
                        connected,
                        AccountValue(account, AccountItem.CashValue, denomination),
                        AccountValue(account, AccountItem.NetLiquidation, denomination)))
                {
                    relevant.Add(account);
                }
            }
            return relevant;
        }

        // WHO PLACED THE ORDER, ASKED ONCE PER CAPTURE.
        //
        // An Order and an Execution do not name their strategy, but a strategy
        // names its orders and its fills, so the link is read in that direction
        // and inverted here. See StrategyAttributionMap for what the automatic
        // path was shipping without it.
        //
        // Memoised on the instance for the same reason snapshotAccounts is: the
        // orders section and the executions section must see ONE answer. Built
        // twice, a strategy that stops between the two sections would attribute
        // an order and then leave its own fill unattributed, and the CRM would
        // hold a close whose parts disagree about who traded.
        private Dictionary<Account, StrategyAttributionMap> attributionByAccount;

        private StrategyAttributionMap Attribution(Account account)
        {
            if (attributionByAccount == null)
            {
                attributionByAccount = new Dictionary<Account, StrategyAttributionMap>();
                foreach (Account relevant in SnapshotAccounts())
                    attributionByAccount[relevant] = StrategyAttributionMap.Build(ReadOwnership(relevant));
            }
            StrategyAttributionMap attribution;
            return attributionByAccount.TryGetValue(account, out attribution)
                ? attribution
                : StrategyAttributionMap.Empty;
        }

        /// <summary>
        /// What each of the account's strategies says it owns.
        ///
        /// The two collections are reached through the reflection helpers rather
        /// than against StrategyBase.Orders and StrategyBase.Executions directly:
        /// the AddOn is compiled once and loaded by whatever NinjaTrader the
        /// client runs, 8.1.6 through 8.1.8 across the fleet, and a member one of
        /// them does not expose has to degrade to no attribution rather than to a
        /// type the assembly cannot bind.
        ///
        /// Every collection is copied before it is read, because the platform can
        /// add an order to a strategy while we walk it.
        ///
        /// The lock covers exactly what it covers in ReadStrategies: the copy of
        /// account.Strategies, and nothing after it. That lock guards the account's
        /// list of strategies, not the collections hanging off each one, so holding
        /// it across these reads would protect nothing. It would only mean holding
        /// a platform lock, on NinjaTrader's own dispatcher thread, while a custom
        /// type descriptor runs platform code to answer us, which is how a capture
        /// stops being something that merely fails and starts being something that
        /// can stall the terminal it is reading. ReadStrategies keeps
        /// TypeDescriptor out of the lock for the same reason.
        /// </summary>
        private static List<StrategyOrderOwnership> ReadOwnership(Account account)
        {
            List<StrategyBase> strategies;
            lock (account.Strategies)
                strategies = account.Strategies.ToList();

            var owned = new List<StrategyOrderOwnership>(strategies.Count);
            foreach (StrategyBase strategy in strategies)
            {
                List<object> orders = PublicCollection(strategy, "Orders");
                List<object> executions = PublicCollection(strategy, "Executions");

                var orderIds = new List<string>(orders.Count + executions.Count);
                foreach (object order in orders)
                    orderIds.Add(PublicString(order, "OrderId"));
                // A fill carries the id of the order it filled, and a strategy
                // can still list a fill whose order has already left its Orders
                // collection, so that order id is claimed here too.
                foreach (object execution in executions)
                    orderIds.Add(PublicString(execution, "OrderId"));

                var executionIds = new List<string>(executions.Count);
                foreach (object execution in executions)
                    executionIds.Add(PublicString(execution, "ExecutionId"));

                // The same two members MapStrategy reports the strategy under,
                // so an order's strategyId and strategyName are the strings the
                // strategies section of this very snapshot carries.
                owned.Add(new StrategyOrderOwnership(
                    PublicString(strategy, "StrategyId", "Id"),
                    strategy.Name,
                    orderIds,
                    executionIds));
            }
            return owned;
        }

        /// <summary>
        /// A named collection property, copied out before anything reads it. Same
        /// contract as PublicValue, which it asks first: a member this NinjaTrader
        /// version does not have yields an empty list, and a collection that
        /// changes mid copy yields what was copied before it changed, rather than
        /// throwing and costing the capture its whole orders section.
        /// </summary>
        private static List<object> PublicCollection(object source, string name)
        {
            var items = new List<object>();
            object value = PublicValue(source, name) ?? ReflectedValue(source, name);
            if (!(value is System.Collections.IEnumerable collection))
                return items;
            try
            {
                foreach (object item in collection)
                    items.Add(item);
            }
            catch
            {
                // Mutated underneath the copy. Keep the part that was copied: it
                // attributes the rows it names and says nothing about the rest.
                return items;
            }
            return items;
        }

        private static AccountCaptureSource MapAccount(Account account)
        {
            Currency denomination = account.Denomination;
            IDictionary<string, decimal?> accountValues = AllAccountValues(account, denomination);
            decimal? realized = AccountValue(account, AccountItem.RealizedProfitLoss, denomination);
            decimal? grossRealized = AccountValue(account, AccountItem.GrossRealizedProfitLoss, denomination);
            decimal? unrealized = AccountValue(account, AccountItem.UnrealizedProfitLoss, denomination);
            return new AccountCaptureSource
            {
                AccountName = account.Name,
                ConnectionName = ConnectionName(account),
                DisplayName = PublicString(account, "DisplayName"),
                NetLiquidation = AccountValue(account, AccountItem.NetLiquidation, denomination),
                CashValue = AccountValue(account, AccountItem.CashValue, denomination),
                RealizedPnl = realized,
                GrossRealizedPnl = grossRealized,
                UnrealizedPnl = unrealized,
                TotalPnl = realized.HasValue && unrealized.HasValue ? realized + unrealized : null,
                // Read out of the enumerated account values rather than named
                // here. NinjaTrader's published AccountItem list does not mention
                // either, but a real install reports both — enumerating the enum
                // found WeeklyProfitLoss and TrailingMaxDrawdown alongside 29
                // others. Looking them up by name keeps this compiling against
                // versions whose enum lacks the members, and yields null there
                // instead of failing to build.
                WeeklyPnl = accountValues.TryGetValue("WeeklyProfitLoss", out decimal? weekly) ? weekly : null,
                TrailingMaxDrawdown = accountValues.TryGetValue("TrailingMaxDrawdown", out decimal? trailing) ? trailing : null,
                BuyingPower = AccountValue(account, AccountItem.BuyingPower, denomination),
                ExcessIntradayMargin = AccountValue(account, AccountItem.ExcessIntradayMargin, denomination),
                InitialMargin = AccountValue(account, AccountItem.InitialMargin, denomination),
                MaintenanceMargin = AccountValue(account, AccountItem.MaintenanceMargin, denomination),
                Currency = denomination.ToString(),
                Status = PublicString(account, "ConnectionStatus"),
                AccountValues = accountValues,
            };
        }

        /// <summary>
        /// Every AccountItem NinjaTrader will report, by enumerating the enum
        /// instead of naming values one at a time. The named properties above only
        /// cover a third of them, and a hand-picked list silently goes stale when
        /// NinjaTrader adds a value. Items a connection does not answer for are
        /// skipped rather than stored as null noise.
        /// </summary>
        private static IDictionary<string, decimal?> AllAccountValues(Account account, Currency denomination)
        {
            var values = new Dictionary<string, decimal?>(StringComparer.Ordinal);
            foreach (object item in Enum.GetValues(typeof(AccountItem)))
            {
                var accountItem = (AccountItem)item;
                decimal? value = AccountValue(account, accountItem, denomination);
                if (value.HasValue)
                    values[accountItem.ToString()] = value;
            }
            return values;
        }

        private static StrategyCaptureSource MapStrategy(Account account, StrategyBase strategy)
        {
            object position = strategy.Position;
            object instrument = strategy.Instruments == null
                ? null
                : strategy.Instruments.FirstOrDefault();
            return new StrategyCaptureSource
            {
                StrategyId = PublicString(strategy, "StrategyId", "Id") ?? String.Empty,
                StrategyName = strategy.Name,
                StrategyDisplayName = PublicString(strategy, "DisplayName") ?? strategy.Name,
                AccountName = account.Name,
                Instrument = PublicString(instrument, "FullName"),
                State = strategy.State.ToString(),
                Quantity = NullableDecimal(PublicValue(position, "Quantity")),
                Position = PublicString(position, "MarketPosition"),
                AveragePrice = NullableDecimal(PublicValue(position, "AveragePrice")),
                RealizedPnl = null,
                UnrealizedPnl = null,
                Enabled = true,
                Sync = NullableBoolean(PublicValue(strategy, "IsInSync", "Sync")),
                DataSeries = PublicString(strategy, "BarsPeriod", "DataSeries"),
                ConnectionName = ConnectionName(account),
                StartedAt = null,
                Parameters = ReadParameters(strategy),
                ExtraValues = ReadExtraValues(strategy),
            };
        }

        private static OrderCaptureSource MapOrder(
            Account account, Order order, StrategyAttributionMap attribution)
        {
            string type = order.OrderType.ToString();
            bool hasLimit = type == "Limit" || type == "StopLimit";
            bool hasStop = type == "StopMarket" || type == "StopLimit";
            // Null when no strategy on this account claims the order, which is
            // what every order carried before the lookup existed: a manual trade,
            // and an order whose strategy the platform will not name, both say
            // nothing here rather than something invented.
            StrategyAttribution strategy = attribution.ResolveOrder(order.OrderId);
            return new OrderCaptureSource
            {
                OrderId = order.OrderId ?? String.Empty,
                AccountName = account.Name,
                StrategyId = strategy?.StrategyId,
                StrategyName = strategy?.StrategyName,
                Instrument = order.Instrument == null ? String.Empty : order.Instrument.FullName,
                Action = order.OrderAction.ToString(),
                OrderType = type,
                Quantity = NullableDecimal(order.Quantity),
                Filled = NullableDecimal(order.Filled),
                Remaining = NullableDecimal(Math.Max(0, order.Quantity - order.Filled)),
                LimitPrice = hasLimit ? NullableDecimal(order.LimitPrice) : null,
                StopPrice = hasStop ? NullableDecimal(order.StopPrice) : null,
                AverageFillPrice = order.Filled > 0 ? NullableDecimal(order.AverageFillPrice) : null,
                State = order.OrderState.ToString(),
                Time = ToOffset(order.Time),
                Tif = order.TimeInForce.ToString(),
                Oco = String.IsNullOrWhiteSpace(order.Oco) ? null : order.Oco,
                Name = order.Name,
                NativeId = null,
                ExtraValues = ReadExtraValues(order),
            };
        }

        private static ExecutionCaptureSource MapExecution(
            Account account, Execution execution, StrategyAttributionMap attribution)
        {
            Order order = execution.Order;
            // A fill the strategy lists answers for itself; one it does not list
            // falls back to the order it filled. This is the field the CRM reads
            // to attribute an account day, and the one that was empty on 98% of
            // the automatic path's fills.
            StrategyAttribution strategy = attribution.ResolveExecution(
                execution.ExecutionId, execution.OrderId);
            return new ExecutionCaptureSource
            {
                ExecutionId = execution.ExecutionId ?? String.Empty,
                OrderId = execution.OrderId,
                AccountName = account.Name,
                StrategyId = strategy?.StrategyId,
                StrategyName = strategy?.StrategyName,
                Instrument = execution.Instrument == null ? String.Empty : execution.Instrument.FullName,
                Action = order == null ? String.Empty : order.OrderAction.ToString(),
                Quantity = NullableDecimal(execution.Quantity),
                Price = NullableDecimal(execution.Price),
                Time = ToOffset(execution.Time),
                MarketPosition = execution.MarketPosition.ToString(),
                EntryExit = null,
                Name = execution.Name,
                Commission = NullableDecimal(execution.Commission),
                Fee = null,
                Rate = NullableDecimal(execution.Rate),
                RealizedPnl = null,
                ConnectionName = ConnectionName(account),
                NativeId = null,
                ExtraValues = ReadExtraValues(execution),
            };
        }

        private static IEnumerable<StrategyParameterSource> ReadParameters(StrategyBase strategy)
        {
            var parameters = new List<StrategyParameterSource>();
            foreach (PropertyDescriptor property in TypeDescriptor.GetProperties(strategy))
            {
                if (property.Name == "Name" || property.Name == "DisplayName")
                    continue;
                object value;
                try
                {
                    value = property.GetValue(strategy);
                }
                catch
                {
                    value = new FailedParameterValue();
                }
                parameters.Add(new StrategyParameterSource(property.Name, value, property.IsBrowsable));
            }
            return parameters;
        }


        /// <summary>
        /// Every readable scalar property on a NinjaTrader object, by reflection,
        /// so a column the CRM does not name today is still captured. Reading is
        /// guarded per property: a strategy backed by a proprietary indicator can
        /// throw when a property is touched, and one bad property must not cost us
        /// the whole row. Only scalars are kept — following object graphs would
        /// pull in live collections and risk touching NinjaTrader state.
        /// </summary>
        private static IDictionary<string, object> ReadExtraValues(object source)
        {
            var values = new Dictionary<string, object>(StringComparer.Ordinal);
            if (source == null)
                return values;

            foreach (PropertyDescriptor property in TypeDescriptor.GetProperties(source))
            {
                object value;
                try
                {
                    value = property.GetValue(source);
                }
                catch
                {
                    continue;
                }

                object scalar = AsScalar(value);
                if (scalar != null)
                    values[property.Name] = scalar;
            }
            return values;
        }

        private static object AsScalar(object value)
        {
            if (value == null)
                return null;

            if (value is string text)
                return text.Length > 512 ? text.Substring(0, 512) : text;
            if (value is bool || value is int || value is long || value is short
                || value is byte || value is float || value is double || value is decimal)
                return value;
            if (value is DateTime dateTime)
                return dateTime.ToString("O", CultureInfo.InvariantCulture);
            if (value.GetType().IsEnum)
                return value.ToString();
            return null;
        }

        private static decimal? AccountValue(Account account, AccountItem item, Currency currency)
        {
            try
            {
                return NullableDecimal(account.Get(item, currency));
            }
            catch
            {
                return null;
            }
        }

        private static string ConnectionName(Account account)
        {
            return account.Connection == null || account.Connection.Options == null
                ? null
                : account.Connection.Options.Name;
        }

        private static object PublicValue(object source, params string[] names)
        {
            if (source == null)
                return null;
            PropertyDescriptorCollection properties = TypeDescriptor.GetProperties(source);
            foreach (string name in names)
            {
                PropertyDescriptor property = properties.Find(name, true);
                if (property == null)
                    continue;
                try
                {
                    return property.GetValue(source);
                }
                catch
                {
                    return null;
                }
            }
            return null;
        }

        /// <summary>
        /// The same read as PublicValue, through plain reflection, for a member
        /// TypeDescriptor does not list. A NinjaScript object can carry a custom
        /// type descriptor, which is how the platform shows a strategy's
        /// parameters and nothing else in its own grids, and a collection kept out
        /// of that view is still an ordinary property on the type. Absent,
        /// ambiguous or unreadable, it is null here, exactly as PublicValue leaves
        /// a member that does not exist.
        ///
        /// The hierarchy is walked a level at a time, taking non-public members
        /// too, and that is deliberate rather than thorough. A single GetProperty
        /// sees only public members and, of those, only the ones the most derived
        /// type inherits; which members NinjaTrader declares public on which of
        /// the versions the fleet runs is the one thing this file can never see
        /// from here. A read that quietly finds nothing costs the whole attribution
        /// on every machine and looks exactly like an account with no strategies,
        /// which is the failure this was written to end. Taking the most derived
        /// declaration also resolves a shadowed member the way the compiler would,
        /// instead of as an ambiguous match.
        /// </summary>
        private static object ReflectedValue(object source, string name)
        {
            if (source == null)
                return null;
            try
            {
                const System.Reflection.BindingFlags flags =
                    System.Reflection.BindingFlags.Instance
                    | System.Reflection.BindingFlags.Public
                    | System.Reflection.BindingFlags.NonPublic
                    | System.Reflection.BindingFlags.DeclaredOnly;
                for (Type type = source.GetType(); type != null; type = type.BaseType)
                {
                    System.Reflection.PropertyInfo property = type.GetProperty(name, flags);
                    if (property != null && property.CanRead)
                        return property.GetValue(source, null);
                }
                return null;
            }
            catch
            {
                return null;
            }
        }

        private static string PublicString(object source, params string[] names)
        {
            object value = PublicValue(source, names);
            return value == null ? null : Convert.ToString(value, CultureInfo.InvariantCulture);
        }

        private static decimal? NullableDecimal(object value)
        {
            if (value == null)
                return null;
            try
            {
                double number = Convert.ToDouble(value, CultureInfo.InvariantCulture);
                if (Double.IsNaN(number) || Double.IsInfinity(number) || number == Double.MinValue)
                    return null;
                return Convert.ToDecimal(number, CultureInfo.InvariantCulture);
            }
            catch
            {
                return null;
            }
        }

        private static bool? NullableBoolean(object value)
        {
            if (value == null)
                return null;
            try
            {
                return Convert.ToBoolean(value, CultureInfo.InvariantCulture);
            }
            catch
            {
                return null;
            }
        }

        private static DateTimeOffset ToOffset(DateTime value)
        {
            if (value.Kind == DateTimeKind.Utc)
                return new DateTimeOffset(value);
            if (value.Kind == DateTimeKind.Unspecified)
                value = DateTime.SpecifyKind(value, DateTimeKind.Local);
            return new DateTimeOffset(value);
        }

        private sealed class FailedParameterValue
        {
            public override string ToString()
            {
                throw new InvalidOperationException("The parameter value could not be read.");
            }
        }
    }
}
