// L3 E2E 验证：node 客户端做 e2ee 握手 + 密文信封，验加密通道下终端 I/O。
// 真实场景手机从二维码拿 Host 公钥；此测试从本机 host-identity 文件推出公钥。
// 用法：先跑 HtyBox app，再 `node scripts/ws-smoke-e2e.mjs [port]`。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import nacl from "tweetnacl";
import WebSocket from "ws";

const PORT = process.argv[2] || 6767;
const b64d = (s) => new Uint8Array(Buffer.from(s, "base64"));
const b64e = (b) => Buffer.from(b).toString("base64");
const enc = (s) => new TextEncoder().encode(s);
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

const cfg = process.env.APPDATA || join(process.env.HOME || ".", ".config");
let hostPub;
try {
  const id = JSON.parse(readFileSync(join(cfg, "HtyBox", "host-identity.json"), "utf8"));
  hostPub = nacl.box.keyPair.fromSecretKey(b64d(id.secretKeyB64)).publicKey;
} catch (e) {
  fail("读 host-identity 失败（先跑一次 app 生成）: " + e.message);
}

const client = nacl.box.keyPair();
const shared = nacl.box.before(hostPub, client.secretKey);

const sealFrame = (innerKind, inner) => {
  const nonce = nacl.randomBytes(24);
  const ct = nacl.box.after(inner, nonce, shared);
  const f = new Uint8Array(2 + 24 + ct.length);
  f[0] = 0x00;
  f[1] = innerKind;
  f.set(nonce, 2);
  f.set(ct, 26);
  return f;
};
const openFrame = (frame) => {
  const plain = nacl.box.open.after(frame.slice(26), frame.slice(2, 26), shared);
  return plain ? { innerKind: frame[1], plain } : null;
};
const termFrame = (op, slot, payload) => {
  const f = new Uint8Array(2 + payload.length);
  f[0] = op;
  f[1] = slot;
  f.set(payload, 2);
  return f;
};
const sendJson = (ws, obj) => ws.send(sealFrame(0x01, enc(JSON.stringify(obj))), { binary: true });

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let ready = false;
const timer = setTimeout(() => fail("超时"), 15000);

ws.on("open", () => ws.send(JSON.stringify({ type: "e2ee_hello", key: b64e(client.publicKey) })));
ws.on("message", (data, isBinary) => {
  if (!ready) {
    if (isBinary) fail("握手阶段收到二进制");
    const m = JSON.parse(data.toString());
    if (m.type !== "e2ee_ready") fail("期待 e2ee_ready，收到 " + m.type);
    ready = true;
    console.log("· E2E 握手完成 (e2ee_ready)");
    sendJson(ws, { type: "hello", clientId: "e2e", clientType: "cli", protocolVersion: 1, appVersion: "e2e", capabilities: { terminalBinary: true } });
    return;
  }
  if (!isBinary) fail("加密阶段收到明文（应全部密文）");
  const o = openFrame(new Uint8Array(data));
  if (!o) fail("解密失败");
  if (o.innerKind === 0x01) {
    const m = JSON.parse(new TextDecoder().decode(o.plain));
    if (m.type === "server_info") {
      console.log("· server_info(加密):", m.serverId);
      sendJson(ws, { type: "terminal.create.request", requestId: "r1", cols: 80, rows: 24 });
    } else if (m.type === "terminal.create.response") {
      sendJson(ws, { type: "terminal.subscribe.request", requestId: "r2", terminalId: m.payload.terminalId, restore: { mode: "visible-snapshot" } });
    } else if (m.type === "terminal.subscribe.response") {
      ws.send(sealFrame(0x02, termFrame(0x02, m.payload.slot, enc("echo E2EOK\r\n"))), { binary: true });
    } else if (m.type === "rpc_error") {
      fail("rpc_error: " + m.error);
    }
  } else if (o.innerKind === 0x02) {
    const f = o.plain;
    if (f[0] === 0x01 || f[0] === 0x05) {
      if (new TextDecoder().decode(f.slice(10)).includes("E2EOK")) {
        console.log("PASS: E2E 加密通道下终端回显 E2EOK —— 端到端加密 + 终端 I/O 打通");
        clearTimeout(timer);
        ws.close();
        process.exit(0);
      }
    }
  }
});
ws.on("error", (e) => fail("ws error: " + e.message));
ws.on("close", () => fail("连接关闭但未见 E2EOK"));
