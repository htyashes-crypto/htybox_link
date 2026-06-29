//! 明文层编解码往返测试（Step 1）。

use htybox_link::frame::{classify_binary, BinaryClass};
use htybox_link::handshake::{ClientType, Hello, ServerInfo};
use htybox_link::offer::{ConnectionOffer, LanEndpoint, RelayEndpoint};
use htybox_link::rpc::{
    types, CreateTerminalParams, Request, Response, RestoreMode, RpcError, SubscribeTerminalParams,
    SubscribeTerminalResult,
};
use htybox_link::terminal::{
    decode_frame, decode_resize, encode_frame, encode_resize, encode_revision_frame, should_drop,
    split_revision, Opcode, Resize,
};

#[test]
fn handshake_roundtrip_and_forward_compat() {
    let h = Hello::new("cid", ClientType::Ios, "1.0.0");
    let s = serde_json::to_string(&h).unwrap();
    assert!(s.contains("\"type\":\"hello\""));
    assert!(s.contains("\"clientType\":\"ios\""));
    assert!(s.contains("\"terminalBinary\":true"));
    assert_eq!(serde_json::from_str::<Hello>(&s).unwrap(), h);

    // 未知字段被忽略 → 旧端能解析新端消息（向后兼容）
    let future = r#"{"type":"hello","clientId":"c","clientType":"web","protocolVersion":1,
        "appVersion":"x","capabilities":{"voice":true},"futureField":42}"#;
    assert!(serde_json::from_str::<Hello>(future).is_ok());

    let si = ServerInfo::new("srv", "DESKTOP", "1.0.0", Default::default());
    let s = serde_json::to_string(&si).unwrap();
    assert!(s.contains("\"type\":\"server_info\""));
    assert_eq!(serde_json::from_str::<ServerInfo>(&s).unwrap(), si);
}

#[test]
fn rpc_envelope_roundtrip() {
    let req = Request::new(
        types::TERMINAL_CREATE_REQ,
        "r1",
        CreateTerminalParams { cols: 80, rows: 24, ..Default::default() },
    );
    let s = serde_json::to_string(&req).unwrap();
    assert!(s.contains("\"type\":\"terminal.create.request\""));
    assert!(s.contains("\"requestId\":\"r1\""));
    assert!(s.contains("\"cols\":80")); // flatten：params 字段在顶层
    let back: Request<CreateTerminalParams> = serde_json::from_str(&s).unwrap();
    assert_eq!(back.params.cols, 80);

    let resp = Response::new(types::TERMINAL_SUBSCRIBE_RESP, "r1", SubscribeTerminalResult { slot: 3, revision: 7, cols: 80, rows: 24 });
    let s = serde_json::to_string(&resp).unwrap();
    assert!(s.contains("\"payload\":{"));
    let back: Response<SubscribeTerminalResult> = serde_json::from_str(&s).unwrap();
    assert_eq!(back.payload, SubscribeTerminalResult { slot: 3, revision: 7, cols: 80, rows: 24 });

    let err = RpcError {
        kind: "rpc_error".into(),
        request_id: Some("r1".into()),
        request_type: "terminal.kill.request".into(),
        error: "no such terminal".into(),
        code: "not_found".into(),
    };
    assert_eq!(serde_json::from_str::<RpcError>(&serde_json::to_string(&err).unwrap()).unwrap(), err);
}

#[test]
fn restore_mode_roundtrip() {
    let vs = RestoreMode::VisibleSnapshot { scrollback_lines: Some(200) };
    let s = serde_json::to_string(&vs).unwrap();
    assert!(s.contains("\"mode\":\"visible-snapshot\""));
    assert!(s.contains("\"scrollbackLines\":200"));
    assert_eq!(serde_json::from_str::<RestoreMode>(&s).unwrap(), vs);
    assert_eq!(serde_json::from_str::<RestoreMode>(r#"{"mode":"live"}"#).unwrap(), RestoreMode::Live);

    // subscribe 请求带 restore
    let req = Request::new(
        types::TERMINAL_SUBSCRIBE_REQ,
        "r2",
        SubscribeTerminalParams { terminal_id: "t1".into(), restore: RestoreMode::Live },
    );
    let s = serde_json::to_string(&req).unwrap();
    let back: Request<SubscribeTerminalParams> = serde_json::from_str(&s).unwrap();
    assert_eq!(back.params.restore, RestoreMode::Live);
}

#[test]
fn terminal_frames_roundtrip() {
    let f = encode_frame(Opcode::Input, 3, b"abc");
    let d = decode_frame(&f).unwrap();
    assert_eq!((d.opcode, d.slot, d.payload), (Opcode::Input, 3, &b"abc"[..]));

    let f = encode_revision_frame(Opcode::Output, 1, 42, b"hello");
    let d = decode_frame(&f).unwrap();
    assert_eq!(d.opcode, Opcode::Output);
    assert_eq!(split_revision(d.payload).unwrap(), (42, &b"hello"[..]));

    let f = encode_resize(0, &Resize { cols: 120, rows: 40 });
    let d = decode_frame(&f).unwrap();
    assert_eq!(d.opcode, Opcode::Resize);
    assert_eq!(decode_resize(d.payload).unwrap(), Resize { cols: 120, rows: 40 });

    assert!(decode_frame(&[0x01]).is_err()); // 太短
    assert!(Opcode::from_u8(0x09).is_err()); // 未知 opcode
}

#[test]
fn revision_dedup() {
    assert!(should_drop(5, 10)); // 旧的 → 丢
    assert!(should_drop(10, 10)); // 等于快照基线 → 丢
    assert!(!should_drop(11, 10)); // 新的 → 留
}

#[test]
fn offer_url_roundtrip() {
    let offer = ConnectionOffer {
        v: 1,
        server_id: "srv-uuid".into(),
        host_name: "DESKTOP".into(),
        host_public_key_b64: "AAAA".into(),
        lan: Some(LanEndpoint { host: "192.168.1.23".into(), port: 6767 }),
        relay: Some(RelayEndpoint { endpoint: "relay.example:443".into(), use_tls: true }),
    };
    let url = htybox_link::offer::encode_offer_url(&offer).unwrap();
    assert!(url.starts_with("htybox://pair#offer="));
    assert_eq!(htybox_link::offer::parse_offer_url(&url).unwrap(), offer);
    assert!(htybox_link::offer::parse_offer_url("nope").is_err());
}

#[test]
fn classify_binary_frames() {
    assert_eq!(classify_binary(&[0x00, 0x01, 9, 9]).unwrap(), BinaryClass::Cipher);
    let term = encode_frame(Opcode::Output, 0, b"x");
    assert_eq!(classify_binary(&term).unwrap(), BinaryClass::TerminalPlain);
    assert!(classify_binary(&[]).is_err());
    assert!(classify_binary(&[0x7f]).is_err());
}
