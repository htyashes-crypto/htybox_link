// 验证 L4 终端 resize 修复：① subscribe 返回 cols/rows ② 远程 resize 被 Host 忽略（桌面独占尺寸，
// 不再被手机压缩）。用法：先跑 Host（dev app 占 6768，安装版占 6767），再 `pnpm smoke:resize [port]`。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { connectLan } from "../src/connect";
import { keyPairFromSecret, publicB64 } from "../src/e2e";
import { RpcTypes, type CreateTerminalResult, type TerminalListResult } from "../src/messages";
import type { WebSocketLike } from "../src/transport-ws";

const PORT = Number(process.argv[2] || 6768);
const fail = (m: string) => {
  console.error("FAIL:", m);
  process.exit(1);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const cfg = process.env.APPDATA || join(process.env.HOME || ".", ".config");
  const id = JSON.parse(readFileSync(join(cfg, "HtyBox", "host-identity.json"), "utf8")) as {
    secretKeyB64: string;
    serverId: string;
  };
  const hostKp = keyPairFromSecret(new Uint8Array(Buffer.from(id.secretKeyB64, "base64")));
  const offer = {
    v: 1,
    serverId: id.serverId,
    hostName: "smoke",
    hostPublicKeyB64: publicB64(hostKp),
    lan: { host: "127.0.0.1", port: PORT },
  };

  const conn = await connectLan(offer, {
    clientId: "smoke-resize",
    clientType: "cli",
    appVersion: "smoke",
    wsFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
    handshakeTimeoutMs: 8000,
  });
  console.log("· 连接 OK：", conn.serverInfo.serverId);

  const cr = await conn.client.request<CreateTerminalResult>(RpcTypes.terminalCreate, { cols: 100, rows: 30 });
  console.log("· 远程建终端 100×30 →", cr.terminalId);

  const sub = await conn.client.subscribeTerminal(cr.terminalId, { mode: "visible-snapshot" }, () => {});
  console.log("· subscribe 返回尺寸：cols=" + sub.cols + " rows=" + sub.rows);
  if (sub.cols !== 100 || sub.rows !== 30) fail(`subscribe 尺寸应为 100×30，实为 ${sub.cols}×${sub.rows}`);

  // 远程试图把 PTY 缩成手机大小 —— 桌面独占尺寸，Host 应忽略
  conn.client.sendResize(sub.slot, 20, 5);
  await sleep(600);

  const list = await conn.client.request<TerminalListResult>(RpcTypes.terminalList, {});
  const t = list.terminals.find((x) => x.terminalId === cr.terminalId);
  if (!t) fail("终端列表里找不到刚建的终端");
  console.log("· 远程 sendResize(20×5) 后该终端尺寸：cols=" + t!.cols + " rows=" + t!.rows);
  if (t!.cols !== 100 || t!.rows !== 30) {
    fail(`远程 resize 未被忽略！终端被改成 ${t!.cols}×${t!.rows}（桌面会被压缩）`);
  }

  await conn.client.request(RpcTypes.terminalKill, { terminalId: cr.terminalId });
  console.log("PASS: subscribe 带尺寸 + 远程 resize 被 Host 忽略（桌面尺寸不受手机影响）");
  conn.close();
  process.exit(0);
})().catch((e: unknown) => fail(String((e as Error)?.stack ?? e)));
