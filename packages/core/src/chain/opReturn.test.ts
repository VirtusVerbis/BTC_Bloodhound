import { describe, expect, it } from "vitest";
import {
  capStoredDisplay,
  decodeOpReturnPayload,
  extractOpReturnDisplay,
  parseOpReturnPayloadFromAsm,
  parseOpReturnPayloadFromScript,
  passesHumanReadableQuality,
  truncateOpReturnGraphLabel,
} from "./opReturn.js";

function hexUtf8(text: string): string {
  return Buffer.from(text, "utf8").toString("hex");
}

describe("opReturn", () => {
  it("parses OP_RETURN asm hex", () => {
    const bytes = parseOpReturnPayloadFromAsm("OP_RETURN 48656c6c6f");
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).toString("utf8")).toBe("Hello");
  });

  it("parses scriptpubkey push payload", () => {
    const script = `6a${(5).toString(16).padStart(2, "0")}${hexUtf8("Hello")}`;
    const bytes = parseOpReturnPayloadFromScript(script);
    expect(bytes).not.toBeNull();
    expect(Buffer.from(bytes!).toString("utf8")).toBe("Hello");
  });

  it("decodes UTF-8 human-readable text", () => {
    expect(decodeOpReturnPayload(Buffer.from("pay me", "utf8"))).toBe("pay me");
  });

  it("rejects hex-hash-only payloads", () => {
    const hash = "a".repeat(64);
    expect(passesHumanReadableQuality(hash)).toBe(false);
  });

  it("rejects binary-only payloads", () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 4, 5]);
    expect(decodeOpReturnPayload(bytes)).toBeNull();
  });

  it("joins multiple readable OP_RETURN outputs", () => {
    const tx = {
      txid: "abc",
      vout: [
        {
          scriptpubkey_type: "op_return",
          scriptpubkey_asm: `OP_RETURN ${hexUtf8("note one")}`,
        },
        {
          scriptpubkey_type: "op_return",
          scriptpubkey_asm: `OP_RETURN ${hexUtf8("note two")}`,
        },
      ],
    };
    expect(extractOpReturnDisplay(tx)).toBe("note one · note two");
  });

  it("returns empty string when no readable text", () => {
    const tx = {
      txid: "abc",
      vout: [
        {
          scriptpubkey_type: "op_return",
          scriptpubkey_asm: "OP_RETURN 000102030405060708090a0b0c0d0e0f10",
        },
      ],
    };
    expect(extractOpReturnDisplay(tx)).toBe("");
  });

  it("caps stored display bytes", () => {
    const long = "x".repeat(600);
    expect(new TextEncoder().encode(capStoredDisplay(long)).length).toBeLessThanOrEqual(512);
  });

  it("truncates graph labels", () => {
    const label = truncateOpReturnGraphLabel("abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOP");
    expect(label.length).toBeLessThanOrEqual(48);
    expect(label.endsWith("…")).toBe(true);
  });
});
