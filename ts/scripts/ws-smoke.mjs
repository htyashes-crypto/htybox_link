// HtyBox Host WS 冒烟验证（L2）：连本机 ws_host，hello→create→subscribe→input→看回显。
// 用法：先跑 HtyBox app（ws_host 监听 127.0.0.1:6767），再 `node scripts/ws-smoke.mjs [port]`。
import WebSocket from "ws";

const PORT = process.argv[2] || 6767;
const url = `ws://127.0.0.1:${PORT}/ws`;
const enc = (s) => new TextEncoder().encode(s);
const termFrame = (opcode, slot, payload) => {
  const f = new Uint8Array(2 + payload.length);
  f[0] = opcode;
  f[1] = slot;
  f.set(payload, 2);
  return f;
};
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};

const ws = new WebSocket(url);
let termId = null;
let done = false;
const timer = setTimeout(() => fail("超时未收到回显"), 15000);

ws.on("open", () => {
  ws.send(JSON.stringify({ type: "hello", clientId: "smoke", clientType: "cli", protocolVersion: 1, appVersion: "smoke", capabilities: { terminalBinary: true } }));
});

ws.on("message", (data, isBinary) => {
  if (!isBinary) {
    const m = JSON.parse(data.toString());
    if (m.type === "server_info") {
      console.log("· server_info:", m.serverId, "features=", JSON.stringify(m.features));
      ws.send(JSON.stringify({ type: "terminal.create.request", requestId: "r1", cols: 80, rows: 24 }));
    } else if (m.type === "terminal.create.response") {
      termId = m.payload.terminalId;
      console.log("· 已建终端:", termId);
      ws.send(JSON.stringify({ type: "terminal.subscribe.request", requestId: "r2", terminalId: termId, restore: { mode: "visible-snapshot" } }));
    } else if (m.type === "terminal.subscribe.response") {
      const slot = m.payload.slot;
      console.log("· 已订阅 slot=", slot, "baselineRev=", m.payload.revision);
      ws.send(termFrame(0x02, slot, enc("echo HTYBOXOK\r\n"))); // Input 帧
    } else if (m.type === "rpc_error") {
      fail("rpc_error: " + m.error);
    }
  } else {
    const b = new Uint8Array(data);
    if (b.length < 2) return;
    const opcode = b[0];
    if (opcode === 0x01 || opcode === 0x05) {
      // Output/Restore：payload = revision(8B) + data
      const text = new TextDecoder().decode(b.slice(2 + 8));
      if (text.includes("HTYBOXOK")) {
        console.log("PASS: 经 WS 收到终端回显 HTYBOXOK —— 终端 I/O 端到端打通");
        done = true;
        clearTimeout(timer);
        ws.close();
        process.exit(0);
      }
    }
  }
});

ws.on("error", (e) => fail("ws error: " + e.message));
ws.on("close", () => {
  if (!done) fail("连接关闭但未见回显");
});
