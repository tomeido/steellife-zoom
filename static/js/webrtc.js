/**
 * LiveKit SFU Client Manager for SLZoom
 * Manages video/audio tracks via LiveKit Client SDK (livekit-client.umd.min.js)
 */
class LiveKitManager {
  constructor(localVideoElem, videoGridElem) {
    this.localVideo = localVideoElem;
    this.videoGrid = videoGridElem;
    this.room = null;
    this.ws = null;
    this.localStream = null;
    this.currentUserId = null;
    this.currentRoomId = null;
    this.currentUsername = null;
    this.screenShareStateHandler = null;

    // Track elements mapping
    this.participantTiles = new Map(); // identity -> DOM element
  }

  onScreenShareStateChange(handler) {
    this.screenShareStateHandler = handler;
  }

  notifyScreenShareState(isSharing) {
    if (this.screenShareStateHandler) {
      this.screenShareStateHandler(isSharing);
    }
  }

  async loadIceServers() {
    // LiveKit manages ICE/TURN infrastructure natively on the SFU server side
    console.info('🚀 [LiveKit] Initialized Self-Hosted LiveKit Manager (SFU Architecture Active)');
  }

  async initLocalMedia() {
    // Check for Secure Context warning if needed
    if (!window.isSecureContext && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
      console.warn('[LiveKit] Secure Context (HTTPS or localhost) is required for Camera/Mic access.');
      this.showInsecureContextWarning();
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true
      });
      this.localStream = stream;
      if (this.localVideo) {
        this.localVideo.srcObject = stream;
        this.localVideo.muted = true;
        this.localVideo.play().catch(e => console.warn('[LiveKit] Local video play error:', e));
      }
    } catch (err) {
      console.warn('[LiveKit] Fallback local stream capture:', err);
    }
    return this.localStream;
  }

  showInsecureContextWarning() {
    let warningBanner = document.getElementById('insecure-context-banner');
    if (!warningBanner) {
      warningBanner = document.createElement('div');
      warningBanner.id = 'insecure-context-banner';
      warningBanner.style.cssText = 'position:fixed; top:12px; left:50%; transform:translateX(-50%); background:#ef4444; color:#fff; padding:10px 20px; border-radius:8px; z-index:9999; font-weight:600; font-size:0.88rem; box-shadow:0 4px 20px rgba(0,0,0,0.5); text-align:center; max-width:90%;';
      warningBanner.innerHTML = '⚠️ 보안 연결(HTTPS 또는 http://localhost)이 아닌 환경에서는 브라우저가 카메라/마이크 권한을 차단합니다. <strong>http://localhost:3000</strong> 으로 접속해 주세요.';
      document.body.appendChild(warningBanner);
    }
  }

  /**
   * Connect to Self-Hosted LiveKit Server using token from Rust Backend
   */
  async connectLiveKit(roomId, userId, username) {
    this.currentRoomId = roomId;
    this.currentUserId = userId;
    this.currentUsername = username;

    // 1. Fetch JWT Token from Rust Axum Backend (/api/livekit/token)
    const tokenRes = await fetch('/api/livekit/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ room_id: roomId, user_id: userId, username: username })
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      throw new Error(`Failed to obtain LiveKit token: HTTP ${tokenRes.status} - ${errText}`);
    }

    const { server_url, token } = await tokenRes.json();
    console.log(`🔌 Connecting to LiveKit Self-Hosted Server: ${server_url} (Room: ${roomId})`);

    // 2. Instantiate LiveKit Room
    const LiveKitClient = window.LivekitClient || window.LiveKit;
    if (!LiveKitClient) {
      throw new Error('LiveKit Client SDK script not loaded on page!');
    }

    this.room = new LiveKitClient.Room({
      adaptiveStream: true,
      dynacast: true,
      videoCaptureDefaults: {
        resolution: LiveKitClient.VideoPresets.h720.resolution,
      },
    });

    // 3. Register LiveKit Room Event Listeners
    this.setupRoomEvents(LiveKitClient);

    // 4. Connect to LiveKit SFU Server
    await this.room.connect(server_url, token);
    console.log('✅ [LiveKit] Successfully connected to LiveKit SFU Server room:', this.room.name);

    // 5. Publish Local Audio & Video Tracks
    try {
      await this.room.localParticipant.enableCameraAndMicrophone();
      console.log('🎥 [LiveKit] Local camera and microphone published to LiveKit room');
      
      // Update local preview with LiveKit local video track
      const videoPub = Array.from(this.room.localParticipant.videoTrackPublications.values())[0];
      if (videoPub && videoPub.track && this.localVideo) {
        videoPub.track.attach(this.localVideo);
      }
    } catch (pubErr) {
      console.warn('⚠️ [LiveKit] Could not publish camera/mic automatically:', pubErr);
    }

    // Process existing participants in room
    this.room.remoteParticipants.forEach((participant) => {
      participant.trackPublications.forEach((publication) => {
        if (publication.isSubscribed && publication.track) {
          this.handleTrackSubscribed(publication.track, participant);
        }
      });
    });

    return this.room;
  }

  setupRoomEvents(LiveKitClient) {
    const RoomEvent = LiveKitClient.RoomEvent;

    this.room
      .on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
        console.log(`📡 [LiveKit] Track Subscribed: ${track.kind} from participant ${participant.identity}`);
        this.handleTrackSubscribed(track, participant);
      })
      .on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
        console.log(`📡 [LiveKit] Track Unsubscribed: ${track.kind} from ${participant.identity}`);
        this.handleTrackUnsubscribed(track, participant);
      })
      .on(RoomEvent.ParticipantConnected, (participant) => {
        console.log(`👤 [LiveKit] Participant Connected: ${participant.name} (${participant.identity})`);
        this.getOrCreateParticipantTile(participant);
      })
      .on(RoomEvent.ParticipantDisconnected, (participant) => {
        console.log(`🚪 [LiveKit] Participant Disconnected: ${participant.name} (${participant.identity})`);
        this.removeParticipantTile(participant.identity);
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers) => {
        this.handleActiveSpeakersChanged(speakers);
      })
      .on(RoomEvent.LocalTrackPublished, (publication, participant) => {
        if (publication.source === LiveKitClient.Track.Source.ScreenShare) {
          this.notifyScreenShareState(true);
        }
      })
      .on(RoomEvent.LocalTrackUnpublished, (publication, participant) => {
        if (publication.source === LiveKitClient.Track.Source.ScreenShare) {
          this.notifyScreenShareState(false);
        }
      })
      .on(RoomEvent.Disconnected, (reason) => {
        console.warn('⚠️ [LiveKit] Disconnected from LiveKit Server:', reason);
      });
  }

  handleTrackSubscribed(track, participant) {
    const tile = this.getOrCreateParticipantTile(participant);
    const mediaElem = track.attach();
    mediaElem.dataset.trackId = track.sid;

    if (track.kind === 'video') {
      const existingVideo = tile.querySelector('video');
      if (existingVideo) existingVideo.remove();
      mediaElem.style.width = '100%';
      mediaElem.style.height = '100%';
      mediaElem.style.objectFit = 'cover';
      tile.appendChild(mediaElem);
    } else if (track.kind === 'audio') {
      const existingAudio = tile.querySelector('audio');
      if (existingAudio) existingAudio.remove();
      tile.appendChild(mediaElem);
    }
  }

  handleTrackUnsubscribed(track, participant) {
    track.detach().forEach((element) => element.remove());
  }

  getOrCreateParticipantTile(participant) {
    const identity = participant.identity;
    let tile = document.getElementById(`tile-${identity}`);

    if (!tile) {
      tile = document.createElement('div');
      tile.id = `tile-${identity}`;
      tile.className = 'video-tile';

      const label = document.createElement('div');
      label.className = 'speaker-tag';
      label.innerHTML = `<span>${participant.name || identity}</span>`;

      tile.appendChild(label);
      this.videoGrid.appendChild(tile);
      this.participantTiles.set(identity, tile);
    }
    return tile;
  }

  removeParticipantTile(identity) {
    const tile = document.getElementById(`tile-${identity}`);
    if (tile) {
      tile.remove();
      this.participantTiles.delete(identity);
    }
  }

  handleActiveSpeakersChanged(speakers) {
    const activeIdentities = new Set(speakers.map(s => s.identity));

    // Update remote speaker tiles
    this.participantTiles.forEach((tile, identity) => {
      if (activeIdentities.has(identity)) {
        tile.classList.add('speaking');
      } else {
        tile.classList.remove('speaking');
      }
    });

    // Update local speaker tile
    const localTile = document.getElementById('tile-local');
    if (localTile) {
      if (activeIdentities.has(this.currentUserId)) {
        localTile.classList.add('speaking');
      } else {
        localTile.classList.remove('speaking');
      }
    }
  }

  /**
   * Connect WebSocket for WASM STT & Chat synchronization
   */
  connectWS(wsUrl, userId, username, roomId, onMessageCallback) {
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('⚡ WebSocket Connected for STT & Chat signaling');
      this.ws.send(JSON.stringify({
        type: 'JoinRoom',
        payload: { room_id: roomId, user_id: userId, username: username }
      }));
    };

    this.ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (onMessageCallback) onMessageCallback(msg);
      } catch (err) {
        console.error('Error parsing WebSocket message:', err);
      }
    };

    this.ws.onclose = () => {
      console.warn('WebSocket connection closed.');
    };

    return this.ws;
  }

  // --- Track Toggle Controls using LiveKit APIs ---

  async toggleMic() {
    if (!this.room) return true;
    const isEnabled = this.room.localParticipant.isMicrophoneEnabled;
    await this.room.localParticipant.setMicrophoneEnabled(!isEnabled);
    return !isEnabled;
  }

  async toggleCam() {
    if (!this.room) return true;
    const isEnabled = this.room.localParticipant.isCameraEnabled;
    await this.room.localParticipant.setCameraEnabled(!isEnabled);
    return !isEnabled;
  }

  async toggleScreenShare() {
    if (!this.room) return false;
    const isSharing = this.room.localParticipant.isScreenShareEnabled;
    try {
      await this.room.localParticipant.setScreenShareEnabled(!isSharing);
      this.notifyScreenShareState(!isSharing);
      return !isSharing;
    } catch (err) {
      console.warn('Screen share cancelled or failed:', err);
      this.notifyScreenShareState(false);
      return false;
    }
  }

  leaveRoom() {
    if (this.room) {
      this.room.disconnect();
      this.room = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.participantTiles.forEach((tile) => tile.remove());
    this.participantTiles.clear();
  }
}

// Global class export for app.js
window.WebRTCManager = LiveKitManager;
