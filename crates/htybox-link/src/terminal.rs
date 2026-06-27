//! 终端二进制帧（03-spec §6）：`[opcode:1B][slot:1B][payload...]`。
//!
//! Output/Snapshot/Restore 的 payload 以 `revision:u64`(大端) 开头；Input 为原始字节；
//! Resize 为 JSON `{cols,rows}`。`slot` 由 `terminal.subscribe` 分配，单连接内多终端复用。

use serde::{Deserialize, Serialize};

use crate::{LinkError, Result};

/// 终端帧操作码（03-spec §6）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Opcode {
    Output = 0x01,
    Input = 0x02,
    Resize = 0x03,
    Snapshot = 0x04,
    Restore = 0x05,
}

impl Opcode {
    pub fn from_u8(b: u8) -> Result<Self> {
        Ok(match b {
            0x01 => Opcode::Output,
            0x02 => Opcode::Input,
            0x03 => Opcode::Resize,
            0x04 => Opcode::Snapshot,
            0x05 => Opcode::Restore,
            _ => return Err(LinkError::BadFrame("unknown terminal opcode")),
        })
    }
    pub fn as_u8(self) -> u8 {
        self as u8
    }
    /// 该 opcode 的 payload 是否以 revision(u64 BE) 开头。
    pub fn carries_revision(self) -> bool {
        matches!(self, Opcode::Output | Opcode::Snapshot | Opcode::Restore)
    }
}

/// 已解析的终端帧（借用底层缓冲，零拷贝）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DecodedFrame<'a> {
    pub opcode: Opcode,
    pub slot: u8,
    pub payload: &'a [u8],
}

/// 编码一帧：`[opcode][slot][payload]`。
pub fn encode_frame(opcode: Opcode, slot: u8, payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(2 + payload.len());
    out.push(opcode.as_u8());
    out.push(slot);
    out.extend_from_slice(payload);
    out
}

/// 解码一帧（至少 2 字节）。
pub fn decode_frame(bytes: &[u8]) -> Result<DecodedFrame<'_>> {
    if bytes.len() < 2 {
        return Err(LinkError::BadFrame("terminal frame too short"));
    }
    Ok(DecodedFrame {
        opcode: Opcode::from_u8(bytes[0])?,
        slot: bytes[1],
        payload: &bytes[2..],
    })
}

/// 编码带 revision 的帧（Output/Snapshot/Restore）：payload = `revision(u64 BE) ++ data`。
pub fn encode_revision_frame(opcode: Opcode, slot: u8, revision: u64, data: &[u8]) -> Vec<u8> {
    debug_assert!(opcode.carries_revision());
    let mut payload = Vec::with_capacity(8 + data.len());
    payload.extend_from_slice(&revision.to_be_bytes());
    payload.extend_from_slice(data);
    encode_frame(opcode, slot, &payload)
}

/// 拆出 `(revision, data)`（用于 Output/Snapshot/Restore 的 payload）。
pub fn split_revision(payload: &[u8]) -> Result<(u64, &[u8])> {
    if payload.len() < 8 {
        return Err(LinkError::BadFrame("revision payload too short"));
    }
    let rev = u64::from_be_bytes(payload[..8].try_into().unwrap());
    Ok((rev, &payload[8..]))
}

/// Resize payload（03-spec §6：JSON `{cols,rows}`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Resize {
    pub cols: u16,
    pub rows: u16,
}

pub fn encode_resize(slot: u8, resize: &Resize) -> Vec<u8> {
    let json = serde_json::to_vec(resize).expect("resize serialize");
    encode_frame(Opcode::Resize, slot, &json)
}

pub fn decode_resize(payload: &[u8]) -> Result<Resize> {
    Ok(serde_json::from_slice(payload)?)
}

/// 历史重放去重（03-spec §6.1）：客户端已重放到 `replayed_revision` 后，
/// 收到 `revision <= replayed_revision` 的 Output 应丢弃（已含在快照/Restore 内）。
pub fn should_drop(revision: u64, replayed_revision: u64) -> bool {
    revision <= replayed_revision
}
