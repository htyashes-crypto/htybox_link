# HtyBox Link

HtyBox 双端方案的**连接层**：Host（HtyBox 桌面）与客户端（HtyBox_ios / 前端）之间的共享协议，外加（后续）relay 中继。

- `crates/htybox-link/` — Rust 协议库（Host 与 relay 依赖）：WS 分帧 / 握手 / 终端二进制帧 / 配对 offer / E2E。
- `ts/` — TypeScript 绑定（前端 / iOS 客户端依赖）：同源消息类型 + `DaemonClient` 客户端封装。
- `test-vectors/` — 跨语言一致性测试向量（Rust 与 TS 共用，锁定字节级契约）。
- `Document/` — 设计文档：`01-双端方案总体设计` / `02-paseo参考详解` / `03-protocol-spec`（协议契约，单一事实来源）。

当前阶段：**L1 协议骨架**（纯库 + 单测，不接 Host、不连网络）。里程碑见 `Document/01` §9。
