require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
app.use(cors());
app.use(express.json());

// Налаштування
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.error('❌ ERROR: Missing TELEGRAM_BOT_TOKEN or ADMIN_CHAT_ID in .env file');
  process.exit(1);
}

const bot = new TelegramBot(TELEGRAM_BOT_TOKEN, { polling: true });

// Зберігання активних чатів
const activeChats = new Map();

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
      activeChats.set(data.sessionId, {
        lastMessage: Date.now(),
        messages: []
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
bot.onText(/\/reply_([a-zA-Z0-9-]+)\s+(.+)/, async (msg, match) => {
  const sessionId = match[1];
  const reply = match[2];
  
  const chat = activeChats.get(sessionId);
  if (chat) {
    chat.messages.push({
      text: reply,
      timestamp: Date.now()
    });
    
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
