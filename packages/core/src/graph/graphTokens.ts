export interface L1CursorPayload {
  amountSats: number;
  toAddress: string;
}

export interface L2TokenPayload {
  hacker: string;
  parents: string[];
  minEdgeSats: number;
  maxPerParent: number;
  graphBundleMinEdges: number;
  maxGraphDepth: number;
}

export interface L2CursorPayload {
  parentIndex: number;
  amountSats: number;
  toAddress: string;
}

function encodeBase64Url(value: unknown): string {
  const json = JSON.stringify(value);
  if (typeof Buffer !== "undefined") {
    return Buffer.from(json, "utf8").toString("base64url");
  }
  const bytes = new TextEncoder().encode(json);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeBase64Url<T>(token: string): T | null {
  try {
    let b64 = token.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) b64 += "=";
    let json: string;
    if (typeof Buffer !== "undefined") {
      json = Buffer.from(b64, "base64").toString("utf8");
    } else {
      const binary = atob(b64);
      const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
      json = new TextDecoder().decode(bytes);
    }
    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

export function encodeL1Cursor(payload: L1CursorPayload): string {
  return encodeBase64Url(payload);
}

export function decodeL1Cursor(token: string): L1CursorPayload | null {
  const parsed = decodeBase64Url<L1CursorPayload>(token);
  if (
    !parsed ||
    !Number.isFinite(parsed.amountSats) ||
    !isNonEmptyString(parsed.toAddress)
  ) {
    return null;
  }
  return { amountSats: Math.floor(parsed.amountSats), toAddress: parsed.toAddress };
}

export function encodeL2Token(payload: L2TokenPayload): string {
  return encodeBase64Url(payload);
}

export function decodeL2Token(token: string): L2TokenPayload | null {
  const parsed = decodeBase64Url<L2TokenPayload>(token);
  if (
    !parsed ||
    !isNonEmptyString(parsed.hacker) ||
    !Array.isArray(parsed.parents) ||
    !Number.isFinite(parsed.minEdgeSats) ||
    !Number.isFinite(parsed.maxPerParent) ||
    !Number.isFinite(parsed.graphBundleMinEdges) ||
    !Number.isFinite(parsed.maxGraphDepth)
  ) {
    return null;
  }
  return {
    hacker: parsed.hacker,
    parents: parsed.parents.filter(isNonEmptyString),
    minEdgeSats: Math.max(0, Math.floor(parsed.minEdgeSats)),
    maxPerParent: Math.max(1, Math.floor(parsed.maxPerParent)),
    graphBundleMinEdges: Math.max(1, Math.floor(parsed.graphBundleMinEdges)),
    maxGraphDepth: Math.max(1, Math.floor(parsed.maxGraphDepth)),
  };
}

export function encodeL2Cursor(payload: L2CursorPayload): string {
  return encodeBase64Url(payload);
}

export function decodeL2Cursor(token: string): L2CursorPayload | null {
  const parsed = decodeBase64Url<L2CursorPayload>(token);
  if (
    !parsed ||
    !Number.isFinite(parsed.parentIndex) ||
    !Number.isFinite(parsed.amountSats) ||
    !isNonEmptyString(parsed.toAddress)
  ) {
    return null;
  }
  return {
    parentIndex: Math.max(0, Math.floor(parsed.parentIndex)),
    amountSats: Math.floor(parsed.amountSats),
    toAddress: parsed.toAddress,
  };
}
