export interface Hacker {
  address: string;
  label: string | null;
  source: string;
  totalReceivedSats: number;
}

export interface HackerGroup {
  source: string;
  label: string;
  totalReceivedSats: number;
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

export function formatSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
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
