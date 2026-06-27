// L2 多客户端验证：A 建终端产出历史 → B 后加入(visible-snapshot)应见历史 → A 再输入 B 实时可见。
import WebSocket from "ws";

const PORT = process.argv[2] || 6767;
const enc = (s) => new TextEncoder().encode(s);
const tf = (op, slot, p) => {
  const f = new Uint8Array(2 + p.length);
  f[0] = op;
  f[1] = slot;
  f.set(p, 2);
  return f;
};
const fail = (m) => {
  console.error("FAIL:", m);
  process.exit(1);
};
const conn = () =>
  new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on("open", () => res(ws));
    ws.on("error", rej);
  });
const rpc = (ws, msg) =>
  new Promise((res) => {
    const h = (d, bin) => {
      if (bin) return;
      const m = JSON.parse(d.toString());
      const matchResp = m.requestId === msg.requestId && m.type.endsWith(".response");
      if (matchResp || (msg.type === "hello" && m.type === "server_info")) {
        ws.off("message", h);
        res(m);
      }
    };
    ws.on("message", h);
    ws.send(JSON.stringify(msg));
  });
const waitMarker = (ws, marker, ms = 10000) =>
  new Promise((res) => {
    const t = setTimeout(() => {
      ws.off("message", h);
      res(false);
    }, ms);
    const h = (d, bin) => {
      if (!bin) return;
      const b = new Uint8Array(d);
      if (b.length >= 2 && (b[0] === 0x01 || b[0] === 0x05)) {
        if (new TextDecoder().decode(b.slice(10)).includes(marker)) {
          clearTimeout(t);
          ws.off("message", h);
          res(true);
        }
      }
    };
    ws.on("message", h);
  });
const hello = (id) => ({ type: "hello", clientId: id, clientType: "cli", protocolVersion: 1, appVersion: "s", capabilities: { terminalBinary: true } });

(async () => {
  const a = await conn();
  await rpc(a, hello("A"));
  const cr = await rpc(a, { type: "terminal.create.request", requestId: "a1", cols: 80, rows: 24 });
  const termId = cr.payload.terminalId;
  const sa = await rpc(a, { type: "terminal.subscribe.request", requestId: "a2", terminalId: termId, restore: { mode: "live" } });
  a.send(tf(0x02, sa.payload.slot, enc("echo SHARE1\r\n")));
  if (!(await waitMarker(a, "SHARE1"))) fail("A 未见 SHARE1");
  console.log("· A 终端产出 SHARE1");

  const b = await conn();
  await rpc(b, hello("B"));
  const waitB1 = waitMarker(b, "SHARE1"); // 订阅前挂监听，接 Restore 历史帧
  await rpc(b, { type: "terminal.subscribe.request", requestId: "b1", terminalId: termId, restore: { mode: "visible-snapshot" } });
  if (!(await waitB1)) fail("B 历史重放未见 SHARE1");
  console.log("· B 后加入，历史重放看到 SHARE1");

  const waitB2 = waitMarker(b, "SHARE2");
  a.send(tf(0x02, sa.payload.slot, enc("echo SHARE2\r\n")));
  if (!(await waitB2)) fail("B 未实时看到 SHARE2");
  console.log("PASS: 多客户端共享 + 历史重放 OK（A 输入→B 实时可见；B 加入→见历史 scrollback）");
  process.exit(0);
})().catch((e) => fail(String(e)));
