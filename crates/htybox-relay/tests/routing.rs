//! relay 路由/配对/抢占 集成测试：用 tokio-tungstenite 作客户端驱动真实 relay。

use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use htybox_link::relay::RelayControl;
use tokio_tungstenite::tungstenite::Message as TMsg;
use tokio_tungstenite::{connect_async, MaybeTlsStream, WebSocketStream};

type Ws = WebSocketStream<MaybeTlsStream<tokio::net::TcpStream>>;

async fn start_relay() -> u16 {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    tokio::spawn(htybox_relay::serve(listener));
    port
}

async fn connect(port: u16, path: &str) -> Ws {
    let (ws, _) = connect_async(format!("ws://127.0.0.1:{port}{path}"))
        .await
        .unwrap();
    ws
}

async fn send_ctrl(ws: &mut Ws, m: &RelayControl) {
    ws.send(TMsg::Text(serde_json::to_string(m).unwrap().into()))
        .await
        .unwrap();
}

async fn recv_ctrl(ws: &mut Ws) -> RelayControl {
    loop {
        match ws.next().await {
            Some(Ok(TMsg::Text(t))) => return serde_json::from_str(t.as_str()).unwrap(),
            Some(Ok(_)) => continue,
            other => panic!("控制连提前关闭: {other:?}"),
        }
    }
}

async fn recv_bin(ws: &mut Ws) -> Vec<u8> {
    loop {
        match ws.next().await {
            Some(Ok(TMsg::Binary(b))) => return b.to_vec(),
            Some(Ok(_)) => continue,
            other => panic!("数据连提前关闭: {other:?}"),
        }
    }
}

async fn closed_within(ws: &mut Ws, secs: u64) -> bool {
    tokio::time::timeout(Duration::from_secs(secs), async {
        loop {
            match ws.next().await {
                Some(Ok(TMsg::Close(_))) | None | Some(Err(_)) => return true,
                Some(Ok(_)) => continue,
            }
        }
    })
    .await
    .unwrap_or(false)
}

#[tokio::test]
async fn pairs_and_forwards_both_directions() {
    let port = start_relay().await;
    let mut control = connect(port, "/session/srv1").await;
    send_ctrl(&mut control, &RelayControl::Sync).await;

    // 客户端数据 socket 连上 → 控制通道应收到 connected{conn1}
    let mut client = connect(port, "/session/srv1/conn1").await;
    assert_eq!(
        recv_ctrl(&mut control).await,
        RelayControl::Connected { connection_id: "conn1".into() }
    );

    // Host 据此开同 id 数据 socket → 配对
    let mut host = connect(port, "/session/srv1/conn1").await;

    // 双向逐字节转发
    client.send(TMsg::Binary(b"ping".to_vec().into())).await.unwrap();
    assert_eq!(recv_bin(&mut host).await, b"ping");
    host.send(TMsg::Binary(b"pong".to_vec().into())).await.unwrap();
    assert_eq!(recv_bin(&mut client).await, b"pong");
}

#[tokio::test]
async fn new_control_preempts_old() {
    let port = start_relay().await;
    let mut c1 = connect(port, "/session/srvP").await;
    send_ctrl(&mut c1, &RelayControl::Sync).await;
    tokio::time::sleep(Duration::from_millis(80)).await; // 等 c1 注册
    let mut c2 = connect(port, "/session/srvP").await;
    send_ctrl(&mut c2, &RelayControl::Sync).await;
    assert!(closed_within(&mut c1, 2).await, "旧控制连应被新连顶替关闭");
}

#[tokio::test]
async fn data_without_control_is_closed() {
    let port = start_relay().await;
    let mut data = connect(port, "/session/ghost/c1").await;
    assert!(closed_within(&mut data, 2).await, "无控制连时数据连应被关闭");
}
