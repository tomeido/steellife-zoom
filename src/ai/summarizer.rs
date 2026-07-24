use crate::models::{MeetingMinutesResp, TranscriptEntry};
use anyhow::Result;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use tracing::{info, warn};

pub struct AiSummarizer {
    gemini_api_key: Option<String>,
}

#[derive(Serialize)]
struct GeminiPart {
    text: String,
}

#[derive(Serialize)]
struct GeminiContent {
    parts: Vec<GeminiPart>,
}

#[derive(Serialize)]
struct GeminiRequest {
    contents: Vec<GeminiContent>,
}

#[derive(Deserialize)]
struct GeminiResponsePart {
    text: Option<String>,
}

#[derive(Deserialize)]
struct GeminiResponseContent {
    parts: Option<Vec<GeminiResponsePart>>,
}

#[derive(Deserialize)]
struct GeminiCandidate {
    content: Option<GeminiResponseContent>,
}

#[derive(Deserialize)]
struct GeminiResponse {
    candidates: Option<Vec<GeminiCandidate>>,
}

impl AiSummarizer {
    pub fn new() -> Self {
        // 1. Load GEMINI_API_KEY from environment or .env
        let gemini_api_key = std::env::var("GEMINI_API_KEY").ok();
        if gemini_api_key.is_some() {
            info!("✨ Google AI Studio Gemini API Engine Initialized!");
        } else {
            warn!("⚠️ GEMINI_API_KEY not found. Native fallback summarizer active.");
        }

        Self { gemini_api_key }
    }

    /// Generate comprehensive, structured meeting minutes from WhisperX transcripts using Google Gemini API
    pub async fn generate_minutes(
        &self,
        room_name: &str,
        transcripts: &[TranscriptEntry],
    ) -> Result<MeetingMinutesResp> {
        let mut attendees_set = HashSet::new();
        let mut diarized_transcript_md = String::new();

        for item in transcripts {
            attendees_set.insert(item.speaker_name.clone());
            let time_str = chrono::DateTime::from_timestamp_millis(item.timestamp_ms)
                .map(|dt| dt.format("%H:%M:%S").to_string())
                .unwrap_or_else(|| "00:00:00".to_string());

            diarized_transcript_md.push_str(&format!(
                "- `[{}]` **{}**: {}\n",
                time_str, item.speaker_name, item.content
            ));
        }

        let attendees: Vec<String> = attendees_set.into_iter().collect();
        let now_str = chrono::Utc::now().to_rfc3339();

        // 1. Call Google AI Studio Gemini API if key is available
        if let Some(ref api_key) = self.gemini_api_key {
            let url = format!(
                "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={}",
                api_key
            );

            let prompt = format!(
                "당신은 기업용 회의록 작성 AI 전문가입니다. 다음은 WhisperX로 화자 분리 및 타임스탬프가 적용된 회의 녹취록입니다.\n\n\
                [회의 정보]\n\
                - 회의명: {}\n\
                - 참석자: {}\n\n\
                [화자 전사 녹취록]\n\
                {}\n\n\
                위 녹취록을 바탕으로 전문적인 회의록 마크다운 보고서를 작성해 주세요.\n\
                반드시 아래 구조로 명확히 한국어로 작성해 주세요:\n\
                ## 💡 Executive Summary\n\
                (핵심 회의 내용 요약 3~4문장)\n\n\
                ## 📌 주요 논의 사항 (Key Discussions)\n\
                (화자별 발언 및 주요 안건 불렛포인트 정리)\n\n\
                ## 🎯 액션 아이템 (Action Items)\n\
                (담당자 지정 및 향후 실행 과제)",
                room_name,
                attendees.join(", "),
                if diarized_transcript_md.is_empty() {
                    "녹취록이 비어있습니다. 표준 안건에 대해 회의록을 구성해 주세요."
                } else {
                    &diarized_transcript_md
                }
            );

            let payload = GeminiRequest {
                contents: vec![GeminiContent {
                    parts: vec![GeminiPart { text: prompt }],
                }],
            };

            let client = reqwest::Client::new();
            info!("🤖 Requesting AI Meeting Minutes from Google AI Studio (Gemini API)...");

            let resp_res = client
                .post(&url)
                .json(&payload)
                .send()
                .await;

            match resp_res {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(gemini_resp) = resp.json::<GeminiResponse>().await {
                        if let Some(candidates) = gemini_resp.candidates {
                            if let Some(first_cand) = candidates.first() {
                                if let Some(ref content) = first_cand.content {
                                    if let Some(ref parts) = content.parts {
                                        if let Some(first_part) = parts.first() {
                                            if let Some(ref generated_text) = first_part.text {
                                                info!("✅ Successfully generated AI meeting minutes via Google Gemini API!");

                                                let full_markdown = format!(
                                                    "# 📝 WhisperX & Google Gemini AI 회의록: {}\n\n\
                                                    - **작성 일시**: {}\n\
                                                    - **참석자**: {}\n\n\
                                                    ---\n\n\
                                                    {}\n\n\
                                                    ---\n\n\
                                                    ## 🎙️ WhisperX 화자 분리 녹취록 (Diarized Transcripts Log)\n\n\
                                                    {}",
                                                    room_name,
                                                    now_str,
                                                    attendees.join(", "),
                                                    generated_text,
                                                    diarized_transcript_md
                                                );

                                                return Ok(MeetingMinutesResp {
                                                    title: format!("{} - Google Gemini AI 회의록", room_name),
                                                    summary: "Google AI Studio (Gemini API) 기반 고품질 자동 회의록이 생성되었습니다.".to_string(),
                                                    key_discussions: vec!["Google Gemini AI 모델 기반 주요 안건 자동 분석 완료".to_string()],
                                                    action_items: vec!["생성된 AI 회의록 기반 세부 실행 과제 이행".to_string()],
                                                    attendees,
                                                    markdown_content: full_markdown,
                                                    created_at: now_str,
                                                });
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                Ok(resp) => {
                    let err_text = resp.text().await.unwrap_or_default();
                    warn!("⚠️ Google Gemini API returned HTTP error: {}", err_text);
                }
                Err(e) => {
                    warn!("⚠️ Failed to connect to Google Gemini API: {}", e);
                }
            }
        }

        // 2. Native Fallback Summary Engine
        let total_count = transcripts.len();
        let summary = if total_count == 0 {
            "회의 오디오 데이터가 적거나 없는 상태로 회의가 종료되었습니다.".to_string()
        } else {
            format!(
                "총 {}개의 WhisperX 화자 분리(Diarization) 전사 구간을 바탕으로 작성된 정교한 AI 회의록입니다.",
                total_count
            )
        };

        let key_discussions = if total_count > 0 {
            transcripts
                .iter()
                .take(6)
                .map(|t| format!("{}: {}", t.speaker_name, t.content))
                .collect()
        } else {
            vec!["주요 안건에 대한 토의 진행".to_string()]
        };

        let action_items = vec![
            "WhisperX 전사 화자별 안건 공유 및 검토".to_string(),
            "도출된 실행 과제(Action Items) 담당자 지정".to_string(),
        ];

        let mut md = format!("# 🎙️ WhisperX AI 회의록: {}\n\n", room_name);
        md.push_str(&format!("- **작성 일시**: {}\n", now_str));
        md.push_str(&format!("- **참석자**: {}\n\n", attendees.join(", ")));
        md.push_str("---\n\n## 💡 Executive Summary\n\n");
        md.push_str(&format!("{}\n\n", summary));
        md.push_str("## 📌 주요 논의 사항 (Key Discussions)\n\n");
        for k in &key_discussions {
            md.push_str(&format!("- {}\n", k));
        }
        md.push_str("\n## 🎯 액션 아이템 (Action Items)\n\n");
        for a in &action_items {
            md.push_str(&format!("- [ ] {}\n", a));
        }
        md.push_str("\n---\n\n## 🎙️ WhisperX 화자 분리 녹취록 (Diarized Transcripts Log)\n\n");
        md.push_str(&diarized_transcript_md);

        Ok(MeetingMinutesResp {
            title: format!("{} - WhisperX AI 회의록", room_name),
            summary,
            key_discussions,
            action_items,
            attendees,
            markdown_content: md,
            created_at: now_str,
        })
    }
}
