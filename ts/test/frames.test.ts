import { describe, expect, it } from "vitest";
import {
  classifyBinary,
  decodeFrame,
  decodeResize,
  encodeFrame,
  encodeResize,
  encodeRevisionFrame,
  Opcode,
  shouldDrop,
  splitRevision,
} from "../src/frames";
import { encodeOfferUrl, parseOfferUrl } from "../src/offer";
import type { ConnectionOffer } from "../src/messages";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("terminal frames", () => {
  it("roundtrips input frame", () => {
    const d = decodeFrame(encodeFrame(Opcode.Input, 3, enc("abc")));
    expect([d.opcode, d.slot, dec(d.payload)]).toEqual([Opcode.Input, 3, "abc"]);
  });
  it("roundtrips revision frame", () => {
    const d = decodeFrame(encodeRevisionFrame(Opcode.Output, 1, 42n, enc("hello")));
    const { revision, data } = splitRevision(d.payload);
    expect(revision).toBe(42n);
    expect(dec(data)).toBe("hello");
  });
  it("roundtrips resize", () => {
    const d = decodeFrame(encodeResize(0, { cols: 120, rows: 40 }));
    expect(decodeResize(d.payload)).toEqual({ cols: 120, rows: 40 });
  });
  it("revision dedup", () => {
    expect(shouldDrop(5n, 10n)).toBe(true);
    expect(shouldDrop(10n, 10n)).toBe(true);
    expect(shouldDrop(11n, 10n)).toBe(false);
  });
  it("classifies binary frames", () => {
    expect(classifyBinary(new Uint8Array([0x00, 1]))).toBe("cipher");
    expect(classifyBinary(encodeFrame(Opcode.Output, 0, new Uint8Array()))).toBe("terminal");
    expect(() => classifyBinary(new Uint8Array())).toThrow();
  });
});

describe("offer url", () => {
  it("roundtrips", () => {
    const offer: ConnectionOffer = {
      v: 1,
      serverId: "s",
      hostName: "H",
      hostPublicKeyB64: "AAAA",
      lan: { host: "1.2.3.4", port: 6767 },
    };
    const url = encodeOfferUrl(offer);
    expect(url.startsWith("htybox://pair#offer=")).toBe(true);
    expect(parseOfferUrl(url)).toEqual(offer);
    expect(() => parseOfferUrl("nope")).toThrow();
  });
});
