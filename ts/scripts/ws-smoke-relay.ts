// L4 relay smoke：经本机 relay 中继 connectRelay 连真实 Host（验证 反连 + 路由 + E2E 透传 + RPC/终端/catalog）。
// 前置：1) 起 relay（`cargo run -p htybox-relay`，默认 6868）  2) Host 配 relay endpoint=127.0.0.1:6868、use_tls=false、启用并重启（反连上线）
// 用法：`pnpm smoke:relay [relayEndpoint]`（默认 127.0.0.1:6868），tsx 跑 TS 源 —— 与 iOS 同一套 connectRelay。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket } from "ws";
import { connectRelay } from "../src/connect";
import { keyPairFromSecret, publicB64 } from "../src/e2e";
import {
  RpcTypes,
  type CreateTerminalResult,
  type FilesResult,
  type MemoriesResult,
  type SessionsResult,
  type SkillsResult,
  type WorkspacesResult,
} from "../src/messages";
import type { WebSocketLike } from "../src/transport-ws";

const RELAY = process.argv[2] || "127.0.0.1:6868";
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
  // 真机从二维码拿公钥 + relay 端点；此处从本机身份文件推公钥构造 relay offer。
  const hostKp = keyPairFromSecret(new Uint8Array(Buffer.from(id.secretKeyB64, "base64")));
  const offer = {
    v: 1,
    serverId: id.serverId,
    hostName: "smoke",
    hostPublicKeyB64: publicB64(hostKp),
    relay: { endpoint: RELAY, useTls: false },
  };

  const conn = await connectRelay(offer, {
    clientId: "smoke-relay",
    clientType: "cli",
    appVersion: "smoke",
    wsFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
    handshakeTimeoutMs: 12000,
  });
  console.log("· 经 relay：E2E 握手 + server_info OK：", conn.serverInfo.serverId, "/", conn.serverInfo.hostName);
  if (conn.serverInfo.serverId !== offer.serverId) {
    fail(`serverId 不一致：offer=${offer.serverId} server_info=${conn.serverInfo.serverId}（违反 spec §3.2）`);
  }
  console.log("· serverId 一致校验 OK：", offer.serverId);

  const wsr = await conn.client.request<WorkspacesResult>(RpcTypes.hostWorkspacesList, {});
  console.log("· host.workspaces.list →", wsr.workspaces.length, "工作区, active:", wsr.activeId ?? "(无)");

  const sk = await conn.client.request<SkillsResult>(RpcTypes.catalogSkillsList, { projectDir: "" });
  const mem = await conn.client.request<MemoriesResult>(RpcTypes.catalogMemoriesList, { slug: "G--hty-workflows" });
  const files = await conn.client.request<FilesResult>(RpcTypes.catalogFilesList, { dir: "G:\\hty_workflows" });
  const ses = await conn.client.request<SessionsResult>(RpcTypes.catalogSessionsList, { cwd: "G:\\hty_workflows\\HtyBox" });
  console.log(
    "· catalog(经 relay): skills=" + sk.skills.length +
      " memories=" + mem.memories.length +
      " files=" + files.entries.length +
      " sessions=" + ses.claude.length + "claude/" + ses.codex.length + "codex",
  );

  const cr = await conn.client.request<CreateTerminalResult>(RpcTypes.terminalCreate, { cols: 80, rows: 24 });
  console.log("· terminal.create →", cr.terminalId);

  let seen = false;
  const sub = await conn.client.subscribeTerminal(cr.terminalId, { mode: "visible-snapshot" }, (_rev, data) => {
    if (new TextDecoder().decode(data).includes("RELAYOK")) seen = true;
  });
  console.log("· subscribe slot", sub.slot, "—— 发送 echo RELAYOK");
  conn.client.sendInput(sub.slot, new TextEncoder().encode("echo RELAYOK\r\n"));

  await waitFor(() => seen, 12000);
  console.log("PASS: 真实 Host 经 relay 中继端到端（反连→配对→E2E→create→subscribe→输入→回显 RELAYOK）打通");
  conn.close();
  process.exit(0);
})().catch((e: unknown) => fail(String((e as Error)?.stack ?? e)));
