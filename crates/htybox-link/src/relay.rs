//! relay 信封层控制消息与 URL 助手（`Document/03-protocol-spec.md` §9）。
//!
//! relay 与 Host/客户端只在这一层交互：控制通道上收发 [`RelayControl`] JSON 文本帧，
//! 数据通道上**逐字节转发**密文帧（relay 不解析 E2E 内层）。本模块被中继服务端
//! (`htybox-relay`) 与 Host 反连客户端 (`relay_client`) 共享，保证两端字节对齐。

use serde::{Deserialize, Serialize};

/// relay 控制通道消息（控制 socket 上的 JSON 文本帧）。
///
/// 线格式 = `#[serde(tag="type")]` + camelCase：
/// - [`RelayControl::Sync`] → `{"type":"sync"}`（Host 连上控制通道首发，声明归属；serverId 在 URL 路径）
/// - [`RelayControl::Connected`] → `{"type":"connected","connectionId":"…"}`（relay→Host：有客户端连上，Host 开同 id 数据 socket）
/// - [`RelayControl::Disconnected`] → `{"type":"disconnected","connectionId":"…"}`（relay→Host：该连接断开）
/// - [`RelayControl::Ping`] / [`RelayControl::Pong`] → `{"type":"ping"}` / `{"type":"pong"}`（应用层心跳）
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum RelayControl {
    Sync,
    Connected { connection_id: String },
    Disconnected { connection_id: String },
    Ping,
    Pong,
}

/// 控制通道路径 `/session/{serverId}`。
pub fn control_path(server_id: &str) -> String {
    format!("/session/{server_id}")
}

/// 数据通道路径 `/session/{serverId}/{connectionId}`。
pub fn data_path(server_id: &str, connection_id: &str) -> String {
    format!("/session/{server_id}/{connection_id}")
}

fn scheme(use_tls: bool) -> &'static str {
    if use_tls {
        "wss"
    } else {
        "ws"
    }
}

/// 完整控制通道 URL：`{ws|wss}://{endpoint}/session/{serverId}`（Host 反连用）。
pub fn control_url(endpoint: &str, use_tls: bool, server_id: &str) -> String {
    format!("{}://{endpoint}{}", scheme(use_tls), control_path(server_id))
}

/// 完整数据通道 URL：`{ws|wss}://{endpoint}/session/{serverId}/{connectionId}`（Host/客户端数据 socket 用）。
pub fn data_url(endpoint: &str, use_tls: bool, server_id: &str, connection_id: &str) -> String {
    format!("{}://{endpoint}{}", scheme(use_tls), data_path(server_id, connection_id))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn control_json_wire_format() {
        assert_eq!(serde_json::to_string(&RelayControl::Sync).unwrap(), r#"{"type":"sync"}"#);
        assert_eq!(serde_json::to_string(&RelayControl::Ping).unwrap(), r#"{"type":"ping"}"#);
        assert_eq!(serde_json::to_string(&RelayControl::Pong).unwrap(), r#"{"type":"pong"}"#);
        assert_eq!(
            serde_json::to_string(&RelayControl::Connected { connection_id: "c1".into() }).unwrap(),
            r#"{"type":"connected","connectionId":"c1"}"#
        );
        assert_eq!(
            serde_json::to_string(&RelayControl::Disconnected { connection_id: "c1".into() }).unwrap(),
            r#"{"type":"disconnected","connectionId":"c1"}"#
        );
    }

    #[test]
    fn control_roundtrip() {
        for m in [
            RelayControl::Sync,
            RelayControl::Connected { connection_id: "abc".into() },
            RelayControl::Disconnected { connection_id: "abc".into() },
            RelayControl::Ping,
            RelayControl::Pong,
        ] {
            let s = serde_json::to_string(&m).unwrap();
            let back: RelayControl = serde_json::from_str(&s).unwrap();
            assert_eq!(m, back);
        }
    }

    #[test]
    fn url_helpers() {
        assert_eq!(control_path("srv"), "/session/srv");
        assert_eq!(data_path("srv", "conn"), "/session/srv/conn");
        assert_eq!(control_url("relay.x:443", true, "srv"), "wss://relay.x:443/session/srv");
        assert_eq!(data_url("127.0.0.1:6868", false, "srv", "conn"), "ws://127.0.0.1:6868/session/srv/conn");
    }
}
