/** July 30, 2026 at local midnight — anchor for hack elapsed label. */
export const HACK_START_DATE = new Date(2026, 6, 30);

const SUFFIX = "since July 30, 2026";

export interface CalendarYMD {
  years: number;
  months: number;
  days: number;
}

export function diffCalendarYMD(from: Date, to: Date): CalendarYMD {
  let years = to.getFullYear() - from.getFullYear();
  let months = to.getMonth() - from.getMonth();
  let days = to.getDate() - from.getDate();

  if (days < 0) {
    months--;
    days += new Date(to.getFullYear(), to.getMonth(), 0).getDate();
  }
  if (months < 0) {
    years--;
    months += 12;
  }

  return { years, months, days };
}

function pluralUnit(value: number, singular: string): string {
  return value === 1 ? `1 ${singular}` : `${value} ${singular}s`;
}

export function formatHackElapsed(now = new Date()): string {
  if (now < HACK_START_DATE) {
    return `0 Days ${SUFFIX}`;
  }

  const { years, months, days } = diffCalendarYMD(HACK_START_DATE, now);
  const parts: string[] = [];

  if (years >= 1) parts.push(pluralUnit(years, "Year"));
  if (months >= 1) parts.push(pluralUnit(months, "Month"));
  parts.push(pluralUnit(days, "Day"));

  return `${parts.join(" ")} ${SUFFIX}`;
}
