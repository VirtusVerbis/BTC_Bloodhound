import type { Hacker } from "./hackerGroups";

const STORAGE_KEY = "cointrace:hackerLastViewed";
const INIT_KEY = "cointrace:hackerLastViewed:initialized";

export type HackerLastViewedMap = Record<string, string>;

function readMap(): HackerLastViewedMap {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const out: HackerLastViewedMap = {};
    for (const [address, ts] of Object.entries(parsed)) {
      if (typeof ts === "string" && ts.length > 0) out[address] = ts;
    }
    return out;
  } catch {
    return {};
  }
}

function writeMap(map: HackerLastViewedMap): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(map));
}

export function hasHackerLastViewedState(): boolean {
  return localStorage.getItem(INIT_KEY) === "1";
}

export function getHackerLastViewedMap(): HackerLastViewedMap {
  return readMap();
}

export function seedLastViewedFromHackers(hackers: Hacker[]): void {
  const map: HackerLastViewedMap = {};
  const now = new Date().toISOString();
  for (const hacker of hackers) {
    map[hacker.address] = hacker.lastGraphActivityAt ?? now;
  }
  writeMap(map);
  localStorage.setItem(INIT_KEY, "1");
}

/** After baseline, seed newly appeared hackers without marking them unread. */
export function syncNewHackersLastViewed(hackers: Hacker[]): void {
  if (!hasHackerLastViewedState()) return;
  const map = readMap();
  let changed = false;
  const now = new Date().toISOString();
  for (const hacker of hackers) {
    if (map[hacker.address]) continue;
    map[hacker.address] = hacker.lastGraphActivityAt ?? now;
    changed = true;
  }
  if (changed) writeMap(map);
}

export function markHackerViewed(address: string, at?: string): void {
  if (!address) return;
  const map = readMap();
  map[address] = at ?? new Date().toISOString();
  writeMap(map);
  if (!localStorage.getItem(INIT_KEY)) {
    localStorage.setItem(INIT_KEY, "1");
  }
}

/** For tests — reset stored state. */
export function clearHackerLastViewedForTests(): void {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(INIT_KEY);
}
