use crate::{
    models::{CreateRoomReq, RoomInfo},
    state::{AppState, RoomSession},
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use std::sync::Arc;
use uuid::Uuid;

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
