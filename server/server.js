const http = require('http');
const fs = require('fs/promises');
const path = require('path');
const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const { Pool } = require('pg');
const { computeRoundResult } = require('./score');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const SERVER_HOST_ID = 'SERVER';
const RECORD_ROOM_IDS = new Set(['DAY', 'MON']);

let recordsPool = null;
let recordsDbReady = false;

function hasRecordsDb() {
  return Boolean(process.env.DATABASE_URL);
}

async function ensureRecordsDb() {
  if (!hasRecordsDb()) {
    throw new Error('DATABASE_URL is not configured');
  }
  if (!recordsPool) {
    recordsPool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: false },
    });
  }
  if (recordsDbReady) return;

  await recordsPool.query(`
    CREATE TABLE IF NOT EXISTS room_records (
      room_id TEXT PRIMARY KEY,
      record JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  recordsDbReady = true;
}

function normalizeRecordRoomId(value) {
  const roomId = String(value || '').trim().toUpperCase();
  if (!RECORD_ROOM_IDS.has(roomId)) return null;
  return roomId;
}

async function readRecord(roomId) {
  await ensureRecordsDb();
  const result = await recordsPool.query(
    'SELECT room_id, record, updated_at FROM room_records WHERE room_id = $1 LIMIT 1',
    [roomId],
  );
  if (!result.rows.length) return null;
  const row = result.rows[0];
  return {
    roomId: row.room_id,
    ...(row.record || {}),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || ''),
  };
}

async function readRecordFromFile(roomId) {
  const filePath = path.resolve(__dirname, '..', 'records', `${roomId}.json`);
  let raw;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  return {
    roomId,
    ...parsed,
  };
}

async function readAnyRecord(roomId) {
  if (hasRecordsDb()) return readRecord(roomId);
  return readRecordFromFile(roomId);
}

async function writeRecord(roomId, record) {
  await ensureRecordsDb();
  const nowIso = new Date().toISOString();
  const payload = {
    ...(record || {}),
    roomId,
    updatedAt: nowIso,
  };
  await recordsPool.query(
    `
      INSERT INTO room_records (room_id, record, updated_at)
      VALUES ($1, $2::jsonb, $3::timestamptz)
      ON CONFLICT (room_id) DO UPDATE
      SET record = EXCLUDED.record,
          updated_at = EXCLUDED.updated_at
    `,
    [roomId, JSON.stringify(payload), nowIso],
  );
  return payload;
}

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
  if (room.clients.size === 0) {
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

  if (pathname.startsWith('/records/')) {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!hasRecordsDb()) {
      sendJson(res, 503, { error: 'Records DB is not configured' });
      return;
    }

    const roomId = normalizeRecordRoomId(pathname.replace('/records/', ''));
    if (!roomId) {
      sendJson(res, 400, { error: 'Invalid room id' });
      return;
    }

    if (req.method === 'GET') {
      try {
        const record = await readRecord(roomId);
        if (!record) {
          sendJson(res, 404, { error: 'Record not found' });
          return;
        }
        sendJson(res, 200, record);
      } catch (error) {
        sendJson(res, 500, { error: error.message || 'Failed to read record' });
      }
      return;
    }

    if (req.method === 'POST') {
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
      if (!payload?.record || typeof payload.record !== 'object') {
        sendJson(res, 400, { error: 'Invalid record' });
        return;
      }

      try {
        const saved = await writeRecord(roomId, payload.record);
        sendJson(res, 200, { ok: true, ...saved });
      } catch (error) {
        sendJson(res, 500, { error: error.message || 'Failed to write record' });
      }
      return;
    }

    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  if (pathname === '/save') {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    if (!hasRecordsDb()) {
      sendJson(res, 503, { error: 'Records DB is not configured' });
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

    const roomId = normalizeRecordRoomId(payload?.roomId);
    if (!roomId) {
      sendJson(res, 400, { error: 'Invalid room id' });
      return;
    }
    if (!payload?.record || typeof payload.record !== 'object') {
      sendJson(res, 400, { error: 'Invalid record' });
      return;
    }

    try {
      const saved = await writeRecord(roomId, payload.record);
      sendJson(res, 200, { ok: true, ...saved });
    } catch (error) {
      sendJson(res, 500, { error: error.message || 'Failed to save record' });
    }
    return;
  }

  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('HKE9 relay server running');
});

function makeDeck54() {
  const deck = [];
  const suits = ['S', 'H', 'D', 'C'];
  for (const s of suits) {
    for (let r = 2; r <= 14; r += 1) deck.push({ r, s });
  }
  deck.push({ r: 16, s: 'J', j: 'BJ' });
  deck.push({ r: 15, s: 'J', j: 'SJ' });
  return deck;
}

function shuffle(arr) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function cardKey(c) {
  if (!c) return '';
  if (c.s === 'J') return c.j;
  return `${c.r}${c.s}`;
}

function normalizeCard(c) {
  if (!c || typeof c !== 'object') return null;
  if (c.s === 'J') {
    if (c.j !== 'BJ' && c.j !== 'SJ') return null;
    return { s: 'J', j: c.j, r: c.j === 'BJ' ? 16 : 15 };
  }
  const r = Number(c.r);
  const s = String(c.s || '');
  if (!Number.isInteger(r) || r < 2 || r > 14) return null;
  if (!['S', 'H', 'D', 'C'].includes(s)) return null;
  return { r, s };
}

function validateSubmission(cards9, sub) {
  if (!cards9 || cards9.length !== 9) return { ok: false, msg: '尚未發牌' };
  const dealerCard = normalizeCard(sub?.dealerCard);
  const head = (sub?.head || []).map(normalizeCard);
  const mid = (sub?.mid || []).map(normalizeCard);
  const tail = (sub?.tail || []).map(normalizeCard);
  if (!dealerCard) return { ok: false, msg: '請選擇選莊牌' };
  if (head.length !== 2 || mid.length !== 3 || tail.length !== 3) return { ok: false, msg: '牌組長度不符' };
  if ([...head, ...mid, ...tail].some((c) => !c)) return { ok: false, msg: '墩位有空牌' };

  const dealt = new Set(cards9.map(cardKey));
  const used = [dealerCard, ...head, ...mid, ...tail].map(cardKey);
  if (new Set(used).size !== used.length) return { ok: false, msg: '提交存在重複牌' };
  for (const k of used) {
    if (!dealt.has(k)) return { ok: false, msg: '提交的牌不在手牌中' };
  }
  return { ok: true, data: { dealerCard, head, mid, tail } };
}

function getRoom(roomId) {
  const id = String(roomId || '').trim().toUpperCase();
  if (!id) return null;
  if (!rooms.has(id)) {
    rooms.set(id, {
      roomId: id,
      clients: new Map(),
      seatOrder: [],
      disconnectedSeatNames: {},
      cumulative: {},
      cumulativeByName: {},
      recordLoaded: false,
      settings: { roundsTotal: 0, bbMode: false },
      round: 0,
      started: false,
      dealt: {},
      submissions: {},
      revealed: false,
      nextReadyMap: {},
      preStartReadyMap: {},
      dealerPick: null,
      dealerOverride: null,
    });
  }
  return rooms.get(id);
}

async function ensureRoomRecordLoaded(room) {
  if (!room || room.recordLoaded) return;
  const recordRoomId = normalizeRecordRoomId(room.roomId);
  room.recordLoaded = true;
  if (!recordRoomId) return;

  try {
    const record = await readAnyRecord(recordRoomId);
    const scoresByName = record?.scoresByName;
    if (!scoresByName || typeof scoresByName !== 'object') return;

    room.cumulativeByName = { ...room.cumulativeByName };
    for (const [name, value] of Object.entries(scoresByName)) {
      const key = String(name || '').trim();
      if (!key) continue;
      room.cumulativeByName[key] = Number(value || 0);
    }
  } catch (error) {
    console.error(`Failed to load persisted record for room ${recordRoomId}:`, error?.message || error);
  }
}

function roomPlayers(room) {
  const out = [];
  for (const id of room.seatOrder) {
    const p = room.clients.get(id);
    if (p) {
      out.push({ id, name: p.name || '玩家', connected: true });
      continue;
    }
    const offlineName = String(room.disconnectedSeatNames?.[id] || '').trim();
    if (offlineName) out.push({ id, name: offlineName, connected: false });
  }
  for (const [id, p] of room.clients.entries()) {
    if (!out.find((x) => x.id === id)) out.push({ id, name: p.name || '玩家', connected: true });
  }
  return out;
}

function pruneDisconnectedSeats(room) {
  const keep = [];
  for (const id of room.seatOrder) {
    if (room.clients.has(id)) {
      keep.push(id);
      continue;
    }
    delete room.dealt[id];
    delete room.submissions[id];
    delete room.nextReadyMap[id];
    delete room.preStartReadyMap[id];
    delete room.cumulative[id];
    delete room.disconnectedSeatNames[id];
  }
  room.seatOrder = keep;
}

function relayToRoom(room, payload, exceptId = null) {
  for (const [id, p] of room.clients.entries()) {
    if (id === exceptId) continue;
    send(p.socket, { t: 'relay', fromId: SERVER_HOST_ID, payload });
  }
}

function currentRoundPlayerIds(room) {
  const dealtIds = Object.keys(room.dealt || {});
  if (room.started && !room.revealed && dealtIds.length) {
    return dealtIds.sort();
  }
  if (!dealtIds.length) return room.seatOrder.filter((id) => room.clients.has(id));
  return room.seatOrder.filter((id) => room.clients.has(id) && room.dealt[id]);
}

function buildAutoSubmission(cards9) {
  if (!Array.isArray(cards9) || cards9.length !== 9) return null;
  const cards = cards9.map((card) => normalizeCard(card)).filter(Boolean);
  if (cards.length !== 9) return null;
  return {
    dealerCard: cards[0],
    head: cards.slice(1, 3),
    mid: cards.slice(3, 6),
    tail: cards.slice(6, 9),
    report: 'none',
  };
}

function broadcastPlayers(room) {
  relayToRoom(room, { t: 'players', list: roomPlayers(room), hostId: SERVER_HOST_ID, hostName: 'SERVER', seatOrder: room.seatOrder.slice() });
}

function dealRound(room) {
  const ids = room.seatOrder.filter((id) => room.clients.has(id));
  if (ids.length === 0) return;
  room.round += 1;
  room.started = true;
  room.revealed = false;
  room.dealt = {};
  room.submissions = {};
  room.nextReadyMap = {};
  room.dealerPick = null;
  room.dealerOverride = null;

  for (const id of ids) room.preStartReadyMap[id] = false;

  const deck = shuffle(makeDeck54());
  for (const id of ids) {
    room.dealt[id] = { all9: deck.splice(0, 9) };
  }

  relayToRoom(room, { t: 'start', round: room.round, settings: room.settings, cumulative: room.cumulative });
  const ready = {};
  for (const id of ids) ready[id] = false;
  for (const id of ids) {
    const p = room.clients.get(id);
    if (!p) continue;
    send(p.socket, {
      t: 'relay',
      fromId: SERVER_HOST_ID,
      payload: { t: 'deal', round: room.round, cards9: room.dealt[id].all9, ready },
    });
  }
}

function maybeStartNextRound(room) {
  const ids = room.seatOrder.filter((id) => room.clients.has(id));
  if (ids.length === 0) return;
  if (!room.started) {
    const allPreReady = ids.length > 0 && ids.every((id) => !!room.preStartReadyMap[id]);
    if (!allPreReady) return;
    dealRound(room);
    return;
  }
  if (!room.revealed) return;
  const nextReadyIds = currentRoundPlayerIds(room);
  const allReady = nextReadyIds.length > 0 && nextReadyIds.every((id) => room.nextReadyMap[id]);
  if (!allReady) return;
  pruneDisconnectedSeats(room);
  broadcastPlayers(room);
  relayToRoom(room, { t: 'nextRound', round: room.round + 1 });
  dealRound(room);
}


function findDealerPickController(submissions, ids) {
  const targetIds = Array.isArray(ids) ? ids.slice() : Object.keys(submissions || {});
  const big = targetIds.filter((id) => submissions[id]?.dealerCard?.s === 'J' && submissions[id]?.dealerCard?.j === 'BJ');
  if (big.length) {
    big.sort();
    return { controllerId: big[0], kind: 'BJ' };
  }
  const small = targetIds.filter((id) => submissions[id]?.dealerCard?.s === 'J' && submissions[id]?.dealerCard?.j === 'SJ');
  if (small.length) {
    small.sort();
    return { controllerId: small[0], kind: 'SJ' };
  }
  return null;
}

function startDealerPickOrReveal(room) {
  const subs = room.submissions || {};
  const ids = currentRoundPlayerIds(room);
  if (!ids.length) return;
  if (!ids.every((id) => !!subs[id])) return;

  const controller = findDealerPickController(subs, ids);
  if (!controller) {
    room.dealerPick = null;
    resolveReveal(room, null);
    return;
  }

  room.dealerPick = { ...controller, round: room.round };
  room.dealerOverride = null;

  const payload = {
    t: 'dealerPickStart',
    round: room.round,
    controllerId: controller.controllerId,
    kind: controller.kind,
    submissions: subs,
    players: roomPlayers(room),
  };

  const controllerSocket = room.clients.get(controller.controllerId)?.socket;
  if (!controllerSocket) {
    room.dealerPick = null;
    resolveReveal(room, null);
    return;
  }

  send(controllerSocket, { t: 'relay', fromId: SERVER_HOST_ID, payload });
  relayToRoom(room, { t: 'dealerPickWait', round: room.round, controllerId: controller.controllerId }, controller.controllerId);
}

function resolveReveal(room, dealerOverride = null) {
  const subs = room.submissions;
  const ids = currentRoundPlayerIds(room);
  if (!ids.length) return;
  if (!ids.every((id) => !!subs[id])) return;

  let scoreData;
  try {
    scoreData = computeRoundResult({ submissions: subs, dealerOverride });
  } catch (error) {
    relayToRoom(room, { t: 'error', message: error.message || '結算失敗' });
    return;
  }

  const dealerId = scoreData.dealerId;
  for (const id of ids) {
    const playerName = String(room.clients.get(id)?.name || '').trim();
    const baseline =
      room.cumulative[id] !== undefined
        ? Number(room.cumulative[id] || 0)
        : Number(playerName ? room.cumulativeByName[playerName] || 0 : 0);
    const roundTotal = Number(scoreData.results?.[id]?.total || 0);
    room.cumulative[id] = baseline + roundTotal;
    if (playerName) room.cumulativeByName[playerName] = room.cumulative[id];
  }

  room.revealed = true;
  room.dealerPick = null;
  room.dealerOverride = null;
  room.nextReadyMap = {};
  for (const id of ids) room.nextReadyMap[id] = false;

  relayToRoom(room, {
    t: 'reveal',
    round: room.round,
    dealerId,
    results: scoreData.results,
    cumulative: room.cumulative,
    submissions: subs,
    players: roomPlayers(room),
  });

  relayToRoom(room, { t: 'nextReady', ready: room.nextReadyMap, round: room.round });
}

const wss = new WebSocketServer({ server });
const HEARTBEAT_INTERVAL_MS = 15000;

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
  ws.isAlive = true;

  ws.on('pong', () => markAlive(ws));

  ws.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { t: 'error', message: 'Invalid JSON payload.' });
      return;
    }

    if (!msg || typeof msg !== 'object') return;

    if (msg.t === 'create-room' || msg.t === 'join-room') {
      const roomId = String(msg.roomId || '').trim().toUpperCase();
      if (!roomId) {
        send(ws, { t: 'error', message: 'Room id required.' });
        return;
      }
      const room = getRoom(roomId);
      await ensureRoomRecordLoaded(room);
      ws.roomId = roomId;
      const playerName = String(msg.name || '玩家').trim() || '玩家';
      room.clients.set(ws.id, { socket: ws, name: playerName });
      delete room.disconnectedSeatNames[ws.id];
      if (!room.seatOrder.includes(ws.id)) room.seatOrder.push(ws.id);
      room.preStartReadyMap[ws.id] = false;
      if (room.cumulative[ws.id] === undefined && room.cumulativeByName[playerName] !== undefined) {
        room.cumulative[ws.id] = Number(room.cumulativeByName[playerName] || 0);
      }

      send(ws, { t: 'joined', roomId, id: ws.id, hostId: SERVER_HOST_ID });
      send(ws, {
        t: 'relay',
        fromId: SERVER_HOST_ID,
        payload: {
          t: 'welcome',
          hostId: SERVER_HOST_ID,
          hostName: 'SERVER',
          seatOrder: room.seatOrder.slice(),
          settings: room.settings,
          cumulative: room.cumulative,
        },
      });

      broadcastPlayers(room);

      if (!room.started) {
        const ready = {};
        for (const id of room.seatOrder) ready[id] = !!room.preStartReadyMap[id];
        relayToRoom(room, { t: 'ready', ready });
      }

      if (room.started && !room.revealed && room.dealt[ws.id]) {
        const ready = {};
        for (const id of currentRoundPlayerIds(room)) ready[id] = !!room.submissions[id];
        send(ws, { t: 'relay', fromId: SERVER_HOST_ID, payload: { t: 'deal', round: room.round, cards9: room.dealt[ws.id].all9, ready, resume: true } });
      } else if (room.started && !room.revealed) {
        send(ws, { t: 'relay', fromId: SERVER_HOST_ID, payload: { t: 'waitNextRound', round: room.round } });
      }
      if (room.revealed) {
        send(ws, { t: 'relay', fromId: SERVER_HOST_ID, payload: { t: 'waitNextRound', round: room.round } });
      }

      maybeStartNextRound(room);
      return;
    }

    if (msg.t === 'relay') {
      const room = rooms.get(ws.roomId);
      if (!room) return;
      const payload = msg.payload || {};

      if (payload.t === 'join') {
        const p = room.clients.get(ws.id);
        if (p) {
          const prevName = String(p.name || '').trim();
          const nextName = String(payload.name || p.name || '玩家').trim() || '玩家';
          p.name = nextName;
          if (room.cumulative[ws.id] !== undefined) {
            if (prevName) room.cumulativeByName[prevName] = Number(room.cumulative[ws.id] || 0);
            if (nextName) room.cumulativeByName[nextName] = Number(room.cumulative[ws.id] || 0);
          }
        }
        broadcastPlayers(room);
        return;
      }


      if (payload.t === 'preReady') {
        if (room.started) return;
        room.preStartReadyMap[ws.id] = !!payload.ready;
        const ready = {};
        for (const id of room.seatOrder) ready[id] = !!room.preStartReadyMap[id];
        relayToRoom(room, { t: 'ready', ready });
        maybeStartNextRound(room);
        return;
      }

      if (payload.t === 'ping') {
        send(ws, { t: 'relay', fromId: SERVER_HOST_ID, payload: { t: 'pong' } });
        return;
      }

      if (payload.t === 'pong') {
        return;
      }

      if (payload.t === 'submit') {
        const dealt = room.dealt[ws.id]?.all9;
        const ok = validateSubmission(dealt, payload);
        if (!ok.ok) {
          send(ws, { t: 'relay', fromId: SERVER_HOST_ID, payload: { t: 'error', message: ok.msg } });
          return;
        }
        room.submissions[ws.id] = { ...ok.data, report: String(payload.report || 'none') };

        const ready = {};
        for (const id of currentRoundPlayerIds(room)) ready[id] = !!room.submissions[id];
        relayToRoom(room, { t: 'ready', ready });
        startDealerPickOrReveal(room);
        return;
      }

      if (payload.t === 'dealerPickChoice') {
        const expected = room.dealerPick;
        const pick = payload.pick || {};
        if (!expected) {
          send(ws, { t: 'relay', fromId: SERVER_HOST_ID, payload: { t: 'error', message: '目前沒有需要指定莊家的局' } });
          return;
        }
        if (Number(pick.round || 0) !== Number(expected.round || 0)) {
          send(ws, { t: 'relay', fromId: SERVER_HOST_ID, payload: { t: 'error', message: '指定莊家局數不符' } });
          return;
        }
        if (ws.id !== expected.controllerId) {
          send(ws, { t: 'relay', fromId: SERVER_HOST_ID, payload: { t: 'error', message: '你不是本局指定莊家的控制者' } });
          return;
        }

        const dealerId = String(pick.dealerId || '');
        const ids = currentRoundPlayerIds(room);
        if (!ids.includes(dealerId)) {
          send(ws, { t: 'relay', fromId: SERVER_HOST_ID, payload: { t: 'error', message: '指定的莊家不在房間內' } });
          return;
        }

        room.dealerOverride = dealerId;
        room.dealerPick = null;
        relayToRoom(room, { t: 'dealerPickFinal', round: room.round, dealerId });
        resolveReveal(room, dealerId);
        return;
      }

      if (payload.t === 'nextReady') {
        if (!room.revealed) return;
        const round = Number(payload.round || 0);
        if (round && round !== room.round) return;
        if (room.nextReadyMap[ws.id] === undefined) return;
        room.nextReadyMap[ws.id] = true;
        relayToRoom(room, { t: 'nextReady', ready: room.nextReadyMap, round: room.round });
        maybeStartNextRound(room);
        return;
      }

      if (payload.t === 'chat' || payload.t === 'danmaku' || payload.t === 'poop') {
        const p = room.clients.get(ws.id);
        relayToRoom(room, { ...payload, fromId: ws.id, from: p?.name || '玩家' });
      }
    }
  });

  ws.on('close', () => {
    const roomId = ws.roomId;
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;

    const closedPlayer = room.clients.get(ws.id);
    const closedName = String(closedPlayer?.name || '').trim();
    if (closedName && room.cumulative[ws.id] !== undefined) {
      room.cumulativeByName[closedName] = Number(room.cumulative[ws.id] || 0);
    }

    const leftDuringRound = !!(room.started && !room.revealed && room.dealt[ws.id]);

    if (leftDuringRound && !room.submissions[ws.id]) {
      const autoSub = buildAutoSubmission(room.dealt[ws.id]?.all9);
      if (autoSub) {
        room.submissions[ws.id] = autoSub;
      }
    }

    room.clients.delete(ws.id);

    if (leftDuringRound) {
      room.disconnectedSeatNames[ws.id] = closedName || '玩家';
    } else {
      room.seatOrder = room.seatOrder.filter((id) => id !== ws.id);
      delete room.disconnectedSeatNames[ws.id];
    }

    if (!leftDuringRound) {
      delete room.dealt[ws.id];
      delete room.submissions[ws.id];
      delete room.cumulative[ws.id];
    }

    delete room.nextReadyMap[ws.id];
    delete room.preStartReadyMap[ws.id];

    broadcastPlayers(room);
    if (!room.started) {
      const ready = {};
      for (const id of room.seatOrder) ready[id] = !!room.preStartReadyMap[id];
      relayToRoom(room, { t: 'ready', ready });
    }

    if (leftDuringRound) {
      const ready = {};
      for (const id of currentRoundPlayerIds(room)) ready[id] = !!room.submissions[id];
      relayToRoom(room, { t: 'ready', ready });
      startDealerPickOrReveal(room);
    }

    maybeStartNextRound(room);
    cleanRoom(roomId);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`HKE9 relay server listening on :${PORT}`);
  console.log(`Records DB: ${hasRecordsDb() ? 'enabled (DATABASE_URL set)' : 'disabled (using fallback)'}`);
});
