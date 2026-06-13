import { logSystem, getUserProfile, updateUserProfile, getAllUserProfiles, getRecentMessages } from './database.js';
import { generateText } from './router.js';
import { addTraceStep } from './trace.js';
import fs from 'fs';
import path from 'path';
import { InputFile } from 'grammy';

// Global variables for Telegram Bot Instance
let botInstance = null;

export function setBotInstance(bot) {
  botInstance = bot;
}

// ------------------------------------------------------------------------------
// 1. Memory Tools
// ------------------------------------------------------------------------------
export async function remember(userId, fact, userName = 'Unknown') {
  addTraceStep('TOOL', 'pending', `Running remember() for user ${userName} (${userId})`);
  let profile = await getUserProfile(userId);
  if (!profile) {
    profile = await updateUserProfile(userId, { name: userName, facts: [fact] });
  } else {
    const facts = [...profile.facts, fact];
    profile = await updateUserProfile(userId, { facts });
  }
  await logSystem('TOOL', `remember() -> Added fact for user ${userId}: "${fact}"`);
  addTraceStep('TOOL', 'success', `Fact remembered successfully`);
  return { success: true, profile };
}

export async function forget(userId, factIndex) {
  addTraceStep('TOOL', 'pending', `Running forget() index ${factIndex} for user ${userId}`);
  const profile = await getUserProfile(userId);
  if (!profile || !profile.facts[factIndex]) {
    addTraceStep('TOOL', 'failed', `Fact index ${factIndex} not found`);
    return { success: false, error: 'Fact index not found' };
  }
  const removed = profile.facts.splice(factIndex, 1);
  await updateUserProfile(userId, { facts: profile.facts });
  await logSystem('TOOL', `forget() -> Removed fact for user ${userId}: "${removed[0]}"`);
  addTraceStep('TOOL', 'success', `Fact forgotten successfully`);
  return { success: true, profile };
}

export async function searchMemory(query) {
  addTraceStep('TOOL', 'pending', `Running searchMemory() for query: "${query}"`);
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
  addTraceStep('TOOL', 'success', `Found ${results.length} user matches in SQLite database`);
  return results;
}

export async function updateProfile(userId, updates, userName = 'Unknown') {
  addTraceStep('TOOL', 'pending', `Running updateProfile() for user ${userName} (${userId})`);
  let profile = await getUserProfile(userId);
  if (!profile) {
    profile = await updateUserProfile(userId, { name: userName, ...updates });
  } else {
    profile = await updateUserProfile(userId, updates);
  }
  await logSystem('TOOL', `updateProfile() -> Updated profile for user ${userId}`);
  addTraceStep('TOOL', 'success', `User profile updated inside database`);
  return { success: true, profile };
}

// ------------------------------------------------------------------------------
// 2. Telegram Moderation Tools
// ------------------------------------------------------------------------------
export async function deleteMessages(chatId, messageIds) {
  addTraceStep('TOOL', 'pending', `Running deleteMessages() in chat ${chatId}`);
  if (!botInstance) return { success: false, error: 'Bot not initialized' };
  try {
    for (const msgId of messageIds) {
      await botInstance.api.deleteMessage(chatId, msgId);
    }
    await logSystem('TOOL', `deleteMessages() -> Deleted messages: ${messageIds.join(', ')} in chat ${chatId}`);
    addTraceStep('TOOL', 'success', `Deleted messages: ${messageIds.join(', ')}`);
    return { success: true };
  } catch (error) {
    await logSystem('TOOL', `deleteMessages() failed: ${error.message}`);
    addTraceStep('TOOL', 'failed', `deleteMessages() failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function banUser(chatId, userId) {
  addTraceStep('TOOL', 'pending', `Running banUser() for user ${userId} in chat ${chatId}`);
  if (!botInstance) return { success: false, error: 'Bot not initialized' };
  try {
    await botInstance.api.banChatMember(chatId, userId);
    await logSystem('TOOL', `banUser() -> Banned user ${userId} in chat ${chatId}`);
    addTraceStep('TOOL', 'success', `Banned user ${userId} successfully`);
    return { success: true };
  } catch (error) {
    await logSystem('TOOL', `banUser() failed: ${error.message}`);
    addTraceStep('TOOL', 'failed', `banUser() failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function muteUser(chatId, userId, durationMinutes = 60) {
  addTraceStep('TOOL', 'pending', `Running muteUser() for user ${userId} in chat ${chatId}`);
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
    addTraceStep('TOOL', 'success', `Muted user ${userId} for ${durationMinutes} minutes`);
    return { success: true };
  } catch (error) {
    await logSystem('TOOL', `muteUser() failed: ${error.message}`);
    addTraceStep('TOOL', 'failed', `muteUser() failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

export async function pinMessage(chatId, messageId) {
  addTraceStep('TOOL', 'pending', `Running pinMessage() id ${messageId} in chat ${chatId}`);
  if (!botInstance) return { success: false, error: 'Bot not initialized' };
  try {
    await botInstance.api.pinChatMessage(chatId, messageId);
    await logSystem('TOOL', `pinMessage() -> Pinned message ${messageId} in chat ${chatId}`);
    addTraceStep('TOOL', 'success', `Pinned message successfully`);
    return { success: true };
  } catch (error) {
    await logSystem('TOOL', `pinMessage() failed: ${error.message}`);
    addTraceStep('TOOL', 'failed', `pinMessage() failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}

const userWarnings = {};

export async function warnUser(chatId, userId, reason = 'No reason provided') {
  addTraceStep('TOOL', 'pending', `Running warnUser() for user ${userId}`);
  if (!userWarnings[userId]) {
    userWarnings[userId] = 0;
  }
  userWarnings[userId]++;
  
  await logSystem('TOOL', `warnUser() -> Warned user ${userId}. Total warnings: ${userWarnings[userId]}. Reason: ${reason}`);
  addTraceStep('TOOL', 'success', `Warned user. Total warnings: ${userWarnings[userId]}`);
  
  if (userWarnings[userId] >= 3) {
    await muteUser(chatId, userId, 1440);
    userWarnings[userId] = 0;
    return { success: true, warningCount: 3, actionTaken: 'MUTED_24H' };
  }
  
  return { success: true, warningCount: userWarnings[userId], actionTaken: 'WARNED' };
}

// ------------------------------------------------------------------------------
// 3. Web Search & Map Grounding Tools
// ------------------------------------------------------------------------------
export async function webSearch(query) {
  await logSystem('TOOL', `webSearch() -> Searching for: "${query}"`);
  addTraceStep('TOOL', 'pending', `Executing Web Search for: "${query}"`);
  
  try {
    // Attempt Google Search Grounding via Gemini 2.0/2.5 API
    const searchPrompt = `Search and summarize the latest information on: "${query}". Provide a concise list of bullet points with key facts.`;
    const searchSummary = await generateText({
      forceModel: 'gemini-3.1-flash-lite', // Stable lite model with active quota
      prompt: searchPrompt,
      grounding: 'search'
    });
    
    await logSystem('TOOL', `webSearch() -> Gemini Search Grounding completed.`);
    addTraceStep('TOOL', 'success', `Google Search Grounding returned results`);
    return { success: true, results: [searchSummary] };
  } catch (error) {
    await logSystem('TOOL', `Google Search Grounding failed: ${error.message}. Falling back to DuckDuckGo.`);
    addTraceStep('TOOL', 'pending', `Google Search Grounding failed, falling back to DuckDuckGo scraping`);
    
    // Fallback to DuckDuckGo HTML scraping
    try {
      const response = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`);
      if (!response.ok) throw new Error('DuckDuckGo search failed');
      const html = await response.text();
      
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
      
      addTraceStep('TOOL', 'success', `DuckDuckGo scraper returned ${results.length} results`);
      return { success: true, results };
    } catch (fallbackError) {
      await logSystem('TOOL', `DuckDuckGo fallback failed: ${fallbackError.message}`);
      addTraceStep('TOOL', 'failed', `Web Search failed completely: ${fallbackError.message}`);
      return { success: false, error: fallbackError.message };
    }
  }
}

// ------------------------------------------------------------------------------
// 4. Vision Tools
// ------------------------------------------------------------------------------
export async function analyzeImage(fileId) {
  if (!botInstance) return { success: false, error: 'Bot not initialized' };
  await logSystem('TOOL', `analyzeImage() -> Processing file ${fileId}`);
  addTraceStep('TOOL', 'pending', `Analyzing image file ID: ${fileId}`);
  
  try {
    const file = await botInstance.api.getFile(fileId);
    const fileUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${file.file_path}`;
    
    const res = await fetch(fileUrl);
    const buffer = await res.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');
    
    const contents = [{
      role: 'user',
      parts: [
        { text: "Analyze this image in detail. Identify objects, text, and the overall context." },
        { inlineData: { mimeType: "image/jpeg", data: base64 } }
      ]
    }];
    
    // Run vision on gemini-3.1-flash-lite (high capacity)
    const description = await generateText({
      forceModel: 'gemini-3.1-flash-lite',
      contents: contents
    });
    
    await logSystem('TOOL', 'analyzeImage() -> Image analysis completed.');
    addTraceStep('TOOL', 'success', `Image analysis OCR completed`);
    return { success: true, description };
  } catch (error) {
    await logSystem('TOOL', `analyzeImage() failed: ${error.message}`);
    addTraceStep('TOOL', 'failed', `Image analysis failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}



// ------------------------------------------------------------------------------
// 6. Discussion Summarization Tool (Gemini 3 Flash Live)
// ------------------------------------------------------------------------------
export async function followDiscussion(chatId, limit = 100) {
  await logSystem('TOOL', `followDiscussion() -> Ingesting recent chat logs for chat ${chatId}`);
  addTraceStep('TOOL', 'pending', `Fetching last ${limit} messages from rolling buffer`);

  try {
    const messages = await getRecentMessages(chatId, limit);
    if (messages.length === 0) {
      addTraceStep('TOOL', 'success', 'No messages found to summarize');
      return { success: true, summary: "هیچ پیام اخیری در این گروه یافت نشد." };
    }

    // Sort chronologically (rolling buffer stores newest first, so we reverse it)
    const transcript = messages
      .reverse()
      .map(msg => `[${msg.user_fullname}]: ${msg.content}`)
      .join('\n');

    addTraceStep('TOOL', 'pending', `Calling Gemini 3 Flash Live API (WebSocket) to summarize`);

    const summaryPrompt = `
You are the Group Discussion Summarizer. Below is a transcript of the last ${messages.length} messages in this Telegram group.
Analyze the conversation, extract the main topics, summarize the main arguments or consensus, and highlight any pending questions or issues.

Group Transcript:
${transcript}

Output a concise summary/digest in Persian (max 4 sentences) outlining:
1. What the current discussion is about.
2. Who said/demanded what.
3. What the bot is expected to respond to or provide its opinion on.
`;

    // Call only the gemini-3-flash-live model for this tool
    const summary = await generateText({
      forceModel: 'gemini-3-flash-live',
      prompt: summaryPrompt,
      systemInstruction: 'You are an objective group observer. Output a concise summary in Persian.'
    });

    await logSystem('TOOL', `followDiscussion() -> Summarization successfully completed.`);
    addTraceStep('TOOL', 'success', `Discussion summarized via Gemini 3 Flash Live`);

    return { success: true, summary };
  } catch (error) {
    await logSystem('TOOL', `followDiscussion() failed: ${error.message}`);
    addTraceStep('TOOL', 'failed', `followDiscussion failed: ${error.message}`);
    // Return success: false to let the planner handle the failure
    return { success: false, error: error.message };
  }
}
