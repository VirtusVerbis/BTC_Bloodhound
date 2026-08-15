import { satsToBtc } from "./api";

export interface Hacker {
  address: string;
  label: string | null;
  source: string;
  totalReceivedSats: number;
  lastGraphActivityAt?: string | null;
  recentVictimCount?: number;
  recentDownstreamCount?: number;
}

export interface HackerGroup {
  source: string;
  label: string;
  totalReceivedSats: number;
  items: Hacker[];
}

export interface HackerDropdownGroup {
  source: string;
  label: string;
  items: Hacker[];
}

const SOURCE_LABELS: Record<string, string> = {
  coldcardwatch: "coldcardwatch.com",
  coldcard_sweep_watch: "Coldcard Sweep Watch",
  coldcard_hack_tracker: "Coldcard Hack Tracker",
  public_seed: "Public seed list",
  local_config: "Local config",
  admin: "Manual",
  ops: "Ops CLI",
};

const RECENT_GROUP_SOURCE = "__recent__";

export function formatSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

export function isHackerUnread(hacker: Hacker, lastViewedAt: string | undefined): boolean {
  if (!hacker.lastGraphActivityAt) return false;
  if (!lastViewedAt) return false;
  return hacker.lastGraphActivityAt > lastViewedAt;
}

function activitySuffix(hacker: Hacker): string {
  const victims = hacker.recentVictimCount ?? 0;
  const downstream = hacker.recentDownstreamCount ?? 0;
  if (victims === 0 && downstream === 0) return "";
  const parts: string[] = [];
  if (victims > 0) parts.push(`${victims} victim${victims === 1 ? "" : "s"}`);
  if (downstream > 0) parts.push(`${downstream} downstream`);
  return ` · ${parts.join(", ")}`;
}

export function formatHackerOptionLabel(hacker: Hacker, unread: boolean): string {
  const name = (hacker.label ?? hacker.address.slice(0, 12)) + "…";
  const btc = `(${satsToBtc(hacker.totalReceivedSats)} BTC)`;
  const suffix = unread ? activitySuffix(hacker) : "";
  return unread ? `● ${name} ${btc}${suffix}` : `${name} ${btc}`;
}

export function groupHackersBySource(hackers: Hacker[]): HackerGroup[] {
  const bySource = new Map<string, Hacker[]>();
  for (const h of hackers) {
    const src = h.source ?? "unknown";
    const bucket = bySource.get(src);
    if (bucket) bucket.push(h);
    else bySource.set(src, [h]);
  }

  const groups: HackerGroup[] = [];
  for (const [source, items] of bySource) {
    if (items.length === 0) continue;
    const sorted = [...items].sort((a, b) => b.totalReceivedSats - a.totalReceivedSats);
    const totalReceivedSats = sorted.reduce((sum, h) => sum + h.totalReceivedSats, 0);
    groups.push({
      source,
      label: formatSourceLabel(source),
      totalReceivedSats,
      items: sorted,
    });
  }

  groups.sort((a, b) => {
    if (b.totalReceivedSats !== a.totalReceivedSats) {
      return b.totalReceivedSats - a.totalReceivedSats;
    }
    return a.label.localeCompare(b.label);
  });

  return groups;
}

export function groupHackersForDropdown(
  hackers: Hacker[],
  lastViewedMap: Record<string, string>,
): HackerDropdownGroup[] {
  const unread = hackers
    .filter((h) => isHackerUnread(h, lastViewedMap[h.address]))
    .sort((a, b) => (b.lastGraphActivityAt ?? "").localeCompare(a.lastGraphActivityAt ?? ""));

  const unreadAddresses = new Set(unread.map((h) => h.address));
  const groups: HackerDropdownGroup[] = [];

  if (unread.length > 0) {
    groups.push({
      source: RECENT_GROUP_SOURCE,
      label: "Recently updated",
      items: unread,
    });
  }

  for (const group of groupHackersBySource(hackers)) {
    const items = group.items.filter((h) => !unreadAddresses.has(h.address));
    if (items.length === 0) continue;
    groups.push({
      source: group.source,
      label: group.label,
      items,
    });
  }

  return groups;
}
