// server.js — WebSocket сервер для 2D Шутера
const WebSocket = require('ws');
const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

console.log('🚀 Сервер запущен на порту', PORT);

const rooms = new Map();

function generateRoomCode() {
    let code;
    let attempts = 0;
    do {
        code = String(Math.floor(1000 + Math.random() * 9000));
        attempts++;
    } while (rooms.has(code) && attempts < 100);
    return code;
}

function broadcastToRoom(code, message, exceptWs) {
    const room = rooms.get(code);
    if (!room) return;
    const all = [room.host, ...room.clients];
    for (const client of all) {
        if (!client || client === exceptWs) continue;
        if (client.readyState === WebSocket.OPEN) {
            try { client.send(JSON.stringify(message)); } catch (e) {}
        }
    }
}

function sendTo(ws, message) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(message)); } catch (e) {}
}

function leaveRoom(ws) {
    const code = ws._roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (room.host === ws) {
        if (room.clients.length > 0) {
            const newHost = room.clients.shift();
            room.host = newHost;
            newHost._playerId = 'host';
            broadcastToRoom(code, { type: 'host_changed', newHost: 'host' }, null);
        } else {
            rooms.delete(code);
        }
    } else {
        room.clients = room.clients.filter(c => c !== ws);
        broadcastToRoom(code, { type: 'player_left', id: ws._playerId }, ws);
    }
    ws._roomCode = null;
    ws._playerId = null;
}

wss.on('connection', (ws) => {
    ws._roomCode = null;
    ws._playerId = null;
    ws._isAlive = true;

    ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (!msg || typeof msg.type !== 'string') return;

        if (msg.type === 'create_room') {
            if (ws._roomCode) return;
            const code = generateRoomCode();
            ws._roomCode = code;
            ws._playerId = 'host';
            rooms.set(code, { host: ws, clients: [], createdAt: Date.now(), lastActivity: Date.now() });
            sendTo(ws, { type: 'room_created', code, playerId: 'host' });
            return;
        }

        if (msg.type === 'join_room') {
            if (ws._roomCode) return;
            const code = String(msg.code || '').trim();
            const room = rooms.get(code);
            if (!room) { sendTo(ws, { type: 'error', message: 'Комната не найдена' }); return; }
            if (room.clients.length >= 3) { sendTo(ws, { type: 'error', message: 'Комната заполнена' }); return; }
            ws._roomCode = code;
            ws._playerId = 'p' + (room.clients.length + 1);
            room.clients.push(ws);
            room.lastActivity = Date.now();
            sendTo(ws, { type: 'room_joined', code, playerId: ws._playerId });
            sendTo(room.host, { type: 'player_joined', id: ws._playerId });
            broadcastToRoom(code, { type: 'player_joined', id: ws._playerId }, ws);
            return;
        }

        if (msg.type === 'ping') { sendTo(ws, { type: 'pong' }); return; }

        if (ws._roomCode) {
            const room = rooms.get(ws._roomCode);
            if (room) {
                room.lastActivity = Date.now();
                msg.from = ws._playerId;
                broadcastToRoom(ws._roomCode, msg, ws);
            }
        }
    });

    ws.on('close', () => leaveRoom(ws));
    ws.on('error', () => leaveRoom(ws));
    ws.on('pong', () => { ws._isAlive = true; });
});

setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws._isAlive === false) { try { ws.terminate(); } catch (e) {} return; }
        ws._isAlive = false;
        try { ws.ping(); } catch (e) {}
    });
    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
        if (now - room.lastActivity > 30 * 60 * 1000) {
            broadcastToRoom(code, { type: 'room_timeout' }, null);
            rooms.delete(code);
        }
    }
}, 30000);

const http = require('http');
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
}).listen(PORT + 1);
