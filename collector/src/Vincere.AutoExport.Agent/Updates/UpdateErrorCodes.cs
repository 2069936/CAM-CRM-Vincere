namespace Vincere.AutoExport.Agent.Updates;

/* THE WORDS THE UPDATER REPORTS, AND NOTHING ELSE.
 *
 * Every one of these travels to the CRM as `errorCode` on the agent-update poll,
 * which accepts snake_case up to 64 characters and shows it to the Manager who
 * pressed Update. They are a fixed vocabulary on purpose: a message, a path or an
 * exception text would put this machine's details on a screen, and a code the
 * desk has not seen before cannot be looked up in installing.md.
 *
 * The four written by update-agent.ps1 into last-result.json (backup_failed,
 * install_failed, service_not_running, rollback_failed) arrive through
 * ReadLastResult and are checked against the same shape before they are sent. */
public static class UpdateErrorCodes
{
    // The directive itself.
    public const string DirectiveInvalid = "directive_invalid";
    public const string VersionNotNewer = "version_not_newer";
    public const string UrlNotAllowed = "url_not_allowed";

    // The release manifest the directive pins.
    public const string ManifestUnreachable = "manifest_unreachable";
    public const string ManifestHashMismatch = "manifest_hash_mismatch";
    public const string ManifestInvalid = "manifest_invalid";

    /* The release says it needs a newer NinjaTrader AddOn than the one this
     * machine last reported. The AddOn is never updated from the CRM, so the
     * agent stays where it is until someone updates the AddOn by hand. */
    public const string AddonUpdateRequired = "addon_update_required";

    // The package.
    public const string DiskSpace = "disk_space";
    public const string PackageUnreachable = "package_unreachable";
    public const string PackageHashMismatch = "package_hash_mismatch";
    public const string PackageInvalid = "package_invalid";

    /// <summary>A local file operation failed for a reason that is not disk space, such as a file held open.</summary>
    public const string StagingFailed = "staging_failed";

    // Handing over to the scheduled task.
    public const string ScheduleFailed = "schedule_failed";

    /// <summary>The task was started and nothing came back from it within the apply timeout.</summary>
    public const string ApplyTimeout = "apply_timeout";

    /// <summary>update-agent.ps1 said installed, but the service that came back reports another version.</summary>
    public const string VersionMismatch = "version_mismatch";

    /// <summary>The fallback for a rolled back result whose own code is missing or not a code.</summary>
    public const string InstallFailed = "install_failed";

    /// <summary>The fallback when the budget is spent and no earlier failure left a code.</summary>
    public const string AttemptsExhausted = "attempts_exhausted";

    /// <summary>The fallback the CRM client sends when a failed state arrives without a usable code.</summary>
    public const string UpdateFailed = "update_failed";
}
