// Завантажуємо dotenv тільки локально (не на Railway)
if (process.env.NODE_ENV !== 'production') {
  require('dotenv').config();
}

const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
// Capture raw body (needed for webhook signature verification)
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf?.toString('utf8') || '';
  }
}));

// Налаштування
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const MAKE_WEBHOOK_URL = process.env.MAKE_WEBHOOK_URL;
const MAKE_WEBHOOK_SECRET = process.env.MAKE_WEBHOOK_SECRET;

if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error('❌ ERROR: Missing TELEGRAM_BOT_TOKEN or ADMIN_CHAT_ID');
  console.error('TELEGRAM_BOT_TOKEN:', TELEGRAM_BOT_TOKEN ? 'SET' : 'NOT SET');
  console.error('ADMIN_CHAT_ID:', ADMIN_CHAT_ID ? 'SET' : 'NOT SET');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Зберігання активних чатів
const activeChats = new Map();

function getChat(sessionId) {
  if (!activeChats.has(sessionId)) {
    activeChats.set(sessionId, { lastMessage: Date.now(), messages: [], history: [] });
  }
  return activeChats.get(sessionId);
}

function pushHistory(sessionId, entry) {
  const chat = getChat(sessionId);
  chat.history = Array.isArray(chat.history) ? chat.history : [];
  chat.history.push(entry);
  // keep last 20 entries
  if (chat.history.length > 20) chat.history = chat.history.slice(-20);
  chat.lastMessage = Date.now();
}

function makeSignature(rawBody) {
  if (!MAKE_WEBHOOK_SECRET) return null;
  const h = crypto.createHmac('sha256', MAKE_WEBHOOK_SECRET).update(rawBody).digest('hex');
  return `sha256=${h}`;
}

function verifyIncomingSignature(req) {
  if (!MAKE_WEBHOOK_SECRET) return false;
  const sig = req.get('x-make-signature') || '';
  const expected = makeSignature(req.rawBody || '');
  if (!expected) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

async function notifyMake(payload) {
  if (!MAKE_WEBHOOK_URL) return;
  try {
    const raw = JSON.stringify(payload);
    console.log('➡️ MAKE webhook: sending', {
      type: payload?.type,
      sessionId: payload?.sessionId,
      url: MAKE_WEBHOOK_URL ? '[set]' : '[missing]'
    });
    const r = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(MAKE_WEBHOOK_SECRET ? { 'x-make-signature': makeSignature(raw) } : {})
      },
      body: raw
    });
    console.log('✅ MAKE webhook: delivered', { status: r.status });
  } catch (e) {
    console.error('⚠️ MAKE webhook failed:', e?.message || e);
  }
}

// =========================
// Live counter (server-side)
// =========================
// NOTE: uses SERVER LOCAL TIME for "day" boundaries.
// For production, set environment variable TZ (e.g. "Europe/Kyiv") in your host.
const COUNTER_STATE_PATH = path.join(__dirname, 'counter-state.json');
const COUNTER_MIN_MS = 20 * 60 * 1000;
const COUNTER_MAX_MS = 45 * 60 * 1000;

const counterState = {
  dayKey: null,
  count: 0,
  nextAt: 0
};

function dayKeyLocal(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function nextLocalMidnightTs(ts = Date.now()) {
  const d = new Date(ts);
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function randDelayMs() {
  return COUNTER_MIN_MS + Math.floor(Math.random() * (COUNTER_MAX_MS - COUNTER_MIN_MS + 1));
}

function loadCounterStateFromDisk() {
  try {
    if (!fs.existsSync(COUNTER_STATE_PATH)) return null;
    const raw = fs.readFileSync(COUNTER_STATE_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

function saveCounterStateToDisk() {
  try {
    fs.writeFileSync(COUNTER_STATE_PATH, JSON.stringify(counterState, null, 2));
  } catch (e) {
    console.error('⚠️ Counter state save failed:', e?.message || e);
  }
}

function ensureCounterDay(now = Date.now()) {
  const key = dayKeyLocal(now);
  if (counterState.dayKey !== key) {
    counterState.dayKey = key;
    counterState.count = 0;
    counterState.nextAt = now + randDelayMs();
    saveCounterStateToDisk();
    return true;
  }
  return false;
}

function maybeIncrementCounter(now = Date.now()) {
  ensureCounterDay(now);

  if (!counterState.nextAt || typeof counterState.nextAt !== 'number') {
    counterState.nextAt = now + randDelayMs();
    saveCounterStateToDisk();
    return false;
  }

  if (now >= counterState.nextAt) {
    counterState.count = (Number(counterState.count) || 0) + 1;
    counterState.nextAt = now + randDelayMs();
    saveCounterStateToDisk();
    return true;
  }

  return false;
}

let counterTimer = null;
function scheduleCounterTick() {
  if (counterTimer) clearTimeout(counterTimer);
  const now = Date.now();
  ensureCounterDay(now);

  const midnight = nextLocalMidnightTs(now);
  const nextEvent = Math.min(counterState.nextAt || (now + randDelayMs()), midnight);
  const delay = Math.max(1000, nextEvent - now);

  counterTimer = setTimeout(() => {
    try {
      maybeIncrementCounter(Date.now());
    } finally {
      scheduleCounterTick();
    }
  }, delay);
}

// init counter state + scheduler
(() => {
  const disk = loadCounterStateFromDisk();
  if (disk) {
    counterState.dayKey = disk.dayKey || null;
    counterState.count = Number(disk.count) || 0;
    counterState.nextAt = Number(disk.nextAt) || 0;
  }
  ensureCounterDay(Date.now());
  // if nextAt is in the past (server was offline), increment once and reschedule
  maybeIncrementCounter(Date.now());
  scheduleCounterTick();
})();

// API endpoint for live counter
app.get('/api/live-counter', (req, res) => {
  try {
    maybeIncrementCounter(Date.now());
    res.json({
      count: Number(counterState.count) || 0,
      dayKey: counterState.dayKey
    });
  } catch (e) {
    res.status(500).json({ error: 'Server error' });
  }
});

// API endpoint для отримання повідомлень з сайту
app.post('/api/chat-message', async (req, res) => {
  try {
    const data = req.body;
    
    // Перевіряємо тип ліда
    if (data.type === 'call') {
      // ЗАЯВКА НА ДЗВІНОК
      const messageText = 
        `📞 НОВА ЗАЯВКА НА ДЗВІНОК\n\n` +
        `👤 Ім'я: ${data.name}\n` +
        `📧 Email: ${data.email}\n` +
        `📱 Телефон: ${data.phone}\n` +
        `📅 Дата: ${data.date}\n` +
        `⏰ Час: ${data.time}\n\n` +
        `🔥 Гарячий лід! Передзвони якнайшвидше!`;
      
      await bot.sendMessage(ADMIN_CHAT_ID, messageText);
      
    } else if (data.message && data.sessionId) {
      // ПОВІДОМЛЕННЯ З ЧАТУ
      const messageText = 
        `💬 Нове повідомлення з live chat\n\n` +
        `Session: ${data.sessionId}\n` +
        `Повідомлення: ${data.message}\n\n` +
        `Відповідь: /reply_${data.sessionId} ваша_відповідь`;

      await bot.sendMessage(ADMIN_CHAT_ID, messageText);
      
      // Зберігаємо активний чат
      getChat(data.sessionId);
      pushHistory(data.sessionId, { role: 'user', text: String(data.message), ts: Date.now() });

      // Trigger Make.com / AI manager flow (optional)
      await notifyMake({
        type: 'livechat_message',
        sessionId: data.sessionId,
        message: String(data.message),
        history: getChat(data.sessionId).history,
        // for Make to call back:
        replyUrl: '/api/chat-reply'
      });
    } else {
      return res.status(400).json({ error: 'Invalid data' });
    }

    res.json({ success: true, message: 'Дані отримано' });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: 'Server error' });
  }
});

// AI/Manager -> Site (Make.com callback). Requires signature if MAKE_WEBHOOK_SECRET is set.
app.post('/api/chat-reply', async (req, res) => {
  try {
    if (MAKE_WEBHOOK_SECRET && !verifyIncomingSignature(req)) {
      return res.status(401).json({ error: 'Invalid signature' });
    }
    const { sessionId, text } = req.body || {};
    if (!sessionId || !text) return res.status(400).json({ error: 'Missing sessionId/text' });

    const chat = getChat(String(sessionId));
    chat.messages.push({ text: String(text), timestamp: Date.now() });
    pushHistory(String(sessionId), { role: 'assistant', text: String(text), ts: Date.now() });

    res.json({ success: true });
  } catch (e) {
    console.error('Error:', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// API endpoint для отримання відповідей (polling з фронтенду)
app.get('/api/chat-replies/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const chat = activeChats.get(sessionId);
  
  if (chat && chat.messages.length > 0) {
    const messages = [...chat.messages];
    chat.messages = []; // Очищаємо після відправки
    res.json({ messages });
  } else {
    res.json({ messages: [] });
  }
});

// Обробка команд від менеджера в Telegram
bot.onText(/\/reply_([a-zA-Z0-9_-]+)\s+([\s\S]+)/, async (msg, match) => {
  const sessionId = match[1];
  const reply = match[2];
  
  const chat = activeChats.get(sessionId);
  if (chat) {
    chat.messages.push({
      text: reply,
      timestamp: Date.now()
    });
    chat.lastMessage = Date.now();
    pushHistory(sessionId, { role: 'assistant', text: String(reply), ts: Date.now() });
    
    await bot.sendMessage(msg.chat.id, '✅ Відповідь надіслано на сайт');
  } else {
    await bot.sendMessage(msg.chat.id, '❌ Сесія не знайдена або застаріла');
  }
});

// Очищення старих чатів (старіші 24 годин)
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, chat] of activeChats.entries()) {
    if (now - chat.lastMessage > 24 * 60 * 60 * 1000) {
      activeChats.delete(sessionId);
    }
  }
}, 60 * 60 * 1000); // Кожну годину

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🤖 Telegram bot started`);
});
