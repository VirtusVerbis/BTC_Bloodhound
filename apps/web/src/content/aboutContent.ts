export interface ExternalLink {
  label: string;
  url: string;
  description?: string;
}

export interface ApiReference {
  name: string;
  baseUrl: string;
  docsUrl: string;
}

export interface KeyboardCommand {
  key: string;
  description: string;
}

export const disclaimerItems = [
  "This website is for visual reference only and does not guarantee any accuracy whatsoever.",
  "Data is scraped and aggregated from public web sources.",
  "The purpose of this project is to track where Coldcard-hacked bitcoin went.",
];

export const purposeText =
  "Bitcoin Bloodhound maps consolidation addresses, victim inputs, and downstream flows from the 2026 Coldcard entropy exploit. It is an exploratory on-chain visualization tool, not a forensic or legal record.";

export const keyboardCommands: KeyboardCommand[] = [
  { key: "[", description: "Zoom out the graph." },
  { key: "]", description: "Zoom in the graph." },
  { key: "Page Up", description: "Select the previous hacker in the dropdown (stops at the top entry)." },
  { key: "Page Down", description: "Select the next hacker in the dropdown (stops at the bottom entry)." },
];

export const hackCoverageLinks: ExternalLink[] = [
  {
    label: "Coinkite — Coldcard Security Advisory",
    url: "https://blog.coinkite.com/coldcard-mk3-seed-generation-warning/",
  },
  {
    label: "Coinkite — Technical Deep Dive into the Entropy Issue",
    url: "https://blog.coinkite.com/entropy-technical-backgrounder/",
  },
  {
    label: "Rob Hamilton (X) — Urgent security advisory",
    url: "https://x.com/Rob1Ham/status/2083936334511538368",
  },
  {
    label: "Chainalysis (X) — Coldcard hack analysis",
    url: "https://x.com/chainalysis/status/2083258384396996713",
  },
  {
    label: "Calle (X) — Bitcoin Red Team post-incident security work",
    url: "https://x.com/callebtc/status/2085035257477190080",
  },
  {
    label: "Block Engineering — Predictable RNG fallback analysis",
    url: "https://engineering.block.xyz/blog/predictable-rng-fallback-and-32-bit-reseed-in-coldcard-firmware",
  },
];

export const dataSourceLinks: ExternalLink[] = [
  {
    label: "coldcardwatch.com",
    url: "https://coldcardwatch.com",
    description: "Collector and victim address lists synced periodically.",
  },
  {
    label: "Coldcard Sweep Watch",
    url: "https://coldcard-watch.vercel.app",
    description: "Wave 3 vault addresses and collector (“where the money is”) addresses synced periodically.",
  },
  {
    label: "Coldcard Hack Tracker",
    url: "https://coldcard-hack-tracker.vercel.app",
    description: "Watched holding/collector addresses from snapshot.json synced periodically.",
  },
  {
    label: "dsbaars gist — public hacker address seed list",
    url: "https://gist.github.com/dsbaars/0a4f9e2d1f587a78f4a89a9a45e3b700",
    description: "Initial consolidation addresses loaded at indexer seed time.",
  },
];

export const dataSourceNote =
  "The background indexer actively sources coldcardwatch.com, coldcard-watch.vercel.app, and coldcard-hack-tracker.vercel.app on a cron schedule. Additional victim and downstream addresses are inferred on-chain using blockchain API data.";

export const monitoredExternalSites = [
  { host: "coldcard-watch.vercel.app", label: "Coldcard Sweep Watch" },
  { host: "coldcard-hack-tracker.vercel.app", label: "Coldcard Hack Tracker" },
  { host: "coldcardwatch.com", label: "coldcardwatch.com" },
];

export const monitoringIntro =
  "A background indexer continuously polls blockchain APIs and public tracker sites. The header Monitoring indicator shows when activity was last observed — the most recent of a successful chain API response, an external tracker sync, or a completed indexer job.";

export const apiReferences: ApiReference[] = [
  {
    name: "Blockstream Esplora",
    baseUrl: "https://blockstream.info/api",
    docsUrl: "https://github.com/Blockstream/esplora/blob/master/API.md",
  },
  {
    name: "Mempool Space",
    baseUrl: "https://mempool.space/api",
    docsUrl: "https://mempool.space/docs/api/rest",
  },
];
