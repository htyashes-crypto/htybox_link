//! E2E 加密测试（Step 2）：ECDH 双向一致、seal/open、篡改失败、密文信封。

use htybox_link::e2e::{open, seal, KeyPair};
use htybox_link::frame::{classify_binary, open_frame, seal_frame, BinaryClass, InnerKind};

#[test]
fn ecdh_bidirectional_seal_open() {
    let host = KeyPair::generate();
    let client = KeyPair::generate();
    let host_box = host.box_with(&client.public_bytes());
    let client_box = client.box_with(&host.public_bytes());

    // 客户端 seal → Host open
    let sealed = seal(&client_box, b"hello over e2e");
    assert_eq!(open(&host_box, &sealed).unwrap(), b"hello over e2e");

    // Host seal → 客户端 open（反向也通 = 双方协商出同一 shared key）
    let sealed2 = seal(&host_box, b"reply");
    assert_eq!(open(&client_box, &sealed2).unwrap(), b"reply");
}

#[test]
fn tampered_ciphertext_fails() {
    let host = KeyPair::generate();
    let client = KeyPair::generate();
    let hb = host.box_with(&client.public_bytes());
    let cb = client.box_with(&host.public_bytes());

    let mut sealed = seal(&cb, b"secret-payload");
    let last = sealed.len() - 1;
    sealed[last] ^= 0x01; // 翻转 1 bit → 认证失败
    assert!(open(&hb, &sealed).is_err());

    // 错误对端公钥（非配对方）也开不了
    let stranger = KeyPair::generate();
    let wrong = stranger.box_with(&host.public_bytes());
    let sealed = seal(&cb, b"x");
    assert!(open(&wrong, &sealed).is_err());
}

#[test]
fn cipher_envelope_roundtrip() {
    let host = KeyPair::generate();
    let client = KeyPair::generate();
    let cb = client.box_with(&host.public_bytes());
    let hb = host.box_with(&client.public_bytes());

    let inner = br#"{"type":"hello"}"#;
    let frame = seal_frame(&cb, InnerKind::Json, inner);
    assert_eq!(classify_binary(&frame).unwrap(), BinaryClass::Cipher);
    let (kind, plain) = open_frame(&hb, &frame).unwrap();
    assert_eq!(kind, InnerKind::Json);
    assert_eq!(plain, inner);

    // 终端内层
    let frame = seal_frame(&cb, InnerKind::Terminal, &[1, 2, 3]);
    let (kind, plain) = open_frame(&hb, &frame).unwrap();
    assert_eq!(kind, InnerKind::Terminal);
    assert_eq!(plain, vec![1, 2, 3]);
}

#[test]
fn keypair_from_secret_is_deterministic() {
    let kp = KeyPair::generate();
    let kp2 = KeyPair::from_secret_bytes(kp.secret_bytes());
    assert_eq!(kp.public_bytes(), kp2.public_bytes());
}
