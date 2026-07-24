class WebRTCManager {
  constructor(localVideoElem, videoGridElem) {
    this.localVideo = localVideoElem;
    this.videoGrid = videoGridElem;
    this.localStream = null;
    this.screenStream = null;
    this.canvasFallbackInterval = null;
    this.peerConnections = {}; // peerUserId -> RTCPeerConnection
    this.iceCandidateQueues = {}; // peerUserId -> Array of candidate
    this.iceRestartTimers = {}; // peerUserId -> timer
    this.ws = null;
    this.currentUserId = null;
    this.currentRoomId = null;
    this.screenShareStateHandler = null;

    // STUN configuration fallback
    this.iceServers = {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.services.mozilla.com' }
      ]
    };
  }

  async loadIceServers() {
    try {
      const response = await fetch('/api/config/webrtc');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const config = await response.json();
      if (!Array.isArray(config.ice_servers) || config.ice_servers.length === 0) {
        throw new Error('The server returned no ICE servers');
      }

      this.iceServers = { iceServers: config.ice_servers };
      console.info(`[WebRTC] Loaded ${config.ice_servers.length} ICE server configuration(s).`);
    } catch (error) {
      console.warn('[WebRTC] Could not load server ICE configuration; using STUN fallback.', error);
    }
  }

  onScreenShareStateChange(handler) {
    this.screenShareStateHandler = handler;
  }

  notifyScreenShareState(isSharing) {
    if (this.screenShareStateHandler) {
      this.screenShareStateHandler(isSharing);
    }
  }

  createCanvasFallbackStream() {
    if (this.canvasFallbackInterval) {
      clearInterval(this.canvasFallbackInterval);
      this.canvasFallbackInterval = null;
    }

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext('2d');

    let frameCount = 0;
    const draw = () => {
      frameCount++;
      const grad = ctx.createLinearGradient(0, 0, 640, 360);
      grad.addColorStop(0, '#0f172a');
      grad.addColorStop(1, '#1e1b4b');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, 640, 360);

      const radius = 40 + Math.sin(frameCount * 0.05) * 5;
      ctx.beginPath();
      ctx.arc(320, 140, radius, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(99, 102, 241, 0.25)';
      ctx.fill();

      ctx.fillStyle = '#818cf8';
      ctx.font = 'bold 32px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('📷 SLZoom Stream', 320, 150);

      ctx.fillStyle = '#f8fafc';
      ctx.font = '15px sans-serif';
      ctx.fillText('카메라 미연결 / 가상 스트림 활성화', 320, 210);

      ctx.fillStyle = '#94a3b8';
      ctx.font = '13px monospace';
      ctx.fillText(new Date().toLocaleTimeString(), 320, 250);
    };

    draw();
    this.canvasFallbackInterval = setInterval(draw, 1000 / 30);
    return canvas.captureStream(30);
  }

  async initLocalMedia() {
    try {
      // First try with resolution preference
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: true
      });
    } catch (e1) {
      console.warn('[WebRTC] Constrained getUserMedia failed, retrying simple getUserMedia...', e1);
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({
          video: true,
          audio: true
        });
      } catch (err) {
        console.warn('[WebRTC] Camera/Mic access denied or unavailable. Activating canvas fallback stream:', err);
        this.localStream = this.createCanvasFallbackStream();
      }
    }

    if (this.localVideo && this.localStream) {
      this.localVideo.setAttribute('playsinline', 'true');
      this.localVideo.setAttribute('webkit-playsinline', 'true');
      this.localVideo.muted = true;
      this.localVideo.style.transform = 'scaleX(-1)';
      this.localVideo.srcObject = this.localStream;
      this.localVideo.play().catch(err => console.warn('[WebRTC] Local video play error:', err));
    }

    return this.localStream;
  }

  connectWS(wsUrl, userId, username, roomId, onMessageCallback) {
    this.currentUserId = userId;
    this.currentRoomId = roomId;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('⚡ WebSocket Connected to Signaling Server');
      this.ws.send(JSON.stringify({
        type: 'JoinRoom',
        payload: { room_id: roomId, user_id: userId, username: username }
      }));
    };

    this.ws.onmessage = async (event) => {
      if (typeof event.data === 'string') {
        const msg = JSON.parse(event.data);
        await this.handleSignalingMessage(msg);
        if (onMessageCallback) onMessageCallback(msg);
      }
    };

    this.ws.onclose = () => console.log('WebSocket connection closed');
    return this.ws;
  }

  async handleSignalingMessage(msg) {
    const { type, payload } = msg;
    if (!payload) return;

    switch (type) {
      case 'PeerList':
        if (payload.peers && Array.isArray(payload.peers)) {
          for (const peer of payload.peers) {
            console.log(`[PeerList] Existing peer found: ${peer.username} (${peer.user_id}). Initiating Offer.`);
            this.ensurePeerTile(peer.user_id, peer.username);
            await this.createOffer(peer.user_id);
          }
        }
        break;

      case 'UserJoined':
        console.log(`[UserJoined] New peer joined: ${payload.username} (${payload.user_id}). Creating tile & awaiting Offer.`);
        this.ensurePeerTile(payload.user_id, payload.username);
        break;

      case 'Offer':
        if (payload.target_user_id === this.currentUserId) {
          console.log(`[Offer Received] From ${payload.sender_user_id}. Creating Answer.`);
          this.ensurePeerTile(payload.sender_user_id, '참여자');
          await this.handleOffer(payload.sender_user_id, payload.sdp);
        }
        break;

      case 'Answer':
        if (payload.target_user_id === this.currentUserId) {
          console.log(`[Answer Received] From ${payload.sender_user_id}. Setting Remote Description.`);
          await this.handleAnswer(payload.sender_user_id, payload.sdp);
        }
        break;

      case 'IceCandidate':
        if (payload.target_user_id === this.currentUserId) {
          await this.handleIceCandidate(payload.sender_user_id, payload.candidate);
        }
        break;

      case 'UserLeft':
        console.log(`[UserLeft] ${payload.username} (${payload.user_id}) left.`);
        this.removePeer(payload.user_id);
        break;
    }
  }

  ensurePeerTile(peerUserId, username) {
    let peerTile = document.getElementById(`tile-${peerUserId}`);
    if (!peerTile) {
      peerTile = document.createElement('div');
      peerTile.className = 'video-tile';
      peerTile.id = `tile-${peerUserId}`;

      const remoteVideo = document.createElement('video');
      remoteVideo.id = `video-${peerUserId}`;
      remoteVideo.autoplay = true;
      remoteVideo.setAttribute('playsinline', 'true');
      remoteVideo.setAttribute('webkit-playsinline', 'true');

      const tag = document.createElement('div');
      tag.className = 'speaker-tag';
      tag.innerHTML = `<span class="peer-status-dot" id="status-${peerUserId}">🔴 연결 중...</span> <span id="name-${peerUserId}">${username || '참여자'}</span> (${peerUserId.substring(0, 5)})`;

      const playOverlay = document.createElement('div');
      playOverlay.className = 'play-overlay hidden';
      playOverlay.id = `overlay-${peerUserId}`;
      playOverlay.innerHTML = '<span>▶ 터치하여 비디오 재생</span>';
      playOverlay.addEventListener('click', () => {
        remoteVideo.play().then(() => {
          this.hidePlayOverlay(peerUserId);
        }).catch(e => console.warn('Manual play failed:', e));
      });

      peerTile.appendChild(remoteVideo);
      peerTile.appendChild(tag);
      peerTile.appendChild(playOverlay);
      this.videoGrid.appendChild(peerTile);
    } else if (username && username !== '참여자') {
      const nameElem = document.getElementById(`name-${peerUserId}`);
      if (nameElem && nameElem.innerText !== username) {
        nameElem.innerText = username;
      }
    }
    return peerTile;
  }

  updatePeerStatus(peerUserId, statusText) {
    const statusElem = document.getElementById(`status-${peerUserId}`);
    if (statusElem) {
      statusElem.innerText = statusText;
    }
  }

  showPlayOverlay(peerUserId) {
    const overlay = document.getElementById(`overlay-${peerUserId}`);
    if (overlay) overlay.classList.remove('hidden');
  }

  hidePlayOverlay(peerUserId) {
    const overlay = document.getElementById(`overlay-${peerUserId}`);
    if (overlay) overlay.classList.add('hidden');
  }

  ensureLocalTracks(pc) {
    if (!this.localStream) return;
    const senders = pc.getSenders();
    const videoStream = this.screenStream || this.localStream;
    const tracks = [
      ...this.localStream.getAudioTracks().map(track => ({ track, stream: this.localStream })),
      ...videoStream.getVideoTracks().map(track => ({ track, stream: videoStream }))
    ];

    tracks.forEach(({ track, stream }) => {
      const exists = senders.some(s => s.track && s.track.kind === track.kind);
      if (!exists) {
        pc.addTrack(track, stream);
      }
    });
  }

  createPeerConnection(peerUserId) {
    if (this.peerConnections[peerUserId]) {
      return this.peerConnections[peerUserId];
    }

    const pc = new RTCPeerConnection(this.iceServers);
    this.peerConnections[peerUserId] = pc;
    this.iceCandidateQueues[peerUserId] = [];

    // Ensure local media tracks are attached
    this.ensureLocalTracks(pc);

    // ICE Candidate Handler
    pc.onicecandidate = (event) => {
      if (event.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'IceCandidate',
          payload: {
            target_user_id: peerUserId,
            candidate: JSON.stringify(event.candidate),
            sender_user_id: this.currentUserId
          }
        }));
      }
    };

    // Remote Track Handler (Supports MediaStream or single track stream creation)
    pc.ontrack = (event) => {
      console.log(`🎥 Remote track [${event.track.kind}] received from ${peerUserId}`, event.streams);
      const peerTile = this.ensurePeerTile(peerUserId);
      const remoteVideo = peerTile.querySelector('video');
      if (remoteVideo) {
        let stream = (event.streams && event.streams[0]) ? event.streams[0] : null;
        if (!stream) {
          if (!remoteVideo.srcObject) {
            remoteVideo.srcObject = new MediaStream();
          }
          stream = remoteVideo.srcObject;
          if (!stream.getTracks().some(t => t.id === event.track.id)) {
            stream.addTrack(event.track);
          }
        } else {
          remoteVideo.srcObject = stream;
        }

        remoteVideo.play().then(() => {
          this.updatePeerStatus(peerUserId, '🟢 연결됨');
          this.hidePlayOverlay(peerUserId);
        }).catch(e => {
          console.warn('Autoplay prevented, showing touch play overlay:', e);
          this.showPlayOverlay(peerUserId);
        });
      }
    };

    // Connection State Change & Auto ICE Restart
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      console.log(`ICE Connection State [${peerUserId}]:`, state);

      if (state === 'connected' || state === 'completed') {
        this.updatePeerStatus(peerUserId, '🟢 연결됨');
        this.hidePlayOverlay(peerUserId);
        if (this.iceRestartTimers[peerUserId]) {
          clearTimeout(this.iceRestartTimers[peerUserId]);
          delete this.iceRestartTimers[peerUserId];
        }
      } else if (state === 'failed' || state === 'disconnected') {
        this.updatePeerStatus(peerUserId, '🟡 재연결 중...');
        this.scheduleIceRestart(peerUserId);
      }
    };

    return pc;
  }

  scheduleIceRestart(peerUserId) {
    if (this.iceRestartTimers[peerUserId]) return;

    this.iceRestartTimers[peerUserId] = setTimeout(async () => {
      console.log(`🔄 Attempting WebRTC ICE Restart for peer ${peerUserId}...`);
      const pc = this.peerConnections[peerUserId];
      if (pc) {
        try {
          const offer = await pc.createOffer({ iceRestart: true });
          await pc.setLocalDescription(offer);

          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({
              type: 'Offer',
              payload: {
                target_user_id: peerUserId,
                sdp: JSON.stringify(offer),
                sender_user_id: this.currentUserId
              }
            }));
          }
        } catch (e) {
          console.warn('ICE Restart failed:', e);
        }
      }
      delete this.iceRestartTimers[peerUserId];
    }, 3000);
  }

  async createOffer(peerUserId) {
    const pc = this.createPeerConnection(peerUserId);
    this.ensureLocalTracks(pc);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'Offer',
          payload: {
            target_user_id: peerUserId,
            sdp: JSON.stringify(offer),
            sender_user_id: this.currentUserId
          }
        }));
      }
    } catch (e) {
      console.error(`[WebRTC] Failed to create offer for ${peerUserId}:`, e);
    }
  }

  async handleOffer(senderUserId, sdpStr) {
    const pc = this.createPeerConnection(senderUserId);
    this.ensureLocalTracks(pc);

    try {
      const offer = JSON.parse(sdpStr);
      await pc.setRemoteDescription(new RTCSessionDescription(offer));

      // Process buffered ICE candidates
      await this.flushIceCandidates(senderUserId);

      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);

      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          type: 'Answer',
          payload: {
            target_user_id: senderUserId,
            sdp: JSON.stringify(answer),
            sender_user_id: this.currentUserId
          }
        }));
      }
    } catch (e) {
      console.error(`[WebRTC] Failed to handle offer from ${senderUserId}:`, e);
    }
  }

  async handleAnswer(senderUserId, sdpStr) {
    const pc = this.peerConnections[senderUserId];
    if (pc) {
      try {
        const answer = JSON.parse(sdpStr);
        await pc.setRemoteDescription(new RTCSessionDescription(answer));
        await this.flushIceCandidates(senderUserId);
      } catch (e) {
        console.error(`[WebRTC] Failed to handle answer from ${senderUserId}:`, e);
      }
    }
  }

  async handleIceCandidate(senderUserId, candidateStr) {
    const pc = this.peerConnections[senderUserId];
    if (!candidateStr) return;
    const candidate = new RTCIceCandidate(JSON.parse(candidateStr));

    if (pc && pc.remoteDescription && pc.remoteDescription.type) {
      try {
        await pc.addIceCandidate(candidate);
      } catch (err) {
        console.warn('Error adding ICE Candidate:', err);
      }
    } else {
      if (!this.iceCandidateQueues[senderUserId]) {
        this.iceCandidateQueues[senderUserId] = [];
      }
      this.iceCandidateQueues[senderUserId].push(candidate);
    }
  }

  async flushIceCandidates(peerUserId) {
    const pc = this.peerConnections[peerUserId];
    const queue = this.iceCandidateQueues[peerUserId];

    if (pc && queue && queue.length > 0) {
      while (queue.length > 0) {
        const candidate = queue.shift();
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          console.warn('Error flushing ICE candidate:', err);
        }
      }
    }
  }

  removePeer(peerUserId) {
    if (this.peerConnections[peerUserId]) {
      this.peerConnections[peerUserId].close();
      delete this.peerConnections[peerUserId];
    }
    delete this.iceCandidateQueues[peerUserId];
    if (this.iceRestartTimers[peerUserId]) {
      clearTimeout(this.iceRestartTimers[peerUserId]);
      delete this.iceRestartTimers[peerUserId];
    }

    const tile = document.getElementById(`tile-${peerUserId}`);
    if (tile) tile.remove();
  }

  toggleMic(enabled) {
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach(t => t.enabled = enabled);
    }
  }

  toggleCam(enabled) {
    if (this.localStream) {
      this.localStream.getVideoTracks().forEach(t => t.enabled = enabled);
    }
  }

  async replaceOutgoingVideoTrack(stream) {
    const videoTrack = stream?.getVideoTracks()[0] || null;
    if (!videoTrack) {
      throw new Error('No video track is available to send');
    }

    const peers = Object.entries(this.peerConnections);
    const replacements = peers.map(async ([peerUserId, pc]) => {
      if (pc.connectionState === 'closed') return;

      const sender = pc.getSenders().find(candidate => candidate.track?.kind === 'video');
      if (!sender) {
        pc.addTrack(videoTrack, stream);
        await this.createOffer(peerUserId);
        return;
      }

      await sender.replaceTrack(videoTrack);
    });

    await Promise.allSettled(replacements);
  }

  async stopScreenShare() {
    const stream = this.screenStream;
    if (!stream) return false;

    this.screenStream = null;
    stream.getTracks().forEach(track => track.stop());

    try {
      await this.replaceOutgoingVideoTrack(this.localStream);
    } catch (error) {
      console.error('[WebRTC] Failed to restore the camera after screen sharing.', error);
    }

    if (this.localVideo && this.localStream) {
      this.localVideo.style.transform = 'scaleX(-1)';
      this.localVideo.srcObject = this.localStream;
      this.localVideo.play().catch(e => console.warn(e));
    }
    this.notifyScreenShareState(false);
    return false;
  }

  async toggleScreenShare() {
    if (this.screenStream) {
      return this.stopScreenShare();
    }

    if (!navigator.mediaDevices?.getDisplayMedia) {
      alert('현재 브라우저 환경에서는 화면 공유(getDisplayMedia)를 지원하지 않습니다.');
      return false;
    }

    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 } },
        audio: false
      });
      const videoTrack = stream.getVideoTracks()[0];
      if (!videoTrack) {
        stream.getTracks().forEach(track => track.stop());
        throw new Error('선택된 화면 공유 비디오 트랙이 없습니다.');
      }

      this.screenStream = stream;
      videoTrack.addEventListener('ended', () => {
        if (this.screenStream === stream) {
          this.stopScreenShare();
        }
      }, { once: true });

      await this.replaceOutgoingVideoTrack(stream);
      if (this.localVideo) {
        this.localVideo.style.transform = 'none';
        this.localVideo.srcObject = stream;
        this.localVideo.play().catch(e => console.warn(e));
      }
      this.notifyScreenShareState(true);
      return true;
    } catch (error) {
      console.warn('Screen share cancelled or could not start.', error);
      if (this.screenStream) {
        await this.stopScreenShare();
      }
      return false;
    }
  }
}

window.WebRTCManager = WebRTCManager;
