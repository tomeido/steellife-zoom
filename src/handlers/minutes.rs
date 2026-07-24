use crate::{
    models::{GenerateMinutesReq, MeetingMinutesResp},
    state::AppState,
};
use axum::{
    extract::{Path, State},
    http::StatusCode,
    Json,
};
use tracing::info;

pub async fn end_meeting_and_generate_minutes(
    State(state): State<AppState>,
    Path(room_id): Path<String>,
) -> Result<Json<MeetingMinutesResp>, (StatusCode, String)> {
    info!("🛑 Ending room session '{}' and starting WhisperX + LLM pipeline", room_id);

    // 1. Finalize room WAV audio recording file
    let audio_file_path = state
        .recorder
        .finalize_recording(&room_id)
        .await
        .ok_or_else(|| (StatusCode::NOT_FOUND, "No audio recording file found for room".to_string()))?;

    // Get room name from state
    let room_name = state
        .rooms
        .get(&room_id)
        .and_then(|session| session.info.clone().map(|i| i.name))
        .unwrap_or_else(|| format!("화상 회의 ({})", room_id));

    // 2. Transcribe audio file using WhisperX with Speaker Diarization & Word Timestamps
    let diarized_transcripts = state
        .whisperx
        .transcribe_file(&audio_file_path, &room_id)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("WhisperX error: {}", e)))?;

    // 3. Generate LLM AI Meeting Minutes from WhisperX transcripts
    let minutes = state
        .ai
        .generate_minutes(&room_name, &diarized_transcripts)
        .await
        .map_err(|e| (StatusCode::INTERNAL_SERVER_ERROR, format!("LLM error: {}", e)))?;

    Ok(Json(minutes))
}

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
