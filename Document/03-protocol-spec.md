# HtyBox Link 协议规范 v1（三端契约）

> 状态：规范稿 v1（2026-06-25）。本文是 Host / 前端 / iOS / relay 四方的**单一事实来源**。
> Rust crate（`crates/htybox-link`）与 TS 绑定（`ts/`）两侧实现都必须对齐本文。
> 设计依据见 `01-双端方案总体设计.md` §4 与 `02-paseo参考详解.md`。

## 1. 约定与版本

- **字节序**：二进制帧多字节字段一律大端（network order）。
- **编码**：JSON 为 UTF-8；终端 payload 为原始字节流（不做 UTF-8 校验，半截字符交客户端 xterm 处理）。
- **ID**：`serverId` / `clientId` / `requestId` / `terminalId` 均为 UUIDv4 字符串。
- **时间**：ISO-8601 UTC 字符串（如 `2026-06-25T10:00:00Z`）。
- **`protocolVersion`**：整数，本规范 = `1`。单调递增；**破坏性能力变更不靠版本号，靠 `features` 协商**（见 §3.3）。
- **兼容铁律**（照搬 paseo）：
  - 新增字段必 optional + 合理默认；**不得**删字段、收窄类型、把 optional 翻 required。
  - 旧端必须能解析新端消息（多余字段忽略）；新端必须能解析旧端消息（缺字段走默认）。
  - 每个兼容 shim 标 `// COMPAT(<name>): added v1.x, drop after <date>`；`rg "COMPAT\("` 可列全。

## 2. 传输与分帧

- 单条 **WebSocket** 连接承载全部通信，混合两类 WS 帧：
  - **WS 文本帧 = JSON**：握手、RPC（请求/响应/错误）、服务端推送事件、E2E 明文握手。
  - **WS 二进制帧 = 终端帧**：`[opcode:1B][slot:1B][payload...]`（见 §6）。
- **加密信道**（LAN 可选 / relay 强制）一旦建立：**所有** WS 文本与二进制帧改为统一封装为**密文二进制帧**：
  ```
  密文帧 = [ 0x00 (magic) ][ inner_kind:1B ][ nonce:24B ][ ciphertext... ]
  inner_kind: 0x01 = 内层为 JSON 文本帧   0x02 = 内层为终端二进制帧
  ciphertext = XSalsa20Poly1305(shared_key, nonce, inner_bytes)
  ```
  - `0x00` magic 区分"密文帧"与"明文握手帧"（明文 JSON 以 `{` 开头、明文终端帧首字节是 opcode 0x01–0x05，均 ≠ 0x00）。
  - 解密后按 `inner_kind` 还原为 §4 的 JSON 或 §6 的终端帧处理。
- **未加密信道**（仅本地 `127.0.0.1` 直连且未开密码/加密时）：JSON 直接走文本帧、终端帧直接走二进制帧，无 `0x00` 封装。
- 帧大小：单 WS 帧建议 ≤ 1 MiB；超长终端输出由发送端切分为多个 Output 帧。

## 3. 握手

连接建立（且 E2E 完成，若启用）后，客户端**先发** `hello`，Host **必回** `server_info`，然后才可发其它 RPC。

### 3.1 client → `hello`
```jsonc
{
  "type": "hello",
  "clientId": "<uuid>",            // 客户端实例 id（持久化，便于 Host 关联设备）
  "clientType": "desktop" | "ios" | "android" | "web" | "cli",
  "protocolVersion": 1,
  "appVersion": "1.0.0",
  "capabilities": {                // 客户端能力位，可空；未知键忽略
    "terminalBinary": true         // 是否支持二进制终端帧（v1 必 true）
  }
}
```

### 3.2 Host → `server_info`
```jsonc
{
  "type": "server_info",
  "serverId": "<uuid>",            // 与配对 offer 中一致
  "hostName": "DESKTOP-XXXX",      // 展示用
  "appVersion": "1.0.0",
  "protocolVersion": 1,
  "features": {                    // 能力协商：客户端检测到才启用对应功能
    "terminalRestore": true,       // 支持 snapshot/restore 历史重放
    "pairing": true,               // 支持配对管理 RPC
    "relay": true                  // Host 已接入 relay
    // COMPAT(<feature>): added v1.x, drop after <date>
  }
}
```

### 3.3 能力协商规则
- 客户端**只**在 `server_info.features.X` 为真时启用特性 X；否则提示「请升级 Host」。**无降级路径**：不为缺失能力写"模拟实现"。
- 新增 Host 能力 → 加 `features.X`，客户端检测；新增客户端能力 → 加 `hello.capabilities.Y`，Host 检测。
- 鉴权失败 / 协议过低：Host 回 `rpc_error`（见 §4.4）并关闭连接，`code` 用 `unauthorized` / `protocol_too_old`。

## 4. JSON-RPC

### 4.1 命名
- `域.操作.request` ↔ `域.操作.response`（dotted namespace + 方向后缀）。
- 域：`host` / `terminal` / `pairing` / `workspace`（v1）；后续 `agent` 等照此扩展。

### 4.2 请求
```jsonc
{ "type": "terminal.create.request", "requestId": "<uuid>", /* ...参数 */ }
```

### 4.3 响应
```jsonc
{ "type": "terminal.create.response", "requestId": "<uuid>", "payload": { /* ... */ } }
```
- `requestId` 原样回填；客户端按它匹配 pending 请求。

### 4.4 错误
```jsonc
{ "type": "rpc_error", "requestId": "<uuid>", "requestType": "terminal.create.request",
  "error": "no such terminal", "code": "not_found" }
```
- `code` 枚举（可扩展）：`bad_request` / `unauthorized` / `not_found` / `unsupported`(能力缺失) / `protocol_too_old` / `internal`。

### 4.5 推送事件（无 `requestId`）
```jsonc
{ "type": "terminal.exit", "payload": { "terminalId": "<uuid>", "exitCode": 0 } }
```

## 5. RPC 目录（v1）

### 5.1 host 域
- `host.info.request` → `response{ payload:{ serverId, hostName, appVersion, cwdDefault } }`：基础信息（与 server_info 冗余字段允许）。
- `host.workspaces.list.request` → `response{ payload:{ workspaces:[{ id, name, path }] } }`：列工作区（对应 HtyBox 已打开工作区）。
- 推送 `host.workspaces.update{ workspaces:[...] }`：工作区集合变化。

### 5.2 terminal 域
- `terminal.list.request` → `response{ payload:{ terminals:[{ terminalId, title, cwd, cols, rows, workspaceId? }] } }`。
- `terminal.create.request{ shell?, cwd?, cols, rows, env?, workspaceId? }` → `response{ payload:{ terminalId } }`。
- `terminal.subscribe.request{ terminalId, restore: {mode:"live"} | {mode:"visible-snapshot", scrollbackLines?} }`
  → `response{ payload:{ slot, revision } }`，随后 Host 发 Snapshot/Restore（§6）+ Output 流。
- `terminal.unsubscribe.request{ terminalId }` → `response{ payload:{} }`：释放该客户端对该终端的订阅/slot（不杀终端）。
- `terminal.kill.request{ terminalId }` → `response{ payload:{} }`：结束 PTY。
- `terminal.rename.request{ terminalId, title }` → `response{ payload:{} }`。
- 推送：`terminal.exit{ terminalId, exitCode? }`、`terminal.title{ terminalId, title }`。
- 注：输入 / resize / 输出 走**二进制帧**（§6），不走 JSON-RPC。

### 5.3 pairing 域（多在 Host 本地 UI 用，远程客户端一般只读）
- `pairing.offer.get.request` → `response{ payload:{ offerUrl, offer } }`：生成当前 offer（§7）+ 可展示链接/二维码内容。
- `pairing.devices.list.request` → `response{ payload:{ devices:[{ clientId, label, lastSeenAt, transport }] } }`。
- `pairing.devices.revoke.request{ clientId }` → `response{ payload:{} }`：吊销某设备（断开 + 拒绝后续；见 §8.5 设备策略）。

### 5.4 workspace 域（v1 最小）
- `workspace.title.set.request{ workspaceId, title }` → `response{ payload:{} }`（可选）。

> v1 不含 agent/chat/schedule 等高级域——先把"远程看&操控终端"打通；后续按 paseo 域扩展，遵守 §1 兼容铁律。

## 6. 终端二进制帧

帧布局：`[opcode:1B][slot:1B][payload...]`。`slot` 由 `terminal.subscribe.response` 分配（0–255），单连接内 `slot ↔ terminalId` 一一映射。

| opcode | 名称 | 方向 | payload |
|---|---|---|---|
| `0x01` | Output | Host→Client | `[revision:u64 BE][bytes...]` 原始 PTY 输出字节 |
| `0x02` | Input | Client→Host | 原始输入字节（按键/粘贴） |
| `0x03` | Resize | Client→Host | JSON `{"cols":N,"rows":N}`（UTF-8） |
| `0x04` | Snapshot | Host→Client | `[revision:u64 BE]` + JSON 网格快照（结构见下；v1 可选） |
| `0x05` | Restore | Host→Client | `[revision:u64 BE][ansi bytes...]` 历史 ANSI 重放 |

### 6.1 revision 语义
- Host 侧每个终端持 `revision: u64`，每读到一段 PTY 输出自增。
- Output/Snapshot/Restore 均携带其代表的 `revision`（合并多块时取**最后一块**的 revision）。
- 客户端订阅历史后做去重：收到 Output 时若 `revision <= 已重放到的 revision` 则丢弃（已含在快照/Restore 内）。

### 6.2 订阅与历史重放时序
```
Client → terminal.subscribe.request{ terminalId, restore }
Host   → terminal.subscribe.response{ slot, revision:R0 }
若 restore.mode=="visible-snapshot":
  Host → Restore 帧(slot, revision R0, ANSI 历史)
Host   → Output 帧(slot, revision >R0) ... 实时流
Client：渲染 Restore；对 Output 按 revision>R0 去重后 xterm.write
```
- `mode:"live"`：不发 Restore，仅以 `R0` 为基线开始；客户端只看订阅后的新输出。

### 6.3 Snapshot JSON（v1 可选，先用 Restore-ANSI 实现，Snapshot 留扩展）
```jsonc
{ "cols":80, "rows":24, "cursor":{"x":0,"y":0},
  "lines":[ { "cells":[ {"ch":"$","fg":7,"bg":0,"bold":false}, ... ] }, ... ] }
```

### 6.4 输入/合并/背压（实现约束，非线格式）
- Host 收 Input 累积后批量写 PTY（避免多客户端竞争多次系统调用）。
- Output 发送端两段合并（leading 空闲≥5ms 立即 flush + trailing 5ms 缓冲），合并块带最后 revision。
- 背压依据 WS 发送缓冲：超阈值（参考 256KB 输出 + 4MB 缓冲）对该慢客户端转 Snapshot/Restore 对齐，不阻塞其他客户端。
- resize：last-interacting-client-wins；Host **不**把 resize 广播给其他客户端（靠 PTY 重绘的 Output）。

## 7. 配对 offer

### 7.1 schema
```jsonc
{
  "v": 1,
  "serverId": "<uuid>",
  "hostName": "DESKTOP-XXXX",
  "hostPublicKeyB64": "<curve25519 公钥, base64>",
  "lan":   { "host": "192.168.1.23", "port": 6767 },          // 可空：无 LAN 时省略
  "relay": { "endpoint": "relay.htybox.example:443", "useTls": true } // 可空：未启用 relay 时省略
}
```

### 7.2 URL / 二维码
- 形如 `htybox://pair#offer=<base64url(json)>`；`#` 后为 fragment，**不随网络请求上送**，客户端本地解析。
- 二维码编码该完整 URL。也提供"复制链接"。

### 7.3 客户端保存
```jsonc
// HostProfile（客户端持久化；iOS 存 Keychain，桌面存 localStorage/配置）
{ "serverId":"<uuid>", "label":"我的台式机", "hostPublicKeyB64":"...",
  "connections":[ {"id":"lan","host":"192.168.1.23","port":6767},
                  {"id":"relay","endpoint":"relay...","useTls":true} ],
  "preferredConnectionId":"relay", "createdAt":"...", "updatedAt":"..." }
```
- 多连接候选 + 健康探测自适应选路（LAN 优先、回退 relay）。免重扫复用。

## 8. E2E 握手与加密

### 8.1 算法
- 密钥协商：**Curve25519 ECDH**；对称加密：**XSalsa20-Poly1305**（NaCl `box.before`/`box.open.after`，24B nonce）。
- Host 持长期密钥对（公钥进 offer）；客户端每次连接生成**临时**密钥对。
- Rust：`crypto_box`(x25519 + xsalsa20poly1305) 或 `sodiumoxide`/`libsodium-sys`。TS：`tweetnacl` / `libsodium-wrappers`。两端跑同一测试向量。

### 8.2 握手（明文阶段，可经 relay 透传）
```
Client → {"type":"e2ee_hello","key":"<client 临时公钥 B64>"}
Host   → {"type":"e2ee_ready"}     // 双方各自 ECDH → 相同 shared_key
```
- 握手这两条为**明文** WS 文本帧（首字符 `{`，不与 §2 的 `0x00` 密文帧冲突）。
- `e2ee_ready` 之后，双方一切帧按 §2 密文帧封装（`0x00 | inner_kind | nonce | ciphertext`）。
- Host 收到 hello 前若先到密文帧：缓冲，待 shared_key 就绪后解密；解密失败 → 关闭连接。

### 8.3 nonce
- 每帧随机 24B nonce（XSalsa20 nonce 空间足够大，随机即可）；放帧头明文。
- v1 不带重放计数器（同 paseo）；relay 信道短、且 NaCl 认证防篡改。**若后续要防重放**：加单调递增 counter 字段并校验，记 COMPAT。

### 8.4 信任模型
- offer 中的 `hostPublicKeyB64` 是唯一信任锚；客户端只对该公钥加密 → 只有持私钥的 Host 能解。
- relay / LAN 中间人无 Host 私钥 → 无法解密/伪造。
- **本地 `127.0.0.1` 直连**：可跳过 E2E（loopback 信任）；可选叠加 Bearer 密码做深度防御。

### 8.5 设备策略（v1 简化）
- v1 采用 paseo 式"公钥即信任、无显式白名单"：能完成 E2E 即视为已配对。
- `pairing.devices.list` 展示近期连接过的 `clientId`（仅记录元数据）；`revoke` = 断开并（可选）轮换 Host 密钥使旧 offer 失效（轮换会让所有已配对设备需重配，谨慎）。
- 进阶（后续，记 COMPAT）：客户端首连时由 Host UI 显式"批准"，落显式白名单。

## 9. relay 信封协议（relay 只看这层）

- Host 反连（控制通道）：`wss://<endpoint>/session/{serverId}`，连上发 `{"type":"sync"}`。
- 客户端连（数据通道）：`wss://<endpoint>/session/{serverId}/{connectionId}`（`connectionId` 客户端生成）。
- relay：按 `serverId` 找 Host 控制通道、按 `connectionId` 建立"客户端↔Host"双向转发；向 Host 控制通道发 `{"type":"connected","connectionId":...}` / `{"type":"disconnected","connectionId":...}`。
- 心跳：`{"type":"ping"}` / `{"type":"pong"}`。
- relay 转发的是 §2/§8 的密文帧字节，**不解析内层**；relay 不需要也不实现 §3–§7 任何语义。
- 抢占：同 `serverId` 出现新控制连接时，relay 需校验（v1 可简单顶替；进阶加 Host 出示签名证明持有私钥）。

## 10. 超时 / 重连 / 心跳（客户端实现约束）

- 请求超时：默认 15s 无 response → 报错（可配）。
- WS 断开 → 指数退避重连（如 0.5s→8s 上限）；重连后重发 `hello`、重新 `terminal.subscribe`（带 `restore` 拿历史，靠 revision 去重续接）。
- 应用层心跳（除 relay 信封 ping 外）：可用空 `host.info` 或 WS ping 维持 NAT 映射。
- iOS 切后台/息屏：回前台触发重连 + 重订阅 + 历史重放（依赖 §6.2）。

## 11. 兼容性矩阵与扩展纪律

| 变更类型 | 做法 |
|---|---|
| 加新 RPC | 直接加 `域.操作.request/response`；旧端不认会回 `rpc_error{code:"unsupported"}`，客户端按能力位规避 |
| 加新字段 | optional + 默认；旧端忽略 |
| 加新能力 | `server_info.features.X` / `hello.capabilities.Y`；对端检测后启用 |
| 加新 opcode | 新增高位 opcode；旧端遇未知 opcode 丢弃该帧（不崩） |
| 弃用字段 | 停发但继续接受解析；标 COMPAT + 删除日期 |

- 禁止：删字段 / 收窄类型 / optional→required / 复用 opcode 改语义。
- 每个 shim：`// COMPAT(<name>): added v1.x, drop after <date>`。

---

## 附：v1 实现清单（与 `01` §9 里程碑对应）
- `crates/htybox-link`：§2 分帧、§3 握手、§6 终端帧编解码、§7 offer 编解码、§8 E2E。单测覆盖：帧往返、ECDH 双向一致、篡改解密失败、revision 去重。
- `ts/`：同源消息类型 + `DaemonClient`（连接/重连/RPC/订阅/E2E transport/选路）。
- relay：§9 信封转发（独立 Rust 服务）。
- 三端对齐本文；任何分歧以本文为准并同步修订 `01`。
