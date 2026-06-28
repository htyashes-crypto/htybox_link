//! HtyBox relay 中继：无状态 E2E 密文转发（`Document/03-protocol-spec.md` §9）。
//!
//! 对 Host（控制通道 `/session/{serverId}`）与客户端（数据通道
//! `/session/{serverId}/{connectionId}`）都是 WS 服务端；按 `serverId` 找控制通道、
//! 按 `connectionId` 配对两条数据 socket 双向**逐字节转发**，不解析 E2E 内层。
//! 模型 = 1 控制 socket + N 数据 socket（对标 paseo）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::any;
use axum::Router;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, oneshot};

use htybox_link::relay::RelayControl;

/// 控制 socket 出站项：转发给 Host 的控制消息，或主动关闭（抢占）。
enum ControlOut {
    Msg(RelayControl),
    Close,
}

/// 一个在册的控制连接（serverId → 此）。`id` 用于抢占后精确注销。
struct ControlHandle {
    tx: mpsc::UnboundedSender<ControlOut>,
    id: u64,
}

/// relay 全局状态：serverId→控制连 + (serverId,connId)→等待配对的首个数据 socket。
#[derive(Default)]
pub struct RelayInner {
    controls: Mutex<HashMap<String, ControlHandle>>,
    pending: Mutex<HashMap<(String, String), oneshot::Sender<WebSocket>>>,
}

/// 共享状态句柄（axum State 要求 Clone；Arc 内部可变）。
pub type RelayState = Arc<RelayInner>;

static NEXT_CONTROL_ID: AtomicU64 = AtomicU64::new(1);

/// 构建 relay 路由（自带新状态）。
pub fn router() -> Router {
    Router::new()
        .route("/session/{server_id}", any(control_handler))
        .route("/session/{server_id}/{connection_id}", any(data_handler))
        .with_state(Arc::new(RelayInner::default()))
}

/// 在给定 listener 上跑 relay（消费 tokio TcpListener，便于测试用随机端口）。
pub async fn serve(listener: tokio::net::TcpListener) {
    let _ = axum::serve(listener, router().into_make_service()).await;
}

/// 控制通道 `/session/{serverId}`：Host 反连，relay 向其推 connected/disconnected/ping。
async fn control_handler(
    ws: WebSocketUpgrade,
    Path(server_id): Path<String>,
    State(state): State<RelayState>,
) -> Response {
    ws.on_upgrade(move |socket| handle_control(socket, server_id, state))
}

/// 数据通道 `/session/{serverId}/{connectionId}`：客户端与 Host 各连一条，relay 配对转发。
async fn data_handler(
    ws: WebSocketUpgrade,
    Path((server_id, connection_id)): Path<(String, String)>,
    State(state): State<RelayState>,
) -> Response {
    ws.on_upgrade(move |socket| handle_data(socket, server_id, connection_id, state))
}

async fn handle_control(socket: WebSocket, server_id: String, state: RelayState) {
    let (mut sink, mut stream) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<ControlOut>();
    let id = NEXT_CONTROL_ID.fetch_add(1, Ordering::Relaxed);

    // 注册 + 抢占旧控制连（决策 6=A：新连顶替旧连）
    if let Some(old) = state
        .controls
        .lock()
        .unwrap()
        .insert(server_id.clone(), ControlHandle { tx: tx.clone(), id })
    {
        let _ = old.tx.send(ControlOut::Close);
    }

    // 写任务：rx → sink（RelayControl JSON 文本 / 主动关闭）
    let writer = tokio::spawn(async move {
        while let Some(out) = rx.recv().await {
            let msg = match out {
                ControlOut::Msg(m) => {
                    Message::Text(serde_json::to_string(&m).unwrap_or_default().into())
                }
                ControlOut::Close => {
                    let _ = sink.send(Message::Close(None)).await;
                    break;
                }
            };
            if sink.send(msg).await.is_err() {
                break;
            }
        }
    });

    // 心跳：每 30s relay→Host Ping（保活 Host 出站 NAT 映射）
    let ping_tx = tx.clone();
    let pinger = tokio::spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.tick().await; // 跳过立即触发的首拍
        loop {
            tick.tick().await;
            if ping_tx.send(ControlOut::Msg(RelayControl::Ping)).is_err() {
                break;
            }
        }
    });

    // 读循环：Host → relay 的 sync / pong / ping（对端 ping 则回 pong）
    while let Some(Ok(msg)) = stream.next().await {
        match msg {
            Message::Text(t) => {
                if let Ok(RelayControl::Ping) = serde_json::from_str::<RelayControl>(t.as_str()) {
                    let _ = tx.send(ControlOut::Msg(RelayControl::Pong));
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    // 注销（仅当仍是当前控制连，避免误删抢占后的新连）
    {
        let mut controls = state.controls.lock().unwrap();
        if controls.get(&server_id).map(|h| h.id) == Some(id) {
            controls.remove(&server_id);
        }
    }
    pinger.abort();
    writer.abort();
}

async fn handle_data(socket: WebSocket, server_id: String, connection_id: String, state: RelayState) {
    // 须先有 Host 控制连，否则无人配对 → 关闭
    let ctrl_tx = state
        .controls
        .lock()
        .unwrap()
        .get(&server_id)
        .map(|h| h.tx.clone());
    let Some(ctrl_tx) = ctrl_tx else {
        let mut socket = socket;
        let _ = socket.send(Message::Close(None)).await;
        return;
    };
    let key = (server_id, connection_id.clone());

    // 已有等待者 = 第二个到达（Host 侧）→ 交出自身 socket，由第一个 handler 桥接
    let waiter = state.pending.lock().unwrap().remove(&key);
    if let Some(pair_tx) = waiter {
        let _ = pair_tx.send(socket);
        return;
    }

    // 第一个到达（客户端侧）→ 登记 + 通知 Host Connected + 等待配对（10s 超时）
    let (pair_tx, pair_rx) = oneshot::channel::<WebSocket>();
    state.pending.lock().unwrap().insert(key.clone(), pair_tx);
    let _ = ctrl_tx.send(ControlOut::Msg(RelayControl::Connected {
        connection_id: connection_id.clone(),
    }));

    match tokio::time::timeout(Duration::from_secs(10), pair_rx).await {
        Ok(Ok(other)) => {
            bridge(socket, other).await;
            let _ = ctrl_tx.send(ControlOut::Msg(RelayControl::Disconnected { connection_id }));
        }
        _ => {
            state.pending.lock().unwrap().remove(&key);
            let mut socket = socket;
            let _ = socket.send(Message::Close(None)).await;
        }
    }
}

/// 双向逐字节转发两条数据 socket 的 Text/Binary 帧；任一端关闭即结束（halves drop→双双关闭）。
async fn bridge(a: WebSocket, b: WebSocket) {
    let (mut a_tx, mut a_rx) = a.split();
    let (mut b_tx, mut b_rx) = b.split();
    let a_to_b = async {
        while let Some(Ok(msg)) = a_rx.next().await {
            match msg {
                Message::Text(_) | Message::Binary(_) => {
                    if b_tx.send(msg).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };
    let b_to_a = async {
        while let Some(Ok(msg)) = b_rx.next().await {
            match msg {
                Message::Text(_) | Message::Binary(_) => {
                    if a_tx.send(msg).await.is_err() {
                        break;
                    }
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    };
    tokio::pin!(a_to_b, b_to_a);
    tokio::select! {
        _ = &mut a_to_b => {},
        _ = &mut b_to_a => {},
    }
}
