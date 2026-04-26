import express from 'express';
import { prisma } from '../db.js';

const router = express.Router();

// Telegram Bot API configuration
let TELEGRAM_BOT_TOKEN = null;
let TELEGRAM_WEBHOOK_URL = null;

// Store conversation mappings: telegram_chat_id -> conversation_id
const telegramConversations = new Map();

// Initialize Telegram bot with token from settings
async function initTelegramBot() {
  try {
    const site = await prisma.site.findFirst({
      where: { id: "1" }, // Assuming site_id = 1 for now (as string)
      select: { settings: true }
    });

    if (site && site.settings) {
      const siteSettings = typeof site.settings === 'string' ? JSON.parse(site.settings) : site.settings;
      const telegramConfig = siteSettings.integrations?.telegram;

      if (telegramConfig && telegramConfig.token) {
        TELEGRAM_BOT_TOKEN = telegramConfig.token;
        console.log('Telegram bot initialized');

        // Set webhook
        await setWebhook();
      }
    }
  } catch (error) {
    console.error('Error initializing Telegram bot:', error);
  }
}

// API endpoint to manually initialize Telegram bot
router.post('/init', async (req, res) => {
  try {
    await initTelegramBot();
    res.json({ success: true, message: 'Telegram bot initialized' });
  } catch (error) {
    console.error('Error initializing Telegram bot via API:', error);
    res.status(500).json({ error: error.message });
  }
});

// Set Telegram webhook
async function setWebhook() {
  if (!TELEGRAM_BOT_TOKEN) return;
  
  const baseUrl = process.env.BASE_URL || 'https://chatmesaj.cc';
  TELEGRAM_WEBHOOK_URL = `${baseUrl}/api/telegram/webhook`;
  
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: TELEGRAM_WEBHOOK_URL,
          allowed_updates: ['message', 'callback_query']
        })
      }
    );
    
    const result = await response.json();
    if (result.ok) {
      console.log('Telegram webhook set successfully');
    } else {
      console.error('Failed to set Telegram webhook:', result.description);
    }
  } catch (error) {
    console.error('Error setting Telegram webhook:', error);
  }
}

// Handle incoming Telegram webhook
router.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    const io = req.app.get('io');

    // Handle messages
    if (body.message) {
      await handleTelegramMessage(body.message, io);
    }

    // Handle callback queries (button clicks)
    if (body.callback_query) {
      await handleCallbackQuery(body.callback_query);
    }

    res.sendStatus(200);
  } catch (error) {
    console.error('Error handling Telegram webhook:', error);
    res.sendStatus(500);
  }
});

// Handle Telegram messages
async function handleTelegramMessage(message, io) {
  const chatId = message.chat.id;
  const text = message.text;
  const from = message.from;

  if (!text) return;

  try {
    // Find or create conversation for this Telegram user
    let conversationId = telegramConversations.get(chatId.toString());

    if (!conversationId) {
      // Create new conversation
      const conversation = await prisma.conversation.create({
        data: {
          visitorId: from.id.toString(),
          siteId: "1",
          status: 'OPEN',
          channel: 'telegram',
          channelUserId: chatId.toString(),
        }
      });

      conversationId = conversation.id;
      telegramConversations.set(chatId.toString(), conversationId);

      // Create or update visitor
      await prisma.visitor.upsert({
        where: { id: from.id.toString() },
        update: {
          name: `${from.first_name || ''} ${from.last_name || ''}`.trim() || 'Telegram User',
          email: from.username || ''
        },
        create: {
          id: from.id.toString(),
          siteId: "1",
          name: `${from.first_name || ''} ${from.last_name || ''}`.trim() || 'Telegram User',
          email: from.username || ''
        }
      });

      // Create initial message in conversation
      await prisma.message.create({
        data: {
          conversationId: conversationId,
          from: 'VISITOR',
          text: text,
        }
      });

      // Notify connected clients via socket.io
      if (io) {
        io.to(`site:1`).emit('new_conversation', {
          id: conversationId,
          visitor_id: from.id,
          channel: 'telegram',
          channel_user_id: chatId.toString(),
          status: 'open'
        });
      }
    } else {
      // Add message to existing conversation
      await prisma.message.create({
        data: {
          conversationId: conversationId,
          from: 'VISITOR',
          text: text,
        }
      });

      // Notify connected clients
      if (io) {
        io.to(`conversation:${conversationId}`).emit('new_message', {
          conversation_id: conversationId,
          sender_id: from.id,
          sender_type: 'visitor',
          content: text
        });
      }
    }
  } catch (error) {
    console.error('Error handling Telegram message:', error);
  }
}

// Handle callback queries
async function handleCallbackQuery(callbackQuery) {
  const chatId = callbackQuery.message.chat.id;
  const data = callbackQuery.data;
  
  try {
    // Acknowledge the callback
    await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQuery.id,
          text: 'Received'
        })
      }
    );
    
    // Handle the callback data as needed
    console.log('Callback query received:', data);
  } catch (error) {
    console.error('Error handling callback query:', error);
  }
}

// Send message to Telegram
async function sendTelegramMessage(chatId, text, options = {}) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('Telegram bot not initialized');
  }
  
  try {
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: text,
          parse_mode: 'HTML',
          ...options
        })
      }
    );
    
    const result = await response.json();
    if (!result.ok) {
      throw new Error(result.description);
    }
    
    return result;
  } catch (error) {
    console.error('Error sending Telegram message:', error);
    throw error;
  }
}

// API endpoint to send message to Telegram from admin
router.post('/send', async (req, res) => {
  try {
    const { chatId, text, conversationId } = req.body;

    if (!chatId || !text) {
      return res.status(400).json({ error: 'chatId and text are required' });
    }

    const result = await sendTelegramMessage(chatId, text);

    // Save message to database if conversationId is provided
    if (conversationId) {
      await prisma.message.create({
        data: {
          conversationId: conversationId,
          from: 'AGENT',
          text: text,
          authorId: req.user?.id || 0,
        }
      });
    }

    res.json({ success: true, result });
  } catch (error) {
    console.error('Error sending message via API:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get Telegram bot info
router.get('/info', async (req, res) => {
  try {
    if (!TELEGRAM_BOT_TOKEN) {
      return res.json({ connected: false });
    }
    
    const response = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`
    );
    
    const result = await response.json();
    
    if (result.ok) {
      res.json({
        connected: true,
        bot: result.result
      });
    } else {
      res.json({ connected: false });
    }
  } catch (error) {
    console.error('Error getting Telegram bot info:', error);
    res.json({ connected: false });
  }
});

// Initialize on server start
setTimeout(initTelegramBot, 2000);

export default router;
export { sendTelegramMessage, initTelegramBot };
