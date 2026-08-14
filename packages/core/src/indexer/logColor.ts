const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const MAGENTA = "\x1b[35m";
const BLUE = "\x1b[34m";
const BRIGHT_MAGENTA = "\x1b[95m";
const BRIGHT_CYAN = "\x1b[96m";
const BRIGHT_BLUE = "\x1b[94m";
const BRIGHT_GREEN = "\x1b[92m";
const BRIGHT_YELLOW = "\x1b[93m";
const GRAY = "\x1b[90m";

const ORANGE = "\x1b[38;5;208m";
const PURPLE = "\x1b[38;5;141m";
const WORK_CYAN = "\x1b[38;5;51m";
const LIME = "\x1b[38;5;118m";
const CORAL = "\x1b[38;5;203m";
const VIOLET = "\x1b[38;5;147m";
const GOLD = "\x1b[38;5;220m";
const TEAL = "\x1b[38;5;30m";
const SKY = "\x1b[38;5;39m";
const PINK = "\x1b[38;5;218m";
const BRIGHT_YELLOW_256 = "\x1b[38;5;229m";
const LAVENDER = "\x1b[38;5;183m";
const MINT = "\x1b[38;5;120m";
const AQUA = "\x1b[38;5;45m";
const CRON_SCHEDULE = "\x1b[38;5;214m";
const CRON_TICK_DONE = "\x1b[38;5;117m";

/** Longest prefix first so `[job] start` wins over `[job]`. */
const LINE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["[cron] schedule done", CRON_SCHEDULE],
  ["[cron] tick done", CRON_TICK_DONE],
  ["[job] start", CYAN],
  ["[job] done", GREEN],
  ["[job] fail", RED],
  ["[job] defer", YELLOW],
  ["[cron]", YELLOW],
];

const KEY_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["skipNonCritical=", GOLD],
  ["pendingTxidsCount=", BRIGHT_GREEN],
  ["processedIndex=", BRIGHT_YELLOW],
  ["traceEdgesPending=", LAVENDER],
  ["traceEdgeIndex=", LAVENDER],
  ["edgesApplied=", MINT],
  ["workSubreq=", AQUA],
  ["chainCursor=", GRAY],
  ["pagesExhausted=", BLUE],
  ["continuation=", BLUE],
  ["continued=", BLUE],
  ["subreq=", ORANGE],
  ["sched=", PURPLE],
  ["work=", WORK_CYAN],
  ["rem=", LIME],
  ["stop=", CORAL],
  ["processed=", VIOLET],
  ["ms=", GRAY],
  ["crawlEnq=", TEAL],
  ["pollEnq=", SKY],
  ["maint=", PINK],
  ["btc=", BRIGHT_YELLOW_256],
  ["traceEdge=", LAVENDER],
  ["id=", CYAN],
  ["type=", YELLOW],
  ["address=", MAGENTA],
  ["error=", RED],
  ["attempts=", BRIGHT_MAGENTA],
  ["reason=", BRIGHT_CYAN],
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
