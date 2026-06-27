//! 顶层 WS 帧分类与 E2E 密文信封（03-spec §2）。
//!
//! - 明文信道：WS 文本帧=JSON、WS 二进制帧=终端帧（首字节是 opcode `0x01..=0x05`）。
//! - 加密信道：所有内层帧统一封装为密文二进制帧 `[0x00][inner_kind][nonce(24)][ct]`，
//!   首字节 magic `0x00`（≠ 任何终端 opcode）用于和明文终端帧区分。

use crypto_box::SalsaBox;

use crate::{e2e, LinkError, Result};

/// 密文信封 magic（首字节）。
pub const CIPHER_MAGIC: u8 = 0x00;

/// 密文信封内层类型（解密后如何处理）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum InnerKind {
    /// 内层为 JSON 文本帧（握手 / RPC / 事件）。
    Json = 0x01,
    /// 内层为终端二进制帧。
    Terminal = 0x02,
}

impl InnerKind {
    pub fn from_u8(b: u8) -> Result<Self> {
        Ok(match b {
            0x01 => InnerKind::Json,
            0x02 => InnerKind::Terminal,
            _ => return Err(LinkError::BadFrame("unknown inner kind")),
        })
    }
    pub fn as_u8(self) -> u8 {
        self as u8
    }
}

/// 二进制帧的分类（仅用于二进制 WS 帧；JSON 走文本帧另行处理）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BinaryClass {
    /// 密文信封（需先 [`open_frame`] 解密）。
    Cipher,
    /// 明文终端帧（直接 `terminal::decode_frame`）。
    TerminalPlain,
}

/// 判定一个二进制 WS 帧是密文信封还是明文终端帧。
pub fn classify_binary(frame: &[u8]) -> Result<BinaryClass> {
    match frame.first() {
        None => Err(LinkError::BadFrame("empty binary frame")),
        Some(&CIPHER_MAGIC) => Ok(BinaryClass::Cipher),
        Some(&b) if (0x01..=0x05).contains(&b) => Ok(BinaryClass::TerminalPlain),
        Some(_) => Err(LinkError::BadFrame("unrecognized binary frame")),
    }
}

/// 封装为密文信封：`[0x00][inner_kind][nonce(24)][ct]`。
pub fn seal_frame(sbox: &SalsaBox, inner_kind: InnerKind, inner_bytes: &[u8]) -> Vec<u8> {
    let sealed = e2e::seal(sbox, inner_bytes); // nonce ++ ct
    let mut out = Vec::with_capacity(2 + sealed.len());
    out.push(CIPHER_MAGIC);
    out.push(inner_kind.as_u8());
    out.extend_from_slice(&sealed);
    out
}

/// 拆开密文信封，返回 `(内层类型, 明文字节)`；篡改 → `Err(Crypto)`。
pub fn open_frame(sbox: &SalsaBox, frame: &[u8]) -> Result<(InnerKind, Vec<u8>)> {
    if frame.len() < 2 || frame[0] != CIPHER_MAGIC {
        return Err(LinkError::BadFrame("not a cipher frame"));
    }
    let inner_kind = InnerKind::from_u8(frame[1])?;
    let plain = e2e::open(sbox, &frame[2..])?;
    Ok((inner_kind, plain))
}
