// L5 Step2 真实 Host smoke：走真实 connectLan（E2E 握手 + DaemonClient 装配）对运行中的 HtyBox。
// 与 ws-smoke-e2e.mjs 不同——本脚本用的是 iOS 端将复用的同一套连接器代码（@htybox/link/connect）。
// 用法：先 PowerShell 起 htybox-app.exe（监听 6767），再 `pnpm smoke:connect [port]`（tsx 跑 TS 源）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { connectLan } from "../src/connect";
import { keyPairFromSecret, publicB64 } from "../src/e2e";
import { RpcTypes, type CreateTerminalResult, type WorkspacesResult } from "../src/messages";
import type { WebSocketLike } from "../src/transport-ws";

const PORT = Number(process.argv[2] || 6767);
const fail = (m: string) => {
  console.error("FAIL:", m);
  process.exit(1);
};

function waitFor(cond: () => boolean, ms: number): Promise<void> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const i = setInterval(() => {
      if (cond()) {
        clearInterval(i);
        res();
      } else if (Date.now() - t0 > ms) {
        clearInterval(i);
        rej(new Error("等待回显超时"));
      }
    }, 50);
  });
}

(async () => {
  const cfg = process.env.APPDATA || join(process.env.HOME || ".", ".config");
  const id = JSON.parse(readFileSync(join(cfg, "HtyBox", "host-identity.json"), "utf8")) as {
    secretKeyB64: string;
    serverId: string;
  };
  // 真机从二维码拿 Host 公钥；此处从本机身份文件推出公钥构造 offer。
  const hostKp = keyPairFromSecret(new Uint8Array(Buffer.from(id.secretKeyB64, "base64")));
  const offer = {
    v: 1,
    serverId: id.serverId,
    hostName: "smoke",
    hostPublicKeyB64: publicB64(hostKp),
    lan: { host: "127.0.0.1", port: PORT },
  };

  const conn = await connectLan(offer, {
    clientId: "smoke-connect",
    clientType: "cli",
    appVersion: "smoke",
    wsFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
    handshakeTimeoutMs: 8000,
  });
  console.log("· E2E 握手 + server_info OK：", conn.serverInfo.serverId, "/", conn.serverInfo.hostName);
  if (conn.serverInfo.serverId !== offer.serverId) {
    fail(`serverId 不一致：offer=${offer.serverId} server_info=${conn.serverInfo.serverId}（违反 spec §3.2）`);
  }
  console.log("· serverId 一致校验 OK：", offer.serverId);

  const wsr = await conn.client.request<WorkspacesResult>(RpcTypes.hostWorkspacesList, {});
  console.log("· host.workspaces.list →", wsr.workspaces.length, "工作区, active:", wsr.activeId ?? "(无)");

  const cr = await conn.client.request<CreateTerminalResult>(RpcTypes.terminalCreate, { cols: 80, rows: 24 });
  console.log("· terminal.create →", cr.terminalId);

  let seen = false;
  const sub = await conn.client.subscribeTerminal(cr.terminalId, { mode: "visible-snapshot" }, (_rev, data) => {
    if (new TextDecoder().decode(data).includes("CONNECTOK")) seen = true;
  });
  console.log("· subscribe slot", sub.slot, "—— 发送 echo CONNECTOK");
  conn.client.sendInput(sub.slot, new TextEncoder().encode("echo CONNECTOK\r\n"));

  await waitFor(() => seen, 10000);
  console.log("PASS: 真实 Host 经 connectLan 端到端（E2E→create→subscribe→输入→回显 CONNECTOK）打通");
  conn.close();
  process.exit(0);
})().catch((e: unknown) => fail(String((e as Error)?.stack ?? e)));
