using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace Vincere.AutoExport.Agent.Queue;

public interface IQueueDurability
{
    void FlushDirectoryMetadata(string directoryPath);
}

public sealed class WindowsQueueDurability : IQueueDurability
{
    private const uint GenericWrite = 0x40000000;
    private const uint FileShareRead = 0x00000001;
    private const uint FileShareWrite = 0x00000002;
    private const uint FileShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint FileFlagBackupSemantics = 0x02000000;

    public static WindowsQueueDurability Instance { get; } = new();

    private WindowsQueueDurability()
    {
    }

    public void FlushDirectoryMetadata(string directoryPath)
    {
        if (!OperatingSystem.IsWindows()) return;

        using SafeFileHandle handle = CreateFileW(
            directoryPath,
            GenericWrite,
            FileShareRead | FileShareWrite | FileShareDelete,
            IntPtr.Zero,
            OpenExisting,
            FileFlagBackupSemantics,
            IntPtr.Zero);
        if (handle.IsInvalid) return;

        // Some Windows filesystems do not support flushing directory handles.
        // The payload itself was already opened with WriteThrough and Flush(true),
        // so an unsupported metadata flush is a best-effort durability enhancement.
        _ = FlushFileBuffers(handle);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        IntPtr securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool FlushFileBuffers(SafeFileHandle fileHandle);
}
