export const HACKS = [
  { id: "coldcard", label: "Coldcard", order: 0 },
  { id: "liquid", label: "Liquid", order: 1 },
] as const;

export type HackId = (typeof HACKS)[number]["id"];

export const DEFAULT_HACK_ID: HackId = "coldcard";

const HACK_IDS = new Set<string>(HACKS.map((h) => h.id));

export function isKnownHackId(id: string): boolean {
  return HACK_IDS.has(id);
}

export function resolveHackId(raw?: string | null): HackId {
  const trimmed = raw?.trim();
  if (trimmed && isKnownHackId(trimmed)) return trimmed as HackId;
  return DEFAULT_HACK_ID;
}

export function formatKnownHacksList(): string {
  const lines = HACKS.map((h) => `  ${h.id.padEnd(12)} ${h.label}`);
  return ["Known hack categories:", ...lines].join("\n");
}

export function hackLabel(id: HackId): string {
  return HACKS.find((h) => h.id === id)?.label ?? id;
}
