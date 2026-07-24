class WebRTCManager {
  constructor(localVideoElem, videoGridElem) {
    this.localVideo = localVideoElem;
    this.videoGrid = videoGridElem;
    this.localStream = null;
    this.screenStream = null;
    this.peerConnections = {}; // peerUserId -> RTCPeerConnection
    this.iceCandidateQueues = {}; // peerUserId -> Array of candidate
    this.ws = null;
    this.currentUserId = null;
    this.currentRoomId = null;

    // Multi STUN Configuration for Cross-Network (Mobile <-> PC NAT Traversal)
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
      this.localVideo.srcObject = this.localStream;
      return this.localStream;
    } catch (err) {
      console.warn('Camera/Mic permission denied or not available:', err);
      // Fallback: Canvas stream for devices without camera access
      const canvas = document.createElement('canvas');
      canvas.width = 640; canvas.height = 480;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#1e293b'; ctx.fillRect(0, 0, 640, 480);
      ctx.fillStyle = '#6366f1'; ctx.font = '24px sans-serif';
      ctx.fillText('SLZoom User Stream', 200, 240);

      this.localStream = canvas.captureStream(30);
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
        // Joining user receives list of existing peers. Create video tiles and wait for their Offers.
        if (payload.peers && Array.isArray(payload.peers)) {
          for (const peer of payload.peers) {
            console.log(`[PeerList] Existing peer found: ${peer.username} (${peer.user_id})`);
            this.ensurePeerTile(peer.user_id, peer.username);
          }
        }
        break;

      case 'UserJoined':
        // Existing user receives notification of new peer. Initiate Offer!
        console.log(`[UserJoined] ${payload.username} (${payload.user_id}) joined room. Sending WebRTC Offer.`);
        this.ensurePeerTile(payload.user_id, payload.username);
        await this.createOffer(payload.user_id);
        break;

      case 'Offer':
        if (payload.target_user_id === this.currentUserId) {
          console.log(`[Offer Received] From ${payload.sender_user_id}. Responding with Answer.`);
          this.ensurePeerTile(payload.sender_user_id, '참여자');
          await this.handleOffer(payload.sender_user_id, payload.sdp);
        }
        break;

      case 'Answer':
        if (payload.target_user_id === this.currentUserId) {
          console.log(`[Answer Received] From ${payload.sender_user_id}. Finalizing connection.`);
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
      remoteVideo.playsInline = true;

      const tag = document.createElement('div');
      tag.className = 'speaker-tag';
      tag.innerText = `${username || '참여자'} (${peerUserId.substring(0, 5)})`;

      peerTile.appendChild(remoteVideo);
      peerTile.appendChild(tag);
      this.videoGrid.appendChild(peerTile);
    }
    return peerTile;
  }

  createPeerConnection(peerUserId) {
    if (this.peerConnections[peerUserId]) {
      return this.peerConnections[peerUserId];
    }

    const pc = new RTCPeerConnection(this.iceServers);
    this.peerConnections[peerUserId] = pc;
    this.iceCandidateQueues[peerUserId] = [];

    // Add local media tracks
    if (this.localStream) {
      this.localStream.getTracks().forEach(track => {
        pc.addTrack(track, this.localStream);
      });
    }

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
      console.log(`🎥 Remote track received from ${peerUserId}`, event.streams);
      const peerTile = this.ensurePeerTile(peerUserId, '참여자');
      const remoteVideo = peerTile.querySelector('video');
      if (remoteVideo) {
        remoteVideo.srcObject = event.streams[0];
        remoteVideo.play().catch(e => console.warn('Autoplay prevented:', e));
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log(`ICE Connection State [${peerUserId}]:`, pc.iceConnectionState);
    };

    return pc;
  }

  async createOffer(peerUserId) {
    const pc = this.createPeerConnection(peerUserId);
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
