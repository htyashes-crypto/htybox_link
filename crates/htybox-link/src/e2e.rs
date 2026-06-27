//! 端到端加密（03-spec §8）：Curve25519 ECDH + XSalsa20-Poly1305（NaCl box）。
//!
//! 与 TS 侧 `tweetnacl` 的 `nacl.box` 字节兼容（同为 NaCl crypto_box）。
//! seal 输出 `nonce(24) ++ ciphertext`；密钥 32B。

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use crypto_box::{
    aead::{Aead, AeadCore, OsRng},
    PublicKey, SalsaBox, SecretKey,
};
use serde::{Deserialize, Serialize};

use crate::{LinkError, Result};

/// 公钥/私钥字节数（Curve25519）。
pub const KEY_SIZE: usize = 32;
/// XSalsa20-Poly1305 nonce 字节数。
pub const NONCE_SIZE: usize = 24;

/// X25519 密钥对。私钥由 `crypto_box::SecretKey` 持有（drop 时自动 zeroize）。
pub struct KeyPair {
    secret: SecretKey,
    public: PublicKey,
}

impl KeyPair {
    /// 随机生成（用 OS RNG）。
    pub fn generate() -> Self {
        let secret = SecretKey::generate(&mut OsRng);
        let public = secret.public_key();
        Self { secret, public }
    }

    /// 从 32 字节私钥还原（用于固定测试向量 / 持久化加载）。
    pub fn from_secret_bytes(bytes: [u8; KEY_SIZE]) -> Self {
        let secret = SecretKey::from_bytes(bytes);
        let public = secret.public_key();
        Self { secret, public }
    }

    pub fn public_bytes(&self) -> [u8; KEY_SIZE] {
        *self.public.as_bytes()
    }

    pub fn secret_bytes(&self) -> [u8; KEY_SIZE] {
        self.secret.to_bytes()
    }

    pub fn public_b64(&self) -> String {
        STANDARD.encode(self.public_bytes())
    }

    /// 与对端公钥协商出加密盒（双方各算得相同结果 → 可互相 seal/open）。
    pub fn box_with(&self, their_public: &[u8; KEY_SIZE]) -> SalsaBox {
        SalsaBox::new(&PublicKey::from_bytes(*their_public), &self.secret)
    }
}

/// 解析 base64 公钥为 32 字节。
pub fn public_from_b64(b64: &str) -> Result<[u8; KEY_SIZE]> {
    let raw = STANDARD
        .decode(b64.trim())
        .map_err(|e| LinkError::Base64(e.to_string()))?;
    raw.as_slice()
        .try_into()
        .map_err(|_| LinkError::BadFrame("public key not 32 bytes"))
}

/// 用指定 nonce 加密（确定性，供测试向量用）：输出 `nonce(24) ++ ciphertext`。
pub fn seal_with_nonce(sbox: &SalsaBox, nonce: &[u8; NONCE_SIZE], plaintext: &[u8]) -> Vec<u8> {
    let nonce = crypto_box::Nonce::from_slice(nonce);
    let ct = sbox.encrypt(nonce, plaintext).expect("salsabox encrypt");
    let mut out = Vec::with_capacity(NONCE_SIZE + ct.len());
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&ct);
    out
}

/// 加密：随机 nonce，输出 `nonce(24) ++ ciphertext`。
pub fn seal(sbox: &SalsaBox, plaintext: &[u8]) -> Vec<u8> {
    let nonce = SalsaBox::generate_nonce(&mut OsRng);
    let mut arr = [0u8; NONCE_SIZE];
    arr.copy_from_slice(nonce.as_slice());
    seal_with_nonce(sbox, &arr, plaintext)
}

/// 解密 `nonce(24) ++ ciphertext`；篡改 / 认证失败 → `Err(Crypto)`。
pub fn open(sbox: &SalsaBox, data: &[u8]) -> Result<Vec<u8>> {
    if data.len() < NONCE_SIZE {
        return Err(LinkError::BadFrame("e2e payload shorter than nonce"));
    }
    let nonce = crypto_box::Nonce::from_slice(&data[..NONCE_SIZE]);
    sbox.decrypt(nonce, &data[NONCE_SIZE..])
        .map_err(|_| LinkError::Crypto)
}

/// E2E 握手第一步：客户端 → Host（明文）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct E2eeHello {
    #[serde(rename = "type")]
    pub kind: String,
    /// 客户端临时公钥（base64）。
    pub key: String,
}

impl E2eeHello {
    pub const TYPE: &'static str = "e2ee_hello";
    pub fn new(public_b64: impl Into<String>) -> Self {
        Self { kind: Self::TYPE.to_string(), key: public_b64.into() }
    }
}

/// E2E 握手第二步：Host → 客户端（明文）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct E2eeReady {
    #[serde(rename = "type")]
    pub kind: String,
}

impl Default for E2eeReady {
    fn default() -> Self {
        Self { kind: "e2ee_ready".to_string() }
    }
}
