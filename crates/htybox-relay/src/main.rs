//! relay 二进制入口：绑定端口并跑 WS 中继（ws:// 明文，生产 TLS 由前置代理终止）。
//!
//! 端口取自环境变量 `HTYBOX_RELAY_PORT`，缺省 6868。绑 `0.0.0.0` 以便容器/VPS 暴露。

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("HTYBOX_RELAY_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(6868);
    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr)
        .await
        .unwrap_or_else(|e| panic!("htybox-relay 绑定 {addr} 失败: {e}"));
    eprintln!("htybox-relay listening on ws://{addr} (TLS 由前置代理终止)");
    htybox_relay::serve(listener).await;
}
