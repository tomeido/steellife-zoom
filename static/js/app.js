import initWasm, { RustSpeechRecognizer } from '/pkg/wasm_stt.js';

document.addEventListener('DOMContentLoaded', async () => {
  // Initialize WASM Module (Rust web-sys SpeechRecognition)
  let isWasmLoaded = false;
  try {
    await initWasm();
    isWasmLoaded = true;
    console.log('🚀 [Rust WASM] web-sys SpeechRecognition WASM module loaded successfully');
  } catch (err) {
    console.warn('⚠️ [Rust WASM] Could not load WASM module directly, fallback active:', err);
  }

  // DOM Elements
  const localVideo = document.getElementById('local-video');
  const videoGrid = document.getElementById('video-grid');
  const btnNewRoom = document.getElementById('btn-new-room');
  const btnJoinRoom = document.getElementById('btn-join-room');
  const btnCopyCode = document.getElementById('btn-copy-code');
  const btnGenMinutes = document.getElementById('btn-gen-minutes');
  const roomCodeDisplay = document.getElementById('room-code-display');

  const btnToggleMic = document.getElementById('btn-toggle-mic');
  const btnToggleCam = document.getElementById('btn-toggle-cam');
  const btnScreenShare = document.getElementById('btn-screen-share');
  const btnToggleChat = document.getElementById('btn-toggle-chat');
  const btnLeaveRoom = document.getElementById('btn-leave-room');
  const sidebar = document.getElementById('sidebar');

  // Mobile sidebar toggle
  if (btnToggleChat) {
    btnToggleChat.addEventListener('click', () => {
      sidebar.classList.toggle('hidden-mobile');
    });
  }

  const panelTranscript = document.getElementById('panel-transcript');
  const panelChat = document.getElementById('panel-chat');
  const tabTranscript = document.getElementById('tab-transcript');
  const tabChat = document.getElementById('tab-chat');
  const chatMessages = document.getElementById('chat-messages');
  const chatInput = document.getElementById('chat-input');
  const btnSendChat = document.getElementById('btn-send-chat');

  const minutesModal = document.getElementById('minutes-modal');
  const btnCloseModal = document.getElementById('btn-close-modal');
  const btnCloseModalFooter = document.getElementById('btn-close-modal-footer');
  const btnDownloadMd = document.getElementById('btn-download-md');
  const minutesSummary = document.getElementById('minutes-summary');
  const minutesDiscussions = document.getElementById('minutes-discussions');
  const minutesActions = document.getElementById('minutes-actions');

  // Client Application State
  const userId = 'user-' + Math.random().toString(36).substr(2, 6);
  const username = '사원_' + Math.floor(Math.random() * 900 + 100);
  let currentRoomId = null;
  let currentRoomName = '화상 회의';
  let isMicOn = true;
  let isCamOn = true;
  let generatedMarkdownContent = '';

  let wasmRecognizer = null;
  let audioStreamer = null;

  // WebRTC Manager
  const rtcManager = new WebRTCManager(localVideo, videoGrid);
  await rtcManager.initLocalMedia();
  document.getElementById('local-user-label').innerText = `${username} (나)`;

  // Register JS bridge callback for Rust web-sys WASM SpeechRecognizer
  window.onWasmSpeechResult = (speaker, content, timestampMs, isFinal) => {
    if (isFinal) {
      const timeStr = new Date(timestampMs).toLocaleTimeString();
      addTranscriptItem(speaker, content, timeStr);
    }

    // Broadcast live transcript over WebSocket
    if (rtcManager.ws && rtcManager.ws.readyState === WebSocket.OPEN) {
      rtcManager.ws.send(JSON.stringify({
        type: 'SpeechRecognized',
        payload: {
          speaker_name: speaker,
          content: content,
          timestamp_ms: timestampMs,
          is_final: isFinal
        }
      }));
    }
  };

  // Sidebar Tab Switching
  tabTranscript.addEventListener('click', () => {
    tabTranscript.classList.add('active');
    tabChat.classList.remove('active');
    panelTranscript.classList.remove('hidden');
    panelChat.classList.add('hidden');
  });

  tabChat.addEventListener('click', () => {
    tabChat.classList.add('active');
    tabTranscript.classList.remove('active');
    panelChat.classList.remove('hidden');
    panelTranscript.classList.add('hidden');
  });

  // 1. Create New Room
  btnNewRoom.addEventListener('click', async () => {
    const roomName = prompt('새 회의실 이름을 입력하세요:', `${username}의 화상 회의`);
    if (!roomName) return;

    try {
      const res = await fetch('/api/rooms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: roomName, host_id: userId })
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.substring(0, 100)}`);
      }
      const room = await res.json();
      joinRoomSession(room.id, room.name);
    } catch (err) {
      alert('회의실 생성 실패: ' + err.message);
    }
  });

  // 2. Join Room
  btnJoinRoom.addEventListener('click', () => {
    const code = prompt('입장할 회의 ID (예: room-12345678)를 입력하세요:');
    if (!code) return;
    joinRoomSession(code, '화상 회의실');
  });

  btnCopyCode.addEventListener('click', () => {
    if (!currentRoomId) return;
    navigator.clipboard.writeText(currentRoomId).then(() => {
      alert(`회의 ID가 복사되었습니다: ${currentRoomId}`);
    }).catch(() => {
      prompt('회의 ID를 복사하세요:', currentRoomId);
    });
  });

  // Join Session Logic
  function joinRoomSession(roomId, roomName) {
    currentRoomId = roomId;
    currentRoomName = roomName;
    roomCodeDisplay.innerText = `회의 ID: ${roomId}`;
    btnCopyCode.style.display = 'inline-flex';
    btnGenMinutes.style.display = 'inline-flex';

    const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProtocol}//${window.location.host}/api/ws`;

    const ws = rtcManager.connectWS(wsUrl, userId, username, roomId, (msg) => {
      handleWsEvent(msg);
    });

    // Start Audio Streamer (saves PCM to server WAV for post-meeting WhisperX)
    audioStreamer = new AudioStreamer(ws);
    audioStreamer.start(rtcManager.localStream);

    // Initialize Rust web-sys WASM SpeechRecognizer for live captions
    if (isWasmLoaded) {
      try {
        wasmRecognizer = new RustSpeechRecognizer(username);
        wasmRecognizer.start();
        console.log('🎙️ [Rust WASM STT Engine] Live SpeechRecognition activated');
      } catch (err) {
        console.warn('Fallback: Web Speech API error:', err);
      }
    }

    addTranscriptItem('시스템', `[${roomName}] 회의실 입장. (Rust web-sys WASM 실시간 자막 & 오디오 녹음 중)`, new Date().toLocaleTimeString());
  }

  // Handle incoming WebSocket messages
  function handleWsEvent(msg) {
    const { type, payload } = msg;
    if (!payload) return;

    if (type === 'SpeechRecognized') {
      if (payload.is_final && payload.speaker_name !== username) {
        const timeStr = new Date(payload.timestamp_ms).toLocaleTimeString();
        addTranscriptItem(payload.speaker_name, payload.content, timeStr);
      }
    } else if (type === 'ChatMessage') {
      const timeStr = new Date(payload.timestamp).toLocaleTimeString();
      addChatMessage(payload.sender_name, payload.content, timeStr);
    } else if (type === 'ActiveSpeaker') {
      const tile = document.getElementById(`tile-${payload.user_id}`) || document.getElementById('tile-local');
      if (tile) {
        if (payload.is_speaking) tile.classList.add('speaking');
        else tile.classList.remove('speaking');
      }
    }
  }

  // Add Live Transcript Item
  function addTranscriptItem(speaker, content, time) {
    const card = document.createElement('div');
    card.className = 'transcript-card';
    card.innerHTML = `
      <div class="transcript-header">
        <span class="transcript-speaker">${speaker}</span>
        <span>${time}</span>
      </div>
      <div class="transcript-body">${content}</div>
    `;
    panelTranscript.appendChild(card);
    panelTranscript.scrollTop = panelTranscript.scrollHeight;
  }

  // Add Chat Message
  function addChatMessage(sender, content, time) {
    const msgDiv = document.createElement('div');
    msgDiv.style.cssText = 'background:rgba(255,255,255,0.05); padding:8px 12px; border-radius:6px;';
    msgDiv.innerHTML = `
      <div style="font-size:0.75rem; color:var(--text-secondary); margin-bottom:2px;">
        <strong>${sender}</strong> (${time})
      </div>
      <div style="font-size:0.9rem;">${content}</div>
    `;
    chatMessages.appendChild(msgDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // Send Chat
  btnSendChat.addEventListener('click', () => {
    const text = chatInput.value.trim();
    if (!text || !rtcManager.ws) return;
    rtcManager.ws.send(JSON.stringify({
      type: 'ChatMessage',
      payload: {
        sender_name: username,
        content: text,
        timestamp: Date.now()
      }
    }));
    chatInput.value = '';
  });

  chatInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') btnSendChat.click();
  });

  // Controls: Mic & Cam & Screen Share
  btnToggleMic.addEventListener('click', () => {
    isMicOn = !isMicOn;
    rtcManager.toggleMic(isMicOn);
    if (wasmRecognizer) {
      if (isMicOn) wasmRecognizer.start();
      else wasmRecognizer.stop();
    }
    btnToggleMic.innerText = isMicOn ? '🎙️' : '🔇';
    btnToggleMic.style.background = isMicOn ? '' : 'var(--danger)';
  });

  btnToggleCam.addEventListener('click', () => {
    isCamOn = !isCamOn;
    rtcManager.toggleCam(isCamOn);
    btnToggleCam.innerText = isCamOn ? '📷' : '🚫';
    btnToggleCam.style.background = isCamOn ? '' : 'var(--danger)';
  });

  btnScreenShare.addEventListener('click', async () => {
    const isSharing = await rtcManager.toggleScreenShare();
    btnScreenShare.style.background = isSharing ? 'var(--accent-primary)' : '';
  });

  // 3. End Meeting & Generate WhisperX + LLM Meeting Minutes
  async function triggerEndMeetingAndGenerateMinutes() {
    if (!currentRoomId) return;

    btnGenMinutes.innerText = '⏳ WhisperX 전사 & LLM 회의록 작성 중...';
    btnGenMinutes.disabled = true;

    try {
      // Stop local audio streaming and WASM STT
      if (wasmRecognizer) wasmRecognizer.stop();
      if (audioStreamer) audioStreamer.stop();

      const res = await fetch(`/api/rooms/${currentRoomId}/end`, {
        method: 'POST'
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}: Failed to generate WhisperX minutes`);
      }
      const minutes = await res.json();
      generatedMarkdownContent = minutes.markdown_content;
      displayMinutes(minutes);
    } catch (err) {
      alert('WhisperX 회의록 생성 에러: ' + err.message);
    } finally {
      btnGenMinutes.innerText = '✨ 회의 종료 & WhisperX 회의록 생성';
      btnGenMinutes.disabled = false;
    }
  }

  btnGenMinutes.addEventListener('click', triggerEndMeetingAndGenerateMinutes);
  btnLeaveRoom.addEventListener('click', async () => {
    if (confirm('회의를 종료하고 WhisperX 회의록을 생성하시겠습니까?')) {
      await triggerEndMeetingAndGenerateMinutes();
    }
  });

  // Display Minutes Modal
  function displayMinutes(minutes) {
    document.getElementById('minutes-modal-title').innerText = `✨ ${minutes.title}`;
    minutesSummary.innerText = minutes.summary;

    minutesDiscussions.innerHTML = minutes.key_discussions
      .map(item => `<li>${item}</li>`).join('');

    minutesActions.innerHTML = minutes.action_items
      .map(item => `<li>${item}</li>`).join('');

    minutesModal.classList.remove('hidden');
  }

  // Close Modal
  btnCloseModal.addEventListener('click', () => minutesModal.classList.add('hidden'));
  btnCloseModalFooter.addEventListener('click', () => minutesModal.classList.add('hidden'));

  // Client Download .md File
  btnDownloadMd.addEventListener('click', () => {
    if (!generatedMarkdownContent) return;

    const blob = new Blob([generatedMarkdownContent], { type: 'text/markdown;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.setAttribute('download', `whisperx_minutes_${currentRoomId || 'session'}.md`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  });
});
