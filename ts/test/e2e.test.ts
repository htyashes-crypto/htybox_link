import { describe, expect, it } from "vitest";
import { generateKeyPair, keyPairFromSecret, open, seal, sharedKey } from "../src/e2e";
import { classifyBinary, InnerKind, openFrame, sealFrame } from "../src/frames";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("e2e", () => {
  it("ecdh bidirectional seal/open", () => {
    const host = generateKeyPair();
    const client = generateKeyPair();
    const hostBox = sharedKey(client.publicKey, host.secretKey);
    const clientBox = sharedKey(host.publicKey, client.secretKey);
    expect(dec(open(hostBox, seal(clientBox, enc("hello over e2e"))))).toBe("hello over e2e");
    expect(dec(open(clientBox, seal(hostBox, enc("reply"))))).toBe("reply");
  });
  it("tampered ciphertext fails", () => {
    const host = generateKeyPair();
    const client = generateKeyPair();
    const hostBox = sharedKey(client.publicKey, host.secretKey);
    const clientBox = sharedKey(host.publicKey, client.secretKey);
    const sealed = seal(clientBox, enc("secret"));
    sealed[sealed.length - 1] ^= 1;
    expect(() => open(hostBox, sealed)).toThrow();
  });
  it("cipher envelope roundtrip", () => {
    const host = generateKeyPair();
    const client = generateKeyPair();
    const hostBox = sharedKey(client.publicKey, host.secretKey);
    const clientBox = sharedKey(host.publicKey, client.secretKey);
    const inner = enc('{"type":"hello"}');
    const frame = sealFrame(clientBox, InnerKind.Json, inner);
    expect(classifyBinary(frame)).toBe("cipher");
    const { innerKind, plain } = openFrame(hostBox, frame);
    expect(innerKind).toBe(InnerKind.Json);
    expect(dec(plain)).toBe('{"type":"hello"}');
  });
  it("keypair from secret is deterministic", () => {
    const kp = generateKeyPair();
    const kp2 = keyPairFromSecret(kp.secretKey);
    expect(Array.from(kp2.publicKey)).toEqual(Array.from(kp.publicKey));
  });
});
