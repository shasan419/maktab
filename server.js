/**
 * server.js
 * Custom Node.js server combining:
 *  - Next.js (HTTP handler for all pages + API routes)
 *  - WebSocket server (ws) for real-time Azan audio streaming
 *
 * Architecture:
 *   Transmitter (admin) ─── binary audio chunks ──→ [WS Server] ──→ all Listeners
 *
 * Protocol:
 *   Client → Server (JSON):   { type: 'transmitter', token: '...' }
 *                              { type: 'listener' }
 *                              { type: 'stop' }
 *   Server → Client (JSON):   { type: 'ready' }
 *                              { type: 'broadcast-start' }
 *                              { type: 'broadcast-end' }
 *                              { type: 'error', message: '...' }
 *                              { type: 'listener-count', count: N }
 *   Transmitter → Server:     <binary ArrayBuffer> audio chunks
 *   Server → Listeners:       <binary ArrayBuffer> forwarded chunks
 */

const { createServer } = require('http');
const { parse } = require('url');
const next = require('next');
const { WebSocketServer, OPEN } = require('ws');
const { jwtVerify } = require('jose');

const dev  = process.env.NODE_ENV !== 'production';
const port = parseInt(process.env.PORT || '3000', 10);

const app    = next({ dev });
const handle = app.getRequestHandler();

// ─── Shared broadcast state (readable by API routes via global) ───────────────
global.__maktabBroadcast = { isLive: false, listenerCount: 0 };

// ─── In-memory prayer timings store ──────────────────────────────────────────
if (!global.__maktabTimings) {
  global.__maktabTimings = {
    fajr:        '05:15',
    sunrise:     '06:40',
    dhuhr:       '12:30',
    asr:         '15:45',
    maghrib:     '18:20',
    isha:        '19:45',
    jumuah:      '13:00',
    sehri:       '04:45',
    iftar:       '18:18',
    showRamadan: false,
    updatedAt:   new Date().toISOString(),
  };
}

// ─── JWT verification ─────────────────────────────────────────────────────────
const JWT_SECRET = new TextEncoder().encode(
  process.env.JWT_SECRET || 'dev-secret-change-in-production-please'
);

async function verifyAdminToken(token) {
  try {
    const { payload } = await jwtVerify(token, JWT_SECRET);
    return payload?.role === 'admin' ? payload : null;
  } catch {
    return null;
  }
}

// ─── WebSocket broadcast state ────────────────────────────────────────────────
let transmitterSocket = null;
let listeners         = new Set();
let isBroadcasting    = false;
let initSegment       = null; // First WebM chunk (contains header) for late-joining listeners

function broadcastJSON(msg) {
  const data = JSON.stringify(msg);
  listeners.forEach(ws => {
    if (ws.readyState === OPEN) ws.send(data);
  });
}

function broadcastBinary(data) {
  listeners.forEach(ws => {
    if (ws.readyState === OPEN) ws.send(data, { binary: true });
  });
}

function updateGlobalState() {
  global.__maktabBroadcast = {
    isLive:        isBroadcasting,
    listenerCount: listeners.size,
  };
}

function sendListenerCount() {
  if (transmitterSocket?.readyState === OPEN) {
    transmitterSocket.send(JSON.stringify({ type: 'listener-count', count: listeners.size }));
  }
}

// ─── Boot Next.js then start combined server ──────────────────────────────────
app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  // ── WebSocket server mounted on the same HTTP server at path /ws ──
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    let role = null; // 'transmitter' | 'listener' | null

    // ── Incoming messages ──
    ws.on('message', async (data, isBinary) => {

      // ── Binary: audio chunk from transmitter ──
      if (isBinary) {
        if (role !== 'transmitter') return;

        // Store the first chunk as the init segment (WebM EBML header)
        // so late-joining listeners can start playback correctly
        if (!initSegment) {
          initSegment = Buffer.from(data); // copy
        }

        broadcastBinary(data);
        return;
      }

      // ── JSON control messages ──
      let msg;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      // ── Register as Transmitter ──
      if (msg.type === 'transmitter') {
        const payload = await verifyAdminToken(msg.token || '');
        if (!payload) {
          ws.send(JSON.stringify({ type: 'error', message: 'Unauthorized' }));
          ws.close();
          return;
        }

        // If another transmitter is active, close the old one
        if (transmitterSocket && transmitterSocket.readyState === OPEN) {
          transmitterSocket.close();
        }

        role             = 'transmitter';
        transmitterSocket = ws;
        isBroadcasting   = true;
        initSegment      = null;

        ws.send(JSON.stringify({ type: 'ready' }));
        broadcastJSON({ type: 'broadcast-start' });
        updateGlobalState();

        console.log(`[WS] Transmitter connected — ${listeners.size} listener(s) active`);
        return;
      }

      // ── Register as Listener ──
      if (msg.type === 'listener') {
        role = 'listener';
        listeners.add(ws);
        updateGlobalState();
        sendListenerCount();

        // Tell this listener the current state
        if (isBroadcasting) {
          ws.send(JSON.stringify({ type: 'broadcast-start' }));
          // Send init segment so MediaSource can start from any point
          if (initSegment) {
            ws.send(initSegment, { binary: true });
          }
        } else {
          ws.send(JSON.stringify({ type: 'broadcast-end' }));
        }

        console.log(`[WS] Listener connected — total: ${listeners.size}`);
        return;
      }

      // ── Transmitter stops broadcast ──
      if (msg.type === 'stop' && role === 'transmitter') {
        isBroadcasting   = false;
        transmitterSocket = null;
        initSegment      = null;

        broadcastJSON({ type: 'broadcast-end' });
        updateGlobalState();

        console.log('[WS] Broadcast stopped by transmitter');
        ws.close();
        return;
      }
    });

    // ── Connection closed ──
    ws.on('close', () => {
      if (role === 'transmitter') {
        isBroadcasting   = false;
        transmitterSocket = null;
        initSegment      = null;

        broadcastJSON({ type: 'broadcast-end' });
        updateGlobalState();
        console.log('[WS] Transmitter disconnected — broadcast ended');
      } else if (role === 'listener') {
        listeners.delete(ws);
        updateGlobalState();
        sendListenerCount();
        console.log(`[WS] Listener disconnected — remaining: ${listeners.size}`);
      }
    });

    ws.on('error', (err) => {
      console.error('[WS] Socket error:', err.message);
    });
  });

  // ── Start listening ──
  server.listen(port, () => {
    console.log(`\n🕌 Maktab e Ahle Sunnat`);
    console.log(`   Ready on http://localhost:${port}`);
    console.log(`   WebSocket at ws://localhost:${port}/ws`);
    console.log(`   Mode: ${dev ? 'development' : 'production'}\n`);
  });
});
