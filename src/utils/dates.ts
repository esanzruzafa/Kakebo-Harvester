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

export function daysBeforeIso(value: string, days: number): string {
  const date = new Date(`${assertIsoDate(value, "date")}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - days);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) {
    throw new Error(`${label} debe usar el formato YYYY-MM-DD.`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${label} debe indicar una fecha real en formato YYYY-MM-DD.`);
  }
  return value;
}
