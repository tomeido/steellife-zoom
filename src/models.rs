use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct RoomInfo {
    pub id: String,
    pub name: String,
    pub host_id: String,
    pub created_at: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct CreateRoomReq {
    pub name: String,
    pub host_id: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PeerInfo {
    pub user_id: String,
    pub username: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TranscriptEntry {
    pub speaker_name: String,
    pub content: String,
    pub timestamp_ms: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateMinutesReq {
    pub room_name: String,
    pub transcripts: Vec<TranscriptEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct MeetingMinutesResp {
    pub title: String,
    pub summary: String,
    pub key_discussions: Vec<String>,
    pub action_items: Vec<String>,
    pub attendees: Vec<String>,
    pub markdown_content: String,
    pub created_at: String,
}

// Real-time WebSocket Protocol Messages
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(tag = "type", content = "payload")]
pub enum WsMessage {
    // Room Session Management
    JoinRoom { room_id: String, user_id: String, username: String },
    PeerList { peers: Vec<PeerInfo> },
    UserJoined { user_id: String, username: String, peer_count: usize },
    UserLeft { user_id: String, username: String },

    // WebRTC Signaling
    Offer { target_user_id: String, sdp: String, sender_user_id: String },
    Answer { target_user_id: String, sdp: String, sender_user_id: String },
    IceCandidate { target_user_id: String, candidate: String, sender_user_id: String },

    // Realtime Chat & Speaker State
    ChatMessage { sender_name: String, content: String, timestamp: i64 },
    ActiveSpeaker { user_id: String, is_speaking: bool },

    // Live XWhisper Transcripts
    LiveTranscript { speaker_name: String, content: String, timestamp_ms: i64 },

    // Error Notification
    Error { message: String },
}
