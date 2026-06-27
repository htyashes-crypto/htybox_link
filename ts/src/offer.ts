// 配对 offer URL 编解码（03-spec §7）：htybox://pair#offer=base64url(json)。

import { fromB64Url, toB64Url } from "./b64";
import type { ConnectionOffer } from "./messages";

const PREFIX = "htybox://pair#offer=";

export function encodeOfferUrl(offer: ConnectionOffer): string {
  return PREFIX + toB64Url(new TextEncoder().encode(JSON.stringify(offer)));
}

export function parseOfferUrl(url: string): ConnectionOffer {
  const i = url.indexOf("#offer=");
  if (i < 0) throw new Error("missing #offer= fragment");
  const json = new TextDecoder().decode(fromB64Url(url.slice(i + "#offer=".length).trim()));
  return JSON.parse(json) as ConnectionOffer;
}
