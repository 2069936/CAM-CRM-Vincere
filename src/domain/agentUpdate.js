/* ────────────────────────────────────────────────────────────────────────────
 * UPDATING THE WINDOWS AGENT FROM THE CRM.
 *
 * A Manager asks for one VPS or for every outdated one; the agent polls
 * /api/ingest/agent-update, gets the release the CRM pins and installs it
 * itself (step 70 keeps the request and what the agent says about it). This
 * module is the one place that decides, for a screen and for the request
 * route alike, which machines the CRM can update and what each one's request
 * says in words.
 *
 * TWO KINDS OF MACHINE THE BUTTON CAN NEVER REACH, and both are told to
 * update on the VPS instead of being sent a request nothing will act on:
 *
 *   An agent older than FIRST_SELF_UPDATING_AGENT has no updater. It never
 *   polls the route, so a request to it would sit as "requested" forever.
 *
 *   A release whose manifest names a minimumAddonVersion above the VPS's
 *   AddOn. The agent cannot install the AddOn on its own, because NinjaTrader
 *   has to be closed for it, so the new agent would run against an AddOn it
 *   does not fully work with.
 *
 * Pure: no React, no clock of its own. The server imports it too.
 * ──────────────────────────────────────────────────────────────────────────── */

/** The first agent build with the updater. One place, read by the card, the
 * fleet view and the request route. */
export const FIRST_SELF_UPDATING_AGENT = '1.3.0';

/** The most device ids one request to /api/admin/ingest-agent-update takes. */
export const AGENT_UPDATE_BATCH_LIMIT = 300;

/** step 70's update_state vocabulary. */
export const AGENT_UPDATE_STATES = Object.freeze([
  'requested', 'downloading', 'staged', 'applying', 'failed', 'completed', 'cancelled',
]);

const READABLE_VERSION = /^\d{1,5}(?:\.\d{1,5}){1,3}$/;
const TARGET_VERSION = /^\d{1,5}\.\d{1,5}\.\d{1,5}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export const AGENT_UPDATE_BLOCKER_COPY = Object.freeze({
  agent_too_old: `This agent is older than ${FIRST_SELF_UPDATING_AGENT} and cannot update itself. Install ${FIRST_SELF_UPDATING_AGENT} on the VPS once; later updates can be sent from here.`,
  addon_too_old: 'This update changes the NinjaTrader AddOn. Install it on the VPS with NinjaTrader closed.',
});

/** A version as numbers padded to four parts, or null when it is not one. */
function versionKey(value) {
  if (typeof value !== 'string' || !READABLE_VERSION.test(value)) return null;
  const parts = value.split('.').map(Number);
  while (parts.length < 4) parts.push(0);
  return parts;
}

/** Negative, zero or positive like a comparator; null when either side is not a version. */
export function compareAgentVersions(left, right) {
  const a = versionKey(left);
  const b = versionKey(right);
  if (!a || !b) return null;
  for (let index = 0; index < 4; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

function isActive(device) {
  return Boolean(device) && device.status === 'active' && !device.revokedAt;
}

/** An active VPS whose reported agent is below the release. An agent that has
 * reported no version is not called outdated: nothing says what it runs. */
export function isAgentOutdated(device, releaseVersion) {
  if (!isActive(device)) return false;
  const difference = compareAgentVersions(device.agentVersion, releaseVersion);
  return difference !== null && difference < 0;
}

/**
 * Why the CRM cannot send this VPS the release, in the order they read:
 * 'agent_too_old' and 'addon_too_old'. Empty when it can.
 *
 * An unreadable or missing version counts as too old on both lines: the CRM
 * only sends a request it can show will be acted on.
 *
 * @param {{agentVersion?: string|null, addonVersion?: string|null}} device
 * @param {{minimumAddonVersion?: string|null}|null} release
 */
export function agentUpdateBlockers(device, release) {
  const blockers = [];
  const agent = compareAgentVersions(device?.agentVersion, FIRST_SELF_UPDATING_AGENT);
  if (agent === null || agent < 0) blockers.push('agent_too_old');
  const minimumAddon = release?.minimumAddonVersion;
  if (minimumAddon) {
    const addon = compareAgentVersions(device?.addonVersion, minimumAddon);
    if (addon === null || addon < 0) blockers.push('addon_too_old');
  }
  return blockers;
}

/** A request is pending while a target is set (step 70 clears it on completed and cancelled). */
export function agentUpdatePending(device) {
  return typeof device?.updateTargetVersion === 'string' && device.updateTargetVersion !== '';
}

/**
 * Everything a screen needs to decide what to offer for one VPS.
 *
 *   outdated    the agent is below the release
 *   blockers    agentUpdateBlockers, only when outdated
 *   pending     a request is pending
 *   inFlight    the pending request is for this release and has not failed;
 *               asking again would only start it over
 *   canRequest  outdated, nothing blocks it, and not in flight: the Update
 *               button, and a place in the fleet's bulk request
 */
export function agentUpdatePlan(device, release) {
  const version = release?.version || null;
  const outdated = Boolean(version) && isAgentOutdated(device, version);
  const blockers = outdated ? agentUpdateBlockers(device, release) : [];
  const pending = agentUpdatePending(device);
  const inFlight = pending && device.updateTargetVersion === version && device.updateState !== 'failed';
  return {
    version,
    outdated,
    blockers,
    pending,
    inFlight,
    canRequest: outdated && !blockers.length && !inFlight,
  };
}

/**
 * The fleet's bulk request: the ids the CRM can update now, and how many
 * outdated machines need an install on the VPS instead.
 *
 * @returns {{version: string, minimumAddonVersion: string|null, deviceIds: string[], needsVps: number}|null}
 *   null when no release is pinned.
 */
export function planFleetAgentUpdate(devices, release) {
  if (!release?.version) return null;
  const deviceIds = [];
  let needsVps = 0;
  for (const device of devices || []) {
    const plan = agentUpdatePlan(device, release);
    if (plan.canRequest) deviceIds.push(device.id);
    else if (plan.outdated && plan.blockers.length) needsVps += 1;
  }
  return {
    version: release.version,
    minimumAddonVersion: release.minimumAddonVersion || null,
    deviceIds,
    needsVps,
  };
}

function agents(count) {
  return `${count} outdated ${count === 1 ? 'agent' : 'agents'}`;
}

/** The bulk button: "Update 12 outdated agents to 1.3.1". */
export function fleetAgentUpdateLabel(plan) {
  return `Update ${agents(plan.deviceIds.length)} to ${plan.version}`;
}

/** What window.confirm asks before the bulk request: how many, which version,
 * and how many the request leaves for an install on the VPS. */
export function fleetAgentUpdateConfirmation(plan) {
  const count = plan.deviceIds.length;
  const head = `Update ${agents(count)} to ${plan.version}? Each one downloads ${plan.version} and installs it outside the 4 pm capture window.`;
  if (!plan.needsVps) return head;
  return `${head} ${plan.needsVps} other ${plan.needsVps === 1 ? 'outdated agent needs' : 'outdated agents need'} an install on the VPS instead and will not be sent this update.`;
}

/** The line beside the bulk button when some outdated machines can only be updated on the VPS. */
export function fleetNeedsVpsWords(plan) {
  if (!plan?.needsVps) return '';
  return `${plan.needsVps} ${plan.needsVps === 1 ? 'outdated agent needs' : 'outdated agents need'} an install on the VPS to reach ${plan.version}: ${plan.needsVps === 1 ? 'it is' : 'they are'} older than ${FIRST_SELF_UPDATING_AGENT}, or the update changes the NinjaTrader AddOn.`;
}

/** What the request route answered, summed over its slices, as one sentence. */
export function agentUpdateResultWords(result) {
  const requested = Number(result?.requested) || 0;
  const parts = [`Update to ${result?.version || 'the pinned release'} requested for ${requested} ${requested === 1 ? 'agent' : 'agents'}.`];
  const needsVps = Number(result?.needsVps) || 0;
  const others = Math.max(0, (Number(result?.skipped) || 0) - needsVps);
  if (needsVps) parts.push(`${needsVps} ${needsVps === 1 ? 'needs' : 'need'} an install on the VPS instead.`);
  if (others) parts.push(`${others} ${others === 1 ? 'was' : 'were'} already up to date or no longer active.`);
  return parts.join(' ');
}

/** Splits ids into requests the route accepts. */
export function chunkDeviceIds(ids, size = AGENT_UPDATE_BATCH_LIMIT) {
  const chunks = [];
  for (let from = 0; from < ids.length; from += size) chunks.push(ids.slice(from, from + size));
  return chunks;
}

function sinceWords(fromMs, nowMs) {
  const seconds = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

/**
 * Where the last request stands, as one plain sentence, or null when there is
 * nothing to say (never requested, or cancelled).
 *
 * "Updated to X" names the version the agent now reports: step 70 clears the
 * target when the request completes, and the agent reported at least that
 * version to complete it.
 */
export function describeAgentUpdate(device, now = Date.now()) {
  if (!device) return null;
  const target = device.updateTargetVersion;
  const state = device.updateState;
  if (agentUpdatePending(device)) {
    if (state === 'downloading') return `Downloading ${target}`;
    if (state === 'staged') return `${target} downloaded, installing outside the 4 pm capture window`;
    if (state === 'applying') return `Installing ${target}`;
    if (state === 'failed') return `Update to ${target} failed: ${device.updateErrorCode || 'unknown_error'}`;
    const requestedMs = Date.parse(device.updateRequestedAt || '');
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    return Number.isFinite(requestedMs) && Number.isFinite(nowMs)
      ? `Update to ${target} requested ${sinceWords(requestedMs, nowMs)}`
      : `Update to ${target} requested`;
  }
  if (state === 'completed') return device.agentVersion ? `Updated to ${device.agentVersion}` : 'Update completed';
  return null;
}

/**
 * step 70's six columns, shaped for a screen. Each value is checked against
 * its own column's rule, so a value a hand edit left behind reads as absent
 * rather than reaching the page.
 */
export function publicAgentUpdateFields(row = {}) {
  return {
    updateTargetVersion: typeof row.update_target_version === 'string' && TARGET_VERSION.test(row.update_target_version)
      ? row.update_target_version : null,
    updateRequestedAt: row.update_requested_at || null,
    updateState: AGENT_UPDATE_STATES.includes(row.update_state) ? row.update_state : null,
    updateStateAt: row.update_state_at || null,
    updateErrorCode: typeof row.update_error_code === 'string' && ERROR_CODE.test(row.update_error_code)
      ? row.update_error_code : null,
  };
}

/** step 70's columns, for a select beside a device's own. */
export const AGENT_UPDATE_COLUMNS = 'update_target_version,update_requested_at,update_state,update_state_at,update_error_code';
