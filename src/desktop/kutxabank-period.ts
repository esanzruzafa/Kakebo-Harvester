export type KutxabankPeriod = "fifteen-days" | "today" | "week" | "month" | "between";

function iso(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function kutxabankPeriodDates(
  period: KutxabankPeriod,
  today: string,
  custom: { dateFrom: string; dateTo: string }
): { dateFrom: string; dateTo: string } {
  if (period === "between") return custom;
  const end = new Date(`${today}T00:00:00Z`);
  if (Number.isNaN(end.getTime()) || iso(end) !== today) throw new Error("INVALID_QUERY");
  const start = new Date(end);
  if (period === "month") {
    const day = start.getUTCDate();
    start.setUTCDate(1);
    start.setUTCMonth(start.getUTCMonth() - 1);
    const finalDay = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0)).getUTCDate();
    start.setUTCDate(Math.min(day, finalDay));
  } else {
    const days = period === "fifteen-days" ? 14 : period === "week" ? 6 : 0;
    start.setUTCDate(start.getUTCDate() - days);
  }
  return { dateFrom: iso(start), dateTo: iso(end) };
}
