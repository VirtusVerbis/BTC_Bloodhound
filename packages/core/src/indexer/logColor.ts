const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
const BRIGHT_MAGENTA = "\x1b[95m";
const BRIGHT_BLUE = "\x1b[94m";

/** Longest prefix first so `[job] start` wins over `[job]`. */
const LINE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["[job] start", CYAN],
  ["[job] done", GREEN],
  ["[job] fail", RED],
  ["[job] defer", YELLOW],
  ["[cron]", YELLOW],
];

const KEY_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["id=", CYAN],
  ["type=", YELLOW],
  ["address=", MAGENTA],
  ["continuation=", BLUE],
  ["error=", RED],
  ["attempts=", BRIGHT_MAGENTA],
  ["duration=", GREEN],
  ["queue=", BRIGHT_BLUE],
];

function colorToken(text: string, token: string, color: string): string {
  if (!text.includes(token)) return text;
  return text.split(token).join(`${color}${token}${RESET}`);
}

export function colorizeIndexerLogLine(line: string, enabled: boolean): string {
  if (!enabled) return line;

  let out = line;
  for (const [prefix, color] of LINE_PREFIXES) {
    if (out.startsWith(prefix)) {
      out = `${color}${prefix}${RESET}${out.slice(prefix.length)}`;
      break;
    }
  }
  for (const [label, color] of KEY_LABELS) {
    out = colorToken(out, label, color);
  }
  return out;
}
