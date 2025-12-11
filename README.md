# Multiplayer Voice Agent with Real-World Agency

> **ElevenLabs Worldwide Hackathon Submission**

The world's first "multiplayer" voice agent. Instead of a 1-on-1 chatbot, John joins your conference calls as a silent, intelligent participant. It listens to the conversation, understands context between multiple speakers, and executes real-world tasks when spoken to.

## Demo

In the demo, we simulate a production incident where a team member is driving and cannot type. They dial in John, diagnose a Kubernetes pod failure verbally, and instruct the agent to fix it. John then triggers a Cursor agent to write the code and raise a PR - all without a single keyboard interaction.

## The Stack

- **Voice/Intelligence**: ElevenLabs Agent API & Scribe v2 (low-latency transcription & multi-speaker context)
- **Telephony**: Twilio Conference & Media Streams
- **Action Layer**: Model Context Protocol (MCP) & Cursor

## Features

- **Multiplayer Conferencing** - Multiple participants can dial in; agent listens to all
- **Real-time Transcription** - ElevenLabs Scribe streams live speech-to-text
- **Wake Phrase Detection** - Configurable trigger phrases activate the agent
- **Conversational AI** - Routes queries to ElevenLabs agent with full call context
- **Real-World Actions** - Triggers Cursor agent, adds participants, and more
- **TTS Responses** - Synthesizes and plays responses to the entire conference

## Requirements

- Node.js 18+
- Twilio account with a phone number
- ElevenLabs API key
- Public URL (ngrok or similar) for Twilio webhooks

## Setup

1. Install dependencies:
```bash
npm install
```

2. Copy environment file and configure:
```bash
cp .env.example .env
```

3. Configure `.env` with your credentials:

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default: 3000) |
| `PUBLIC_BASE_URL` | Public HTTPS URL for webhooks |
| `PUBLIC_WS_URL` | Public WSS URL for media streaming |
| `TWILIO_ACCOUNT_SID` | Twilio account SID |
| `TWILIO_AUTH_TOKEN` | Twilio auth token |
| `TWILIO_NUMBER` | Your Twilio phone number |
| `WAKE_PHRASE` | Trigger phrase (default: "hey assistant") |
| `ELEVEN_API_KEY` | ElevenLabs API key |
| `ELEVEN_WS_URL` | ElevenLabs realtime STT endpoint |
| `ELEVEN_AGENT_ID` | ElevenLabs conversational agent ID |
| `ELEVEN_VOICE_ID` | Voice ID for TTS responses |

4. Configure Twilio webhook to `POST` to `{PUBLIC_BASE_URL}/voice/inbound`

## Usage

Start the server:
```bash
npm start
```

Development mode with auto-reload:
```bash
npm run dev
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/voice/inbound` | POST | Twilio inbound call webhook |
| `/conf-events` | POST | Conference status callback |
| `/add-participant` | POST | Add participant to conference |
| `/audio/:id` | GET | Serve synthesized audio |

### Add Participant

```bash
curl -X POST http://localhost:3000/add-participant \
  -H "Content-Type: application/json" \
  -d '{"to": "+1234567890", "conferenceSid": "CFxxx"}'
```

## Architecture

```
Twilio Call → /voice/inbound → Conference
                    ↓
              Media Stream (WSS)
                    ↓
         ElevenLabs Scribe (STT)
                    ↓
           Wake Phrase Detection
                    ↓
         ElevenLabs Agent (ConvAI)
                    ↓
         ElevenLabs TTS → Conference Announce
                    ↓
           Cursor Agent / MCP Tools
```

## ElevenLabs Agent Setup

### Dynamic Variables

Configure these in your ElevenLabs agent to receive call context:

| Identifier | Variable Name | Description |
|------------|---------------|-------------|
| `conferenceSid` | `conference_sid` | Current conference SID |
| `conference_name` | `conference_name` | Conference friendly name |
| `caller_number` | `caller_number` | Caller's phone number |
| `call_sid` | `call_sid` | Twilio call SID |

### Custom Tools

**add_person_to_current_call** - Adds a participant to the current conference call.

Configure as a webhook tool pointing to `{PUBLIC_BASE_URL}/add-participant` with properties:

| Property | Type | Required | Description |
|----------|------|----------|-------------|
| `to` | String | Yes | Phone number in E.164 format |
| `conferenceSid` | String | Yes | Dynamic variable `conference_sid` |
| `conferenceName` | String | Yes | Dynamic variable `conference_name` |

## License

MIT
