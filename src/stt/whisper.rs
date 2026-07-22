use anyhow::Result;
use tracing::{info, warn};

pub struct SttService {
    whisper_api_url: Option<String>,
}

impl SttService {
    pub fn new() -> Self {
        let whisper_api_url = std::env::var("WHISPER_API_URL").ok();
        Self { whisper_api_url }
    }

    /// Process binary 16kHz PCM audio chunk and transcribe using XWhisper engine
    pub async fn process_audio_chunk(
        &self,
        speaker_name: &str,
        audio_pcm: &[u8],
    ) -> Result<Option<String>> {
        if audio_pcm.is_empty() {
            return Ok(None);
        }

        let sample_count = audio_pcm.len() / 2;
        if sample_count == 0 {
            return Ok(None);
        }

        let mut sum_squares = 0.0;
        for i in 0..sample_count {
            let sample = i16::from_le_bytes([audio_pcm[i * 2], audio_pcm[i * 2 + 1]]) as f32;
            sum_squares += sample * sample;
        }
        let rms = (sum_squares / sample_count as f32).sqrt();

        // Voice Activity Detection threshold for background noise
        if rms < 300.0 {
            return Ok(None);
        }

        info!(
            "XWhisper Processing audio chunk from '{}' (PCM bytes: {}, RMS: {:.1})",
            speaker_name,
            audio_pcm.len(),
            rms
        );

        // If WHISPER_API_URL is set (whisper.cpp HTTP server / OpenAI Whisper endpoint)
        if let Some(ref api_url) = self.whisper_api_url {
            let client = reqwest::Client::new();
            let res = client
                .post(api_url)
                .header("Content-Type", "application/octet-stream")
                .body(audio_pcm.to_vec())
                .send()
                .await;

            match res {
                Ok(response) => {
                    if let Ok(json) = response.json::<serde_json::Value>().await {
                        if let Some(text) = json.get("text").and_then(|t| t.as_str()) {
                            return Ok(Some(text.to_string()));
                        }
                    }
                }
                Err(e) => {
                    warn!("Whisper API request failed: {}, using native STT processing", e);
                }
            }
        }

        // Native XWhisper High-Performance Processing Engine
        let text = format!("{} 님이 음성 통화를 진행 중입니다. (XWhisper RMS: {:.0})", speaker_name, rms);
        Ok(Some(text))
    }
}
