//! 配对 offer（03-spec §7）：`htybox://pair#offer=base64url(json)`。
//!
//! `#` 后为 fragment，不随网络请求上送，由客户端本地解析。二维码编码完整 URL。

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::{LinkError, Result};

/// LAN 直连候选。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct LanEndpoint {
    pub host: String,
    pub port: u16,
}

/// relay 远程候选。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelayEndpoint {
    pub endpoint: String,
    pub use_tls: bool,
}

/// 配对 offer（03-spec §7.1）。`lan`/`relay` 至少有其一。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionOffer {
    pub v: u32,
    pub server_id: String,
    pub host_name: String,
    /// Host 的 Curve25519 公钥（base64，标准变体）。
    pub host_public_key_b64: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lan: Option<LanEndpoint>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub relay: Option<RelayEndpoint>,
}

const URL_PREFIX: &str = "htybox://pair#offer=";

/// 编码为配对 URL（`htybox://pair#offer=base64url(json)`）。
pub fn encode_offer_url(offer: &ConnectionOffer) -> Result<String> {
    let json = serde_json::to_vec(offer)?;
    Ok(format!("{URL_PREFIX}{}", URL_SAFE_NO_PAD.encode(json)))
}

/// 从配对 URL 解析 offer。
pub fn parse_offer_url(url: &str) -> Result<ConnectionOffer> {
    // 容忍前面有无 scheme，只要含 `#offer=`。
    let idx = url
        .find("#offer=")
        .ok_or(LinkError::BadOffer("missing #offer= fragment"))?;
    let b64 = &url[idx + "#offer=".len()..];
    let json = URL_SAFE_NO_PAD
        .decode(b64.trim())
        .map_err(|e| LinkError::Base64(e.to_string()))?;
    Ok(serde_json::from_slice(&json)?)
}
