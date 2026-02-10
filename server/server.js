const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');
const { computeRoundResult } = require('./score');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);

const rooms = new Map();
const recordsDir = path.resolve(__dirname, '..', 'records');
const allowedPersistRooms = new Set(['DAY', 'NIG', 'MON']);

function makeId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function send(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function isSocketOpen(ws) {
  return !!ws && ws.readyState === ws.OPEN;
}

function cleanRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const hostGone = !room.hostSocket || room.hostSocket.readyState !== room.hostSocket.OPEN;
  if (hostGone && room.clients.size === 0) {
    rooms.delete(roomId);
  }
}

function sendJson(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...extraHeaders,
  });
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Persist-Key');
}

async function readRequestBody(req, limit = 1_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Payload too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  if (pathname.startsWith('/persist')) {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (pathname === '/persist/record' && req.method === 'GET') {
      const roomId = String(url.searchParams.get('roomId') || '').trim().toUpperCase();
      if (!allowedPersistRooms.has(roomId)) {
        sendJson(res, 400, { error: 'Invalid roomId' });
        return;
      }
      try {
        const filePath = path.join(recordsDir, `${roomId}.json`);
        const data = await fs.readFile(filePath, 'utf8');
        sendJson(res, 200, JSON.parse(data));
      } catch (error) {
        if (error.code === 'ENOENT') {
          sendJson(res, 404, { error: 'Not found' });
          return;
        }
        sendJson(res, 500, { error: 'Failed to read record' });
      }
      return;
    }

    if (pathname === '/persist/save' && req.method === 'POST') {
      let bodyText;
      try {
        bodyText = await readRequestBody(req);
      } catch (error) {
        sendJson(res, 413, { error: error.message });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(bodyText);
      } catch {
        sendJson(res, 400, { error: 'Bad JSON' });
        return;
      }

      const roomId = String(payload?.roomId || '').trim().toUpperCase();
      if (!allowedPersistRooms.has(roomId)) {
        sendJson(res, 400, { error: 'Invalid roomId' });
        return;
      }
      const record = payload?.record;
      if (!record || typeof record !== 'object') {
        sendJson(res, 400, { error: 'Invalid record' });
        return;
      }

      const now = new Date().toISOString();
      record.roomId = roomId;
      record.updatedAt = now;

      try {
        await fs.mkdir(recordsDir, { recursive: true });
        const filePath = path.join(recordsDir, `${roomId}.json`);
        await fs.writeFile(filePath, JSON.stringify(record, null, 2), 'utf8');
        sendJson(res, 200, { ok: true, roomId, updatedAt: now });
      } catch {
        sendJson(res, 500, { error: 'Failed to save record' });
      }
      return;
    }

    sendJson(res, 404, { error: 'Not found' });
    return;
  }

  if (pathname === '/score') {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'Method not allowed' });
      return;
    }

    let bodyText;
    try {
      bodyText = await readRequestBody(req);
    } catch (error) {
      sendJson(res, 413, { error: error.message });
      return;
    }

    let payload;
    try {
      payload = JSON.parse(bodyText);
    } catch {
      sendJson(res, 400, { error: 'Bad JSON' });
      return;
    }

    const submissions = payload?.submissions;
    if (!submissions || typeof submissions !== 'object') {
      sendJson(res, 400, { error: 'Invalid submissions' });
      return;
    }

    try {
      const { dealerId, results } = computeRoundResult({
        submissions,
        dealerOverride: payload?.dealerOverride || null,
      });
      sendJson(res, 200, { dealerId, results });
    } catch (error) {
      sendJson(res, 400, { error: error.message || 'Failed to compute score' });
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('HKE9 relay server running');
});

const wss = new WebSocketServer({ server });
const HEARTBEAT_INTERVAL_MS = 15000;
const HOST_RECONNECT_GRACE_MS = 30000;

function markAlive(ws) {
  ws.isAlive = true;
}

const heartbeatInterval = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

wss.on('connection', (ws) => {
  ws.id = makeId();
  ws.roomId = null;
  ws.role = null;
  ws.isAlive = true;

  ws.on('pong', () => markAlive(ws));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { t: 'error', message: 'Invalid JSON payload.' });
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'create-room') {
      const roomId = String(msg.roomId || '').trim().toUpperCase();
      const name = String(msg.name || '').trim();
      const hostToken = String(msg.hostToken || '').trim();
      if (!roomId) {
        send(ws, { t: 'error', message: 'Room id required.' });
        return;
      }
      const existingRoom = rooms.get(roomId);
      if (existingRoom) {
        if (existingRoom.hostDisconnectTimer) {
          clearTimeout(existingRoom.hostDisconnectTimer);
          existingRoom.hostDisconnectTimer = null;
        }
        const canTakeOver =
          !!hostToken &&
          !!existingRoom.hostToken &&
          existingRoom.hostToken === hostToken;
        if (isSocketOpen(existingRoom.hostSocket) && !canTakeOver) {
          send(ws, { t: 'error', message: 'Room already exists.' });
          return;
        }
        if (canTakeOver && isSocketOpen(existingRoom.hostSocket) && existingRoom.hostSocket !== ws) {
          try { existingRoom.hostSocket.close(1012, 'Host reconnected'); } catch {}
        }
        existingRoom.hostId = ws.id;
        existingRoom.hostName = name || '房主';
        existingRoom.hostSocket = ws;
        existingRoom.hostToken = hostToken || existingRoom.hostToken || null;
        ws.roomId = roomId;
        ws.role = 'host';
        send(ws, { t: 'hosted', roomId, id: ws.id, hostId: ws.id });
        for (const [id, client] of existingRoom.clients.entries()) {
          send(client.socket, { t: 'host-reconnected', hostId: ws.id, hostName: existingRoom.hostName });
          send(ws, { t: 'client-joined', id, name: client.name });
        }
        return;
      }
      rooms.set(roomId, {
        roomId,
        hostId: ws.id,
        hostName: name || '房主',
        hostSocket: ws,
        hostToken: hostToken || null,
        hostDisconnectTimer: null,
        clients: new Map(),
      });
      ws.roomId = roomId;
      ws.role = 'host';
      send(ws, { t: 'hosted', roomId, id: ws.id, hostId: ws.id });
      return;
    }

    if (msg.t === 'join-room') {
      const roomId = String(msg.roomId || '').trim().toUpperCase();
      const name = String(msg.name || '').trim();
      const room = rooms.get(roomId);
      if (!room) {
        send(ws, { t: 'error', message: 'Room not available.' });
        return;
      }
      room.clients.set(ws.id, { socket: ws, name: name || '玩家' });
      ws.roomId = roomId;
      ws.role = 'client';
      send(ws, { t: 'joined', roomId, id: ws.id, hostId: room.hostId });
      if (room.hostSocket && room.hostSocket.readyState === ws.OPEN) {
        send(room.hostSocket, { t: 'client-joined', id: ws.id, name: name || '玩家' });
      }
      return;
    }

    if (msg.t === 'relay') {
      const payload = msg.payload;
      const to = String(msg.to || '').trim();
      const roomId = ws.roomId;
      if (!roomId) return;
      const room = rooms.get(roomId);
      if (!room) return;

      if (to === '*') {
        for (const [id, client] of room.clients.entries()) {
          if (id === ws.id) continue;
          send(client.socket, { t: 'relay', fromId: ws.id, payload });
        }
        if (ws.role !== 'host' && room.hostSocket && room.hostSocket.readyState === ws.OPEN) {
          send(room.hostSocket, { t: 'relay', fromId: ws.id, payload });
        }
        return;
      }

      if (ws.role === 'host') {
        if (!to) return;
        const target = room.clients.get(to);
        if (!target) return;
        send(target.socket, { t: 'relay', fromId: ws.id, payload });
        return;
      }

      if (ws.role === 'client') {
        if (!room.hostSocket || room.hostSocket.readyState !== ws.OPEN) return;
        send(room.hostSocket, { t: 'relay', fromId: ws.id, payload });
      }
    }
  });

  ws.on('close', () => {
    const roomId = ws.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    if (ws.role === 'host') {
      room.hostSocket = null;
      room.hostId = null;
      if (room.hostDisconnectTimer) {
        clearTimeout(room.hostDisconnectTimer);
      }
      room.hostDisconnectTimer = setTimeout(() => {
        room.hostDisconnectTimer = null;
        const latestRoom = rooms.get(roomId);
        if (!latestRoom || latestRoom.hostSocket) return;
        for (const client of latestRoom.clients.values()) {
          send(client.socket, { t: 'host-left' });
        }
        cleanRoom(roomId);
      }, HOST_RECONNECT_GRACE_MS);
      cleanRoom(roomId);
      return;
    }

    if (ws.role === 'client') {
      room.clients.delete(ws.id);
      if (room.hostSocket && room.hostSocket.readyState === ws.OPEN) {
        send(room.hostSocket, { t: 'client-left', id: ws.id });
      }
      cleanRoom(roomId);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HKE9 relay server listening on :${PORT}`);
});
