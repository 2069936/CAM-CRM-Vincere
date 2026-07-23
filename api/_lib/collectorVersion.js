const VERSION_PATTERN = /^\d{1,5}(?:\.\d{1,5}){1,3}$/;

function hasControlCharacter(value) {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
}

export function normalizeCollectorVersion(value) {
  const normalized = String(value || '').trim();
  if (normalized.length > 23 || hasControlCharacter(normalized) || !VERSION_PATTERN.test(normalized)) {
    throw new Error('Invalid version.');
  }
  return normalized;
}

export function compareCollectorVersions(left, right) {
  const leftParts = normalizeCollectorVersion(left).split('.').map(Number);
  const rightParts = normalizeCollectorVersion(right).split('.').map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

export function requiresCollectorUpdate(agentVersion, minimumVersion) {
  if (!String(minimumVersion || '').trim()) return false;
  return compareCollectorVersions(agentVersion, minimumVersion) < 0;
}
