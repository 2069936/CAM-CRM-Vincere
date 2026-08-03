using System;
using System.IO.Pipes;
using System.Windows;
using System.Windows.Controls;

namespace NinjaTrader.NinjaScript
{
    public enum State
    {
        SetDefaults,
        Active,
        Terminated,
    }

    public abstract class AddOnBase
    {
        protected State State { get; set; }
        public string Name { get; protected set; }
        public string Description { get; protected set; }
        protected virtual void OnStateChange() { }
        protected virtual void OnWindowCreated(Window window) { }
        protected virtual void OnWindowDestroyed(Window window) { }
    }
}

namespace NinjaTrader.Gui
{
    public sealed class ControlCenter : Window
    {
        public object FindFirst(string automationId)
        {
            _ = automationId;
            return null;
        }
    }
}

namespace NinjaTrader.Gui.Tools
{
    public sealed class NTMenuItem : MenuItem
    {
    }
}

namespace Vincere.AutoExport.NinjaTrader.Pipe
{
    public static class CapturePipeSecurity
    {
        public static NamedPipeServerStream Create(string pipeName)
        {
            return new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous);
        }
    }
}
