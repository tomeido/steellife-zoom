use anyhow::Result;
use std::fs::{self, File};
use std::io::{Write, Seek, SeekFrom};
use std::path::PathBuf;
use std::sync::Arc;
use dashmap::DashMap;
use tokio::sync::Mutex;
use tracing::info;

pub struct RoomAudioBuffer {
    pub file_path: PathBuf,
    pub pcm_bytes_written: u32,
    pub file: File,
}

#[derive(Clone)]
pub struct AudioRecorder {
    recordings_dir: PathBuf,
    active_buffers: Arc<DashMap<String, Arc<Mutex<RoomAudioBuffer>>>>,
}

impl AudioRecorder {
    pub fn new() -> Self {
        let recordings_dir = PathBuf::from("recordings");
        if !recordings_dir.exists() {
            let _ = fs::create_dir_all(&recordings_dir);
        }

        Self {
            recordings_dir,
            active_buffers: Arc::new(DashMap::new()),
        }
    }

    /// Append binary 16kHz 16-bit Mono PCM audio chunk to room WAV file
    pub async fn append_audio_chunk(&self, room_id: &str, pcm_chunk: &[u8]) -> Result<()> {
        if pcm_chunk.is_empty() {
            return Ok(());
        }

        let buffer_entry = self
            .active_buffers
            .entry(room_id.to_string())
            .or_insert_with(|| {
                let file_path = self.recordings_dir.join(format!("{}.wav", room_id));
                let mut file = File::create(&file_path).expect("Failed to create room recording WAV file");

                // Write initial 44-byte WAV header placeholder
                let header = create_wav_header(0, 16000, 1, 16);
                let _ = file.write_all(&header);

                info!("🎙️ Created room recording file: {:?}", file_path);

                Arc::new(Mutex::new(RoomAudioBuffer {
                    file_path,
                    pcm_bytes_written: 0,
                    file,
                }))
            })
            .value()
            .clone();

        let mut buf = buffer_entry.lock().await;
        buf.file.write_all(pcm_chunk)?;
        buf.pcm_bytes_written += pcm_chunk.len() as u32;

        Ok(())
    }

    /// Finalize room WAV file header and return file path
    pub async fn finalize_recording(&self, room_id: &str) -> Option<PathBuf> {
        if let Some((_, buffer_arc)) = self.active_buffers.remove(room_id) {
            let mut buf = buffer_arc.lock().await;
            
            // Update WAV header with actual PCM byte count
            if buf.file.seek(SeekFrom::Start(0)).is_ok() {
                let header = create_wav_header(buf.pcm_bytes_written, 16000, 1, 16);
                let _ = buf.file.write_all(&header);
                let _ = buf.file.flush();
            }

            info!(
                "🛑 Finalized room recording '{}.wav' (PCM bytes: {})",
                room_id, buf.pcm_bytes_written
            );

            return Some(buf.file_path.clone());
        }

        // Fallback: check if file exists on disk
        let path = self.recordings_dir.join(format!("{}.wav", room_id));
        if path.exists() {
            Some(path)
        } else {
            None
        }
    }
}

fn create_wav_header(
    pcm_data_len: u32,
    sample_rate: u32,
    num_channels: u16,
    bits_per_sample: u16,
) -> Vec<u8> {
    let mut header = Vec::with_capacity(44);
    let byte_rate = sample_rate * num_channels as u32 * (bits_per_sample / 8) as u32;
    let block_align = num_channels * (bits_per_sample / 8);

    header.extend_from_slice(b"RIFF");
    header.extend_from_slice(&(36 + pcm_data_len).to_le_bytes());
    header.extend_from_slice(b"WAVE");
    header.extend_from_slice(b"fmt ");
    header.extend_from_slice(&16u32.to_le_bytes()); // Subchunk1Size
    header.extend_from_slice(&1u16.to_le_bytes());  // AudioFormat (PCM)
    header.extend_from_slice(&num_channels.to_le_bytes());
    header.extend_from_slice(&sample_rate.to_le_bytes());
    header.extend_from_slice(&byte_rate.to_le_bytes());
    header.extend_from_slice(&block_align.to_le_bytes());
    header.extend_from_slice(&bits_per_sample.to_le_bytes());
    header.extend_from_slice(b"data");
    header.extend_from_slice(&pcm_data_len.to_le_bytes());
    header
}
