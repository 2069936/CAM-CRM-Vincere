using System;
using System.IO.Pipes;
using System.Security.AccessControl;
using System.Security.Principal;

namespace Vincere.AutoExport.NinjaTrader.Pipe
{
    public static class CapturePipeSecurity
    {
        public static NamedPipeServerStream Create(string pipeName)
        {
            if (String.IsNullOrWhiteSpace(pipeName))
                throw new ArgumentException("A capture pipe name is required.", nameof(pipeName));

            SecurityIdentifier system = new SecurityIdentifier(WellKnownSidType.LocalSystemSid, null);
            SecurityIdentifier administrators = new SecurityIdentifier(
                WellKnownSidType.BuiltinAdministratorsSid,
                null);
            SecurityIdentifier interactiveUser;
            using (WindowsIdentity identity = WindowsIdentity.GetCurrent())
            {
                interactiveUser = identity.User
                    ?? throw new InvalidOperationException("The interactive Windows identity has no SID.");
            }

            var security = new PipeSecurity();
            security.SetAccessRuleProtection(true, false);
            security.AddAccessRule(new PipeAccessRule(
                system,
                PipeAccessRights.FullControl,
                AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(
                administrators,
                PipeAccessRights.FullControl,
                AccessControlType.Allow));
            security.AddAccessRule(new PipeAccessRule(
                interactiveUser,
                PipeAccessRights.ReadWrite,
                AccessControlType.Allow));

            return new NamedPipeServerStream(
                pipeName,
                PipeDirection.InOut,
                1,
                PipeTransmissionMode.Byte,
                PipeOptions.Asynchronous,
                4096,
                64 * 1024,
                security);
        }
    }
}
