export function todayIso(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function daysAgoIso(days: number, now = new Date()): string {
  const date = new Date(now);
  date.setDate(date.getDate() - days);
  return todayIso(date);
}

export function monthsAgoIso(months: number, now = new Date()): string {
  const date = new Date(now);
  const originalDay = date.getDate();
  date.setDate(1);
  date.setMonth(date.getMonth() - months);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(originalDay, lastDay));
  return todayIso(date);
}

export function assertIsoDate(value: string, label: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
    throw new Error(`${label} debe usar el formato YYYY-MM-DD.`);
  }
  return value;
}
