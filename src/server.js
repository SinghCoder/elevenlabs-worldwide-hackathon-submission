import express from 'express';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import { WebSocketServer } from 'ws';
import twilio from 'twilio';
import axios from 'axios';
import { ElevenLabsClient, ElevenLabsAgentClient } from './elevenlabs.js';

dotenv.config();

const {
  PORT = 3000,
  PUBLIC_BASE_URL,
  PUBLIC_WS_URL,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_NUMBER,
  WAKE_PHRASE = 'hey assistant',
  WAKE_PHRASES,
  ELEVEN_API_KEY,
  ELEVEN_WS_URL,
  ELEVEN_API_BASE = 'https://api.elevenlabs.io',
  ELEVEN_MODEL_ID = 'scribe_v2_realtime',
  ELEVEN_SAMPLE_RATE = '8000',
  ELEVEN_LANGUAGE_CODE = 'en',
  ELEVEN_COMMIT_STRATEGY = 'vad',
  ELEVEN_START_MESSAGE,
  ELEVEN_VOICE_ID,
  ELEVEN_AGENT_ID,
} = process.env;

const parsedStartPayload = parseStartPayload(ELEVEN_START_MESSAGE);
const wakeList = parseWakeList(WAKE_PHRASES, WAKE_PHRASE);

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const twilioClient = TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;
const callMeta = new Map();
const audioStore = new Map(); // id -> Buffer
const lastWake = new Map(); // callSid -> timestamp
const agentClients = new Map(); // callSid -> ElevenLabsAgentClient

app.get('/health', (_req, res) => res.send('ok'));

app.post('/voice/inbound', (req, res) => {
  console.log('voice/inbound', req.body);
  const { CallSid, From } = req.body;
  const confName = CallSid || 'conference';
  callMeta.set(CallSid, { from: From, conferenceSid: null, conferenceName: confName });

  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say('Connecting you now.');
  if (PUBLIC_WS_URL) {
    const stream = twiml.start().stream({ url: PUBLIC_WS_URL, track: 'inbound_track' });
    stream.parameter({ name: 'callSid', value: CallSid });
    stream.parameter({ name: 'from', value: From || 'unknown' });
    stream.parameter({ name: 'conferenceName', value: confName });
  }
  twiml.dial().conference(
    {
      statusCallback: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/conf-events` : undefined,
      statusCallbackEvent: 'start end join leave',
      statusCallbackMethod: 'POST',
    },
    confName,
  );

  res.type('text/xml').send(twiml.toString());
});

app.post('/conf-events', (req, res) => {
  console.log('conf-events', req.body);
  const { CallSid, ConferenceSid } = req.body;
  if (CallSid && callMeta.has(CallSid)) {
    callMeta.set(CallSid, { ...callMeta.get(CallSid), conferenceSid: ConferenceSid });
  }
  res.sendStatus(200);
});

app.post('/add-participant', async (req, res) => {
  console.log('add-participant', req.body);
  if (!twilioClient) return res.status(400).json({ error: 'Twilio client not configured' });
  const { to, conferenceSid, conferenceName } = req.body;
  if (!to || !conferenceSid) return res.status(400).json({ error: 'to and conferenceSid required' });

  // Get actual conference friendly name if not provided
  let actualConfName = conferenceName;
  if (!actualConfName && conferenceSid) {
    try {
      const conf = await twilioClient.conferences(conferenceSid).fetch();
      actualConfName = conf.friendlyName;
      console.log('fetched conference friendlyName', { conferenceSid, actualConfName });
    } catch (e) {
      console.warn('could not fetch conference friendlyName, using conferenceSid', e.message);
      actualConfName = conferenceSid;
    }
  }

  const twiml = new twilio.twiml.VoiceResponse();
  if (PUBLIC_WS_URL) {
    const stream = twiml.start().stream({ url: PUBLIC_WS_URL, track: 'inbound_track' });
    stream.parameter({ name: 'from', value: to });
    stream.parameter({ name: 'conferenceSid', value: conferenceSid });
    stream.parameter({ name: 'conferenceName', value: actualConfName });
  }
  twiml.dial().conference(actualConfName);

  try {
    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_NUMBER,
      twiml: twiml.toString(),
    });
    // Pre-populate callMeta for this outbound leg
    callMeta.set(call.sid, { from: to, conferenceSid, conferenceName: actualConfName });
    console.log('add-participant success', { callSid: call.sid, to, actualConfName });
    res.json({ callSid: call.sid, conferenceName: actualConfName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const server = app.listen(PORT, () => {
  console.log(`twilio agent listening on ${PORT}`);
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (req.url?.startsWith('/media')) {
    console.log('upgrade request', req.url);
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

wss.on('connection', (ws, req) => {
  const params = new URLSearchParams(req.url?.split('?')[1] || '');
  const callSid = params.get('callSid');
  const from = params.get('from') || callMeta.get(callSid)?.from || 'unknown';
  console.log('media websocket connected', { callSid, from, rawUrl: req.url });
  const eleven = ELEVEN_WS_URL && ELEVEN_API_KEY
    ? new ElevenLabsClient({
        url: ELEVEN_WS_URL,
        apiKey: ELEVEN_API_KEY,
        sampleRate: Number(ELEVEN_SAMPLE_RATE) || 8000,
        modelId: ELEVEN_MODEL_ID,
        wakePhrases: wakeList,
        audioFormat: 'ulaw_8000',
        languageCode: ELEVEN_LANGUAGE_CODE || undefined,
        commitStrategy: ELEVEN_COMMIT_STRATEGY || 'vad',
        includeTimestamps: false,
        includeLanguageDetection: false,
        startPayload: parsedStartPayload,
      })
    : null;

  const state = { callSid, from, eleven };

  eleven?.onTranscript(text => handleTranscript(state, text));
  eleven?.onWake((text, isCommitted) => handleWake(state, text, isCommitted).catch(err => console.error('handleWake error', err)));

  ws.on('message', async raw => {
    // console.log(`raw message: ${raw.toString()}`);
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      console.warn('ws message json parse error', raw.toString().slice(0, 200));
      return;
    }
    // console.log('ws event', { event: msg.event, hasMedia: !!msg.media, payloadLen: msg.media?.payload?.length });
    if (msg.event === 'start') {
      if (!state.callSid && msg.start?.callSid) {
        state.callSid = msg.start.callSid;
      }
      // Get from from customParameters or callMeta
      const customParams = msg.start?.customParameters || {};
      if (customParams.from) state.from = customParams.from;
      if (state.from === 'unknown') {
        const meta = callMeta.get(state.callSid);
        if (meta?.from) state.from = meta.from;
      }
      // Store conferenceSid/Name if not already known
      if (customParams.conferenceSid || customParams.conferenceName) {
        const existing = callMeta.get(state.callSid) || {};
        callMeta.set(state.callSid, {
          ...existing,
          from: state.from,
          conferenceSid: customParams.conferenceSid || existing.conferenceSid,
          conferenceName: customParams.conferenceName || existing.conferenceName || state.callSid,
        });
      }
      try {
        await eleven?.connect();
        console.log('media start', { callSid: state.callSid, from: state.from, streamSid: msg.start?.streamSid, customParams });
      } catch (err) {
        console.error('elevenlabs connect error', err);
      }
    } else if (msg.event === 'media') {
      if (!msg.media?.payload) return;
      const mulaw = Buffer.from(msg.media.payload, 'base64');
      eleven?.sendAudio(mulaw);
      // console.log('media frame sent', { callSid: state.callSid, from: state.from, bytes: mulaw.length });
    } else if (msg.event === 'stop') {
      eleven?.close();
      ws.close();
      console.log('media stop', { callSid: state.callSid, from: state.from });
    }
  });

  ws.on('close', () => {
    eleven?.close();
    const agent = agentClients.get(state.callSid);
    if (agent) {
      agent.close();
      agentClients.delete(state.callSid);
    }
    console.log('media websocket closed', { callSid: state.callSid, from: state.from });
  });

  ws.on('error', err => {
    console.error('media websocket error', { callSid: state.callSid, from: state.from, err });
  });
});

function handleTranscript(state, text) {
  console.log(`[transcript ${state.from || state.callSid}] ${text}`);
}

const partialWakeTimers = new Map(); // callSid -> { timer, text }

async function handleWake(state, text, isCommitted = true) {
  const now = Date.now();
  const last = lastWake.get(state.callSid) || 0;
  if (now - last < 8000) return; // throttle duplicate triggers

  // For partials, delay trigger and reset timer on each new partial (user still speaking)
  if (!isCommitted) {
    const existing = partialWakeTimers.get(state.callSid);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const pending = partialWakeTimers.get(state.callSid);
      partialWakeTimers.delete(state.callSid);
      const stillThrottled = Date.now() - (lastWake.get(state.callSid) || 0) < 8000;
      if (!stillThrottled && pending) {
        console.log('partial wake trigger (user stopped speaking)', pending.text);
        doWake(state, pending.text);
      }
    }, 2500); // wait 2.5s after last partial
    partialWakeTimers.set(state.callSid, { timer, text });
    return;
  }

  // Committed transcript - cancel any pending partial timer and use committed text
  if (partialWakeTimers.has(state.callSid)) {
    clearTimeout(partialWakeTimers.get(state.callSid).timer);
    partialWakeTimers.delete(state.callSid);
  }
  lastWake.set(state.callSid, now);
  await doWake(state, text);
}

async function doWake(state, text) {
  lastWake.set(state.callSid, Date.now());
  console.log(`Wake phrase from ${state.from || state.callSid}: ${text}`);

  if (ELEVEN_AGENT_ID && ELEVEN_API_KEY) {
    try {
      let agent = agentClients.get(state.callSid);
      if (!agent) {
        const meta = callMeta.get(state.callSid) || {};
        agent = new ElevenLabsAgentClient({
          apiKey: ELEVEN_API_KEY,
          agentId: ELEVEN_AGENT_ID,
          baseUrl: ELEVEN_API_BASE.replace('https://', 'wss://'),
          dynamicVariables: {
            conference_sid: meta.conferenceSid || meta.conferenceName || state.callSid,
            conference_name: meta.conferenceName || state.callSid,
            caller_number: state.from || '',
            call_sid: state.callSid || '',
          },
        });
        agent.onSubsequentResponse(resp => {
          console.log('agent subsequent response', resp);
          respondWithTts(state.callSid, resp).catch(e => console.error('subsequent playback error', e));
        });
        agentClients.set(state.callSid, agent);
        await agent.connect();
      }
      const userQuery = text;
      console.log('agent query', userQuery);
      const agentResponse = await agent.sendText(userQuery || text);
      console.log('agent response', agentResponse);
      if (agentResponse) {
        await respondWithTts(state.callSid, agentResponse).catch(e => console.error('playback error', e));
      } else {
        await respondWithTts(state.callSid, `I'm here, but I didn't get a response. Please try again.`).catch(e => console.error('playback error', e));
      }
    } catch (err) {
      console.error('agent error', err);
      await respondWithTts(state.callSid, `Sorry, I encountered an error. Please try again.`).catch(e => console.error('playback error', e));
    }
  } else {
    await respondWithTts(state.callSid, `Hello ${state.from || 'there'}, I heard your request.`).catch(e => console.error('playback error', e));
  }
}


function parseStartPayload(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    console.warn('ELEVEN_START_MESSAGE is not valid JSON');
    return null;
  }
}

function parseWakeList(rawList, defaultPhrase) {
  if (rawList && rawList.trim().length > 0) {
    return rawList
      .split(',')
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  }
  return [defaultPhrase.toLowerCase()].filter(Boolean);
}

async function respondWithTts(callSid, text) {
  if (!twilioClient) {
    console.warn('respondWithTts skipped: twilio client not configured');
    return;
  }
  if (!PUBLIC_BASE_URL) {
    console.warn('respondWithTts skipped: PUBLIC_BASE_URL not set');
    return;
  }
  if (!callSid) {
    console.warn('respondWithTts skipped: callSid missing');
    return;
  }
  console.log('respondWithTts start', { callSid, text });
  const audioBuf = await synthesizeElevenlabs(text);
  console.log('respondWithTts synthesized', { callSid, bytes: audioBuf.length });
  const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  audioStore.set(id, audioBuf);
  setTimeout(() => audioStore.delete(id), 5 * 60 * 1000);
  const url = `${PUBLIC_BASE_URL}/audio/${id}.mp3`;
  const meta = callMeta.get(callSid) || {};
  const confName = meta.conferenceName || callSid;
  let confSid = meta.conferenceSid;
  
  // Look up the active conference by name to get current SID
  if (confName) {
    try {
      const conferences = await twilioClient.conferences.list({ friendlyName: confName, status: 'in-progress', limit: 1 });
      if (conferences.length > 0) {
        confSid = conferences[0].sid;
        callMeta.set(callSid, { ...meta, conferenceSid: confSid });
      }
    } catch (e) {
      console.warn('conference lookup failed', e.message);
    }
  }
  console.log('respondWithTts playing', { callSid, url, confSid, confName });
  
  // Try conference announce, then participant announce, then TwiML fallback
  if (confSid) {
    try {
      const updated = await twilioClient.conferences(confSid).update({ announceUrl: url, announceMethod: 'GET' });
      console.log('respondWithTts conference announce ok', updated?.sid);
      return;
    } catch (e) {
      console.warn('conference announce failed, trying participant', e.message);
    }
    try {
      const updated = await twilioClient.conferences(confSid).participants(callSid).update({ announceUrl: url });
      console.log('respondWithTts participant announce ok', updated?.callSid);
      return;
    } catch (e) {
      console.warn('participant announce failed', e.message);
    }
  }
  // Final fallback: TwiML update (will briefly leave conference then rejoin)
  console.warn('respondWithTts: falling back to TwiML update');
  const twiml = `<Response><Play>${url}</Play><Dial><Conference>${confName}</Conference></Dial></Response>`;
  const updated = await twilioClient.calls(callSid).update({ twiml });
  console.log('respondWithTts TwiML update', updated?.sid || updated?.status);
}

async function synthesizeElevenlabs(text) {
  const endpoint = `${ELEVEN_API_BASE}/v1/text-to-speech/${ELEVEN_VOICE_ID}/stream`;
  try {
    const resp = await axios.post(
      endpoint,
      { text, model_id: 'eleven_flash_v2_5' },
      { responseType: 'arraybuffer', headers: { 'xi-api-key': ELEVEN_API_KEY, 'Content-Type': 'application/json' } },
    );
    return Buffer.from(resp.data);
  } catch (err) {
    console.error('synthesizeElevenlabs error', err.response?.status, err.response?.data || err.message);
    throw err;
  }
}

app.get('/audio/:id', (req, res) => {
  const key = req.params.id.replace('.mp3', '');
  const buf = audioStore.get(key);
  if (!buf) {
    console.warn('audio 404', key);
    return res.sendStatus(404);
  }
  console.log('audio serve', { key, bytes: buf.length });
  res.setHeader('Content-Type', 'audio/mpeg');
  res.send(buf);
});
