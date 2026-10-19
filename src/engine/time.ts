/**
 * Time helpers for local-naive ISO strings (`YYYY-MM-DDTHH:MM:SS`).
 * Same-format strings compare lexicographically, so window checks use plain `<`/`>=`.
 */

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

/** `YYYY-MM-DD` + n days -> `YYYY-MM-DD`. */
export function addDays(dateOnly: string, days: number): string {
  const [y, m, d] = dateOnly.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Start-of-day ISO for a date-only string. */
export const dayStart = (dateOnly: string): string => `${dateOnly}T00:00:00`;

/** ISO at a given time on dateOnly + offset days. */
export function at(dateOnly: string, offDays: number, hh: number, mm = 0): string {
  return `${addDays(dateOnly, offDays)}T${pad(hh)}:${pad(mm)}:00`;
}

/** Minutes since midnight of an ISO timestamp. */
export function minutesOf(iso: string): number {
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
}

/** Epoch ms (UTC-interpreted) of a local-naive ISO. */
export function toMs(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) + minutesOf(iso) * 60_000;
}

export const hoursBetween = (s: string, e: string): number => (toMs(e) - toMs(s)) / 3_600_000;

export const daysBetween = (fromIso: string, toIso: string): number =>
  Math.floor((toMs(toIso) - toMs(fromIso)) / DAY_MS);

/** Half-open interval overlap on same-format ISO strings. */
export const overlaps = (aS: string, aE: string, bS: string, bE: string): boolean =>
  aS < bE && bS < aE;

/** 0 = Monday ... 6 = Sunday. */
export function weekdayOf(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number) as [number, number, number];
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}
