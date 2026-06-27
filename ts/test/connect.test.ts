import { describe, expect, it } from "vitest";
import { fromB64 } from "../src/b64";
import { connectLan } from "../src/connect";
import { generateKeyPair, publicB64, sharedKey, type KeyPair } from "../src/e2e";
import { InnerKind, openFrame, sealFrame } from "../src/frames";
import type { ConnectionOffer, ServerInfo } from "../src/messages";
import type { WebSocketLike } from "../src/transport-ws";

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const toU8 = (d: unknown): Uint8Array => (d instanceof Uint8Array ? d : new Uint8Array(d as ArrayBuffer));

class FakeWebSocket implements WebSocketLike {
  binaryType = "blob";
  readyState = 0;
  onopen: ((ev?: any) => void) | null = null;
  onmessage: ((ev: any) => void) | null = null;
  onclose: ((ev?: any) => void) | null = null;
  onerror: ((ev?: any) => void) | null = null;
  sendHook: ((data: string | Uint8Array) => void) | null = null;
  send(data: string | Uint8Array): void {
    this.sendHook?.(data);
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  fireOpen(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  recv(data: string | Uint8Array): void {
    this.onmessage?.({ data });
  }
}

interface HostOpts {
  badReady?: boolean;
  /** 在 e2ee_ready 之前先发 cipher server_info，且不再回应 hello —— 验证早到密文缓冲。 */
  earlyServerInfo?: boolean;
}

/** 用真 crypto 在 fake 上模拟 Host 侧握手 + 加密应答。 */
function installHost(ws: FakeWebSocket, host: KeyPair, serverInfo: ServerInfo, opts: HostOpts = {}): void {
  let shared: Uint8Array | null = null;
  ws.sendHook = (data) => {
    queueMicrotask(() => {
      if (typeof data === "string") {
        const msg = JSON.parse(data) as { type?: string; key?: string };
        if (msg.type === "e2ee_hello" && msg.key) {
          shared = sharedKey(fromB64(msg.key), host.secretKey);
          if (opts.earlyServerInfo) {
            ws.recv(sealFrame(shared, InnerKind.Json, enc(JSON.stringify(serverInfo))));
          }
          ws.recv(JSON.stringify({ type: opts.badReady ? "nope" : "e2ee_ready" }));
        }
      } else {
        if (!shared) return;
        const { innerKind, plain } = openFrame(shared, toU8(data));
        if (innerKind !== InnerKind.Json) return;
        const inner = JSON.parse(dec(plain)) as { type?: string };
        if (inner.type === "hello" && !opts.earlyServerInfo) {
          ws.recv(sealFrame(shared, InnerKind.Json, enc(JSON.stringify(serverInfo))));
        }
      }
    });
  };
}

const SERVER_INFO: ServerInfo = {
  type: "server_info",
  serverId: "srv-1",
  hostName: "TEST-HOST",
  appVersion: "test",
  protocolVersion: 1,
  features: { terminalRestore: true },
};

function makeOffer(host: KeyPair): ConnectionOffer {
  return { v: 1, serverId: "srv-1", hostName: "TEST-HOST", hostPublicKeyB64: publicB64(host), lan: { host: "127.0.0.1", port: 6767 } };
}

describe("connectLan", () => {
  it("E2E 握手 + 装配 → 收到 server_info（回应 hello）", async () => {
    const host = generateKeyPair();
    const ws = new FakeWebSocket();
    installHost(ws, host, SERVER_INFO);
    const p = connectLan(makeOffer(host), { clientId: "c1", appVersion: "t", wsFactory: () => ws });
    ws.fireOpen();
    const conn = await p;
    expect(conn.serverInfo.serverId).toBe("srv-1");
    expect(conn.serverInfo.features.terminalRestore).toBe(true);
    conn.close();
  });

  it("握手期早到密文被缓冲并回放（hello 不回复仍拿到 server_info）", async () => {
    const host = generateKeyPair();
    const ws = new FakeWebSocket();
    installHost(ws, host, SERVER_INFO, { earlyServerInfo: true });
    const p = connectLan(makeOffer(host), { clientId: "c2", appVersion: "t", handshakeTimeoutMs: 2000, wsFactory: () => ws });
    ws.fireOpen();
    const conn = await p;
    expect(conn.serverInfo.serverId).toBe("srv-1");
    conn.close();
  });

  it("握手回错消息 → reject", async () => {
    const host = generateKeyPair();
    const ws = new FakeWebSocket();
    installHost(ws, host, SERVER_INFO, { badReady: true });
    const p = connectLan(makeOffer(host), { clientId: "c3", appVersion: "t", handshakeTimeoutMs: 1000, wsFactory: () => ws });
    ws.fireOpen();
    await expect(p).rejects.toThrow(/e2ee_ready/);
  });

  it("offer 无 lan → reject", async () => {
    const host = generateKeyPair();
    const offer: ConnectionOffer = { ...makeOffer(host), lan: undefined };
    await expect(
      connectLan(offer, { clientId: "c4", appVersion: "t", wsFactory: () => new FakeWebSocket() }),
    ).rejects.toThrow(/lan/);
  });
});
