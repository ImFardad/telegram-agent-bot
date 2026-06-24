import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import path from 'path';
import fs from 'fs';

const DB_DIR = './data';
const DB_PATH = path.join(DB_DIR, 'memory.db');

// Ensure database directory exists
if (!fs.existsSync(DB_DIR)) {
  fs.mkdirSync(DB_DIR, { recursive: true });
}

let db = null;

export async function initDatabase() {
  db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database
  });

  // Enable WAL mode for concurrency
  await db.run('PRAGMA journal_mode = WAL;');

  // Create Users Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      user_id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      nicknames TEXT DEFAULT '[]',
      interests TEXT DEFAULT '[]',
      skills TEXT DEFAULT '[]',
      projects TEXT DEFAULT '[]',
      relationships TEXT DEFAULT '{}',
      facts TEXT DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Messages Table (Short-Term Memory Buffer)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      telegram_message_id INTEGER,
      chat_id INTEGER,
      user_id INTEGER,
      username TEXT,
      user_fullname TEXT,
      content TEXT,
      reply_to_message_id INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Index to clean up old messages faster
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_chat_timestamp 
    ON messages(chat_id, timestamp)
  `);

  // Create Model Registry Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_registry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id TEXT UNIQUE,
      name TEXT,
      context_length INTEGER,
      supports_tools INTEGER DEFAULT 0,
      latency REAL DEFAULT 0,
      reliability REAL DEFAULT 1.0,
      score REAL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create System Logs Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT,
      message TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Model Usage Tracking Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS model_usage (
      model_id TEXT,
      usage_date TEXT,
      request_count INTEGER DEFAULT 0,
      PRIMARY KEY (model_id, usage_date)
    )
  `);

  // Create Collective Memory Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS collective_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      event_description TEXT NOT NULL,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Group State Table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS group_state (
      chat_id INTEGER PRIMARY KEY,
      vibe TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Create Social Links Table (Relational Graph)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS social_links (
      chat_id INTEGER,
      user_a_id INTEGER,
      user_b_id INTEGER,
      relation_type TEXT,
      description TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (chat_id, user_a_id, user_b_id)
    )
  `);

  // Log initialization
  await logSystem('DATABASE', 'Database initialized successfully.');
  return db;
}

// Log System Events
export async function logSystem(category, message) {
  if (!db) return console.log(`[${category}] ${message}`);
  try {
    await db.run(
      'INSERT INTO system_logs (category, message) VALUES (?, ?)',
      [category, message]
    );
    console.log(`[${category}] ${message}`);
  } catch (error) {
    console.error('Failed to write log to database:', error);
  }
}

// Fetch System Logs
export async function getSystemLogs(limit = 100) {
  if (!db) return [];
  return db.all('SELECT * FROM system_logs ORDER BY timestamp DESC LIMIT ?', [limit]);
}

// Clear Logs
export async function clearSystemLogs() {
  if (!db) return;
  await db.run('DELETE FROM system_logs');
}

// Memory Tools Helper
export async function getUserProfile(userId) {
  if (!db) return null;
  const user = await db.get('SELECT * FROM users WHERE user_id = ?', [userId]);
  if (!user) return null;

  return {
    user_id: user.user_id,
    name: user.name,
    nicknames: JSON.parse(user.nicknames),
    interests: JSON.parse(user.interests),
    skills: JSON.parse(user.skills),
    projects: JSON.parse(user.projects),
    relationships: JSON.parse(user.relationships),
    facts: JSON.parse(user.facts)
  };
}

export async function createUserProfile(userId, name) {
  if (!db) return null;
  await db.run(
    `INSERT OR IGNORE INTO users (user_id, name) VALUES (?, ?)`,
    [userId, name]
  );
  return getUserProfile(userId);
}

export async function updateUserProfile(userId, updates) {
  if (!db) return null;
  const current = await getUserProfile(userId);
  if (!current) return null;

  const name = updates.name !== undefined ? updates.name : current.name;
  const nicknames = updates.nicknames ? JSON.stringify(updates.nicknames) : JSON.stringify(current.nicknames);
  const interests = updates.interests ? JSON.stringify(updates.interests) : JSON.stringify(current.interests);
  const skills = updates.skills ? JSON.stringify(updates.skills) : JSON.stringify(current.skills);
  const projects = updates.projects ? JSON.stringify(updates.projects) : JSON.stringify(current.projects);
  const relationships = updates.relationships ? JSON.stringify(updates.relationships) : JSON.stringify(current.relationships);
  const facts = updates.facts ? JSON.stringify(updates.facts) : JSON.stringify(current.facts);

  await db.run(
    `UPDATE users SET 
      name = ?, nicknames = ?, interests = ?, skills = ?, projects = ?, relationships = ?, facts = ?, updated_at = CURRENT_TIMESTAMP
     WHERE user_id = ?`,
    [name, nicknames, interests, skills, projects, relationships, facts, userId]
  );

  await logSystem('MEMORY', `Updated memory profile for user ${userId} (${name})`);
  return getUserProfile(userId);
}

export async function getAllUserProfiles() {
  if (!db) return [];
  const rows = await db.all('SELECT * FROM users ORDER BY name ASC');
  return rows.map(user => ({
    user_id: user.user_id,
    name: user.name,
    nicknames: JSON.parse(user.nicknames),
    interests: JSON.parse(user.interests),
    skills: JSON.parse(user.skills),
    projects: JSON.parse(user.projects),
    relationships: JSON.parse(user.relationships),
    facts: JSON.parse(user.facts),
    updated_at: user.updated_at
  }));
}

// Short-Term Memory Helper
export async function addMessageToBuffer(msg) {
  if (!db) return;
  await db.run(
    `INSERT INTO messages 
     (telegram_message_id, chat_id, user_id, username, user_fullname, content, reply_to_message_id) 
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [msg.telegram_message_id, msg.chat_id, msg.user_id, msg.username, msg.user_fullname, msg.content, msg.reply_to_message_id]
  );

  // Keep buffer size limited to 500 messages per group/chat
  const countRow = await db.get('SELECT COUNT(*) as cnt FROM messages WHERE chat_id = ?', [msg.chat_id]);
  if (countRow && countRow.cnt > 500) {
    const toDelete = countRow.cnt - 500;
    // Get the ID threshold for deletion
    const thresholdRow = await db.get(
      'SELECT id FROM messages WHERE chat_id = ? ORDER BY timestamp ASC LIMIT 1 OFFSET ?',
      [msg.chat_id, toDelete]
    );
    if (thresholdRow) {
      await db.run('DELETE FROM messages WHERE chat_id = ? AND id < ?', [msg.chat_id, thresholdRow.id]);
    }
  }
}

export async function getRecentMessages(chatId, limit = 500) {
  if (!db) return [];
  return db.all(
    `SELECT * FROM messages WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?`,
    [chatId, limit]
  );
}

// Get message count in last X minutes
export async function getRecentMessageCount(chatId, minutes = 10) {
  if (!db) return 0;
  const row = await db.get(
    `SELECT COUNT(*) as cnt FROM messages 
     WHERE chat_id = ? AND timestamp >= datetime('now', ?)`,
    [chatId, `-${minutes} minutes`]
  );
  return row ? row.cnt : 0;
}

// Model Registry Helpers
export async function registerModel(model) {
  if (!db) return;
  await db.run(
    `INSERT INTO model_registry (model_id, name, context_length, supports_tools, latency, reliability, score)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(model_id) DO UPDATE SET
      name = excluded.name,
      context_length = excluded.context_length,
      supports_tools = excluded.supports_tools,
      latency = excluded.latency,
      reliability = excluded.reliability,
      score = excluded.score,
      updated_at = CURRENT_TIMESTAMP`,
    [model.model_id, model.name, model.context_length, model.supports_tools, model.latency, model.reliability, model.score]
  );
}

export async function getRegisteredModels() {
  if (!db) return [];
  return db.all('SELECT * FROM model_registry ORDER BY score DESC');
}

export async function clearRegisteredModels() {
  if (!db) return;
  await db.run('DELETE FROM model_registry');
}

export async function incrementModelUsage(modelId) {
  if (!db) return;
  const currentDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  try {
    await db.run(`
      INSERT INTO model_usage (model_id, usage_date, request_count)
      VALUES (?, ?, 1)
      ON CONFLICT(model_id, usage_date) DO UPDATE SET request_count = request_count + 1
    `, [modelId, currentDate]);
  } catch (err) {
    console.error(`Failed to increment model usage for ${modelId}:`, err);
  }
}

export async function getModelUsageStats() {
  if (!db) return [];
  try {
    return await db.all(`
      SELECT model_id, usage_date, request_count
      FROM model_usage
      ORDER BY usage_date DESC, request_count DESC
      LIMIT 100
    `);
  } catch (err) {
    console.error('Failed to get model usage stats:', err);
    return [];
  }
}

// Group State & Vibe Helpers
export async function updateGroupVibe(chatId, vibe) {
  if (!db) return;
  await db.run(
    `INSERT INTO group_state (chat_id, vibe) VALUES (?, ?)
     ON CONFLICT(chat_id) DO UPDATE SET vibe = excluded.vibe, updated_at = CURRENT_TIMESTAMP`,
    [chatId, vibe]
  );
}

export async function getGroupVibe(chatId) {
  if (!db) return null;
  const row = await db.get('SELECT vibe FROM group_state WHERE chat_id = ?', [chatId]);
  return row ? row.vibe : 'Neutral';
}

// Collective Memory Helpers
export async function addCollectiveMemory(chatId, eventDescription) {
  if (!db) return;
  await db.run(
    'INSERT INTO collective_memory (chat_id, event_description) VALUES (?, ?)',
    [chatId, eventDescription]
  );
}

export async function getCollectiveMemories(chatId, limit = 10) {
  if (!db) return [];
  return db.all(
    'SELECT * FROM collective_memory WHERE chat_id = ? ORDER BY timestamp DESC LIMIT ?',
    [chatId, limit]
  );
}

// Social Links (Relational Graph) Helpers
export async function updateSocialLink(chatId, userAId, userBId, type, description) {
  if (!db) return;
  // Ensure userAId < userBId for canonical representation
  const [id1, id2] = userAId < userBId ? [userAId, userBId] : [userBId, userAId];
  await db.run(
    `INSERT INTO social_links (chat_id, user_a_id, user_b_id, relation_type, description)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chat_id, user_a_id, user_b_id) DO UPDATE SET
      relation_type = excluded.relation_type,
      description = excluded.description,
      updated_at = CURRENT_TIMESTAMP`,
    [chatId, id1, id2, type, description]
  );
}

export async function getSocialLinks(chatId) {
  if (!db) return [];
  return db.all('SELECT * FROM social_links WHERE chat_id = ?', [chatId]);
}
