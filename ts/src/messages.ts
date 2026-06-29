// 协议消息类型（与 Rust htybox-link 同源，03-spec §3/§4/§5/§7）。
// 字段 camelCase 天然与 Rust serde(rename_all="camelCase") 一致。

export const PROTOCOL_VERSION = 1 as const;

// ── 握手（§3）──
export type ClientType = "desktop" | "ios" | "android" | "web" | "cli";

export interface ClientCapabilities {
  terminalBinary: boolean;
  [k: string]: unknown; // 前向兼容：容未知能力位
}

export interface Hello {
  type: "hello";
  clientId: string;
  clientType: ClientType;
  protocolVersion: number;
  appVersion: string;
  capabilities: ClientCapabilities;
}

export interface Features {
  terminalRestore?: boolean;
  pairing?: boolean;
  relay?: boolean;
  [k: string]: unknown;
}

export interface ServerInfo {
  type: "server_info";
  serverId: string;
  hostName: string;
  appVersion: string;
  protocolVersion: number;
  features: Features;
}

// ── RPC 信封（§4）──
export type RpcRequest<P> = { type: string; requestId: string } & P;
export interface RpcResponse<P> {
  type: string;
  requestId: string;
  payload: P;
}
export interface RpcEvent<P> {
  type: string;
  payload: P;
}
export interface RpcError {
  type: "rpc_error";
  requestId?: string;
  requestType: string;
  error: string;
  code: string;
}

// ── 终端域 payload（§5.2 / §6.2）──
export type RestoreMode =
  | { mode: "live" }
  | { mode: "visible-snapshot"; scrollbackLines?: number };

export interface CreateTerminalParams {
  shell?: string;
  cwd?: string;
  cols: number;
  rows: number;
  env?: Record<string, string>;
  workspaceId?: string;
}
export interface CreateTerminalResult {
  terminalId: string;
}
export interface SubscribeTerminalParams {
  terminalId: string;
  restore: RestoreMode;
}
export interface SubscribeTerminalResult {
  slot: number;
  revision: number;
  /** 订阅时终端当前尺寸（客户端据此设置渲染网格；远程不回改 PTY）。 */
  cols: number;
  rows: number;
}
export interface TerminalRef {
  terminalId: string;
}
export interface RenameTerminalParams {
  terminalId: string;
  title: string;
}
export interface TerminalInfo {
  terminalId: string;
  title: string;
  cwd: string;
  cols: number;
  rows: number;
  workspaceId?: string;
}
export interface TerminalListResult {
  terminals: TerminalInfo[];
}

// ── host / workspace 域 payload（§5.1 / §5.4）──
export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
}
export interface WorkspacesResult {
  workspaces: WorkspaceInfo[];
  activeId?: string;
}

// ── catalog 域（只读镜像，§5.5）──
export interface Skill {
  name: string;
  description: string;
  path: string;
  source: string;
  invoke: string;
}
export interface MemoryItem {
  name: string;
  description: string;
  memType: string;
  path: string;
}
export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
}
export interface SessionRef {
  id: string;
  label: string;
  ts: number;
  path: string;
}
export interface SkillsResult {
  skills: Skill[];
}
export interface MemoriesResult {
  memories: MemoryItem[];
}
export interface FilesResult {
  entries: DirEntry[];
}
export interface SessionsResult {
  claude: SessionRef[];
  codex: SessionRef[];
}

// ── 事件 payload（§5.2）──
export interface TerminalExitEvent {
  terminalId: string;
  exitCode?: number;
}
export interface TerminalTitleEvent {
  terminalId: string;
  title: string;
}

// ── 配对 offer（§7）──
export interface LanEndpoint {
  host: string;
  port: number;
}
export interface RelayEndpoint {
  endpoint: string;
  useTls: boolean;
}
export interface ConnectionOffer {
  v: number;
  serverId: string;
  hostName: string;
  hostPublicKeyB64: string;
  lan?: LanEndpoint;
  relay?: RelayEndpoint;
}

// ── E2E 握手消息（§8）──
export interface E2eeHello {
  type: "e2ee_hello";
  key: string;
}
export interface E2eeReady {
  type: "e2ee_ready";
}

// ── RPC / 事件类型字符串常量（§5）──
export const RpcTypes = {
  terminalList: "terminal.list",
  terminalCreate: "terminal.create",
  terminalSubscribe: "terminal.subscribe",
  terminalUnsubscribe: "terminal.unsubscribe",
  terminalKill: "terminal.kill",
  terminalRename: "terminal.rename",
  hostWorkspacesList: "host.workspaces.list",
  catalogSkillsList: "catalog.skills.list",
  catalogMemoriesList: "catalog.memories.list",
  catalogFilesList: "catalog.files.list",
  catalogSessionsList: "catalog.sessions.list",
  evtTerminalExit: "terminal.exit",
  evtTerminalTitle: "terminal.title",
  evtWorkspacesUpdate: "host.workspaces.update",
} as const;

export const reqType = (domainOp: string) => `${domainOp}.request`;
export const respType = (domainOp: string) => `${domainOp}.response`;
