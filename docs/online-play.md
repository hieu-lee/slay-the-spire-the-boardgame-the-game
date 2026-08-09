# Online co-op

The room server owns the run. Each browser receives only its own hidden cards and can
recover its seat after a refresh or closed tab. Voice is a browser-native WebRTC mesh;
the room WebSocket carries signaling only, never audio.

## Local party

Run these in separate terminals:

```bash
pnpm dev:rooms
pnpm dev
```

Open `http://localhost:5180`, choose **Play online**, create a room, and share its
six-character code. A run starts only after every seat has a live connection.

## Share over Cloudflare Tunnel

Install `cloudflared`, start both development processes above, then run:

```bash
pnpm tunnel
```

Share the printed `https://…trycloudflare.com` URL. HTTPS is required for microphone
access outside localhost. Only port 5180 is tunneled: Vite proxies `/api` and `/ws` to
the room server on `127.0.0.1:8787`, so room tokens and voice signaling stay on one
origin. The development server uses strict port 5180, so it fails visibly instead of
silently tunneling another app when the port is occupied.

Quick Tunnels are for development and testing, have no uptime SLA, and use a random URL.
For a stable deployment, use a [remotely-managed Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/get-started/).

## Reliable voice across restrictive networks

Without configuration, voice uses Cloudflare STUN and connects directly when the peers'
networks allow it. Direct WebRTC can fail behind restrictive NATs or firewalls. For TURN
relay fallback, create a Cloudflare Realtime TURN key and start the room server with its
server-only credentials:

```bash
CLOUDFLARE_TURN_KEY_ID=… \
CLOUDFLARE_TURN_API_TOKEN=… \
pnpm dev:rooms
```

The browser authenticates to `/api/rooms/:code/voice-ice`; the room server exchanges the
long-term key for a six-hour credential and returns only that short-lived ICE configuration.
Never put the TURN API token in Vite variables or browser code. See Cloudflare's
[credential guidance](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
and [TURN service endpoints](https://developers.cloudflare.com/realtime/turn/).

## Voice controls

Each player clicks **Join voice** and grants microphone access. **Mute** disables the
local audio track without leaving the mesh; **Leave voice** stops every local track and
closes every peer connection. A `Voice 2/3` label means two of the three other seats are
currently connected to this browser.
