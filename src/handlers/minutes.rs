use crate::{
    models::{GenerateMinutesReq, MeetingMinutesResp},
    state::AppState,
};
use axum::{extract::State, http::StatusCode, Json};

pub async fn generate_minutes(
    State(state): State<AppState>,
    Json(req): Json<GenerateMinutesReq>,
) -> Result<Json<MeetingMinutesResp>, (StatusCode, String)> {
    let minutes = state
        .ai
        .generate_minutes(&req.room_name, &req.transcripts)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()))?;

    Ok(Json(minutes))
}
