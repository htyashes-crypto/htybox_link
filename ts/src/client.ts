// DaemonClient 骨架（L1）：transport 抽象 + hello/RPC/事件/终端帧路由。
// 不连真实 WS —— 真实 transport 在 L2/L5 注入（本地 WS / relay）。此处可用 mock transport 单测。

import {
  classifyBinary,
  decodeFrame,
  decodeResize,
  encodeFrame,
  encodeResize,
  InnerKind,
  Opcode,
  openFrame,
  sealFrame,
  splitRevision,
} from "./frames";
import {
  PROTOCOL_VERSION,
  reqType,
  RpcTypes,
  type Hello,
  type RestoreMode,
  type ServerInfo,
  type SubscribeTerminalResult,
} from "./messages";

export type WireMessage = { kind: "text"; data: string } | { kind: "binary"; data: Uint8Array };

/** 底层传输（WS / relay 等由上层实现）。 */
export interface Transport {
  send(msg: WireMessage): void;
  onMessage(cb: (msg: WireMessage) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface DaemonClientOptions {
  clientId: string;
  clientType: Hello["clientType"];
  appVersion: string;
  /** 若提供则启用 E2E：所有帧用该共享密钥（nacl.box.before 结果）封装/解封。 */
  e2eShared?: Uint8Array;
  /** RPC 请求超时 ms（无响应即 reject，spec §10）；默认 15000。 */
  requestTimeoutMs?: number;
}

type OutputHandler = (revision: bigint, data: Uint8Array) => void;
type ResizeHandler = (cols: number, rows: number) => void;
type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

export class DaemonClient {
  serverInfo: ServerInfo | null = null;
  private nextId = 1;
  private pending = new Map<string, Pending>();
  private events = new Map<string, Set<(payload: unknown) => void>>();
  private outputs = new Map<number, OutputHandler>();
  private resizes = new Map<number, ResizeHandler>();
  private serverInfoWaiters: Array<(si: ServerInfo) => void> = [];

  constructor(private transport: Transport, private opts: DaemonClientOptions) {
    transport.onMessage((m) => this.handleWire(m));
  }

  /** 发 hello，解析并返回 server_info。 */
  async start(): Promise<ServerInfo> {
    const hello: Hello = {
      type: "hello",
      clientId: this.opts.clientId,
      clientType: this.opts.clientType,
      protocolVersion: PROTOCOL_VERSION,
      appVersion: this.opts.appVersion,
      capabilities: { terminalBinary: true },
    };
    this.sendJson(hello);
    if (this.serverInfo) return this.serverInfo;
    return new Promise((res) => this.serverInfoWaiters.push(res));
  }

  /** 发一次 RPC 请求，按 requestId 匹配响应（rpc_error → reject）。 */
  request<R = unknown>(domainOp: string, params: Record<string, unknown>): Promise<R> {
    const requestId = `c${this.nextId++}`;
    const timeoutMs = this.opts.requestTimeoutMs ?? 15000;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(requestId)) reject(new Error(`RPC 超时(${timeoutMs}ms): ${domainOp}`));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: (v) => {
          clearTimeout(timer);
          (resolve as (v: unknown) => void)(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.sendJson({ type: reqType(domainOp), requestId, ...params });
    });
  }

  /** 订阅推送事件，返回取消函数。 */
  on(eventType: string, cb: (payload: unknown) => void): () => void {
    let set = this.events.get(eventType);
    if (!set) {
      set = new Set();
      this.events.set(eventType, set);
    }
    set.add(cb);
    return () => void set!.delete(cb);
  }

  /** 订阅终端：拿到 slot/revision/尺寸 后，按 slot 路由 Output/Snapshot/Restore 给 onOutput；
   *  桌面 resize 时服务端推 Resize 帧，路由给 onResize（远程渲染器跟随尺寸，不回改 PTY）。 */
  async subscribeTerminal(
    terminalId: string,
    restore: RestoreMode,
    onOutput: OutputHandler,
    onResize?: ResizeHandler,
  ): Promise<SubscribeTerminalResult> {
    const res = await this.request<SubscribeTerminalResult>(RpcTypes.terminalSubscribe, { terminalId, restore });
    this.outputs.set(res.slot, onOutput);
    if (onResize) this.resizes.set(res.slot, onResize);
    return res;
  }

  sendInput(slot: number, bytes: Uint8Array): void {
    this.sendBinary(encodeFrame(Opcode.Input, slot, bytes));
  }
  sendResize(slot: number, cols: number, rows: number): void {
    this.sendBinary(encodeResize(slot, { cols, rows }));
  }
  close(): void {
    this.transport.close();
  }

  // ── internal ──
  private sendJson(obj: unknown): void {
    const text = JSON.stringify(obj);
    if (this.opts.e2eShared) {
      const data = sealFrame(this.opts.e2eShared, InnerKind.Json, new TextEncoder().encode(text));
      this.transport.send({ kind: "binary", data });
    } else {
      this.transport.send({ kind: "text", data: text });
    }
  }
  private sendBinary(frame: Uint8Array): void {
    const data = this.opts.e2eShared ? sealFrame(this.opts.e2eShared, InnerKind.Terminal, frame) : frame;
    this.transport.send({ kind: "binary", data });
  }
  private handleWire(m: WireMessage): void {
    if (m.kind === "text") {
      this.handleJson(m.data);
      return;
    }
    if (this.opts.e2eShared && classifyBinary(m.data) === "cipher") {
      const { innerKind, plain } = openFrame(this.opts.e2eShared, m.data);
      if (innerKind === InnerKind.Json) this.handleJson(new TextDecoder().decode(plain));
      else this.handleTerminal(plain);
    } else {
      this.handleTerminal(m.data);
    }
  }
  private handleTerminal(frame: Uint8Array): void {
    const { opcode, slot, payload } = decodeFrame(frame);
    if (opcode === Opcode.Output || opcode === Opcode.Snapshot || opcode === Opcode.Restore) {
      const h = this.outputs.get(slot);
      if (h) {
        const { revision, data } = splitRevision(payload);
        h(revision, data);
      }
    } else if (opcode === Opcode.Resize) {
      const h = this.resizes.get(slot);
      if (h) {
        const { cols, rows } = decodeResize(payload);
        h(cols, rows);
      }
    }
  }
  private handleJson(text: string): void {
    const msg = JSON.parse(text) as Record<string, unknown>;
    const t = msg.type as string;
    if (t === "server_info") {
      this.serverInfo = msg as unknown as ServerInfo;
      const si = this.serverInfo;
      this.serverInfoWaiters.splice(0).forEach((w) => w(si));
      return;
    }
    const reqId = msg.requestId as string | undefined;
    if (t === "rpc_error" && reqId) {
      const p = this.pending.get(reqId);
      if (p) {
        this.pending.delete(reqId);
        p.reject(new Error(`${msg.code}: ${msg.error}`));
      }
      return;
    }
    if (reqId && this.pending.has(reqId)) {
      const p = this.pending.get(reqId)!;
      this.pending.delete(reqId);
      p.resolve(msg.payload);
      return;
    }
    const set = this.events.get(t);
    if (set) set.forEach((cb) => cb(msg.payload));
  }
}
