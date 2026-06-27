// base64 / base64url / hex 助手（node Buffer 优先，回退浏览器 atob/btoa）。

export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function toB64(b: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(b).toString("base64");
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

export function fromB64(s: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(s, "base64"));
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toB64Url(b: Uint8Array): string {
  return toB64(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64Url(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4;
  return fromB64(s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad));
}
