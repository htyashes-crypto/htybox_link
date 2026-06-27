// 跨语言一致性：TS 侧读同一 test-vectors，断言与 Rust 字节一致（L1 最关键的验收）。
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { fromB64, toB64, toHex } from "../src/b64";
import { keyPairFromSecret, open, publicB64, sealWithNonce, sharedKey } from "../src/e2e";
import { encodeFrame, encodeResize, encodeRevisionFrame, Opcode } from "../src/frames";
import { encodeOfferUrl, parseOfferUrl } from "../src/offer";

const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test-vectors");
// eslint 无关：JSON.parse 返回 any，按 vector 字段读取
const e2eV = JSON.parse(readFileSync(join(dir, "e2e.json"), "utf8"));
const framesV = JSON.parse(readFileSync(join(dir, "frames.json"), "utf8"));
const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe("cross-language vectors", () => {
  it("e2e matches Rust", () => {
    const host = keyPairFromSecret(fromB64(e2eV.hostSecretB64));
    const client = keyPairFromSecret(fromB64(e2eV.clientSecretB64));
    expect(publicB64(host)).toBe(e2eV.hostPublicB64);
    expect(publicB64(client)).toBe(e2eV.clientPublicB64);

    const clientBox = sharedKey(host.publicKey, client.secretKey);
    const sealed = sealWithNonce(clientBox, fromB64(e2eV.nonceB64), enc(e2eV.plaintextUtf8));
    expect(toB64(sealed)).toBe(e2eV.sealedB64); // 与 Rust 密文逐字节一致

    const hostBox = sharedKey(client.publicKey, host.secretKey);
    expect(dec(open(hostBox, fromB64(e2eV.sealedB64)))).toBe(e2eV.plaintextUtf8);
  });

  it("frames match Rust", () => {
    expect(toHex(encodeRevisionFrame(Opcode.Output, 1, 42n, enc("hi")))).toBe(framesV.outputFrameHex);
    expect(toHex(encodeFrame(Opcode.Input, 2, enc("ls\r")))).toBe(framesV.inputFrameHex);
    expect(toHex(encodeResize(0, { cols: 80, rows: 24 }))).toBe(framesV.resizeFrameHex);
  });

  it("offer url matches Rust", () => {
    const offer = parseOfferUrl(framesV.offerUrl);
    expect(offer.v).toBe(1);
    expect(offer.serverId).toBe("srv-vector");
    expect(offer.lan?.port).toBe(6767);
    expect(encodeOfferUrl(offer)).toBe(framesV.offerUrl); // 解析→重编码 字节一致
  });
});
