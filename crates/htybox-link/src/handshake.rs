//! 握手与能力协商（03-spec §3）。
//!
//! 客户端连上后先发 [`Hello`]，Host 回 [`ServerInfo`]（内含 [`Features`] 能力位）。
//! 所有结构 camelCase；新增字段一律 `#[serde(default)]` + optional，保证向后兼容
//! （serde 默认忽略未知字段 → 旧端能解析新端消息）。

use serde::{Deserialize, Serialize};

/// 客户端类型（03-spec §3.1）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClientType {
    Desktop,
    Ios,
    Android,
    Web,
    Cli,
}

/// 客户端能力位（03-spec §3.1）。未知键被忽略 → 前向兼容。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientCapabilities {
    /// 是否支持二进制终端帧（v1 必 true）。
    #[serde(default)]
    pub terminal_binary: bool,
}

/// 客户端 → Host 的握手消息。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hello {
    /// 恒为 `"hello"`。
    #[serde(rename = "type")]
    pub kind: String,
    pub client_id: String,
    pub client_type: ClientType,
    pub protocol_version: u32,
    pub app_version: String,
    #[serde(default)]
    pub capabilities: ClientCapabilities,
}

impl Hello {
    pub const TYPE: &'static str = "hello";

    pub fn new(client_id: impl Into<String>, client_type: ClientType, app_version: impl Into<String>) -> Self {
        Self {
            kind: Self::TYPE.to_string(),
            client_id: client_id.into(),
            client_type,
            protocol_version: crate::PROTOCOL_VERSION,
            app_version: app_version.into(),
            capabilities: ClientCapabilities { terminal_binary: true },
        }
    }
}

/// Host 能力位（03-spec §3.2 / §3.3）。客户端检测到为真才启用对应特性。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Features {
    /// 支持 snapshot/restore 历史重放。
    #[serde(default)]
    pub terminal_restore: bool,
    /// 支持配对管理 RPC。
    #[serde(default)]
    pub pairing: bool,
    /// Host 已接入 relay。
    #[serde(default)]
    pub relay: bool,
}

/// Host → 客户端的信息与能力下发。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    /// 恒为 `"server_info"`。
    #[serde(rename = "type")]
    pub kind: String,
    pub server_id: String,
    pub host_name: String,
    pub app_version: String,
    pub protocol_version: u32,
    #[serde(default)]
    pub features: Features,
}

impl ServerInfo {
    pub const TYPE: &'static str = "server_info";

    pub fn new(
        server_id: impl Into<String>,
        host_name: impl Into<String>,
        app_version: impl Into<String>,
        features: Features,
    ) -> Self {
        Self {
            kind: Self::TYPE.to_string(),
            server_id: server_id.into(),
            host_name: host_name.into(),
            app_version: app_version.into(),
            protocol_version: crate::PROTOCOL_VERSION,
            features,
        }
    }
}
