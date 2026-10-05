using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Reflection.Emit;
using System.Runtime.CompilerServices;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Vincere.AutoExport.Agent.Capture;
using Vincere.AutoExport.Agent.Configuration;
using Vincere.AutoExport.Agent.Service;
using Xunit;

namespace Vincere.AutoExport.Agent.Tests;

/// <summary>
/// DOES THE PROGRAM WIRE ITSELF - WHICH IS NOT A QUESTION ANY TEST OF A METHOD CAN
/// ANSWER.
///
/// The previous round was right to move the registrations into
/// AgentComposition.Register and to prove them by building the container. It closed
/// the question "do the registrations produce a supervisor holding the loop". It did
/// not close the question underneath, and the defect moved up one level instead of
/// being closed: comment out the single line of Program.cs that CALLS Register and
/// the whole agent suite stays green. Measured in a shadow build of the committed
/// tree, Release:
///
///   // AgentComposition.Register(builder.Services, paths, configurationStore, crmBaseUri, version);
///
///   Passed!  - Failed: 0, Passed: 347, Skipped: 0, Total: 347
///
/// Identical to the unmutated baseline. What that machine would actually run is a
/// host with NOTHING registered: no heartbeat, no uploader, no scheduler, no queue,
/// no account tracker. The service would start, stay up, and do nothing at all -
/// which is precisely the shape of the incident this repository already paid for,
/// where a loop took a store as an optional last argument, Program.cs forgot to
/// pass it, it compiled, the heartbeat kept returning 200, and no report was mailed
/// again, silently, forever.
///
/// WHY THE PROGRAM CANNOT SIMPLY BE RUN, said plainly because the honest answer
/// shapes everything below. Two separate blockers, both in the entry point itself:
///
///   * `AgentPaths.FromEnvironment()` goes straight to
///     Environment.SpecialFolder.CommonApplicationData with no seam. Invoking the
///     entry point in-process would read and write the real ProgramData of whatever
///     machine the suite runs on. AgentCompositionTests exists because
///     FromProgramData IS a seam; the entry point deliberately does not use it,
///     since finding ProgramData is one of the three things only it can do.
///   * `await builder.Build().RunAsync()` returns when the service is signalled to
///     stop. There is no token, no timeout and nothing in the container a caller
///     holds before Build() to stop it with. A test that called the entry point
///     would hang, on a VPS-shaped host, on a Mac.
///
/// SO THE COMPILED PROGRAM IS ASKED WHAT IT DOES, which is a different thing from
/// asking the FILE WHAT IT SAYS and is the whole point. The three assertions this
/// replaces the gap of were Assert.Contains against Program.cs's text, and a
/// comment satisfies an Assert.Contains - that is how the account tracker came to be
/// registered on no machine with a green suite. A comment emits no call instruction.
/// A deleted line emits no call instruction. A line moved inside a method that is
/// never reached emits no call instruction in the entry point. So: walk the IL of
/// the entry point and of the async state machine the compiler moved its body into,
/// resolve every method token it calls, and ask about the call graph.
///
/// WHAT THIS DOES NOT COVER, named rather than left for the next person to find:
///
///   * It proves the call SITE exists in the compiled entry point and is reached
///     before the host is built. It does not prove the statement executes at run
///     time. A call guarded by a condition that is false on a VPS would satisfy
///     this. Nothing short of starting the service proves that, and the two
///     blockers above are why nothing here starts the service.
///   * It says nothing about whether the loops TICK on a real machine - the
///     dispatcher marshalling, the pipe, NinjaTrader. That is unchanged and is
///     still only provable on the self-hosted Windows runner.
///   * It is joined to AgentCompositionTests rather than replacing it. That file
///     proves the collection Register builds yields a supervisor holding an
///     AccountSampleLoop; this one proves the program calls Register and starts the
///     host it fills. Neither is sufficient alone, which is why both are here.
///
/// THE WALKER IS SELF-CHECKING. A walker that silently returned nothing would make
/// every Contains assertion here vacuous, so the first test asserts a set of calls
/// the entry point certainly makes and a name it certainly does not. If the IL
/// reader breaks, that test fails rather than the suite going quietly green.
/// </summary>
public sealed class ProgramEntryPointTests
{
    /// <summary>Every opcode by its value, read out of the runtime's own table rather
    /// than hand-written, so the operand sizes below cannot drift.</summary>
    private static readonly Dictionary<short, OpCode> OpCodesByValue = typeof(OpCodes)
        .GetFields(BindingFlags.Public | BindingFlags.Static)
        .Where(field => field.FieldType == typeof(OpCode))
        .Select(field => (OpCode)field.GetValue(null))
        .ToDictionary(code => code.Value, code => code);

    private static int OperandSize(OpCode code, byte[] il, int at) => code.OperandType switch
    {
        OperandType.InlineNone => 0,
        OperandType.ShortInlineBrTarget or OperandType.ShortInlineI or OperandType.ShortInlineVar => 1,
        OperandType.InlineVar => 2,
        OperandType.InlineBrTarget or OperandType.InlineField or OperandType.InlineI
            or OperandType.InlineMethod or OperandType.InlineSig or OperandType.InlineString
            or OperandType.InlineTok or OperandType.InlineType or OperandType.ShortInlineR => 4,
        OperandType.InlineI8 or OperandType.InlineR => 8,
        // The jump table's length is its first operand, so this one is not a constant.
        OperandType.InlineSwitch => 4 + (4 * BitConverter.ToInt32(il, at)),
        _ => throw new NotSupportedException($"No operand size for {code.OperandType}."),
    };

    /// <summary>Every method called by one compiled method body, with the IL offset of
    /// the call, because some of the questions below are about order.</summary>
    private static IEnumerable<(int Offset, MethodBase Method)> CallsIn(MethodBase method)
    {
        MethodBody body = method.GetMethodBody();
        if (body is null) yield break;
        byte[] il = body.GetILAsByteArray();
        if (il is null) yield break;
        Type[] typeArguments = method.DeclaringType?.IsGenericType == true
            ? method.DeclaringType.GetGenericArguments()
            : null;
        int at = 0;
        while (at < il.Length)
        {
            int callAt = at;
            short value = il[at];
            // 0xFE is the two-byte opcode prefix.
            if (il[at] == 0xFE) { value = (short)(0xFE00 | il[at + 1]); at += 2; }
            else { at += 1; }
            OpCode code = OpCodesByValue[value];
            int size = OperandSize(code, il, at);
            if (code.OperandType == OperandType.InlineMethod)
            {
                MethodBase resolved = null;
                try { resolved = method.Module.ResolveMethod(BitConverter.ToInt32(il, at), typeArguments, null); }
                // A token the walker cannot resolve is skipped rather than failing the
                // walk: the assertions below are all about calls that ARE found, and a
                // walker that threw on an unrelated generic instantiation would be a
                // test that breaks for reasons that are not the subject.
                catch (Exception) { }
                if (resolved is not null) yield return (callAt, resolved);
            }
            at += size;
        }
    }

    /// <summary>
    /// Everything the entry point calls, following the compiler's own rewriting.
    ///
    /// A top-level program with an `await` in it compiles to THREE things: a
    /// synchronous `&lt;Main&gt;` that blocks on a Task, an async `&lt;Main&gt;$`
    /// holding the source order, and a state machine whose MoveNext carries the body.
    /// The entry point's own IL is 20 bytes and mentions none of the wiring, so a
    /// walk that stopped there would assert nothing and pass. Compiler-generated
    /// members of the program's own type are therefore followed; library calls are
    /// reported and not descended into.
    /// </summary>
    private static List<(int Offset, MethodBase Method)> EntryPointCallGraph()
    {
        Assembly agent = typeof(AgentComposition).Assembly;
        MethodInfo entryPoint = agent.EntryPoint
            ?? throw new InvalidOperationException("The agent assembly has no entry point.");
        Type program = entryPoint.DeclaringType;
        var found = new List<(int, MethodBase)>();
        var seen = new HashSet<MethodBase>();
        var pending = new Queue<MethodBase>();
        pending.Enqueue(entryPoint);
        while (pending.Count > 0)
        {
            MethodBase current = pending.Dequeue();
            if (!seen.Add(current)) continue;
            MethodBase body = current;
            AsyncStateMachineAttribute machine = current.GetCustomAttribute<AsyncStateMachineAttribute>();
            if (machine is not null)
            {
                MethodBase moveNext = machine.StateMachineType.GetMethod(
                    "MoveNext", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                if (moveNext is not null) body = moveNext;
            }
            foreach ((int offset, MethodBase called) in CallsIn(body))
            {
                found.Add((offset, called));
                bool isTheProgramsOwnCode = called.DeclaringType is not null
                    && called.DeclaringType.Assembly == agent
                    && (called.DeclaringType == program
                        || (called.DeclaringType.IsNested && called.DeclaringType.DeclaringType == program));
                if (isTheProgramsOwnCode) pending.Enqueue(called);
            }
        }
        return found;
    }

    private static IEnumerable<MethodBase> Methods() => EntryPointCallGraph().Select(call => call.Method);

    private static int OffsetOf(string declaringType, string method)
    {
        List<(int Offset, MethodBase Method)> calls = EntryPointCallGraph();
        (int Offset, MethodBase Method) match = calls
            .Where(call => call.Method.DeclaringType?.Name == declaringType && call.Method.Name == method)
            .OrderBy(call => call.Offset)
            .FirstOrDefault();
        Assert.True(match.Method is not null, $"The entry point never calls {declaringType}.{method}.");
        return match.Offset;
    }

    /* THE WALKER ITSELF, BEFORE ANYTHING IS CONCLUDED FROM IT.
     *
     * Every other test here asks whether a call is present, and a reader that found
     * nothing would make all of them pass. So: a set the entry point certainly calls,
     * and a name it certainly does not. */
    [Fact]
    public void The_il_walker_finds_what_the_entry_point_calls_and_not_what_it_does_not()
    {
        List<string> names = Methods()
            .Select(method => $"{method.DeclaringType?.Name}.{method.Name}")
            .ToList();

        // The three things Program.cs keeps because nothing else can do them, plus
        // the host it builds. If the walker breaks, these go first.
        Assert.Contains("AgentPaths.FromEnvironment", names);
        Assert.Contains("ConfigurationStore.LoadAsync", names);
        Assert.Contains("Uri.TryCreate", names);
        Assert.Contains("Host.CreateApplicationBuilder", names);
        Assert.Contains("HostApplicationBuilder.Build", names);

        /* And it DISCRIMINATES, which a walker that returned every method in the
         * assembly would not. FromProgramData is the seam AgentCompositionTests uses
         * and the entry point deliberately does not: finding ProgramData from the
         * environment is one of the three things Program.cs exists to do. So this is
         * both a check on the walker and a statement about the program. If the entry
         * point is ever changed to take a ProgramData override, this is the line that
         * will say so, and it should be changed deliberately rather than deleted. */
        Assert.DoesNotContain("AgentPaths.FromProgramData", names);
    }

    /* THE ONE THAT WOULD HAVE CAUGHT THE DEFECT.
     *
     * Not "does Program.cs contain the string AgentComposition.Register" - a comment
     * satisfies that, measured - but "does the compiled entry point CALL it". */
    [Fact]
    public void The_entry_point_calls_the_composition_root()
    {
        MethodBase[] register = Methods()
            .Where(method => method.DeclaringType == typeof(AgentComposition) && method.Name == nameof(AgentComposition.Register))
            .ToArray();

        // Exactly one: twice would register every loop twice, which on this fleet is
        // every terminal on the desk being asked to read itself twice as often as the
        // SQL editor says. Named, because "The collection was empty" does not say that
        // the service would start with nothing registered at all.
        Assert.True(register.Length == 1,
            $"The compiled entry point calls AgentComposition.Register {register.Length} times, expected "
            + "exactly 1. At 0 the service starts a host with no heartbeat, no uploader, no scheduler and "
            + "no account tracker, and stays up doing nothing.");
    }

    /* AND IT STARTS THE HOST IT FILLED.
     *
     * Register alone is not the wiring. A program that registered everything and
     * never called RunAsync would exit immediately, which on a Windows service is a
     * start failure and on this fleet is a machine that reports nothing. */
    [Fact]
    public void The_entry_point_builds_the_host_and_runs_it()
    {
        List<string> names = Methods().Select(method => $"{method.DeclaringType?.Name}.{method.Name}").ToList();
        Assert.Contains("HostApplicationBuilder.Build", names);
        Assert.Contains("HostingAbstractionsHostExtensions.RunAsync", names);
    }

    /* THE ORDER, WHICH IS A REAL BUG CLASS AND NOT TIDINESS.
     *
     * `builder.Build()` snapshots the service collection. Registrations added after
     * it compile, run, mutate a collection nobody reads again, and the host starts
     * with nothing in it - the same observable as not calling Register at all, and
     * harder to see because the call is right there in the file. */
    [Fact]
    public void It_registers_before_it_builds_the_host()
    {
        int register = OffsetOf(nameof(AgentComposition), nameof(AgentComposition.Register));
        int build = OffsetOf(nameof(HostApplicationBuilder), "Build");
        Assert.True(register < build,
            $"Register is called at IL offset {register} and Build at {build}: "
            + "registrations added after Build() go into a collection the host has already read.");
    }

    /* AND THE GUARD THAT KEEPS AgentCompositionTests MEANINGFUL.
     *
     * AgentCompositionTests can only see what Register puts in the collection. A
     * registration written directly into Program.cs is invisible to it - and that is
     * exactly where all of them used to live, so it is the natural place for the next
     * one to be added. Measured: none today, and this fails the moment one appears,
     * with the message saying where it belongs. */
    [Fact]
    public void The_entry_point_registers_nothing_of_its_own_outside_the_composition_root()
    {
        string[] registrations = Methods()
            .Where(method => method.Name.StartsWith("Add", StringComparison.Ordinal)
                || method.Name.StartsWith("TryAdd", StringComparison.Ordinal))
            .Select(method => $"{method.DeclaringType?.Name}.{method.Name}")
            .Distinct()
            .Where(name => name != "WindowsServiceLifetimeHostBuilderExtensions.AddWindowsService")
            .ToArray();

        /* AddWindowsService is the single exception and it is excluded by name rather
         * than by pattern: it configures the HOST's lifetime, not the service
         * collection's contents, it has to happen on the builder before anything else,
         * and AgentCompositionTests - which builds a bare collection with no host -
         * could not hold it. Anything else found here is a registration the container
         * test cannot see. */
        Assert.True(registrations.Length == 0,
            "Program.cs registers these itself, where AgentCompositionTests cannot see them - move them "
            + "into AgentComposition.Register: " + string.Join(", ", registrations));
    }

    /* THE TWO HALVES JOINED, so that the claim is about a host and not about a
     * collection. AgentCompositionTests resolves the supervisor out of what Register
     * builds; the tests above prove the program calls Register and runs the host. This
     * one states the conclusion in one place: the composition root the entry point
     * calls is the one that yields a supervisor holding the account sample loop. */
    [Fact]
    public void The_composition_root_the_entry_point_calls_is_the_one_that_holds_the_tracker()
    {
        MethodBase[] found = Methods().Where(method =>
            method.DeclaringType == typeof(AgentComposition)
            && method.Name == nameof(AgentComposition.Register)).ToArray();
        // Named rather than left to `.Single()`, whose own message is "Sequence
        // contains no matching element" - a red test that does not say what broke is
        // half a test, and this is the test that would be red when the wiring is gone.
        Assert.True(found.Length == 1,
            $"The entry point calls AgentComposition.Register {found.Length} times, expected exactly 1.");
        MethodBase register = found[0];

        string programData = Path.Combine(Path.GetTempPath(), "vincere-entrypoint-" + Guid.NewGuid().ToString("n"));
        Directory.CreateDirectory(programData);
        try
        {
            ServiceCollection services = new();
            // Invoked through the MethodBase the IL walk found, not through a direct
            // call to AgentComposition.Register, so that the thing exercised here is
            // demonstrably the thing the entry point reaches.
            register.Invoke(null, new object[]
            {
                services,
                AgentPaths.FromProgramData(programData),
                new ConfigurationStore(Path.Combine(programData, "config.json")),
                new Uri("https://crm.example.test/"),
                "1.1.3",
            });
            using ServiceProvider provider = services.BuildServiceProvider(validateScopes: true);

            Worker supervisor = Assert.Single(provider.GetServices<IHostedService>().OfType<Worker>());
            ICollectorLoop[] supervised = SupervisedLoops(supervisor);
            Assert.Contains(supervised, loop => loop is AccountSampleLoop);
            Assert.Contains(supervised, loop => loop.Name == "account-sample");
        }
        finally
        {
            try { Directory.Delete(programData, recursive: true); }
            catch (IOException) { }
        }
    }

    /// <summary>The loops the supervisor will iterate, read off the instance the
    /// container handed over rather than off a second construction of it.</summary>
    private static ICollectorLoop[] SupervisedLoops(Worker supervisor)
    {
        FieldInfo field = typeof(Worker).GetField("loops", BindingFlags.Instance | BindingFlags.NonPublic);
        Assert.NotNull(field);
        return ((IReadOnlyCollection<ICollectorLoop>)field.GetValue(supervisor)).ToArray();
    }
}
