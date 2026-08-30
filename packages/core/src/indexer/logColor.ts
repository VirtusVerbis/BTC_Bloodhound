const RESET = "\x1b[0m";
const WHITE = "\x1b[97m";
const GRAY = "\x1b[90m";
const RED = "\x1b[31m";

export type IndexerLogColorMode = "default" | "sidecar";

/** Longest prefix first so `[job] start` wins over `[job]`. */
const LINE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ["[cron] schedule done", "\x1b[38;5;214m"],
  ["[cron] tick done", "\x1b[38;5;117m"],
  ["[cron] tick plan", "\x1b[38;5;214m"],
  ["[job] start", "\x1b[36m"],
  ["[job] done", "\x1b[32m"],
  ["[job] fail", RED],
  ["[job] defer", "\x1b[33m"],
  ["[cron]", "\x1b[33m"],
];

const KEY_LABELS: ReadonlyArray<readonly [string, string]> = [
  ["jobsCapReason=", "\x1b[38;5;220m"],
  ["headWeight=", "\x1b[96m"],
  ["pairable=", "\x1b[38;5;30m"],
  ["slot=", "\x1b[38;5;39m"],
  ["weight=", "\x1b[38;5;208m"],
  ["phase=", "\x1b[38;5;141m"],
  ["skipNonCritical=", "\x1b[38;5;220m"],
  ["pendingTxidsCount=", "\x1b[92m"],
  ["processedIndex=", "\x1b[93m"],
  ["traceEdgesPending=", "\x1b[38;5;183m"],
  ["traceEdgeIndex=", "\x1b[38;5;183m"],
  ["edgesApplied=", "\x1b[38;5;120m"],
  ["workSubreq=", "\x1b[38;5;45m"],
  ["chainCursor=", GRAY],
  ["pagesExhausted=", "\x1b[34m"],
  ["continuation=", "\x1b[34m"],
  ["continued=", "\x1b[34m"],
  ["subreq=", "\x1b[38;5;208m"],
  ["sched=", "\x1b[38;5;141m"],
  ["work=", "\x1b[38;5;51m"],
  ["rem=", "\x1b[38;5;118m"],
  ["stop=", "\x1b[38;5;203m"],
  ["processed=", "\x1b[38;5;147m"],
  ["ms=", GRAY],
  ["crawlEnq=", "\x1b[38;5;30m"],
  ["pollEnq=", "\x1b[38;5;39m"],
  ["maint=", "\x1b[38;5;218m"],
  ["btc=", "\x1b[38;5;229m"],
  ["traceEdge=", "\x1b[38;5;183m"],
  ["id=", "\x1b[36m"],
  ["type=", "\x1b[33m"],
  ["address=", "\x1b[35m"],
  ["error=", RED],
  ["attempts=", "\x1b[95m"],
  ["reason=", "\x1b[96m"],
  ["duration=", "\x1b[32m"],
  ["queue=", "\x1b[94m"],
];

const SIDECAR_ERROR_PREFIXES = ["[job] fail", "[job] defer", "[sidecar] error"] as const;

const SIDECAR_LINE_PREFIXES: ReadonlyArray<string> = [
  "[cron] schedule done",
  "[cron] tick done",
  "[cron] tick plan",
  "[cron] tick skipped d1_quota",
  "[cron] tick start",
  "[cron] schedule done",
  "[job] start",
  "[job] done",
  "[sidecar] heartbeat",
  "[sidecar] remote D1 connected",
  "[sidecar] tick lease cleared",
  "[cron]",
  "[sidecar]",
];

function colorToken(text: string, token: string, color: string): string {
  if (!text.includes(token)) return text;
  return text.split(token).join(`${color}${token}${RESET}`);
}

function colorizeNormalTokens(rest: string): string {
  if (!rest) return rest;
  const tokens = rest.trimStart().split(/ +/);
  let out = rest.startsWith(" ") ? " " : "";
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (i > 0) out += " ";
    const eq = tok.indexOf("=");
    if (eq < 0) {
      out += `${WHITE}${tok}${RESET}`;
      continue;
    }
    const label = tok.slice(0, eq + 1);
    const value = tok.slice(eq + 1);
    out += `${WHITE}${label}${RESET}${GRAY}${value}${RESET}`;
  }
  return out;
}

function colorizeRestKeyValues(rest: string, errorLine: boolean): string {
  if (!rest) return rest;
  if (errorLine) {
    const errorIdx = rest.indexOf("error=");
    if (errorIdx >= 0) {
      const before = rest.slice(0, errorIdx);
      const errorPart = rest.slice(errorIdx);
      return colorizeNormalTokens(before) + `${RED}${errorPart}${RESET}`;
    }
  }
  return colorizeNormalTokens(rest);
}

export function colorizeSidecarLogLine(line: string): string {
  for (const prefix of SIDECAR_ERROR_PREFIXES) {
    if (line.startsWith(prefix)) {
      const rest = line.slice(prefix.length);
      if (prefix === "[sidecar] error") {
        return `${RED}${prefix}${rest}${RESET}`;
      }
      return `${RED}${prefix}${RESET}${colorizeRestKeyValues(rest, true)}`;
    }
  }

  for (const prefix of SIDECAR_LINE_PREFIXES) {
    if (line.startsWith(prefix)) {
      const rest = line.slice(prefix.length);
      return `${WHITE}${prefix}${RESET}${colorizeRestKeyValues(rest, false)}`;
    }
  }

  return colorizeRestKeyValues(line, false);
}

export function colorizeIndexerLogLine(
  line: string,
  enabled: boolean,
  mode: IndexerLogColorMode = "default",
): string {
  if (!enabled) return line;
  if (mode === "sidecar") return colorizeSidecarLogLine(line);

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
