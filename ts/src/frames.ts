// 终端二进制帧 + 顶层分类 + E2E 密文信封（03-spec §6 / §2）。

import { open, seal } from "./e2e";

export const Opcode = {
  Output: 0x01,
  Input: 0x02,
  Resize: 0x03,
  Snapshot: 0x04,
  Restore: 0x05,
} as const;

export interface DecodedFrame {
  opcode: number;
  slot: number;
  payload: Uint8Array;
}

export function encodeFrame(opcode: number, slot: number, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + payload.length);
  out[0] = opcode;
  out[1] = slot;
  out.set(payload, 2);
  return out;
}

export function decodeFrame(bytes: Uint8Array): DecodedFrame {
  if (bytes.length < 2) throw new Error("terminal frame too short");
  return { opcode: bytes[0], slot: bytes[1], payload: bytes.subarray(2) };
}

/** Output/Snapshot/Restore：payload = revision(u64 BE) ++ data。 */
export function encodeRevisionFrame(opcode: number, slot: number, revision: bigint, data: Uint8Array): Uint8Array {
  const payload = new Uint8Array(8 + data.length);
  new DataView(payload.buffer, payload.byteOffset, payload.byteLength).setBigUint64(0, revision, false);
  payload.set(data, 8);
  return encodeFrame(opcode, slot, payload);
}

export function splitRevision(payload: Uint8Array): { revision: bigint; data: Uint8Array } {
  if (payload.length < 8) throw new Error("revision payload too short");
  const dv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { revision: dv.getBigUint64(0, false), data: payload.subarray(8) };
}

export interface Resize {
  cols: number;
  rows: number;
}
export function encodeResize(slot: number, r: Resize): Uint8Array {
  return encodeFrame(Opcode.Resize, slot, new TextEncoder().encode(JSON.stringify(r)));
}
export function decodeResize(payload: Uint8Array): Resize {
  return JSON.parse(new TextDecoder().decode(payload)) as Resize;
}

/** 历史重放去重（§6.1）：revision <= 已重放基线 → 丢弃。 */
export function shouldDrop(revision: bigint, replayedRevision: bigint): boolean {
  return revision <= replayedRevision;
}

// ── 顶层分类 + 密文信封（§2）──
export const CIPHER_MAGIC = 0x00;
export const InnerKind = { Json: 0x01, Terminal: 0x02 } as const;
export type BinaryClass = "cipher" | "terminal";

export function classifyBinary(frame: Uint8Array): BinaryClass {
  if (frame.length === 0) throw new Error("empty binary frame");
  if (frame[0] === CIPHER_MAGIC) return "cipher";
  if (frame[0] >= 0x01 && frame[0] <= 0x05) return "terminal";
  throw new Error("unrecognized binary frame");
}

/** 封装密文信封：[0x00][innerKind][nonce(24)][ct]。 */
export function sealFrame(shared: Uint8Array, innerKind: number, innerBytes: Uint8Array): Uint8Array {
  const sealed = seal(shared, innerBytes);
  const out = new Uint8Array(2 + sealed.length);
  out[0] = CIPHER_MAGIC;
  out[1] = innerKind;
  out.set(sealed, 2);
  return out;
}

/** 拆密文信封 → { innerKind, plain }；篡改抛错。 */
export function openFrame(shared: Uint8Array, frame: Uint8Array): { innerKind: number; plain: Uint8Array } {
  if (frame.length < 2 || frame[0] !== CIPHER_MAGIC) throw new Error("not a cipher frame");
  return { innerKind: frame[1], plain: open(shared, frame.subarray(2)) };
}
