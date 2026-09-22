// server.js — WebSocket сервер с лёгкой регистрацией
// Работает на Render, Koyeb, Cyclic, Fly.io
// НЕ требует MongoDB — использует файл users.json

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');

const PORT = parseInt(process.env.PORT || 3000, 10);
const wss = new WebSocket.Server({ port: PORT });
console.log('🚀 Сервер запущен на порту', PORT);

// ============ АККАУНТЫ (файл на диске) ============
const USERS_FILE = path.join(__dirname, 'users.json');

let users = {};      // { nickname_lower: { nickname, passwordHash, progress, createdAt } }
let tokens = {};     // { token: nickname_lower }

function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return 'h' + Math.abs(hash).toString(36);
}

function generateToken() {
    return 't' + Math.random().toString(36).substring(2) + Date.now().toString(36) + Math.random().toString(36).substring(2);
}

function loadUsers() {
    try {
        if (fs.existsSync(USERS_FILE)) {
            const data = fs.readFileSync(USERS_FILE, 'utf8');
            users = JSON.parse(data);
            console.log('✅ Загружено пользователей:', Object.keys(users).length);
        } else {
            console.log('📁 users.json ещё не создан — начнём с чистого листа');
        }
    } catch (e) {
        console.error('❌ Ошибка загрузки users.json:', e.message);
        users = {};
    }
}

function saveUsers() {
    try {
        fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
    } catch (e) {
        console.error('❌ Ошибка сохранения users.json:', e.message);
    }
}

loadUsers();
setInterval(saveUsers, 60000);

// ============ КОМНАТЫ ============
const MAX_PLAYERS = 5;
const MAX_CLIENTS = MAX_PLAYERS - 1;
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
            if (room.players) {
                delete room.players[newHost._playerId];
                room.players['host'] = { id: 'host', nickname: newHost._nickname || 'Хост', isHost: true };
            }
            broadcastToRoom(code, { type: 'host_changed', newHost: 'host' }, null);
            console.log(`👑 Хост передан в комнате ${code}`);
        } else {
            rooms.delete(code);
            console.log(`❌ Комната ${code} закрыта`);
        }
    } else {
        room.clients = room.clients.filter(c => c !== ws);
        if (room.players) delete room.players[ws._playerId];
        broadcastToRoom(code, { type: 'player_left', id: ws._playerId }, ws);
        console.log(`👋 Игрок ${ws._playerId} вышел из ${code}`);
    }
    ws._roomCode = null;
    ws._playerId = null;
}

// ============ ПОДКЛЮЧЕНИЕ ============
wss.on('connection', (ws) => {
    ws._roomCode = null;
    ws._playerId = null;
    ws._nickname = null;
    ws._isAlive = true;
    ws._userKey = null;

    console.log('🔌 Новое подключение');

    ws.on('message', async (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
        if (!msg || typeof msg.type !== 'string') return;

        // ===== РЕГИСТРАЦИЯ =====
        if (msg.type === 'register') {
            const { nickname, password } = msg;
            if (!nickname || !password) {
                sendTo(ws, { type: 'auth_error', message: 'Заполни ник и пароль' });
                return;
            }
            if (nickname.length < 3 || nickname.length > 16) {
                sendTo(ws, { type: 'auth_error', message: 'Ник от 3 до 16 символов' });
                return;
            }
            if (password.length < 4) {
                sendTo(ws, { type: 'auth_error', message: 'Пароль минимум 4 символа' });
                return;
            }
            const key = nickname.toLowerCase();
            if (users[key]) {
                sendTo(ws, { type: 'auth_error', message: 'Ник уже занят' });
                return;
            }

            users[key] = {
                nickname: nickname,
                passwordHash: simpleHash(password),
                progress: {
                    playerLevel: 1, playerXP: 0, playerTotalXP: 0,
                    coins: 0, crystals: 0,
                    unlockedContent: { skins: ['default'], weapons: ['pistol'], maps: ['arena'] },
                    ownedSkins: ['default'],
                    ownedWeaponsShop: ['pistol'],
                    battlePass: { level: 1, xp: 0, premium: false },
                },
                createdAt: Date.now(),
            };

            const token = generateToken();
            tokens[token] = key;
            ws._userKey = key;
            saveUsers();

            sendTo(ws, {
                type: 'auth_success',
                token,
                user: {
                    nickname: nickname,
                    progress: users[key].progress,
                },
            });
            console.log(`✅ Регистрация: ${nickname}`);
            return;
        }

        // ===== ВХОД =====
        if (msg.type === 'login') {
            const { nickname, password } = msg;
            if (!nickname || !password) {
                sendTo(ws, { type: 'auth_error', message: 'Заполни ник и пароль' });
                return;
            }
            const key = nickname.toLowerCase();
            const user = users[key];
            if (!user) {
                sendTo(ws, { type: 'auth_error', message: 'Ник не найден' });
                return;
            }
            if (user.passwordHash !== simpleHash(password)) {
                sendTo(ws, { type: 'auth_error', message: 'Неверный пароль' });
                return;
            }

            const token = generateToken();
            tokens[token] = key;
            ws._userKey = key;

            sendTo(ws, {
                type: 'auth_success',
                token,
                user: {
                    nickname: user.nickname,
                    progress: user.progress,
                },
            });
            console.log(`✅ Вход: ${nickname}`);
            return;
        }

        // ===== АВТОЛОГИН =====
        if (msg.type === 'check_token') {
            const key = tokens[msg.token];
            const user = key ? users[key] : null;
            if (!user) {
                sendTo(ws, { type: 'auth_error', message: 'Сессия истекла' });
                return;
            }
            ws._userKey = key;
            sendTo(ws, {
                type: 'auth_success',
                token: msg.token,
                user: {
                    nickname: user.nickname,
                    progress: user.progress,
                },
            });
            return;
        }

        // ===== СОХРАНЕНИЕ ПРОГРЕССА =====
        if (msg.type === 'save_progress') {
            const key = tokens[msg.token];
            if (key && users[key]) {
                users[key].progress = msg.progress;
                users[key].updatedAt = Date.now();
            }
            return;
        }

        // ===== ЛОГАУТ =====
        if (msg.type === 'logout') {
            for (const t in tokens) {
                if (tokens[t] === ws._userKey) delete tokens[t];
            }
            ws._userKey = null;
            sendTo(ws, { type: 'logout_success' });
            return;
        }

        // ===== СОЗДАТЬ КОМНАТУ =====
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

        // ===== ВОЙТИ В КОМНАТУ =====
        if (msg.type === 'join_room') {
            if (ws._roomCode) return;
            const code = String(msg.code || '').trim();
            const room = rooms.get(code);
            if (!room) {
                sendTo(ws, { type: 'error', message: 'Комната не найдена' });
                return;
            }
            if (room.clients.length >= MAX_CLIENTS) {
                sendTo(ws, { type: 'error', message: 'Комната заполнена (макс 5)' });
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
                players: Object.values(room.players),
            });
            sendTo(room.host, {
                type: 'player_joined',
                id: ws._playerId,
                nickname: ws._nickname,
                players: Object.values(room.players),
            });
            broadcastToRoom(code, {
                type: 'player_joined',
                id: ws._playerId,
                nickname: ws._nickname,
                players: Object.values(room.players),
            }, ws);

            console.log(`🎮 Игрок ${ws._playerId} (${ws._nickname}) в комнате ${code} [${room.clients.length + 1}/${MAX_PLAYERS}]`);
            return;
        }

        // ===== PING =====
        if (msg.type === 'ping') {
            sendTo(ws, { type: 'pong' });
            return;
        }

        // ===== РЕЛЕЙ ИГРОВЫХ СООБЩЕНИЙ =====
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

// ============ ПЕРИОДИЧЕСКАЯ ЧИСТКА ============
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws._isAlive === false) {
            try { ws.terminate(); } catch (e) {}
            return;
        }
        ws._isAlive = false;
        try { ws.ping(); } catch (e) {}
    });

    // Удаляем комнаты без активности > 30 мин
    const now = Date.now();
    for (const [code, room] of rooms.entries()) {
        if (now - room.lastActivity > 30 * 60 * 1000) {
            broadcastToRoom(code, { type: 'room_timeout' }, null);
            rooms.delete(code);
            console.log(`⏰ Комната ${code} удалена по таймауту`);
        }
    }
}, 30000);

// ============ HTTP HEALTH CHECK (опционально) ============
const http = require('http');
http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
}).listen(PORT + 1, () => {
    console.log('❤️  Health-check на порту', PORT + 1);
});
