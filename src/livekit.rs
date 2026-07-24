use anyhow::{Context, Result};
use jsonwebtoken::{encode, EncodingKey, Header};
use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug, Serialize)]
pub struct VideoGrant {
    #[serde(rename = "roomJoin")]
    pub room_join: bool,
    pub room: String,
    #[serde(rename = "canPublish")]
    pub can_publish: bool,
    #[serde(rename = "canSubscribe")]
    pub can_subscribe: bool,
    #[serde(rename = "canPublishData")]
    pub can_publish_data: bool,
}

#[derive(Debug, Serialize)]
pub struct Claims {
    pub iss: String,
    pub sub: String,
    pub name: String,
    pub nbf: i64,
    pub exp: i64,
    pub video: VideoGrant,
}

pub fn generate_livekit_token(
    api_key: &str,
    api_secret: &str,
    room_id: &str,
    user_id: &str,
    username: &str,
) -> Result<String> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("Failed to get current timestamp")?
        .as_secs() as i64;

    let claims = Claims {
        iss: api_key.to_string(),
        sub: user_id.to_string(),
        name: username.to_string(),
        nbf: now - 5,
        exp: now + (24 * 3600), // Valid for 24 hours
        video: VideoGrant {
            room_join: true,
            room: room_id.to_string(),
            can_publish: true,
            can_subscribe: true,
            can_publish_data: true,
        },
    };

    let header = Header::default();
    let token = encode(
        &header,
        &claims,
        &EncodingKey::from_secret(api_secret.as_bytes()),
    )?;

    Ok(token)
}
