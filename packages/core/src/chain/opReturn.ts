import type { ChainTxDetail, ChainTxSummary, ChainTxVout } from "./types.js";

export const OP_RETURN_PAYLOAD_MAX_BYTES = 80;
export const OP_RETURN_STORE_MAX_BYTES = 512;
export const OP_RETURN_GRAPH_LABEL_MAX_CHARS = 48;

const PRINTABLE_UNICODE =
  /^[\t\n\r\x20-\x7E\u00A0-\uD7FF\uE000-\uFFFD]*$/;

const HEX_ONLY = /^[0-9a-fA-F]+$/;

/** Windows-1252 bytes 0x80-0x9F that differ from Latin-1 / ISO-8859-1. */
const WIN1252_SPECIAL: Record<number, string> = {
  0x80: "\u20AC",
  0x82: "\u201A",
  0x83: "\u0192",
  0x84: "\u201E",
  0x85: "\u2026",
  0x86: "\u2020",
  0x87: "\u2021",
  0x88: "\u02C6",
  0x89: "\u2030",
  0x8a: "\u0160",
  0x8b: "\u2039",
  0x8c: "\u0152",
  0x8e: "\u017D",
  0x91: "\u2018",
  0x92: "\u2019",
  0x93: "\u201C",
  0x94: "\u201D",
  0x95: "\u2022",
  0x96: "\u2013",
  0x97: "\u2014",
  0x98: "\u02DC",
  0x99: "\u2122",
  0x9a: "\u0161",
  0x9b: "\u203A",
  0x9c: "\u0153",
  0x9e: "\u017E",
  0x9f: "\u0178",
};

export interface ChainTxVoutScript extends ChainTxVout {
  scriptpubkey_type?: string;
  scriptpubkey_asm?: string;
  scriptpubkey?: string;
}

export type ChainTxWithScriptVout = ChainTxSummary & {
  vout?: ChainTxVoutScript[];
};

function bytesFromHex(hex: string): Uint8Array | null {
  const normalized = hex.replace(/\s+/g, "").toLowerCase();
  if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/.test(normalized)) {
    return null;
  }
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function parseOpReturnPayloadFromAsm(asm: string): Uint8Array | null {
  const trimmed = asm.trim();
  if (!/^OP_RETURN\b/i.test(trimmed)) return null;
  const rest = trimmed.replace(/^OP_RETURN\b/i, "").trim();
  if (!rest) return new Uint8Array(0);
  return bytesFromHex(rest);
}

/** Parse payload bytes from raw scriptpubkey hex (6a <push> <data>). */
export function parseOpReturnPayloadFromScript(scriptHex: string): Uint8Array | null {
  const script = bytesFromHex(scriptHex);
  if (!script || script.length < 1 || script[0] !== 0x6a) return null;

  let offset = 1;
  if (offset >= script.length) return new Uint8Array(0);

  const op = script[offset]!;
  let dataLen = 0;
  if (op >= 0x01 && op <= 0x4b) {
    dataLen = op;
    offset += 1;
  } else if (op === 0x4c) {
    if (offset + 1 >= script.length) return null;
    dataLen = script[offset + 1]!;
    offset += 2;
  } else if (op === 0x4d) {
    if (offset + 2 >= script.length) return null;
    dataLen = script[offset + 1]! | (script[offset + 2]! << 8);
    offset += 3;
  } else if (op === 0x4e) {
    if (offset + 4 >= script.length) return null;
    dataLen =
      script[offset + 1]! |
      (script[offset + 2]! << 8) |
      (script[offset + 3]! << 16) |
      (script[offset + 4]! << 24);
    offset += 5;
  } else {
    return new Uint8Array(0);
  }

  if (dataLen < 0 || offset + dataLen > script.length) return null;
  return script.slice(offset, offset + dataLen);
}

function payloadBytesFromVout(vout: ChainTxVoutScript): Uint8Array | null {
  if (vout.scriptpubkey_type !== "op_return" && vout.scriptpubkey_type !== "nulldata") {
    return null;
  }
  if (vout.scriptpubkey_asm) {
    const fromAsm = parseOpReturnPayloadFromAsm(vout.scriptpubkey_asm);
    if (fromAsm) return capPayloadBytes(fromAsm);
  }
  if (vout.scriptpubkey) {
    const fromScript = parseOpReturnPayloadFromScript(vout.scriptpubkey);
    if (fromScript) return capPayloadBytes(fromScript);
  }
  return new Uint8Array(0);
}

function capPayloadBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length <= OP_RETURN_PAYLOAD_MAX_BYTES) return bytes;
  return bytes.slice(0, OP_RETURN_PAYLOAD_MAX_BYTES);
}

function stripUtf8Bom(bytes: Uint8Array): Uint8Array {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.slice(3);
  }
  return bytes;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text;
  } catch {
    return null;
  }
}

function decodeUtf16(bytes: Uint8Array, le: boolean): string | null {
  if (bytes.length < 2 || bytes.length % 2 !== 0) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const codeUnits: number[] = [];
  for (let i = 0; i < bytes.length; i += 2) {
    codeUnits.push(le ? view.getUint16(i, true) : view.getUint16(i, false));
  }
  if (codeUnits.some((c) => c === 0xfffd)) return null;
  try {
    return String.fromCharCode(...codeUnits);
  } catch {
    return null;
  }
}

function decodeWindows1252(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    if (byte <= 0x7f || (byte >= 0xa0 && byte <= 0xff)) {
      out += String.fromCharCode(byte);
    } else {
      out += WIN1252_SPECIAL[byte] ?? String.fromCharCode(byte);
    }
  }
  return out;
}

function printableRatio(text: string): number {
  if (!text.length) return 0;
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0x10ffff)) {
      if (ch !== "\uFFFD") printable++;
    }
  }
  return printable / text.length;
}

export function passesHumanReadableQuality(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 2) return false;
  if (trimmed.includes("\uFFFD")) return false;
  if (!PRINTABLE_UNICODE.test(trimmed)) return false;
  if (printableRatio(trimmed) < 0.85) return false;
  const compact = trimmed.replace(/\s+/g, "");
  if (compact.length >= 32 && HEX_ONLY.test(compact)) return false;
  return true;
}

function looksLikeUtf16LeText(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return false;
  let asciiPairs = 0;
  const pairs = bytes.length / 2;
  for (let i = 0; i < bytes.length; i += 2) {
    const lo = bytes[i]!;
    const hi = bytes[i + 1]!;
    if (hi === 0 && lo >= 0x20 && lo <= 0x7e) asciiPairs++;
  }
  return asciiPairs / pairs >= 0.8;
}

function looksLikeUtf16BeText(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return false;
  let asciiPairs = 0;
  const pairs = bytes.length / 2;
  for (let i = 0; i < bytes.length; i += 2) {
    const hi = bytes[i]!;
    const lo = bytes[i + 1]!;
    if (lo === 0 && hi >= 0x20 && hi <= 0x7e) asciiPairs++;
  }
  return asciiPairs / pairs >= 0.8;
}

function decodeHumanReadableFromBytes(bytes: Uint8Array): string | null {
  if (bytes.length === 0) return null;

  const utf8 = decodeUtf8(stripUtf8Bom(bytes));
  if (utf8 != null && passesHumanReadableQuality(utf8)) return utf8.trim();

  if (bytes.length >= 2) {
    const leBom = bytes[0] === 0xff && bytes[1] === 0xfe;
    const beBom = bytes[0] === 0xfe && bytes[1] === 0xff;
    if (leBom || beBom) {
      const body = bytes.slice(2);
      const utf16 = decodeUtf16(body, leBom);
      if (utf16 != null && passesHumanReadableQuality(utf16)) return utf16.trim();
    } else if (bytes.length % 2 === 0 && bytes.length >= 4) {
      if (looksLikeUtf16LeText(bytes)) {
        const asLe = decodeUtf16(bytes, true);
        if (asLe != null && passesHumanReadableQuality(asLe)) return asLe.trim();
      }
      if (looksLikeUtf16BeText(bytes)) {
        const asBe = decodeUtf16(bytes, false);
        if (asBe != null && passesHumanReadableQuality(asBe)) return asBe.trim();
      }
    }
  }

  const win1252 = decodeWindows1252(bytes);
  if (passesHumanReadableQuality(win1252)) return win1252.trim();

  return null;
}

export function decodeOpReturnPayload(bytes: Uint8Array): string | null {
  return decodeHumanReadableFromBytes(capPayloadBytes(bytes));
}

export function extractOpReturnDisplay(tx: ChainTxWithScriptVout): string {
  const segments: string[] = [];
  for (const vout of tx.vout ?? []) {
    const payload = payloadBytesFromVout(vout);
    if (payload == null) continue;
    const text = decodeOpReturnPayload(payload);
    if (text) segments.push(text);
  }
  if (segments.length === 0) return "";
  return capStoredDisplay(segments.join(" · "));
}

export function capStoredDisplay(text: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= OP_RETURN_STORE_MAX_BYTES) return text;
  let end = OP_RETURN_STORE_MAX_BYTES;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.slice(0, end));
}

export function truncateOpReturnGraphLabel(
  text: string,
  maxChars = OP_RETURN_GRAPH_LABEL_MAX_CHARS,
): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

export function txHasOpReturnScriptFields(tx: ChainTxWithScriptVout): boolean {
  return (tx.vout ?? []).some(
    (v) =>
      v.scriptpubkey_type === "op_return" ||
      v.scriptpubkey_type === "nulldata" ||
      Boolean(v.scriptpubkey_asm?.toUpperCase().includes("OP_RETURN")) ||
      Boolean(v.scriptpubkey?.startsWith("6a")),
  );
}
