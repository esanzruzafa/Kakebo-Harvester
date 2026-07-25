export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function daysAgoIso(days: number, now = new Date()): string {
  const date = new Date(now);
  date.setUTCDate(date.getUTCDate() - days);
  return todayIso(date);
}

export function assertIsoDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} debe usar el formato YYYY-MM-DD.`);
  }
  return value;
}
