import { describe, expect, it } from "vitest";
import type { WireMessage } from "../src/client";
import { BrowserWsTransport, wireFromWsData, type WebSocketLike } from "../src/transport-ws";

class FakeWs implements WebSocketLike {
  binaryType = "blob";
  readyState = 1;
  onopen: ((ev?: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev?: any) => void) | null = null;
  onerror: ((ev?: any) => void) | null = null;
  sent: Array<string | Uint8Array> = [];
  send(d: string | Uint8Array): void {
    this.sent.push(d);
  }
  close(): void {
    this.onclose?.();
  }
  recv(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const asBin = (m: WireMessage) => (m.kind === "binary" ? Array.from(m.data) : m.data);

describe("wireFromWsData", () => {
  it("string → text", () => {
    expect(wireFromWsData("hi")).toEqual({ kind: "text", data: "hi" });
  });
  it("ArrayBuffer → binary", () => {
    const w = wireFromWsData(new Uint8Array([1, 2, 3]).buffer);
    expect(asBin(w)).toEqual([1, 2, 3]);
  });
  it("Uint8Array view → binary", () => {
    expect(asBin(wireFromWsData(new Uint8Array([9, 8])))).toEqual([9, 8]);
  });
});

describe("BrowserWsTransport", () => {
  it("preBuffered + 注册前到达消息按序回放，且先于实时", () => {
    const ws = new FakeWs();
    const t = new BrowserWsTransport(ws, { preBuffered: [new Uint8Array([1])] });
    ws.recv(new Uint8Array([2])); // onMessage 注册前到达 → 入队
    const got: WireMessage[] = [];
    t.onMessage((m) => got.push(m));
    ws.recv(new Uint8Array([3])); // 实时
    expect(got.map(asBin)).toEqual([[1], [2], [3]]);
  });
  it("send 透传到底层 ws", () => {
    const ws = new FakeWs();
    const t = new BrowserWsTransport(ws);
    t.send({ kind: "text", data: "x" });
    t.send({ kind: "binary", data: new Uint8Array([7]) });
    expect(ws.sent[0]).toBe("x");
    expect(Array.from(ws.sent[1] as Uint8Array)).toEqual([7]);
  });
  it("onClose 在已关闭后注册也触发", () => {
    const ws = new FakeWs();
    const t = new BrowserWsTransport(ws);
    ws.close();
    let closed = false;
    t.onClose(() => (closed = true));
    expect(closed).toBe(true);
  });
});
