import WebSocket from 'ws';

export function decodeMulawToPcm16(base64Payload) {
  const mu = Buffer.from(base64Payload, 'base64');
  const pcm = Buffer.alloc(mu.length * 2);
  for (let i = 0; i < mu.length; i += 1) {
    const sample = muLawDecodeSample(mu[i]);
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

function muLawDecodeSample(mu) {
  mu = ~mu & 0xff;
  const sign = mu & 0x80 ? -1 : 1;
  const exponent = (mu >> 4) & 0x07;
  const mantissa = mu & 0x0f;
  const magnitude = ((mantissa << 4) + 0x08) << (exponent + 3);
  const sample = sign * magnitude;
  // Clamp to int16 range to avoid Buffer write overflow
  return Math.max(-32768, Math.min(32767, sample));
}

export class ElevenLabsClient {
  constructor({
    url,
    apiKey,
    sampleRate = 8000,
    modelId = 'scribe_v2_realtime',
    audioFormat = 'ulaw_8000',
    wakePhrases,
    startPayload,
    includeTimestamps = false,
    includeLanguageDetection = false,
    languageCode,
    commitStrategy,
  }) {
    this.url = url;
    this.apiKey = apiKey;
    this.sampleRate = sampleRate;
    this.modelId = modelId;
    this.audioFormat = audioFormat;
    this.languageCode = languageCode;
    this.commitStrategy = commitStrategy;
    this.wakePhrases = (wakePhrases || []).map(p => p.toLowerCase()).filter(Boolean);
    this.startPayload = startPayload; // unused now, but kept for override
    this.includeTimestamps = includeTimestamps;
    this.includeLanguageDetection = includeLanguageDetection;
    this.ws = null;
    this.ready = false;
    this.connectedPromise = null;
    this.transcriptHandler = null;
    this.wakeHandler = null;
    this.pending = [];
  }

  onTranscript(cb) {
    this.transcriptHandler = cb;
  }

  onWake(cb) {
    this.wakeHandler = cb;
  }

  async connect() {
    if (!this.url || !this.apiKey) return null;
    if (this.connectedPromise) return this.connectedPromise;
    const wsUrl = this.buildUrl();
    this.connectedPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(wsUrl, { headers: { 'xi-api-key': this.apiKey } });
      this.ws.on('open', () => {
        this.ready = true;
        this.flushPending();
        resolve();
      });
      this.ws.on('message', data => this.handleMessage(data));
      this.ws.on('close', () => {
        this.ready = false;
        this.connectedPromise = null;
        this.pending = [];
      });
      this.ws.on('error', err => {
        this.ready = false;
        this.connectedPromise = null;
        reject(err);
      });
    });
    return this.connectedPromise;
  }

  sendStart() {
    // not used; configuration is passed as query params per realtime spec
  }

  sendAudio(buffer) {
    if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
      const msg = JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: buffer.toString('base64'),
        commit: false,
        sample_rate: this.sampleRate,
      });
      this.ws.send(msg);
    } else {
      this.pending.push(buffer);
    }
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    this.ready = false;
    this.connectedPromise = null;
    this.pending = [];
  }

  handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      console.warn('elevenlabs non-JSON message', raw.toString());
      parsed = {};
    }
    console.log('elevenlabs message', parsed);
    const type = parsed.message_type;
    const text = parsed.text || parsed.transcript || parsed.message || parsed.partial || '';
    if (text && this.transcriptHandler) this.transcriptHandler(text);
    const isCommitted = type === 'committed_transcript' || type === 'committed_transcript_with_timestamps';
    const isPartial = type === 'partial_transcript';
    if (text && this.wakePhrases.length && (isCommitted || isPartial)) {
      const lower = text.toLowerCase();
      const hit = this.wakePhrases.some(p => lower.includes(p));
      if (hit) {
        console.log('wake phrase hit', text, isCommitted ? '(committed)' : '(partial)');
        this.wakeHandler?.(text, isCommitted);
      }
    }
  }

  flushPending() {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
    while (this.pending.length) {
      const buf = this.pending.shift();
      const msg = JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: buf.toString('base64'),
        commit: false,
        sample_rate: this.sampleRate,
      });
      this.ws.send(msg);
    }
  }

  buildUrl() {
    const u = new URL(this.url);
    u.searchParams.set('model_id', this.modelId);
    u.searchParams.set('audio_format', this.audioFormat);
    u.searchParams.set('sample_rate', String(this.sampleRate));
    u.searchParams.set('include_timestamps', String(this.includeTimestamps));
    u.searchParams.set('include_language_detection', String(this.includeLanguageDetection));
    if (this.languageCode) u.searchParams.set('language_code', this.languageCode);
    if (this.commitStrategy) u.searchParams.set('commit_strategy', this.commitStrategy);
    return u.toString();
  }
}

export class ElevenLabsAgentClient {
  constructor({ apiKey, agentId, baseUrl = 'wss://api.elevenlabs.io', dynamicVariables = {} }) {
    this.apiKey = apiKey;
    this.agentId = agentId;
    this.baseUrl = baseUrl;
    this.dynamicVariables = dynamicVariables;
    this.ws = null;
    this.ready = false;
    this.connectedPromise = null;
    this.conversationId = null;
    this.responseHandler = null;
    this.audioHandler = null;
    this.subsequentHandler = null;
    this.pendingResolve = null;
    this.responseBuffer = '';
    this.firstResolved = false;
  }

  onResponse(cb) { this.responseHandler = cb; }
  onAudio(cb) { this.audioHandler = cb; }
  onSubsequentResponse(cb) { this.subsequentHandler = cb; }

  sendInitData() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (Object.keys(this.dynamicVariables).length === 0) return;
    const msg = {
      type: 'conversation_initiation_client_data',
      dynamic_variables: this.dynamicVariables,
    };
    console.log('agent sendInitData', msg);
    this.ws.send(JSON.stringify(msg));
  }

  async connect() {
    if (this.connectedPromise) return this.connectedPromise;
    const url = `${this.baseUrl}/v1/convai/conversation?agent_id=${encodeURIComponent(this.agentId)}`;
    this.connectedPromise = new Promise((resolve, reject) => {
      this.ws = new WebSocket(url, { headers: { 'xi-api-key': this.apiKey } });
      this.ws.on('open', () => {
        console.log('agent ws open');
        this.ready = true;
        this.sendInitData();
        resolve();
      });
      this.ws.on('message', data => this.handleMessage(data));
      this.ws.on('close', () => {
        console.log('agent ws closed');
        this.ready = false;
        this.connectedPromise = null;
      });
      this.ws.on('error', err => {
        console.error('agent ws error', err);
        this.ready = false;
        this.connectedPromise = null;
        reject(err);
      });
    });
    return this.connectedPromise;
  }

  async sendText(text) {
    if (!this.ready || this.ws?.readyState !== WebSocket.OPEN) {
      await this.connect();
    }
    console.log('agent sendText', text);
    this.responseBuffer = '';
    this.firstResolved = false;
    const msg = JSON.stringify({ type: 'user_message', text });
    this.ws.send(msg);
    return new Promise(resolve => {
      this.pendingResolve = resolve;
      setTimeout(() => {
        if (this.pendingResolve) {
          this.pendingResolve(this.responseBuffer || null);
          this.pendingResolve = null;
          this.firstResolved = true;
        }
      }, 15000);
    });
  }

  handleMessage(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      console.warn('agent non-JSON', raw.toString());
      return;
    }
    console.log('agent message', parsed);
    if (parsed.type === 'conversation_initiation_metadata') {
      this.conversationId = parsed.conversation_initiation_metadata_event?.conversation_id;
    } else if (parsed.type === 'agent_chat_response_part') {
      const part = parsed.text_response_part;
      if (part?.type === 'start') {
        this.responseBuffer = '';
      } else if (part?.type === 'delta' && part.text) {
        this.responseBuffer += part.text;
      } else if (part?.type === 'stop' && this.responseBuffer) {
        const response = this.responseBuffer;
        if (this.pendingResolve) {
          this.pendingResolve(response);
          this.pendingResolve = null;
          this.firstResolved = true;
        } else if (this.firstResolved && this.subsequentHandler) {
          this.subsequentHandler(response);
        }
        this.responseBuffer = '';
      }
    } else if (parsed.type === 'agent_response') {
      const text = parsed.agent_response_event?.agent_response || '';
      this.responseHandler?.(text);
      if (text && this.pendingResolve) {
        this.pendingResolve(text);
        this.pendingResolve = null;
        this.firstResolved = true;
      } else if (text && this.firstResolved && this.subsequentHandler) {
        this.subsequentHandler(text);
      }
    } else if (parsed.type === 'audio') {
      const b64 = parsed.audio_event?.audio_base_64;
      if (b64) this.audioHandler?.(Buffer.from(b64, 'base64'));
    } else if (parsed.type === 'ping') {
      const pong = JSON.stringify({ type: 'pong', event_id: parsed.ping_event?.event_id });
      this.ws?.send(pong);
    }
  }

  close() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
    this.ready = false;
    this.connectedPromise = null;
  }
}
