use crate::{
    ai::AiSummarizer,
    audio_recorder::AudioRecorder,
    models::{RoomInfo, WsMessage},
    stt::WhisperXEngine,
};
use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::mpsc;

#[allow(dead_code)]
#[derive(Clone)]
pub struct Peer {
    pub user_id: String,
    pub username: String,
    pub tx: mpsc::UnboundedSender<WsMessage>,
}

#[derive(Default)]
pub struct RoomSession {
    pub info: Option<RoomInfo>,
    pub peers: DashMap<String, Peer>, // user_id -> Peer
}

#[derive(Clone)]
pub struct AppState {
    pub rooms: Arc<DashMap<String, Arc<RoomSession>>>,
    pub recorder: Arc<AudioRecorder>,
    pub whisperx: Arc<WhisperXEngine>,
    pub ai: Arc<AiSummarizer>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            rooms: Arc::new(DashMap::new()),
            recorder: Arc::new(AudioRecorder::new()),
            whisperx: Arc::new(WhisperXEngine::new()),
            ai: Arc::new(AiSummarizer::new()),
        }
    }
}
