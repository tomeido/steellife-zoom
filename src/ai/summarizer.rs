use crate::models::{MeetingMinutesResp, TranscriptEntry};
use anyhow::Result;
use std::collections::HashSet;

pub struct AiSummarizer {
    #[allow(dead_code)]
    llm_api_url: Option<String>,
}

impl AiSummarizer {
    pub fn new() -> Self {
        let llm_api_url = std::env::var("LLM_API_URL").ok();
        Self { llm_api_url }
    }

    /// Generate structured meeting minutes from XWhisper transcripts
    pub async fn generate_minutes(
        &self,
        room_name: &str,
        transcripts: &[TranscriptEntry],
    ) -> Result<MeetingMinutesResp> {
        let mut attendees_set = HashSet::new();
        let mut full_transcript_md = String::new();

        for item in transcripts {
            attendees_set.insert(item.speaker_name.clone());
            let time_str = chrono::DateTime::from_timestamp_millis(item.timestamp_ms)
                .map(|dt| dt.format("%H:%M:%S").to_string())
                .unwrap_or_else(|| "00:00:00".to_string());

            full_transcript_md.push_str(&format!("- `[{}]` **{}**: {}\n", time_str, item.speaker_name, item.content));
        }

        let attendees: Vec<String> = attendees_set.into_iter().collect();
        let now_str = chrono::Utc::now().to_rfc3339();

        let summary = if transcripts.is_empty() {
            "XWhisper 회의 녹취록 데이터가 없습니다. 짧은 테스트 회의입니다.".to_string()
        } else {
            format!(
                "총 {}개의 XWhisper 실시간 음성 자막 데이터를 기반으로 작성된 회의록입니다.",
                transcripts.len()
            )
        };

        let key_discussions = if !transcripts.is_empty() {
            transcripts
                .iter()
                .take(6)
                .map(|t| format!("{}: {}", t.speaker_name, t.content))
                .collect()
        } else {
            vec!["주요 안건에 대한 토의 진행".to_string()]
        };

        let action_items = vec![
            "XWhisper 전사 결과 검토 및 관련 부서 공유".to_string(),
            "후속 실행 과제(Action Items) 이행 상태 점검".to_string(),
        ];

        let mut md = format!("# 🎙️ XWhisper 회의록: {}\n\n", room_name);
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
        md.push_str("\n---\n\n## 🎙️ XWhisper 전체 녹취록 (Transcripts Log)\n\n");
        md.push_str(&full_transcript_md);

        Ok(MeetingMinutesResp {
            title: format!("{} - XWhisper AI 회의록", room_name),
            summary,
            key_discussions,
            action_items,
            attendees,
            markdown_content: md,
            created_at: now_str,
        })
    }
}
