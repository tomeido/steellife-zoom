class WebRTCManager {
  constructor(localVideoElem, videoGridElem) {
    this.localVideo = localVideoElem;
    this.videoGrid = videoGridElem;
    this.localStream = null;
    this.screenStream = null;
    this.peerConnections = {}; // peerUserId -> RTCPeerConnection
    this.iceCandidateQueues = {}; // peerUserId -> Array of candidate
    this.iceRestartTimers = {}; // peerUserId -> timer
    this.ws = null;
    this.currentUserId = null;
    this.currentRoomId = null;

    // Multi STUN & Public Relay ICE Servers
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

  async initLocalMedia() {
    try {
      this.localStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: 'user'
        },
        audio: true
      });
      this.localVideo.setAttribute('playsinline', 'true');
      this.localVideo.setAttribute('webkit-playsinline', 'true');
      this.localVideo.srcObject = this.localStream;
      return this.localStream;
    } catch (err) {
      console.warn('Camera/Mic permission denied or not available:', err);
      // Canvas fallback for environments without camera access
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1e293b'; ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = '#6366f1'; ctx.font = '24px sans-serif';
      ctx.fillText('SLZoom User Stream', 200, 240);

      this.localStream = canvas.captureStream(30);
      this.localVideo.setAttribute('playsinline', 'true');
      this.localVideo.setAttribute('webkit-playsinline', 'true');
      this.localVideo.srcObject = this.localStream;
      return this.localStream;
    }
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
            console.log(`[PeerList] Found existing peer ${peer.username} (${peer.user_id}). Initiating Offer.`);
            this.ensurePeerTile(peer.user_id, peer.username);
            await this.createOffer(peer.user_id);
          }
        }
        break;

      case 'UserJoined':
        console.log(`[UserJoined] ${payload.username} (${payload.user_id}) joined. Creating tile & awaiting Offer.`);
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
          console.log(`[Answer Received] From ${payload.sender_user_id}. Set remote description.`);
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
      tag.innerHTML = `<span class="peer-status-dot" id="status-${peerUserId}">🔴 연결 중...</span> ${username || '참여자'} (${peerUserId.substring(0, 5)})`;

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
    this.localStream.getTracks().forEach(track => {
      const exists = senders.some(s => s.track && s.track.kind === track.kind);
      if (!exists) {
        pc.addTrack(track, this.localStream);
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

    // Remote Stream Handler
    pc.ontrack = (event) => {
      console.log(`🎥 Remote video track received from ${peerUserId}`, event.streams);
      const peerTile = this.ensurePeerTile(peerUserId, '참여자');
      const remoteVideo = peerTile.querySelector('video');
      if (remoteVideo && event.streams[0]) {
        remoteVideo.srcObject = event.streams[0];
        remoteVideo.play().then(() => {
          this.updatePeerStatus(peerUserId, '🟢 연결됨');
          this.hidePlayOverlay(peerUserId);
        }).catch(e => {
          console.warn('Mobile Autoplay prevented, showing touch play overlay:', e);
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
  }

  async handleOffer(senderUserId, sdpStr) {
    const pc = this.createPeerConnection(senderUserId);
    this.ensureLocalTracks(pc);

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
  }

  async handleAnswer(senderUserId, sdpStr) {
    const pc = this.peerConnections[senderUserId];
    if (pc) {
      const answer = JSON.parse(sdpStr);
      await pc.setRemoteDescription(new RTCSessionDescription(answer));
      await this.flushIceCandidates(senderUserId);
    }
  }

  async handleIceCandidate(senderUserId, candidateStr) {
    const pc = this.peerConnections[senderUserId];
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

  async toggleScreenShare() {
    if (this.screenStream) {
      this.screenStream.getTracks().forEach(t => t.stop());
      this.screenStream = null;
      this.localVideo.srcObject = this.localStream;
      return false;
    } else {
      try {
        this.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        this.localVideo.srcObject = this.screenStream;
        return true;
      } catch (e) {
        console.warn('Screen share cancelled', e);
        return false;
      }
    }
  }
}

window.WebRTCManager = WebRTCManager;
