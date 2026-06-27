# paseo 参考详解（文件级机制摘录）

> 来源：通读本地克隆 `G:\hty_workflows\paseo` 的 `docs/` 与 `packages/`（2026-06-25）。
> 路径均为 paseo 仓库相对路径。本文是 `01-双端方案总体设计.md` 的事实附录，供实现时查证；不替代 paseo 源码。

## 总览

npm workspace 单体仓库，daemon + 多客户端 + 共享协议 + relay：

| package | 角色 |
|---|---|
| `packages/server` | **Daemon**：agent 生命周期、WebSocket API、MCP server、终端 |
| `packages/protocol` | 客户端↔daemon 共享协议（Zod schema、二进制帧编解码） |
| `packages/client` | 共享客户端库（连接/重连/RPC/E2E transport） |
| `packages/app` | 移动端 + Web 客户端（Expo / React Native） |
| `packages/desktop` | Electron 桌面壳（加载 app 的 web 构建 + 管理 daemon 子进程） |
| `packages/relay` | E2E 加密远程中继 |
| `packages/cli` | Docker 风格 CLI 客户端 |
| `packages/highlight` | 语法高亮 |

`docs/` 是系统级知识的事实来源（architecture / data-model / rpc-namespacing / terminal-performance / timeline-sync / SECURITY 等）。

---

## 1. 连接 / 配对 / 鉴权 / relay

### 1.1 daemon 监听
- 默认 `127.0.0.1:6767`（HTTP+WebSocket）；可配 `0.0.0.0:PORT`、Unix socket、Windows named pipe。
- `packages/server/src/server/bootstrap.ts` `parseListenString()` 解析监听目标。
- 首次启动生成 Curve25519 密钥对 → `$PASEO_HOME/daemon-keypair.json`（v2、0600）；见 `daemon-keypair.ts`。
- 稳定 `serverId(UUID)` → `$PASEO_HOME/server-id.json`。

### 1.2 三条连接路径
1. **本地直连** `ws://127.0.0.1:6767`，无加密（loopback 信任）。
2. **LAN 直连**：daemon 取本机网卡 IP（`connection-offer.ts getPrimaryLanIp()`）；offer 含 LAN 端点；同网客户端直连。
3. **relay 远程**：daemon 反连 `relay.paseo.sh:443`；按 `serverId` 路由；v2 = 1 控制 socket + N 数据 socket（每客户端 `connectionId` 一个）。

### 1.3 配对 offer
- 编码：`https://app.paseo.sh/#offer=<base64url(json)>`，**fragment 不上送服务器**，浏览器/客户端本地解析。
- schema（`packages/protocol/src/connection-offer.ts` `ConnectionOfferV2Schema`）：
  ```jsonc
  { "v":2, "serverId":"<uuid>", "daemonPublicKeyB64":"<curve25519 pub>",
    "relay": { "endpoint":"relay.paseo.sh:443", "useTls":true } }
  ```
- 生成：`packages/server/src/server/pairing-offer.ts generateLocalPairingOffer()`。
- 客户端保存（`packages/app/src/types/host-connection.ts`）：`HostProfile{ serverId, label, connections[], preferredConnectionId }`，多连接候选 + 偏好；AsyncStorage/localStorage 持久化；免重扫复用。

### 1.4 鉴权 = 密码学身份（非口令）
- **公钥即信任锚**：offer 里的 daemon 公钥是唯一信任来源；不知公钥者无法 ECDH → 握手失败。
- 无显式"允许设备列表"；ECDH 成功 = 隐式身份验证。
- 可选本地 Bearer 密码（`packages/server/src/server/auth.ts`）：HTTP `Authorization: Bearer`；WS 用 `Sec-WebSocket-Protocol: paseo.bearer.<pwd>`；`bcrypt` 恒定时间比对。仅用于直连深度防御，**不用于 relay**（relay 靠 E2E）。
- 豁免路由：`/api/health` 等。

### 1.5 E2E 握手（`packages/relay/src/encrypted-channel.ts` + `crypto.ts`）
- 算法：Curve25519 ECDH → `shared_key`；NaCl box = **XSalsa20-Poly1305**（24B nonce）。
- 流程：
  ```
  client: 生成临时 keypair → 导入 daemonPublicKey → shared = ECDH(clientSecret, daemonPub)
  client → {"type":"e2ee_hello","key":"<clientPubB64>"}
  daemon: shared = ECDH(daemonSecret, clientPub) → 回 {"type":"e2ee_ready"}
  之后: [nonce(24B)][ciphertext] → base64 走 WS
  ```
- relay 看不到明文、伪造不了（不知 daemonSecret，算不出 shared）、篡改即认证失败。

### 1.6 relay 转发（`packages/relay/src/cloudflare-adapter.ts`、`types.ts`）
- 无状态转发；Cloudflare Durable Object（每 `serverId` 一个实例）或 Node 内存 Map。
- daemon 连 `/session/{serverId}`（控制）；client 连 `/session/{serverId}/{connectionId}`（数据）。
- 控制消息：`sync` / `connected{connectionId}` / `disconnected` / `ping`-`pong`。
- 逐字节转发密文，不解析内层。

### 1.7 安全（`SECURITY.md`、`packages/server/src/server/hostnames.ts`）
- **DNS rebinding** 防护：`isHostnameAllowed()` 白名单（localhost / *.localhost / 字面 IP；可经 `PASEO_HOSTNAMES` 扩展）；HTTP 与 WS 升级都校验 Host header，不允许 → 403。
- CORS/Origin 校验（暴露给非 localhost 时）。
- 信任边界：本地(127.0.0.1, 最高) → LAN(网络隔离) → relay(密码学保护、不信任 relay 运营者)。

---

## 2. daemon 架构与 WebSocket 协议契约

### 2.1 daemon 分层（`packages/server/src/server/`）
- `bootstrap.ts`：初始化 HTTP/WS server、AgentManager、TerminalManager、workspace registry；PID lock `$PASEO_HOME/paseo.pid` 防多实例。
- `websocket-server.ts`：WS 连接、hello 握手、帧分流（JSON / binary）、`server_info` 下发（~L1151 features 块）。
- `session.ts`：per-client 会话，消息 dispatcher（switch → ~8 个子 dispatcher）。
- `agent/agent-manager.ts`：agent 状态机 `initializing→idle⇄running→error/closed` + timeline。
- 进程形态：独立常驻进程为主；桌面可作为 managed 子进程；relay 远程模式。

### 2.2 消息信封（单条 WS 混合）
| type | 方向 | 格式 | 用途 |
|---|---|---|---|
| `hello` | client→ | JSON | 握手 |
| `status`(server_info) | →client | JSON | 能力下发 |
| `*.request` / `*.response` / `rpc_error` | ↔ | JSON | RPC |
| `*_update` / `*_stream` 等 | →client | JSON | 推送事件（无 requestId） |
| 二进制 | ↔ | binary | 终端 I/O |

握手示例：
```jsonc
// → hello
{ "type":"hello","clientId":"<uuid>","clientType":"mobile|browser|cli|mcp",
  "protocolVersion":4,"appVersion":"0.1.98","capabilities":{"voice":true} }
// ← server_info（features 能力位）
{ "type":"status","payload":{ "status":"server_info","serverId":"srv_...",
  "version":{"version":"0.1.98"},
  "features":{ "providersSnapshot":true,"rewind":true,"terminal-restore-modes":true } } }
```

### 2.3 RPC 形态（`docs/rpc-namespacing.md`）
- 新式命名：`域.子域.操作.request` ↔ `域.子域.操作.response`；请求带 `requestId`、`cwd` 等。
- 错误：`{ "type":"rpc_error","payload":{ requestId, requestType, error, code } }`。
- 推送事件无 requestId，如 `agent_update{agent}`、`agent_stream{agentId,event,seq,timestamp}`。
- 主要域（`packages/protocol/src/messages.ts` ~1500 行 + `session.ts` dispatcher）：`agent.*`、`terminal.*`、`checkout.*`、`chat/* schedule/* loop/*`、`daemon.*`、`provider.*`、`workspace.*`。

### 2.4 向后兼容（CLAUDE.md「Critical rules」）
- **协议永远兼容**：新字段 `.optional()`+默认或 `.transform()`；不删字段、不收窄类型、不翻 optional→required；schema 用 `.catchall()` 容未知字段。
- **特性按需协商**：`server_info.features.*` + `CLIENT_CAPS`；客户端 `supports(cap)` 才发/才用；**无降级路径**（旧 daemon 就提示升级）。
- **COMPAT 纪律**：每个 shim `// COMPAT(name): added vX, drop when floor>=vX / 日期`；`rg "COMPAT\("` 列全部清理点。

### 2.5 数据模型（`docs/data-model.md`）
- 文件式 JSON 持久化 + 原子写（写 `.tmp` 再 rename）+ 无迁移框架（靠 optional 默认）。
- agent：`$PASEO_HOME/agents/{cwd-dashes}/{agentId}.json`（含 config/runtimeInfo/persistence.nativeHandle 复原句柄/timeline）。
- workspace：`projects/workspaces.json`（`workspaceId` 不透明，文件操作一律用 `cwd`，不反解 id→path）。

### 2.6 对 HtyBox 的约束
- HtyBox 现状=Tauri 进程内 PTY + IPC + `Channel<Vec<u8>>`，单客户端。要变 Host：新增 WS server + 终端 RPC + 二进制帧路由 + hello/features 握手；Rust 侧 WS 用 `axum`/`tokio-tungstenite`。最小协议集见 `03-protocol-spec.md`。

---

## 3. 终端 I/O 同步（`packages/server/src/terminal/`、`docs/terminal-performance.md`、`docs/timeline-sync.md`）

### 3.1 PTY 持有与隔离
- PTY 在 daemon，用 **node-pty**；**fork 出 worker 子进程**跑 PTY（`worker-terminal-manager.ts` / `terminal-worker-process.ts`），隔离 node-pty/ConPTY 崩溃，避免拖垮主进程。
- 每终端 UUID `id`；内嵌 `@xterm/headless` 解析 ANSI 得网格快照（`terminal.ts` ~L848 `scrollback:1000`）。

### 3.2 输出下行三层管道
```
PTY(worker) → headless xterm 解析 → TerminalOutputCoalescer[worker] (≤1 IPC/5ms)
  → process.send(IPC) → daemon → TerminalOutputCoalescer[per client] → 二进制 WS 帧 → client xterm.write
```
- **revision**：`terminal.ts writeOutputToHeadless()` 每次 `terminal.write` 回调后 `stateRevision += 1`，随 output 广播。
- 合并器（`terminal-output-coalescer.ts`）两段节流：**leading**（空闲≥5ms 立即 flush=回显零延迟）+ **trailing**（持续流量缓冲 5ms 合并）；合并块携带 **最后一块的 revision**（去重才正确）。

### 3.3 二进制帧（`packages/protocol/src/binary-frames/terminal.ts`）
`[opcode:1B][slot:1B][payload]`，opcode：`0x01 Output / 0x02 Input / 0x03 Resize(JSON{rows,cols}) / 0x04 Snapshot(JSON 网格) / 0x05 Restore(ANSI 序列)`。slot 0–255 单连接多终端复用。

### 3.4 输入上行 + resize
- 输入：`0x02` → daemon 解码 UTF-8 → `terminal.send({type:"input"})`；`terminal.ts` 累积 pendingInput 后 `setImmediate` 批量 `ptyProcess.write`（避免多客户端竞争多次系统调用）。
- resize：`0x03` → `ptyProcess.resize`。**last-interacting-client-wins**；只在真实 viewport 变化/聚焦时发；daemon **不广播 resize**（靠 PTY 重绘的正常 output 流），各客户端本地独立渲染。

### 3.5 多客户端广播
- `terminal.ts` 维护 `listeners: Set<>`；PTY `onData` → 广播给全部订阅者；每个 `(termId, slot)` 在 `terminal-session-controller.ts` 有独立 `ActiveTerminalStream`（独立 coalescer + 背压追踪）。
- 无回声：只广播 PTY 原始输出，客户端输入不转发给其他客户端（回显由 PTY 产生）。

### 3.6 历史同步（关键，`terminal-restore.ts` + `terminal-session-controller.ts`）
- 两种 restore：`mode:"live"`（仅 snapshotReady+revision，不送网格）；`mode:"visible-snapshot"{scrollbackLines}`（送 Restore 帧=ANSI 网格，默认 200、上限 500）。
- 订阅落地：标记 needsSnapshot → 生成快照 → 发 Restore → 缓冲此后 output → snapshotReady 后回放缓冲并**去重**：`output.revision <= replayRevision` 跳过（已在快照中）。
- 新客户端（手机）= 先看历史网格，再无缝续接增量，不重不漏。

### 3.7 背压（`terminal-session-controller.ts` ~L865）
- 依据 **transport bufferedAmount**，非输出体积：`outputBytesSinceSnapshot > 256KB` **且** `clientBufferedAmount > 4MB` → 转快照对齐（needsSnapshot）。快客户端永不卡，只有真堆积的慢客户端走快照救援。
- 基准：echo p50~2.3ms；浏览器 keydown→commit p50~18ms（含网络）。日志 `ws_runtime_metrics`。

---

## 4. 客户端（`packages/client` / `app` / `desktop` / `cli`）

### 4.1 共享 client 库（`packages/client/src/daemon-client.ts`）
- `DaemonClient`：单连接生命周期、重连、JSON+二进制路由、超时。
- 三种 transport：`WebSocket` / `RelayE2ee`（Curve25519+XSalsa20）/ `LocalSocket|LocalPipe`（桌面本地 IPC）。
- 高层 `PaseoClient`：`workspaces/agents/providers/config` + handle 模式（稳定 id + `latest()` 缓存 + `refetch()`）。

### 4.2 app（`packages/app`，Expo/RN）
- `react-native 0.81` + `expo 54` + `@xterm/xterm 6.1-beta` + `expo-router` + `expo-camera`(扫码) + Unistyles + Reanimated + AsyncStorage。
- 连接管理 `runtime/host-runtime.ts`：多 `HostConnection` 候选 + 健康探测(2s) + 延迟自适应切换(40ms 阈值)。
- 配对 UI：`add-host-modal.tsx`(直连 TCP)、`pair-link-modal.tsx`(粘贴 relay 链接)、`app/pair-scan.tsx`(相机扫码 `CameraView` barcodes:["qr"])。
- 终端渲染：**web** `terminal-emulator.web.tsx` 直接 xterm DOM（WebGL）；**native** `terminal-emulator.native.tsx` = `react-native-webview` 内跑 xterm.js，RN↔JS bridge 传 I/O；Metro 按 `.web/.native/.electron` 扩展名选实现。
- 平台门 `@/constants/platform`：`isWeb/isNative/getIsElectron()/useIsCompactFormFactor()`。

### 4.3 desktop（`packages/desktop`，Electron）
- 独立 Electron 应用，**加载 app 的 web 构建**（非源码复用）；`daemon-manager.ts` 可起 managed daemon 子进程或连现有 `localhost:6767`；本地 transport=IPC socket/named pipe。

### 4.4 iOS 构建
- EAS Build（`packages/app/eas.json`，`ascAppId`）或本地 `expo run:ios`；`app.config.js` 配 `bundleIdentifier`、相机/麦克风权限、`ITSAppUsesNonExemptEncryption`。
- 原生模块基本走 Expo 托管（camera/notifications/audio/file-system/webview）。

> **HtyBox 取舍**：我方 iOS 选 **Tauri Mobile**（非 Expo），复用 HtyBox 现有 React+xterm 前端，仅换 transport 为远程 WS；终端同样是 xterm 跑在 WebView。理由与权衡见 `01` §3.4 A6、§7、§10。

---

## 5. 关键文件索引（paseo 相对路径）

| 主题 | 文件 |
|---|---|
| 监听/bootstrap | `packages/server/src/server/bootstrap.ts` |
| 密钥对 | `packages/server/src/server/daemon-keypair.ts` |
| 配对 offer | `packages/server/src/server/pairing-offer.ts`、`packages/protocol/src/connection-offer.ts` |
| E2E 通道/加密 | `packages/relay/src/encrypted-channel.ts`、`crypto.ts` |
| relay 转发 | `packages/relay/src/cloudflare-adapter.ts`、`types.ts` |
| WS server/握手 | `packages/server/src/server/websocket-server.ts` |
| 会话 dispatcher | `packages/server/src/server/session.ts` |
| 协议 schema | `packages/protocol/src/messages.ts` |
| 终端二进制帧 | `packages/protocol/src/binary-frames/terminal.ts` |
| 终端核心/广播/revision | `packages/server/src/terminal/terminal.ts` |
| 合并器 | `packages/server/src/terminal/terminal-output-coalescer.ts` |
| 多流/背压/快照回放 | `packages/server/src/terminal/terminal-session-controller.ts` |
| 快照模式 | `packages/server/src/terminal/terminal-restore.ts` |
| 客户端库 | `packages/client/src/daemon-client.ts`、`index.ts` |
| 连接管理 | `packages/app/src/runtime/host-runtime.ts` |
| 配对 UI | `packages/app/src/components/add-host-modal.tsx`、`pair-link-modal.tsx`、`app/pair-scan.tsx` |
| 终端渲染 | `packages/app/src/components/terminal-emulator.{web,native}.tsx`、`terminal-pane.tsx` |
| 文档 | `docs/architecture.md`、`rpc-namespacing.md`、`data-model.md`、`terminal-performance.md`、`timeline-sync.md`、`SECURITY.md` |
