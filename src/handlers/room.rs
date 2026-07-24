use crate::{
    models::{CreateRoomReq, RoomInfo, WebRtcConfig, WebRtcIceServer},
    state::{AppState, RoomSession},
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use std::sync::Arc;
use uuid::Uuid;

pub async fn get_webrtc_config() -> Json<WebRtcConfig> {
    let mut ice_servers = vec![WebRtcIceServer {
        urls: vec![
            "stun:stun.l.google.com:19302".to_string(),
            "stun:stun1.l.google.com:19302".to_string(),
            "stun:stun.services.mozilla.com".to_string(),
        ],
        username: None,
        credential: None,
    }];

    let urls: Vec<String> = std::env::var("TURN_URLS")
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|url| !url.is_empty())
        .map(ToOwned::to_owned)
        .collect();

    if !urls.is_empty() {
        ice_servers.push(WebRtcIceServer {
            urls,
            username: std::env::var("TURN_USERNAME")
                .ok()
                .filter(|value| !value.is_empty()),
            credential: std::env::var("TURN_CREDENTIAL")
                .ok()
                .filter(|value| !value.is_empty()),
        });
    }

    Json(WebRtcConfig { ice_servers })
}

pub async fn create_room(
    State(state): State<AppState>,
    Json(req): Json<CreateRoomReq>,
) -> Result<Json<RoomInfo>, (StatusCode, String)> {
    let room_id = format!("room-{}", &Uuid::new_v4().to_string()[..8]);
    let created_at = chrono::Utc::now().to_rfc3339();

    let room_info = RoomInfo {
        id: room_id.clone(),
        name: req.name,
        host_id: req.host_id,
        created_at,
    };

    let session = state
        .rooms
        .entry(room_id.clone())
        .or_insert_with(|| Arc::new(RoomSession::default()));

    // Store in memory info
    let mut updated_session = RoomSession::default();
    updated_session.info = Some(room_info.clone());
    
    // Copy peers
    for peer in session.peers.iter() {
        updated_session.peers.insert(peer.key().clone(), peer.value().clone());
    }

    state.rooms.insert(room_id, Arc::new(updated_session));

    Ok(Json(room_info))
}

pub async fn list_rooms(
    State(state): State<AppState>,
) -> Result<Json<Vec<RoomInfo>>, (StatusCode, String)> {
    let mut rooms = Vec::new();
    for entry in state.rooms.iter() {
        if let Some(ref info) = entry.value().info {
            rooms.push(info.clone());
        }
    }
    Ok(Json(rooms))
}

pub async fn get_room(
    State(state): State<AppState>,
    Path(room_id): Path<String>,
) -> Result<Json<RoomInfo>, (StatusCode, String)> {
    if let Some(session) = state.rooms.get(&room_id) {
        if let Some(ref info) = session.info {
            return Ok(Json(info.clone()));
        }
    }
    Err((StatusCode::NOT_FOUND, "Room not found in memory".to_string()))
}
