//! JSON-RPC 信封与 v1 域 payload（03-spec §4 / §5）。
//!
//! 三类消息：请求(带 `requestId`)、响应(回 `requestId`+`payload`)、推送事件(无 `requestId`)。
//! 命名 `域.操作.request`/`.response`。本文用泛型信封 [`Request`]/[`Response`]/[`Event`]
//! 承载各域 payload，新增 RPC 只需加 payload 结构 + 类型常量，不改信封。

use serde::{Deserialize, Serialize};

/// v1 RPC / 事件类型字符串常量（03-spec §5）。
pub mod types {
    pub const TERMINAL_LIST_REQ: &str = "terminal.list.request";
    pub const TERMINAL_LIST_RESP: &str = "terminal.list.response";
    pub const TERMINAL_CREATE_REQ: &str = "terminal.create.request";
    pub const TERMINAL_CREATE_RESP: &str = "terminal.create.response";
    pub const TERMINAL_SUBSCRIBE_REQ: &str = "terminal.subscribe.request";
    pub const TERMINAL_SUBSCRIBE_RESP: &str = "terminal.subscribe.response";
    pub const TERMINAL_UNSUBSCRIBE_REQ: &str = "terminal.unsubscribe.request";
    pub const TERMINAL_UNSUBSCRIBE_RESP: &str = "terminal.unsubscribe.response";
    pub const TERMINAL_KILL_REQ: &str = "terminal.kill.request";
    pub const TERMINAL_KILL_RESP: &str = "terminal.kill.response";
    pub const TERMINAL_RENAME_REQ: &str = "terminal.rename.request";
    pub const TERMINAL_RENAME_RESP: &str = "terminal.rename.response";
    pub const HOST_WORKSPACES_LIST_REQ: &str = "host.workspaces.list.request";
    pub const HOST_WORKSPACES_LIST_RESP: &str = "host.workspaces.list.response";
    pub const EVT_TERMINAL_EXIT: &str = "terminal.exit";
    pub const EVT_TERMINAL_TITLE: &str = "terminal.title";
    pub const EVT_WORKSPACES_UPDATE: &str = "host.workspaces.update";
    // L5-4P-2：只读 catalog 域（镜像桌面左侧 Content）
    pub const CATALOG_SKILLS_LIST_REQ: &str = "catalog.skills.list.request";
    pub const CATALOG_SKILLS_LIST_RESP: &str = "catalog.skills.list.response";
    pub const CATALOG_MEMORIES_LIST_REQ: &str = "catalog.memories.list.request";
    pub const CATALOG_MEMORIES_LIST_RESP: &str = "catalog.memories.list.response";
    pub const CATALOG_FILES_LIST_REQ: &str = "catalog.files.list.request";
    pub const CATALOG_FILES_LIST_RESP: &str = "catalog.files.list.response";
    pub const CATALOG_SESSIONS_LIST_REQ: &str = "catalog.sessions.list.request";
    pub const CATALOG_SESSIONS_LIST_RESP: &str = "catalog.sessions.list.response";
}

/// 通用请求信封：`{type, requestId, ...params(flatten)}`（03-spec §4.2）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Request<P> {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    #[serde(flatten)]
    pub params: P,
}

impl<P> Request<P> {
    pub fn new(kind: impl Into<String>, request_id: impl Into<String>, params: P) -> Self {
        Self { kind: kind.into(), request_id: request_id.into(), params }
    }
}

/// 通用响应信封：`{type, requestId, payload}`（03-spec §4.3）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Response<P> {
    #[serde(rename = "type")]
    pub kind: String,
    pub request_id: String,
    pub payload: P,
}

impl<P> Response<P> {
    pub fn new(kind: impl Into<String>, request_id: impl Into<String>, payload: P) -> Self {
        Self { kind: kind.into(), request_id: request_id.into(), payload }
    }
}

/// 通用推送事件信封：`{type, payload}`（03-spec §4.5）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Event<P> {
    #[serde(rename = "type")]
    pub kind: String,
    pub payload: P,
}

impl<P> Event<P> {
    pub fn new(kind: impl Into<String>, payload: P) -> Self {
        Self { kind: kind.into(), payload }
    }
}

/// RPC 错误（03-spec §4.4）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RpcError {
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    pub request_type: String,
    pub error: String,
    /// bad_request / unauthorized / not_found / unsupported / protocol_too_old / internal
    pub code: String,
}

/// 终端历史重放模式（03-spec §5.2 / §6.2）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "mode")]
pub enum RestoreMode {
    #[serde(rename = "live")]
    Live,
    #[serde(rename = "visible-snapshot")]
    VisibleSnapshot {
        #[serde(rename = "scrollbackLines", default, skip_serializing_if = "Option::is_none")]
        scrollback_lines: Option<u32>,
    },
}

// ── terminal 域 payload ───────────────────────────────────────────────

/// `terminal.create.request` 参数。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    pub cols: u16,
    pub rows: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub env: Option<std::collections::HashMap<String, String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// `terminal.create.response` payload。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalResult {
    pub terminal_id: String,
}

/// `terminal.subscribe.request` 参数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeTerminalParams {
    pub terminal_id: String,
    pub restore: RestoreMode,
}

/// `terminal.subscribe.response` payload（分配的 slot + 基线 revision）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscribeTerminalResult {
    pub slot: u8,
    pub revision: u64,
    /// 订阅时终端当前尺寸（客户端据此设置渲染网格；远程不回改 PTY）。
    pub cols: u16,
    pub rows: u16,
}

/// 仅引用某终端（unsubscribe / kill）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalRef {
    pub terminal_id: String,
}

/// `terminal.rename.request` 参数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameTerminalParams {
    pub terminal_id: String,
    pub title: String,
}

/// 终端元信息（list / 事件复用）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub terminal_id: String,
    pub title: String,
    pub cwd: String,
    pub cols: u16,
    pub rows: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}

/// `terminal.list.response` payload。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalListResult {
    pub terminals: Vec<TerminalInfo>,
}

// ── host / workspace 域 payload ───────────────────────────────────────

/// 工作区元信息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct WorkspaceInfo {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// `host.workspaces.list.response` / `host.workspaces.update` payload。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspacesResult {
    pub workspaces: Vec<WorkspaceInfo>,
    /// 当前激活工作区 id（可空；客户端默认定位到它）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub active_id: Option<String>,
}

// ── 事件 payload ──────────────────────────────────────────────────────

/// `terminal.exit` 事件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalExitEvent {
    pub terminal_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
}

/// `terminal.title` 事件。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalTitleEvent {
    pub terminal_id: String,
    pub title: String,
}
