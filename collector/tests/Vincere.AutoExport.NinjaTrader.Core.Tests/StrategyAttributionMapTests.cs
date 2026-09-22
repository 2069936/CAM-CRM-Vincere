using System;
using Vincere.AutoExport.NinjaTrader.Core.Capture;
using Xunit;

namespace Vincere.AutoExport.NinjaTrader.Core.Tests;

public sealed class StrategyAttributionMapTests
{
    [Fact]
    public void An_order_its_strategy_lists_carries_that_strategy()
    {
        var map = StrategyAttributionMap.Build(new[] { Owns("strategy-1", "Opening Range", "order-1") });

        StrategyAttribution attribution = map.ResolveOrder("order-1");

        Assert.NotNull(attribution);
        Assert.Equal("strategy-1", attribution.StrategyId);
        Assert.Equal("Opening Range", attribution.StrategyName);
    }

    [Fact]
    public void A_fill_the_strategy_does_not_list_resolves_through_its_order()
    {
        // The ordinary case on a live machine: the strategy keeps its orders for
        // the session, and the fill only has to name the order it came from.
        var map = StrategyAttributionMap.Build(new[] { Owns("strategy-1", "Opening Range", "order-1") });

        StrategyAttribution attribution = map.ResolveExecution("execution-9", "order-1");

        Assert.Equal("Opening Range", attribution.StrategyName);
    }

    [Fact]
    public void A_fill_the_strategy_lists_answers_without_its_order()
    {
        var map = StrategyAttributionMap.Build(new[]
        {
            new StrategyOrderOwnership("strategy-1", "Opening Range", Array.Empty<string>(), new[] { "execution-1" }),
        });

        Assert.Equal("Opening Range", map.ResolveExecution("execution-1", null).StrategyName);
        Assert.Null(map.ResolveOrder("order-1"));
    }

    [Fact]
    public void An_order_no_strategy_claims_stays_unattributed()
    {
        // A manual trade. It left here with two nulls before the lookup existed
        // and it still does.
        var map = StrategyAttributionMap.Build(new[] { Owns("strategy-1", "Opening Range", "order-1") });

        Assert.Null(map.ResolveOrder("order-2"));
        Assert.Null(map.ResolveExecution("execution-2", "order-2"));
    }

    [Fact]
    public void A_blank_id_never_matches()
    {
        // Both sides of this matter: a strategy that lists an empty order id must
        // not claim that id, and an order that carries an empty id must not be
        // attributed by it. Otherwise one blank on each side attributes unrelated
        // rows to each other wholesale.
        var map = StrategyAttributionMap.Build(new[]
        {
            new StrategyOrderOwnership("strategy-1", "Opening Range", new[] { "", "   ", null, "order-1" }, null),
        });

        Assert.Null(map.ResolveOrder(""));
        Assert.Null(map.ResolveOrder("   "));
        Assert.Null(map.ResolveOrder(null));
        Assert.Null(map.ResolveExecution(null, ""));
        Assert.Equal("Opening Range", map.ResolveOrder("order-1").StrategyName);
    }

    [Fact]
    public void A_strategy_that_can_name_neither_itself_nor_its_id_attributes_nothing()
    {
        var map = StrategyAttributionMap.Build(new[] { Owns(null, "  ", "order-1") });

        Assert.Null(map.ResolveOrder("order-1"));
    }

    [Fact]
    public void Two_strategies_claiming_one_order_leave_it_unattributed()
    {
        // THE AMBIGUITY RULE. A contested id attributes to nobody: a wrong
        // strategy name moves a day's losses onto an algorithm that never traded
        // them, and nothing downstream could tell that it had happened.
        var map = StrategyAttributionMap.Build(new[]
        {
            Owns("strategy-1", "Opening Range", "order-1"),
            Owns("strategy-2", "Mean Reversion", "order-1"),
        });

        Assert.Null(map.ResolveOrder("order-1"));
    }

    [Fact]
    public void A_contested_order_stays_unattributed_however_late_the_agreement_arrives()
    {
        // The contest does not depend on the order the strategies were walked in:
        // a third claim cannot win an id two strategies have already disagreed
        // about, even when it repeats the first one.
        var map = StrategyAttributionMap.Build(new[]
        {
            Owns("strategy-1", "Opening Range", "order-1"),
            Owns("strategy-2", "Mean Reversion", "order-1"),
            Owns("strategy-1", "Opening Range", "order-1"),
        });

        Assert.Null(map.ResolveOrder("order-1"));
    }

    [Fact]
    public void One_strategy_claiming_an_id_twice_is_not_a_contest()
    {
        // Which is what happens on every fill: the id arrives once from the
        // strategy's own order and once from the order id its execution carries.
        var map = StrategyAttributionMap.Build(new[]
        {
            new StrategyOrderOwnership(
                "strategy-1", "Opening Range", new[] { "order-1", "order-1" }, new[] { "execution-1" }),
        });

        Assert.Equal("Opening Range", map.ResolveOrder("order-1").StrategyName);
        Assert.Equal("Opening Range", map.ResolveExecution("execution-1", "order-1").StrategyName);
    }

    [Fact]
    public void A_contested_fill_is_not_rescued_by_its_order()
    {
        // Two strategies have contradicted each other about this fill. Reaching
        // for the order key until one of them answers would turn the
        // contradiction into a confident answer.
        var map = StrategyAttributionMap.Build(new[]
        {
            new StrategyOrderOwnership("strategy-1", "Opening Range", new[] { "order-1" }, new[] { "execution-1" }),
            new StrategyOrderOwnership("strategy-2", "Mean Reversion", Array.Empty<string>(), new[] { "execution-1" }),
        });

        Assert.Equal("Opening Range", map.ResolveOrder("order-1").StrategyName);
        Assert.Null(map.ResolveExecution("execution-1", "order-1"));
    }

    [Fact]
    public void Ids_match_on_their_trimmed_text_while_the_name_is_reported_verbatim()
    {
        // The id is a key and padding on it is noise; the name is a value the CRM
        // joins to the strategies section of the same snapshot, which carries the
        // platform's string as it came.
        var map = StrategyAttributionMap.Build(new[] { Owns("strategy-1", " Opening Range ", " order-1") });

        StrategyAttribution attribution = map.ResolveOrder("order-1 ");

        Assert.NotNull(attribution);
        Assert.Equal(" Opening Range ", attribution.StrategyName);
    }

    [Fact]
    public void An_account_with_no_strategies_attributes_nothing()
    {
        Assert.Null(StrategyAttributionMap.Empty.ResolveOrder("order-1"));
        Assert.Null(StrategyAttributionMap.Build(null).ResolveExecution("execution-1", "order-1"));
        Assert.Null(StrategyAttributionMap.Build(new StrategyOrderOwnership[] { null }).ResolveOrder("order-1"));
    }

    private static StrategyOrderOwnership Owns(string strategyId, string strategyName, params string[] orderIds)
    {
        return new StrategyOrderOwnership(strategyId, strategyName, orderIds, Array.Empty<string>());
    }
}
