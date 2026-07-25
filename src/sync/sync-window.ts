import { assertIsoDate, daysAgoIso, todayIso } from "../utils/dates.js";

export function getSyncWindow(
  lookbackDays: number,
  dateFrom?: string,
  dateTo?: string
): { dateFrom: string; dateTo: string } {
  const resolvedTo = dateTo ? assertIsoDate(dateTo, "--to") : todayIso();
  const resolvedFrom = dateFrom
    ? assertIsoDate(dateFrom, "--from")
    : daysAgoIso(lookbackDays);
  if (resolvedFrom > resolvedTo) {
    throw new Error("--from no puede ser posterior a --to.");
  }
  return { dateFrom: resolvedFrom, dateTo: resolvedTo };
}
