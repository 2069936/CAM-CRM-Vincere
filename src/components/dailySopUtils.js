export function getStreak() {
  try {
    const raw = localStorage.getItem('cam-sop-streak');
    return raw ? JSON.parse(raw) : { count: 0, lastDate: '' };
  } catch { return { count: 0, lastDate: '' }; }
}

export function prevTradingDay(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  do { d.setDate(d.getDate() - 1); } while ([0, 6].includes(d.getDay()));
  return d.toISOString().slice(0, 10);
}

export function computeNewStreak(today, currentStreak, wasComplete, isNowComplete) {
  if (!isNowComplete || wasComplete) return currentStreak;
  const prev = prevTradingDay(today);
  const newCount = currentStreak.lastDate === prev ? currentStreak.count + 1 : 1;
  return { count: newCount, lastDate: today };
}

