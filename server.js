import express from 'express';
import cors from 'cors';
import { Bot, HttpError } from 'grammy';
import dotenv from 'dotenv';
import os from 'os';
import path from 'path';

import { 
  initDatabase, 
  logSystem, 
  getSystemLogs, 
  clearSystemLogs,
  getAllUserProfiles, 
  getRegisteredModels,
  addMessageToBuffer,
  getRecentMessageCount
} from './src/database.js';
import { classifyMessage } from './src/classifier.js';
import { runPlanner } from './src/planner.js';
import { discoverFreeModels, startDiscoverySchedule } from './src/discovery.js';
import { setBotInstance } from './src/tools.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Global bot state variables
let bot = null;
let botStatus = 'IDLE'; // IDLE, ACTIVE, OBSERVING_LIVE
let totalMessagesProcessed = 0;

// Initialize System
async function startSystem() {
  // 1. Database
  await initDatabase();
  
  // 2. Telegram Bot
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.startsWith('your_')) {
    await logSystem('SYSTEM', 'WARNING: TELEGRAM_BOT_TOKEN is missing or placeholder. Bot will not start.');
  } else {
    bot = new Bot(token);
    setBotInstance(bot);
    setupBotHandlers();
    
    // Start Polling in background
    bot.start({
      onStart: (botInfo) => {
        logSystem('SYSTEM', `Telegram Bot started successfully as @${botInfo.username}`);
        botStatus = 'ACTIVE';
      }
    }).catch(err => {
      logSystem('SYSTEM', `Telegram Bot polling failed: ${err.message}`);
    });
  }

  // 3. Start OpenRouter Disocvery Job
  startDiscoverySchedule();
  
  // 4. Start Express Server
  app.listen(PORT, () => {
    logSystem('SYSTEM', `Dashboard Web Server running on port ${PORT}`);
  });
}

// Telegram Bot Message Handlers
function setupBotHandlers() {
  // Middleware to restrict to specified group chat if configured
  bot.use(async (ctx, next) => {
    const allowedChatId = process.env.ALLOWED_CHAT_ID;
    if (allowedChatId && allowedChatId !== 'your_telegram_chat_id_here') {
      const allowedId = Number(allowedChatId);
      if (ctx.chat && ctx.chat.id !== allowedId) {
        // Log & ignore messages outside the private group
        if (ctx.chat.type !== 'private') {
          console.log(`[SYSTEM] Ignored message from unauthorized chat: ${ctx.chat.id}`);
          return;
        }
      }
    }
    await next();
  });

  // Handle Text and Media messages
  bot.on(['message:text', 'message:photo', 'message:document'], async (ctx) => {
    const message = ctx.message;
    const chatId = ctx.chat.id;
    const text = message.text || message.caption || '';
    
    // Save all messages to short-term memory database (rolling buffer)
    const msgRecord = {
      telegram_message_id: message.message_id,
      chat_id: chatId,
      user_id: message.from.id,
      username: message.from.username || '',
      user_fullname: [message.from.first_name, message.from.last_name].filter(Boolean).join(' '),
      content: text || '[Attachment]',
      reply_to_message_id: message.reply_to_message?.message_id || null
    };
    
    await addMessageToBuffer(msgRecord);
    totalMessagesProcessed++;

    // 1. Observation Mode check: if >100 messages in 10 minutes, set state to OBSERVING_LIVE
    const recentMsgs = await getRecentMessageCount(chatId, 10);
    if (recentMsgs >= 100 && botStatus !== 'OBSERVING_LIVE') {
      botStatus = 'OBSERVING_LIVE';
      await logSystem('OBSERVER', `High chat volume detected (${recentMsgs} msgs/10m). Switched to Observation Mode (Gemini 3 Flash Live session active).`);
    } else if (recentMsgs < 50 && botStatus === 'OBSERVING_LIVE') {
      botStatus = 'ACTIVE';
      await logSystem('OBSERVER', `Chat volume normalized (${recentMsgs} msgs/10m). Exiting Observation Mode.`);
    }

    // 2. Classify Message
    const category = classifyMessage(ctx);
    if (category === 'IGNORE') {
      return; // Do nothing
    }

    // 3. Process with Gemma Planner
    await ctx.replyWithChatAction('typing');
    const replyText = await runPlanner(ctx, category);
    
    if (replyText) {
      // Send Reply back to group/user
      await ctx.reply(replyText, {
        reply_parameters: { message_id: message.message_id }
      });
      await logSystem('SYSTEM', `Sent response to ${msgRecord.user_fullname}: "${replyText.substring(0, 50)}..."`);
    }
  });

  // Error Handler
  bot.catch((err) => {
    const ctx = err.ctx;
    logSystem('SYSTEM', `Error while handling update ${ctx.update.update_id}: ${err.error.message}`);
  });
}

// ------------------------------------------------------------------------------
// Dashboard API Endpoints
// ------------------------------------------------------------------------------

// 1. Status overview
app.get('/api/status', async (req, res) => {
  try {
    const memory = process.memoryUsage();
    res.json({
      status: botStatus,
      uptime: Math.floor(process.uptime()),
      system_uptime: Math.floor(os.uptime()),
      memory_rss: Math.floor(memory.rss / 1024 / 1024), // MB
      memory_heap: Math.floor(memory.heapUsed / 1024 / 1024), // MB
      cpu_cores: os.cpus().length,
      platform: os.platform(),
      total_messages_processed: totalMessagesProcessed,
      bot_configured: !!bot
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. System Logs
app.get('/api/logs', async (req, res) => {
  try {
    const logs = await getSystemLogs(80);
    res.json(logs);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. Clear Logs
app.post('/api/logs/clear', async (req, res) => {
  try {
    await clearSystemLogs();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 4. User Profiles
app.get('/api/users', async (req, res) => {
  try {
    const profiles = await getAllUserProfiles();
    res.json(profiles);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 5. OpenRouter Models Registry
app.get('/api/models', async (req, res) => {
  try {
    const models = await getRegisteredModels();
    res.json(models);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 6. Trigger OpenRouter Discovery Manually
app.post('/api/discover', async (req, res) => {
  try {
    // Run discovery asynchronously so request doesn't timeout
    discoverFreeModels();
    res.json({ success: true, message: 'Discovery job triggered successfully.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Start the whole system
startSystem().catch(err => {
  console.error('System start crash:', err);
});
