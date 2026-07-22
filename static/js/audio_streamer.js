class AudioStreamer {
  constructor(wsClient) {
    this.wsClient = wsClient;
    this.audioContext = null;
    this.mediaStream = null;
    this.processor = null;
    this.isStreaming = false;
  }

  async start(stream) {
    try {
      this.mediaStream = stream;
      this.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 16000,
      });

      const source = this.audioContext.createMediaStreamSource(stream);
      // Create script processor node (buffer size 4096)
      this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);

      source.connect(this.processor);
      this.processor.connect(this.audioContext.destination);

      this.processor.onaudioprocess = (e) => {
        if (!this.isStreaming || !this.wsClient || this.wsClient.readyState !== WebSocket.OPEN) {
          return;
        }

        const inputData = e.inputBuffer.getChannelData(0);
        // Convert Float32 [-1.0, 1.0] to Int16 PCM [-32768, 32767]
        const pcmBuffer = new Int16Array(inputData.length);
        let sumSquares = 0;

        for (let i = 0; i < inputData.length; i++) {
          let s = Math.max(-1, Math.min(1, inputData[i]));
          pcmBuffer[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
          sumSquares += s * s;
        }

        const rms = Math.sqrt(sumSquares / inputData.length) * 100;
        
        // Voice Activity Detection threshold for XWhisper audio streaming
        if (rms > 1.5) {
          this.wsClient.send(pcmBuffer.buffer);
        }
      };

      this.isStreaming = true;
      console.log('🎙️ XWhisper Audio Streamer active (16kHz Mono PCM)');
    } catch (err) {
      console.error('Failed to initialize XWhisper Audio Streamer:', err);
    }
  }

  stop() {
    this.isStreaming = false;
    if (this.processor) {
      this.processor.disconnect();
      this.processor = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
    console.log('🛑 XWhisper Audio Streamer stopped');
  }
}

window.AudioStreamer = AudioStreamer;
