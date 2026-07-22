use crate::{
    models::{PeerInfo, WsMessage},
    state::{AppState, Peer, RoomSession},
};
use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::mpsc;
use tracing::{info, warn};

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
) -> impl IntoResponse {
    ws.on_upgrade(|socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: AppState) {
    let (mut ws_sender, mut ws_receiver) = socket.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<WsMessage>();

    // Forward MPSC messages back to the WebSocket client
    let send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            if let Ok(json) = serde_json::to_string(&msg) {
                if ws_sender.send(Message::Text(json)).await.is_err() {
                    break;
                }
            }
        }
    });

    let mut current_room_id: Option<String> = None;
    let mut current_user_id: Option<String> = None;
    let mut current_username: Option<String> = None;

    while let Some(result) = ws_receiver.next().await {
        let msg = match result {
            Ok(m) => m,
            Err(e) => {
                warn!("WebSocket connection issue: {}", e);
                break;
            }
        };

        match msg {
            Message::Text(text) => {
                if let Ok(ws_msg) = serde_json::from_str::<WsMessage>(&text) {
                    match ws_msg {
                        WsMessage::JoinRoom {
                            room_id,
                            user_id,
                            username,
                        } => {
                            current_room_id = Some(room_id.clone());
                            current_user_id = Some(user_id.clone());
                            current_username = Some(username.clone());

                            let room = state
                                .rooms
                                .entry(room_id.clone())
                                .or_insert_with(|| Arc::new(RoomSession::default()))
                                .clone();

                            // Collect existing peers before inserting new user
                            let existing_peers: Vec<PeerInfo> = room
                                .peers
                                .iter()
                                .map(|p| PeerInfo {
                                    user_id: p.value().user_id.clone(),
                                    username: p.value().username.clone(),
                                })
                                .collect();

                            let peer = Peer {
                                user_id: user_id.clone(),
                                username: username.clone(),
                                tx: tx.clone(),
                            };

                            room.peers.insert(user_id.clone(), peer);
                            let peer_count = room.peers.len();

                            info!(
                                "User '{}' ({}) joined room '{}' (Total Peers: {})",
                                username, user_id, room_id, peer_count
                            );

                            // 1. Send existing peer list to the joining user
                            let _ = tx.send(WsMessage::PeerList {
                                peers: existing_peers,
                            });

                            // 2. Broadcast UserJoined to existing room peers
                            let joined_msg = WsMessage::UserJoined {
                                user_id: user_id.clone(),
                                username: username.clone(),
                                peer_count,
                            };

                            for peer_ref in room.peers.iter() {
                                if peer_ref.key() != &user_id {
                                    let _ = peer_ref.value().tx.send(joined_msg.clone());
                                }
                            }
                        }

                        // WebRTC Signaling Forwarding
                        WsMessage::Offer { target_user_id, sdp, sender_user_id } => {
                            if let Some(ref room_id) = current_room_id {
                                if let Some(room) = state.rooms.get(room_id) {
                                    if let Some(target_peer) = room.peers.get(&target_user_id) {
                                        let _ = target_peer.tx.send(WsMessage::Offer {
                                            target_user_id: target_user_id.clone(),
                                            sdp,
                                            sender_user_id,
                                        });
                                    }
                                }
                            }
                        }

                        WsMessage::Answer { target_user_id, sdp, sender_user_id } => {
                            if let Some(ref room_id) = current_room_id {
                                if let Some(room) = state.rooms.get(room_id) {
                                    if let Some(target_peer) = room.peers.get(&target_user_id) {
                                        let _ = target_peer.tx.send(WsMessage::Answer {
                                            target_user_id: target_user_id.clone(),
                                            sdp,
                                            sender_user_id,
                                        });
                                    }
                                }
                            }
                        }

                        WsMessage::IceCandidate { target_user_id, candidate, sender_user_id } => {
                            if let Some(ref room_id) = current_room_id {
                                if let Some(room) = state.rooms.get(room_id) {
                                    if let Some(target_peer) = room.peers.get(&target_user_id) {
                                        let _ = target_peer.tx.send(WsMessage::IceCandidate {
                                            target_user_id: target_user_id.clone(),
                                            candidate,
                                            sender_user_id,
                                        });
                                    }
                                }
                            }
                        }

                        // Realtime Chat Broadcast
                        WsMessage::ChatMessage { sender_name, content, timestamp } => {
                            if let Some(ref room_id) = current_room_id {
                                if let Some(room) = state.rooms.get(room_id) {
                                    let evt = WsMessage::ChatMessage { sender_name, content, timestamp };
                                    for peer_ref in room.peers.iter() {
                                        let _ = peer_ref.value().tx.send(evt.clone());
                                    }
                                }
                            }
                        }

                        // Active Speaker Indicator
                        WsMessage::ActiveSpeaker { user_id, is_speaking } => {
                            if let Some(ref room_id) = current_room_id {
                                if let Some(room) = state.rooms.get(room_id) {
                                    let spk_evt = WsMessage::ActiveSpeaker { user_id, is_speaking };
                                    for peer_ref in room.peers.iter() {
                                        let _ = peer_ref.value().tx.send(spk_evt.clone());
                                    }
                                }
                            }
                        }

                        _ => {}
                    }
                }
            }

            Message::Binary(audio_pcm) => {
                // Incoming binary 16kHz PCM audio stream chunk for XWhisper processing
                if let (Some(ref room_id), Some(ref username)) = (&current_room_id, &current_username) {
                    if let Ok(Some(transcript_text)) = state
                        .stt
                        .process_audio_chunk(username, &audio_pcm)
                        .await
                    {
                        let timestamp_ms = chrono::Utc::now().timestamp_millis();

                        if let Some(room) = state.rooms.get(room_id) {
                            let live_msg = WsMessage::LiveTranscript {
                                speaker_name: username.clone(),
                                content: transcript_text,
                                timestamp_ms,
                            };
                            for peer_ref in room.peers.iter() {
                                let _ = peer_ref.value().tx.send(live_msg.clone());
                            }
                        }
                    }
                }
            }

            Message::Close(_) => break,
            _ => {}
        }
    }

    // Clean up memory state on disconnect
    if let (Some(room_id), Some(user_id), Some(username)) = (current_room_id, current_user_id, current_username) {
        if let Some(room) = state.rooms.get(&room_id) {
            room.peers.remove(&user_id);
            let left_msg = WsMessage::UserLeft {
                user_id: user_id.clone(),
                username: username.clone(),
            };
            for peer_ref in room.peers.iter() {
                let _ = peer_ref.value().tx.send(left_msg.clone());
            }
            info!("User '{}' disconnected from room '{}'", username, room_id);
        }
    }

    send_task.abort();
}
