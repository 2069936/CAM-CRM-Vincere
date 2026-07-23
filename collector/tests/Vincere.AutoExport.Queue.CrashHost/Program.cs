using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using System.Threading.Tasks;
using Vincere.AutoExport.Agent.Queue;
using Vincere.AutoExport.Agent.Security;
using Vincere.AutoExport.Contracts;

namespace Vincere.AutoExport.Queue.CrashHost;

public static class CrashHostMarker
{
}

internal static class Program
{
    private static async Task<int> Main(string[] args)
    {
        if (args.Length != 2) return 64;

        SnapshotQueue queue = new(
            args[0],
            new TestDirectorySecurity(),
            durability: new BlockingDurability(args[1]));
        await queue.EnqueueAsync(new AutoExportSnapshotV1
        {
            SchemaVersion = 1,
            CaptureId = Guid.Parse("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"),
            CapturedAt = new DateTimeOffset(2026, 7, 23, 16, 45, 0, TimeSpan.FromHours(-4)),
            TradingDate = "2026-07-23",
            TimeZone = "America/New_York",
            Source = new SourceMetadataV1
            {
                MachineId = "process-kill-test",
                AgentVersion = "test",
                AddonVersion = "test",
                NinjaTraderVersion = "test",
            },
            Accounts = new List<AccountRowV1>(),
            Strategies = new List<StrategyRowV1>(),
            Orders = new List<OrderRowV1>(),
            Executions = new List<ExecutionRowV1>(),
        });
        return 0;
    }

    private sealed class BlockingDurability : IQueueDurability
    {
        private readonly string readyPath;
        private int entered;

        public BlockingDurability(string readyPath)
        {
            this.readyPath = readyPath;
        }

        public void FlushDirectoryMetadata(string directoryPath)
        {
            if (Interlocked.Exchange(ref entered, 1) != 0) return;
            File.WriteAllText(readyPath, directoryPath);
            Thread.Sleep(Timeout.Infinite);
        }
    }

    private sealed class TestDirectorySecurity : IAgentDirectorySecurity
    {
        public void EnsureProtected(string path) => Directory.CreateDirectory(path);
    }
}
