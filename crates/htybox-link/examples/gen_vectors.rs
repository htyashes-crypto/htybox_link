//! 生成跨语言一致性测试向量到 `HtyBox_link/test-vectors/`（Step 3）。
//! 用固定密钥/nonce，使输出确定可复现；Rust 与 TS 两侧都对这些向量断言。
//! 运行：`cargo run --example gen_vectors --manifest-path crates/htybox-link/Cargo.toml`

use base64::engine::general_purpose::STANDARD;
use base64::Engine;
use htybox_link::e2e::{seal_with_nonce, KeyPair, NONCE_SIZE};
use htybox_link::offer::{encode_offer_url, ConnectionOffer, LanEndpoint};
use htybox_link::terminal::{encode_frame, encode_resize, encode_revision_frame, Opcode, Resize};
use serde_json::json;

fn main() {
    // ── E2E 向量（固定密钥 + 固定 nonce → 确定密文）──
    let host = KeyPair::from_secret_bytes([7u8; 32]);
    let client = KeyPair::from_secret_bytes([9u8; 32]);
    let nonce = [3u8; NONCE_SIZE];
    let plaintext = b"htybox-link e2e vector";
    let client_box = client.box_with(&host.public_bytes());
    let sealed = seal_with_nonce(&client_box, &nonce, plaintext);

    let e2e = json!({
        "_note": "TS 用 clientSecret/hostSecret 还原密钥对→断言公钥匹配；以 clientBox+nonce seal(plaintext)==sealed；open(sealed)==plaintext",
        "hostSecretB64": STANDARD.encode(host.secret_bytes()),
        "clientSecretB64": STANDARD.encode(client.secret_bytes()),
        "hostPublicB64": host.public_b64(),
        "clientPublicB64": client.public_b64(),
        "nonceB64": STANDARD.encode(nonce),
        "plaintextUtf8": std::str::from_utf8(plaintext).unwrap(),
        "sealedB64": STANDARD.encode(&sealed),
    });

    // ── 帧 / offer 向量（确定字节）──
    let output = encode_revision_frame(Opcode::Output, 1, 42, b"hi");
    let input = encode_frame(Opcode::Input, 2, b"ls\r");
    let resize = encode_resize(0, &Resize { cols: 80, rows: 24 });

    let offer = ConnectionOffer {
        v: 1,
        server_id: "srv-vector".into(),
        host_name: "VECTOR".into(),
        host_public_key_b64: host.public_b64(),
        lan: Some(LanEndpoint { host: "192.168.0.10".into(), port: 6767 }),
        relay: None,
    };
    let offer_url = encode_offer_url(&offer).unwrap();

    let frames = json!({
        "_note": "TS 复现各帧的 hex 与 offer 的 url，必须与本文件完全一致",
        "outputFrameHex": hex::encode(&output),
        "outputSlot": 1, "outputRevision": 42, "outputDataUtf8": "hi",
        "inputFrameHex": hex::encode(&input),
        "inputSlot": 2, "inputDataUtf8": "ls\r",
        "resizeFrameHex": hex::encode(&resize),
        "resizeCols": 80, "resizeRows": 24,
        "offer": offer,
        "offerUrl": offer_url,
    });

    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../test-vectors");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("e2e.json"), serde_json::to_string_pretty(&e2e).unwrap()).unwrap();
    std::fs::write(dir.join("frames.json"), serde_json::to_string_pretty(&frames).unwrap()).unwrap();
    println!("wrote vectors to {}", dir.display());
}
