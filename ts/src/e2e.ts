// E2E 加密（03-spec §8）：Curve25519 ECDH + XSalsa20-Poly1305，经 tweetnacl。
// 与 Rust htybox-link::e2e 字节兼容（同 NaCl box）。"shared" = nacl.box.before 预计算的共享密钥。

import nacl from "tweetnacl";
import { toB64 } from "./b64";

export const KEY_SIZE = 32;
export const NONCE_SIZE = 24;

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

export function keyPairFromSecret(secret: Uint8Array): KeyPair {
  return nacl.box.keyPair.fromSecretKey(secret);
}

export function publicB64(kp: KeyPair): string {
  return toB64(kp.publicKey);
}

/** 与对端公钥协商出共享密钥（双方各算得相同结果）。 */
export function sharedKey(theirPublic: Uint8Array, mySecret: Uint8Array): Uint8Array {
  return nacl.box.before(theirPublic, mySecret);
}

/** 用指定 nonce 加密（确定性，供向量）：输出 nonce(24) ++ ciphertext。 */
export function sealWithNonce(shared: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const ct = nacl.box.after(plaintext, nonce, shared);
  const out = new Uint8Array(NONCE_SIZE + ct.length);
  out.set(nonce, 0);
  out.set(ct, NONCE_SIZE);
  return out;
}

/** 随机 nonce 加密：输出 nonce(24) ++ ciphertext。 */
export function seal(shared: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return sealWithNonce(shared, nacl.randomBytes(NONCE_SIZE), plaintext);
}

/** 解密 nonce(24) ++ ciphertext；篡改/认证失败抛错。 */
export function open(shared: Uint8Array, data: Uint8Array): Uint8Array {
  if (data.length < NONCE_SIZE) throw new Error("e2e payload shorter than nonce");
  const nonce = data.subarray(0, NONCE_SIZE);
  const pt = nacl.box.open.after(data.subarray(NONCE_SIZE), nonce, shared);
  if (!pt) throw new Error("decrypt/auth failed");
  return pt;
}
