// server.js — WebSocket сервер для 2D Шутера
// Работает на Render, Koyeb, Cyclic, Fly.io и любом Node.js-хостинге
// ЛИМИТ: 5 игроков (хост + 4 клиента)

const WebSocket = require('ws');

// ВАЖНО: parseInt превращает строку в число
const PORT = parseInt(process.env.PORT || 3000, 10);

const wss = new WebSocket.Server({ port: PORT });

console.log('🚀 Сервер запущен на порту', PORT);

// ============ КОНФИГ ============
const MAX_PLAYERS = 5;           // ← ВСЕГО ИГРОКОВ (хост + 4 клиента)
const MAX_CLIENTS = MAX_PLAYERS - 1; // хост не считается в room.clients

// Комнаты: { code: { host, clients, players, createdAt, lastActivity } }
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
        // Хост ушёл — передаём хоста следующему игроку
        if (room.clients.length > 0) {
            const newHost = room.clients.shift();
            room.host = newHost;
            newHost._playerId = 'host';
            if (room.players) {
                delete room.players[newHost._playerId];
                room.players['host'] = { id: 'host', nickname: newHost._nickname || 'Хост', isHost: true };
            }
            broadcastToRoom(code, { type: 'host_changed', newHost: 'host' }, null);
            console.log(`👑 Хост передан в комнате ${code}`);
        } else {
            rooms.delete(code);
            console.log(`❌ Комната ${code} закрыта (пустая)`);
        }
    } else {
        room.clients = room.clients.filter(c => c !== ws);
        if (room.players) delete room.players[ws._playerId];
        broadcastToRoom(code, { type: 'player_left', id: ws._playerId }, ws);
        console.log(`👋 Игрок ${ws._playerId} вышел из комнаты ${code}`);
    }
    ws._roomCode = null;
    ws._playerId = null;
}

wss.on('connection', (ws) => {
    ws._roomCode = null;
    ws._playerId = null;
    ws._nickname = null;
    ws._isAlive = true;

    console.log('🔌 Новое подключение');

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            return;
        }
        if (!msg || typeof msg.type !== 'string') return;

        // === СОЗДАТЬ КОМНАТУ ===
        if (msg.type === 'create_room') {
            if (ws._roomCode) return;
            const code = generateRoomCode();
            ws._roomCode = code;
            ws._playerId = 'host';
            ws._nickname = String(msg.nickname || 'Хост').slice(0, 16);
            rooms.set(code, {
                host: ws,
                clients: [],
                players: { host: { id: 'host', nickname: ws._nickname, isHost: true } },
                createdAt: Date.now(),
                lastActivity: Date.now(),
            });
            sendTo(ws, { type: 'room_created', code, playerId: 'host', nickname: ws._nickname });
            console.log(`🏠 Создана комната ${code} (хост: ${ws._nickname})`);
            return;
        }

        // === ПОДКЛЮЧИТЬСЯ К КОМНАТЕ ===
        if (msg.type === 'join_room') {
            if (ws._roomCode) return;
            const code = String(msg.code || '').trim();
            const room = rooms.get(code);
            if (!room) {
                sendTo(ws, { type: 'error', message: 'Комната не найдена' });
                return;
            }
            // ⚠️ ПРОВЕРКА ЛИМИТА — 4 клиента максимум (хост + 4 = 5 игроков)
            if (room.clients.length >= MAX_CLIENTS) {
                sendTo(ws, { type: 'error', message: 'Комната заполнена (' + MAX_PLAYERS + ' игроков макс.)' });
                return;
            }
            ws._roomCode = code;
            ws._playerId = 'p' + (room.clients.length + 1);
            ws._nickname = String(msg.nickname || ws._playerId).slice(0, 16);
            room.clients.push(ws);
            room.lastActivity = Date.now();

            if (!room.players) room.players = {};
            room.players[ws._playerId] = { id: ws._playerId, nickname: ws._nickname, isHost: false };

            sendTo(ws, {
                type: 'room_joined',
                code,
                playerId: ws._playerId,
                nickname: ws._nickname,
                players: Object.values(room.players)
            });
            sendTo(room.host, {
                type: 'player_joined',
                id: ws._playerId,
                nickname: ws._nickname,
                players: Object.values(room.players)
            });
            broadcastToRoom(code, {
                type: 'player_joined',
                id: ws._playerId,
                nickname: ws._nickname,
                players: Object.values(room.players)
            }, ws);

            console.log(`🎮 Игрок ${ws._playerId} (${ws._nickname}) подключился к комнате ${code}. Всего: ${room.clients.length + 1}/${MAX_PLAYERS}`);
            return;
        }

        // === PING ===
        if (msg.type === 'ping') {
            sendTo(ws, { type: 'pong' });
            return;
        }

        // === РЕЛЕЙ ИГРОВЫХ СООБЩЕНИЙ ===
        if (ws._roomCode) {
            const room = rooms.get(ws._roomCode);
            if (room) {
                room.lastActivity = Date.now();
                msg.from = ws._playerId;
                broadcastToRoom(ws._roomCode, msg, ws);
            }
        }
    });

    ws.on('close', () => {
        console.log('❌ Отключение');
        leaveRoom(ws);
    });

    ws.on('error', () => {
        leaveRoom(ws);
    });

    ws.on('pong', () => { ws._isAlive = true; });
});

// Периодическая чистка
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws._isAlive === false) {
            try { ws.terminate(); } catch (e) {}
            return;
        }
        ws._isAlive = false;
        try { ws.ping(); } catch (e) {}
    });

    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
        if (now - room.lastActivity > 30 * 60 * 1000) {
            broadcastToRoom(code, { type: 'room_timeout' }, null);
            rooms.delete(code);
            console.log(`⏰ Комната ${code} удалена по таймауту`);
        }
    }
}, 30000);
