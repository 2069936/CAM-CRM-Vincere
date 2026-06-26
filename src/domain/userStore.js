const USERS_KEY = 'cam_crm_users_v1';

export const USER_ROLES = {
  MANAGER: 'Manager',
  CAM: 'CAM',
};

const DEFAULT_USERS = [
  { id: 'user-manager', username: 'manager', password: 'demo', role: USER_ROLES.MANAGER, displayName: 'Manager', email: 'manager@vinceretrading.com', camProfileId: null },
  { id: 'user-pedro', username: 'pedro', password: 'pedro123', role: USER_ROLES.CAM, displayName: 'Pedro', email: 'pedro@vinceretrading.com', camProfileId: 'am-pedro' },
  { id: 'user-amanda', username: 'amanda', password: 'amanda123', role: USER_ROLES.CAM, displayName: 'Amanda', email: 'amanda@vinceretrading.com', camProfileId: 'am-amanda' },
  { id: 'user-juan', username: 'juan', password: 'juan123', role: USER_ROLES.CAM, displayName: 'Juan Pablo', email: 'juan@vinceretrading.com', camProfileId: 'am-juan' },
  { id: 'user-ed', username: 'ed', password: 'ed123', role: USER_ROLES.CAM, displayName: 'Ed', email: 'ed@vinceretrading.com', camProfileId: 'am-ed' },
  { id: 'user-sarah', username: 'sarah', password: 'sarah123', role: USER_ROLES.CAM, displayName: 'Sarah', email: 'sarah@vinceretrading.com', camProfileId: 'am-sarah' },
];

export function loadUsers() {
  if (typeof window === 'undefined') return DEFAULT_USERS;
  try {
    const raw = window.localStorage.getItem(USERS_KEY);
    if (!raw) return DEFAULT_USERS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || !parsed.length) return DEFAULT_USERS;
    return parsed;
  } catch {
    return DEFAULT_USERS;
  }
}

export function saveUsers(users) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(USERS_KEY, JSON.stringify(users));
}

export function authenticateUser(username, password, users) {
  const user = users.find(
    (u) => u.username.toLowerCase() === username.toLowerCase() && u.password === password,
  ) || null;
  if (user) {
    const updated = users.map(u => u.id === user.id ? { ...u, lastActiveAt: new Date().toISOString() } : u);
    saveUsers(updated);
  }
  return user;
}

export function addUser(users, userData) {
  if (!userData.username?.trim()) return users;
  const duplicate = users.some(u => u.username.toLowerCase() === userData.username.toLowerCase());
  if (duplicate) return users;
  const id = `user-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return [...users, { ...userData, id }];
}

export function updateUser(users, userId, patch) {
  return users.map((u) => (u.id === userId ? { ...u, ...patch } : u));
}

export function deleteUser(users, userId) {
  return users.filter((u) => u.id !== userId);
}
