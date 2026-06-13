import { logSystem, getUserProfile, updateUserProfile, getAllUserProfiles } from './database.js';
import { callGeminiWithPool } from './router.js';

// Global variables for Telegram Bot Instance
let botInstance = null;


export function setBotInstance(bot) {
  botInstance = bot;
}

// ------------------------------------------------------------------------------
// 1. Memory Tools
// ------------------------------------------------------------------------------
export async function remember(userId, fact, userName = 'Unknown') {
  let profile = await getUserProfile(userId);
  if (!profile) {
    profile = await updateUserProfile(userId, { name: userName, facts: [fact] });
  } else {
    const facts = [...profile.facts, fact];
    profile = await updateUserProfile(userId, { facts });
  }
  await logSystem('TOOL', `remember() -> Added fact for user ${userId}: "${fact}"`);
  return { success: true, profile };
}

export async function forget(userId, factIndex) {
  const profile = await getUserProfile(userId);
  if (!profile || !profile.facts[factIndex]) {
    return { success: false, error: 'Fact index not found' };
  }
  const removed = profile.facts.splice(factIndex, 1);
  await updateUserProfile(userId, { facts: profile.facts });
  await logSystem('TOOL', `forget() -> Removed fact for user ${userId}: "${removed[0]}"`);
  return { success: true, profile };
}

export async function searchMemory(query) {
  const allProfiles = await getAllUserProfiles();
  const lowerQuery = query.toLowerCase();
  
  const results = [];
  for (const prof of allProfiles) {
    let match = false;
    if (prof.name.toLowerCase().includes(lowerQuery)) match = true;
    if (prof.facts.some(f => f.toLowerCase().includes(lowerQuery))) match = true;
    if (prof.interests.some(i => i.toLowerCase().includes(lowerQuery))) match = true;
    if (prof.skills.some(s => s.toLowerCase().includes(lowerQuery))) match = true;
    
    if (match) {
      results.push(prof);
    }
  }
  
  await logSystem('TOOL', `searchMemory() -> Found ${results.length} profile matches for query "${query}"`);
  return results;
}

export async function updateProfile(userId, updates, userName = 'Unknown') {
  let profile = await getUserProfile(userId);
  if (!profile) {
    profile = await updateUserProfile(userId, { name: userName, ...updates });
  } else {
    profile = await updateUserProfile(userId, updates);
  }
  await logSystem('TOOL', `updateProfile() -> Updated profile for user ${userId}`);
  return { success: true, profile };
}

// ------------------------------------------------------------------------------
// 2. Telegram Moderation Tools
// ------------------------------------------------------------------------------
export async function deleteMessages(chatId, messageIds) {
  if (!botInstance) return { success: false, error: 'Bot not initialized' };
  try {
    for (const msgId of messageIds) {
      await botInstance.api.deleteMessage(chatId, msgId);
    }
    await logSystem('TOOL', `deleteMessages() -> Deleted messages: ${messageIds.join(', ')} in chat ${chatId}`);
    return { success: true };
  } catch (error) {
    await logSystem('TOOL', `deleteMessages() failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function banUser(chatId, userId) {
  if (!botInstance) return { success: false, error: 'Bot not initialized' };
  try {
    await botInstance.api.banChatMember(chatId, userId);
    await logSystem('TOOL', `banUser() -> Banned user ${userId} in chat ${chatId}`);
    return { success: true };
  } catch (error) {
    await logSystem('TOOL', `banUser() failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function muteUser(chatId, userId, durationMinutes = 60) {
  if (!botInstance) return { success: false, error: 'Bot not initialized' };
  try {
    const untilDate = Math.floor(Date.now() / 1000) + (durationMinutes * 60);
    await botInstance.api.restrictChatMember(chatId, userId, {
      permissions: {
        can_send_messages: false,
        can_send_media_messages: false,
        can_send_polls: false,
        can_send_other_messages: false,
        can_add_web_page_previews: false,
      },
      until_date: untilDate
    });
    await logSystem('TOOL', `muteUser() -> Muted user ${userId} in chat ${chatId} for ${durationMinutes} minutes`);
    return { success: true };
  } catch (error) {
    await logSystem('TOOL', `muteUser() failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function pinMessage(chatId, messageId) {
  if (!botInstance) return { success: false, error: 'Bot not initialized' };
  try {
    await botInstance.api.pinChatMessage(chatId, messageId);
    await logSystem('TOOL', `pinMessage() -> Pinned message ${messageId} in chat ${chatId}`);
    return { success: true };
  } catch (error) {
    await logSystem('TOOL', `pinMessage() failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

// Memory tracking of warnings per user
const userWarnings = {};

export async function warnUser(chatId, userId, reason = 'No reason provided') {
  if (!userWarnings[userId]) {
    userWarnings[userId] = 0;
  }
  userWarnings[userId]++;
  
  await logSystem('TOOL', `warnUser() -> Warned user ${userId}. Total warnings: ${userWarnings[userId]}. Reason: ${reason}`);
  
  // Auto-mute on 3 warnings
  if (userWarnings[userId] >= 3) {
    await muteUser(chatId, userId, 1440); // Mute for 24 hours
    userWarnings[userId] = 0; // Reset
    return { success: true, warningCount: 3, actionTaken: 'MUTED_24H' };
  }
  
  return { success: true, warningCount: userWarnings[userId], actionTaken: 'WARNED' };
}

// ------------------------------------------------------------------------------
// 3. Web Search Tools
// ------------------------------------------------------------------------------
export async function webSearch(query) {
  await logSystem('TOOL', `webSearch() -> Searching for: "${query}"`);
  try {
    // Standard mock implementation/fallback or a simple DuckDuckGo HTML fetch
    const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
    if (!response.ok) throw new Error('DuckDuckGo search failed');
    const html = await response.text();
    
    // Quick regex scraping of DuckDuckGo results
    const results = [];
    const resultRegex = /<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = resultRegex.exec(html)) !== null && results.length < 5) {
      const text = match[1].replace(/<[^>]*>/g, '').trim();
      results.push(text);
    }

    if (results.length === 0) {
      return { success: true, results: ["No web snippets found. Try another query."] };
    }
    
    return { success: true, results };
  } catch (error) {
    await logSystem('TOOL', `webSearch() failed: ${error.message}`);
    // Return standard fallback message
    return { success: false, error: error.message, fallback: `Google Search for "${query}" is temporarily offline.` };
  }
}

// ------------------------------------------------------------------------------
// 4. Vision Tools
// ------------------------------------------------------------------------------
export async function analyzeImage(fileId) {
  if (!botInstance) return { success: false, error: 'Bot not initialized' };
  await logSystem('TOOL', `analyzeImage() -> Processing file ${fileId}`);
  
  try {
    // 1. Download file path from Telegram
    const file = await botInstance.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    // 2. Fetch and convert to Base64
    const res = await fetch(fileUrl);
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    
    // 3. Make request to Gemini API via key pool
    const contents = [{
      parts: [
        { text: "Analyze this image in detail. Identify objects, text, and the overall context." },
        { inlineData: { mimeType: "image/jpeg", data: base64 } }
      ]
    }];
    
    const description = await callGeminiWithPool('gemini-1.5-flash', contents);
    
    await logSystem('TOOL', 'analyzeImage() -> Image analysis completed.');
    return { success: true, description };
  } catch (error) {
    await logSystem('TOOL', `analyzeImage() failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}
