//! HtyBox Link 协议层（L1 骨架）。
//!
//! 三端共享的连接协议基座：WS 分帧 / hello+features 握手 / 终端二进制帧 /
//! 配对 offer / Curve25519+XSalsa20-Poly1305 E2E。纯库、无运行时（不引 tokio/网络）。
//! 契约见 `Document/03-protocol-spec.md`（单一事实来源）。

pub mod e2e;
pub mod frame;
pub mod handshake;
pub mod offer;
pub mod rpc;
pub mod terminal;

/// 协议版本（见 03-spec §1）。
pub const PROTOCOL_VERSION: u32 = 1;

/// 协议层统一错误。
#[derive(Debug, thiserror::Error)]
pub enum LinkError {
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("base64 decode: {0}")]
    Base64(String),
    #[error("utf8: {0}")]
    Utf8(#[from] std::str::Utf8Error),
    #[error("bad frame: {0}")]
    BadFrame(&'static str),
    #[error("crypto: decrypt/auth failed")]
    Crypto,
    #[error("bad offer url: {0}")]
    BadOffer(&'static str),
}

pub type Result<T> = std::result::Result<T, LinkError>;
