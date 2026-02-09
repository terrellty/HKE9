const http = require('http');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);

const rooms = new Map();

function makeId() {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 10);
}

function send(ws, payload) {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function cleanRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const hostGone = !room.hostSocket || room.hostSocket.readyState !== room.hostSocket.OPEN;
  if (hostGone && room.clients.size === 0) {
    rooms.delete(roomId);
  }
}

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('HKE9 relay server running');
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  ws.id = makeId();
  ws.roomId = null;
  ws.role = null;

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
      if (!roomId) {
        send(ws, { t: 'error', message: 'Room id required.' });
        return;
      }
      const existingRoom = rooms.get(roomId);
      if (existingRoom) {
        if (existingRoom.hostSocket && existingRoom.hostSocket.readyState === ws.OPEN) {
          send(ws, { t: 'error', message: 'Room already exists.' });
          return;
        }
        existingRoom.hostId = ws.id;
        existingRoom.hostName = name || '房主';
        existingRoom.hostSocket = ws;
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
      for (const client of room.clients.values()) {
        send(client.socket, { t: 'host-left' });
      }
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
