/** Keep in sync with SOURCE_LABELS in apps/web/src/lib/hackerGroups.ts */
export const KNOWN_HACKER_SOURCES: Record<string, string> = {
  coldcardwatch: "coldcardwatch.com",
  coldcard_sweep_watch: "Coldcard Sweep Watch",
  coldcard_hack_tracker: "Coldcard Hack Tracker",
  public_seed: "Public seed list",
  local_config: "Local config",
  admin: "Manual",
  ops: "Ops CLI",
};

export function resolveHackerSourceFlag(raw?: string): string {
  const trimmed = raw?.trim();
  if (trimmed === undefined || trimmed === "") return "ops";
  return trimmed;
}

export function isKnownHackerSource(source: string): boolean {
  return source in KNOWN_HACKER_SOURCES;
}

export function formatKnownHackerSourcesList(): string {
  const lines = Object.entries(KNOWN_HACKER_SOURCES)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, label]) => `  ${key.padEnd(24)} ${label}`);
  return ["Known hacker source categories:", ...lines].join("\n");
}

export async function confirmUnknownHackerSource(opts: {
  source: string;
  ask: (question: string) => Promise<string>;
  isTty: boolean;
  logWarn: (message: string) => void;
}): Promise<boolean> {
  opts.logWarn(`Source "${opts.source}" does not match a known category.`);
  opts.logWarn(formatKnownHackerSourcesList());

  if (!opts.isTty) {
    opts.logWarn("Non-interactive stdin — aborting. Pass --yes to use an unknown source.");
    return false;
  }

  const answer = (await opts.ask(`Use source "${opts.source}" anyway? [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}
