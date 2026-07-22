use crate::{
    ai::AiSummarizer,
    models::{RoomInfo, WsMessage},
    stt::SttService,
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
    pub stt: Arc<SttService>,
    pub ai: Arc<AiSummarizer>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            rooms: Arc::new(DashMap::new()),
            stt: Arc::new(SttService::new()),
            ai: Arc::new(AiSummarizer::new()),
        }
    }
}
