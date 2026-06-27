// 通用 WebSocket transport（03-spec §2）。结构化 WebSocketLike 同时适配浏览器原生
// WebSocket 与 node `ws`，不引 DOM lib，保持协议库运行时无关。

import type { Transport, WireMessage } from "./client";

/** 结构化 WebSocket（浏览器原生 / node `ws` 均满足）；事件用 any 规避 DOM lib 依赖与函数变型问题。 */
export interface WebSocketLike {
  binaryType: string;
  readyState: number;
  send(data: string | Uint8Array): void;
  close(): void;
  // eslint 无（项目无 ESLint）；显式 any 仅用于结构化事件签名。
  onopen: ((ev?: any) => void) | null;
  onmessage: ((ev: any) => void) | null;
  onclose: ((ev?: any) => void) | null;
  onerror: ((ev?: any) => void) | null;
}

export interface BrowserWsTransportOptions {
  /** 握手期早到的二进制密文帧；构造后优先回放（先于实时消息），保证零丢帧。 */
  preBuffered?: Uint8Array[];
}

/** WS 原始消息 → WireMessage（要求 binaryType='arraybuffer'）。 */
export function wireFromWsData(data: unknown): WireMessage {
  if (typeof data === "string") return { kind: "text", data };
  if (data instanceof ArrayBuffer) return { kind: "binary", data: new Uint8Array(data) };
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return { kind: "binary", data: new Uint8Array(v.buffer, v.byteOffset, v.byteLength) };
  }
  throw new Error("不支持的 WS 消息类型（Blob?）—— 请设 binaryType='arraybuffer'");
}

/** 把一个已连接的 WebSocketLike 适配成 DaemonClient 的 Transport。
 *  在 onMessage 注册前到达的消息会入队，注册时按序回放，避免装配窗口丢帧。 */
export class BrowserWsTransport implements Transport {
  private cb: ((m: WireMessage) => void) | null = null;
  private queue: WireMessage[] = [];
  private closeCb: (() => void) | null = null;
  private closed = false;

  constructor(private ws: WebSocketLike, opts: BrowserWsTransportOptions = {}) {
    ws.binaryType = "arraybuffer";
    for (const b of opts.preBuffered ?? []) this.queue.push({ kind: "binary", data: b });
    ws.onmessage = (ev: { data: unknown }) => this.deliver(wireFromWsData(ev.data));
    ws.onclose = () => {
      this.closed = true;
      this.closeCb?.();
    };
  }

  send(msg: WireMessage): void {
    this.ws.send(msg.data);
  }
  onMessage(cb: (m: WireMessage) => void): void {
    this.cb = cb;
    const pending = this.queue;
    this.queue = [];
    for (const m of pending) cb(m);
  }
  onClose(cb: () => void): void {
    this.closeCb = cb;
    if (this.closed) cb();
  }
  close(): void {
    this.ws.close();
  }
  private deliver(m: WireMessage): void {
    if (this.cb) this.cb(m);
    else this.queue.push(m);
  }
}
