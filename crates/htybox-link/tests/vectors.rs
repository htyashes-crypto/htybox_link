//! 跨语言一致性向量：Rust 侧断言（Step 3）。TS 侧读同一文件做同样断言（Step 4/5）。
//! 向量由 `examples/gen_vectors.rs` 生成；本测试只读不写。

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use htybox_link::e2e::{open, seal_with_nonce, KeyPair};
use htybox_link::offer::{encode_offer_url, parse_offer_url, ConnectionOffer};
use htybox_link::terminal::{encode_frame, encode_resize, encode_revision_frame, Opcode, Resize};
use serde_json::Value;

fn vectors_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-vectors")
}
fn read(name: &str) -> Value {
    let p = vectors_dir().join(name);
    let s = std::fs::read_to_string(&p).unwrap_or_else(|_| panic!("missing vector {}", p.display()));
    serde_json::from_str(&s).unwrap()
}
fn b64(v: &Value, k: &str) -> Vec<u8> {
    STANDARD.decode(v[k].as_str().unwrap()).unwrap()
}
fn key32(v: &Value, k: &str) -> [u8; 32] {
    b64(v, k).as_slice().try_into().unwrap()
}

#[test]
fn e2e_vector_matches() {
    let v = read("e2e.json");
    let host = KeyPair::from_secret_bytes(key32(&v, "hostSecretB64"));
    let client = KeyPair::from_secret_bytes(key32(&v, "clientSecretB64"));

    // 公钥派生一致
    assert_eq!(host.public_b64(), v["hostPublicB64"].as_str().unwrap());
    assert_eq!(client.public_b64(), v["clientPublicB64"].as_str().unwrap());

    // 用固定 nonce seal → 与向量密文逐字节一致（跨语言锚点）
    let nonce: [u8; 24] = b64(&v, "nonceB64").as_slice().try_into().unwrap();
    let plaintext = v["plaintextUtf8"].as_str().unwrap().as_bytes();
    let client_box = client.box_with(&host.public_bytes());
    let sealed = seal_with_nonce(&client_box, &nonce, plaintext);
    assert_eq!(STANDARD.encode(&sealed), v["sealedB64"].as_str().unwrap());

    // Host 能解开向量密文
    let host_box = host.box_with(&client.public_bytes());
    assert_eq!(open(&host_box, &b64(&v, "sealedB64")).unwrap(), plaintext);
}

#[test]
fn frame_vectors_match() {
    let v = read("frames.json");
    let output = encode_revision_frame(Opcode::Output, 1, 42, b"hi");
    assert_eq!(hex::encode(output), v["outputFrameHex"].as_str().unwrap());
    let input = encode_frame(Opcode::Input, 2, b"ls\r");
    assert_eq!(hex::encode(input), v["inputFrameHex"].as_str().unwrap());
    let resize = encode_resize(0, &Resize { cols: 80, rows: 24 });
    assert_eq!(hex::encode(resize), v["resizeFrameHex"].as_str().unwrap());
}

#[test]
fn offer_vector_matches() {
    let v = read("frames.json");
    let offer: ConnectionOffer = serde_json::from_value(v["offer"].clone()).unwrap();
    let url = v["offerUrl"].as_str().unwrap();
    assert_eq!(encode_offer_url(&offer).unwrap(), url);
    assert_eq!(parse_offer_url(url).unwrap(), offer);
}
