// 连接建立（03-spec §3/§8/§9）：建 WS → E2E 握手 → 装配 DaemonClient。LAN 直连与 relay 中继共用核心。
// 连接器归协议库（spec §附），桌面/iOS/web 客户端共用。

import { fromB64 } from "./b64";
import { DaemonClient, type DaemonClientOptions } from "./client";
import { generateKeyPair, publicB64, sharedKey, type KeyPair } from "./e2e";
import type { ClientType, ConnectionOffer, ServerInfo } from "./messages";
import { BrowserWsTransport, wireFromWsData, type WebSocketLike } from "./transport-ws";

const WS_PATH = "/ws";
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15000;

export interface ConnectOptions {
  clientId: string;
  appVersion: string;
  clientType?: ClientType;
  /** 自定义 WebSocket 工厂（浏览器外如 node smoke 注入 `ws`）；默认用全局 WebSocket。 */
  wsFactory?: (url: string) => WebSocketLike;
  handshakeTimeoutMs?: number;
  /** WS 断开回调（供上层做重连）。 */
  onClose?: () => void;
  /** relay 数据通道 connectionId（默认随机生成；仅 connectRelay 使用）。 */
  connectionId?: string;
}
/** @deprecated 改用 {@link ConnectOptions}（保留别名兼容）。 */
export type ConnectLanOptions = ConnectOptions;

export interface Connection {
  client: DaemonClient;
  serverInfo: ServerInfo;
  url: string;
  close(): void;
}
/** @deprecated 改用 {@link Connection}（保留别名兼容）。 */
export type LanConnection = Connection;

/** 由 offer 的 lan 端点建立一条 E2E 加密 LAN 连接（始终走 E2E）。 */
export async function connectLan(offer: ConnectionOffer, opts: ConnectOptions): Promise<Connection> {
  if (!offer.lan) throw new Error("offer 缺少 lan 端点，无法 LAN 直连");
  const url = `ws://${offer.lan.host}:${offer.lan.port}${WS_PATH}`;
  return connectWs(url, offer.hostPublicKeyB64, opts);
}

/** 经 relay 中继建立一条 E2E 加密连接（数据通道 `/session/{serverId}/{connectionId}`，始终走 E2E）。 */
export async function connectRelay(offer: ConnectionOffer, opts: ConnectOptions): Promise<Connection> {
  if (!offer.relay) throw new Error("offer 缺少 relay 端点，无法经中继连接");
  const connectionId = opts.connectionId ?? randomConnectionId();
  const scheme = offer.relay.useTls ? "wss" : "ws";
  const url = `${scheme}://${offer.relay.endpoint}/session/${offer.serverId}/${connectionId}`;
  return connectWs(url, offer.hostPublicKeyB64, opts);
}

/** LAN/relay 共用核心：建 WS → E2E 握手（早到密文缓冲）→ 同步装配 DaemonClient。 */
async function connectWs(url: string, hostPublicKeyB64: string, opts: ConnectOptions): Promise<Connection> {
  const hostPublicKey = fromB64(hostPublicKeyB64);
  const factory = opts.wsFactory ?? defaultWsFactory();
  const ws = factory(url);
  ws.binaryType = "arraybuffer";

  await waitOpen(ws);

  const kp = generateKeyPair();
  const earlyBinaries: Uint8Array[] = [];
  await handshake(ws, kp, earlyBinaries, opts.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS);
  const e2eShared = sharedKey(hostPublicKey, kp.secretKey);

  // 同步装配：transport 接管 ws.onmessage（回放早到密文）→ DaemonClient（构造即 onMessage）。
  // handshake 的 cleanup 与此处之间无 await，事件循环不会插入新 ws 消息 → 零丢帧。
  const transport = new BrowserWsTransport(ws, { preBuffered: earlyBinaries });
  if (opts.onClose) transport.onClose(opts.onClose);
  const clientOpts: DaemonClientOptions = {
    clientId: opts.clientId,
    clientType: opts.clientType ?? "ios",
    appVersion: opts.appVersion,
    e2eShared,
  };
  const client = new DaemonClient(transport, clientOpts);
  const serverInfo = await client.start();
  return { client, serverInfo, url, close: () => client.close() };
}

/** 生成 relay connectionId（优先 crypto.randomUUID）。 */
function randomConnectionId(): string {
  const g = globalThis as { crypto?: { randomUUID?: () => string } };
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join("");
}

function defaultWsFactory(): (url: string) => WebSocketLike {
  const g = globalThis as { WebSocket?: new (url: string) => WebSocketLike };
  const Ctor = g.WebSocket;
  if (!Ctor) throw new Error("无全局 WebSocket；非浏览器环境请传 opts.wsFactory");
  return (url: string) => new Ctor(url);
}

function waitOpen(ws: WebSocketLike): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === 1 /* OPEN */) return resolve();
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("WebSocket 连接失败"));
  });
}

/** E2E 握手（明文阶段）：发 e2ee_hello → 等 e2ee_ready；其间早到的二进制密文缓冲到 earlyBinaries。 */
function handshake(ws: WebSocketLike, kp: KeyPair, earlyBinaries: Uint8Array[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer: ReturnType<typeof setTimeout> = setTimeout(() => {
      cleanup();
      reject(new Error("E2E 握手超时"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
    };
    ws.onclose = () => {
      cleanup();
      reject(new Error("握手期连接被关闭"));
    };
    ws.onerror = () => {
      cleanup();
      reject(new Error("握手期连接出错"));
    };
    ws.onmessage = (ev: { data: unknown }) => {
      if (typeof ev.data === "string") {
        let msg: { type?: string };
        try {
          msg = JSON.parse(ev.data) as { type?: string };
        } catch {
          cleanup();
          reject(new Error("握手期收到非 JSON 文本"));
          return;
        }
        if (msg.type === "e2ee_ready") {
          cleanup();
          resolve();
        } else {
          cleanup();
          reject(new Error(`期待 e2ee_ready，收到 ${String(msg.type)}`));
        }
      } else {
        earlyBinaries.push(wireFromWsData(ev.data).data as Uint8Array);
      }
    };
    ws.send(JSON.stringify({ type: "e2ee_hello", key: publicB64(kp) }));
  });
}
