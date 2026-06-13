import dotenv from 'dotenv';
import { logSystem } from './database.js';

dotenv.config();

// Default Models Map - can be adjusted via env
const MODEL_MAPPING = {
  LIVE: 'gemini-2.0-flash', // Live session model
  FLASH: 'gemini-2.0-flash', // Analysis model
  LITE: 'gemini-2.0-flash-lite', // Casual chat model
  PLANNER: 'google/gemma-2-27b-it' // Gemma Planner
};

/**
 * Call Gemini API directly using native fetch
 */
async function callGeminiAPI(modelName, contents, systemInstruction = '', apiKey) {
  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('Invalid Gemini API Key');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  
  const payload = {
    contents: contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2048,
    }
  };

  if (systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API Error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textContent = data.candidates?.[0]?.content?.parts?.[0]?.text;
  
  if (!textContent) {
    throw new Error('Empty response from Gemini API');
  }

  return textContent;
}

/**
 * Call Gemini API using pooled Active and Backup keys
 */
export async function callGeminiWithPool(modelName, contents, systemInstruction = '') {
  // Collect active keys
  const activeKeys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
  ].filter(key => key && !key.startsWith('your_'));

  // Collect backup keys
  const backupKeys = [
    process.env.GEMINI_API_KEY_BACKUP_1,
    process.env.GEMINI_API_KEY_BACKUP_2
  ].filter(key => key && !key.startsWith('your_'));

  const totalKeys = activeKeys.length + backupKeys.length;
  if (totalKeys === 0) {
    throw new Error('No valid Gemini API keys found in active or backup pool.');
  }

  let lastError = null;

  // 1. Try active keys
  for (let i = 0; i < activeKeys.length; i++) {
    const key = activeKeys[i];
    try {
      return await callGeminiAPI(modelName, contents, systemInstruction, key);
    } catch (err) {
      await logSystem('ROUTER', `Active Key ${i + 1} failed for ${modelName}: ${err.message}. Trying next key.`);
      lastError = err;
    }
  }

  // 2. Try backup keys
  for (let i = 0; i < backupKeys.length; i++) {
    const key = backupKeys[i];
    try {
      await logSystem('ROUTER', `All active keys failed. Attempting Backup Key ${i + 1} for ${modelName}.`);
      return await callGeminiAPI(modelName, contents, systemInstruction, key);
    } catch (err) {
      await logSystem('ROUTER', `Backup Key ${i + 1} failed for ${modelName}: ${err.message}.`);
      lastError = err;
    }
  }

  throw new Error(`All keys in pool failed. Last error: ${lastError.message}`);
}

/**
 * Call OpenRouter API directly using native fetch
 */
async function callOpenRouterAPI(modelName, messages, apiKey) {
  if (!apiKey || apiKey.startsWith('your_')) {
    throw new Error('Invalid OpenRouter API Key');
  }

  const url = 'https://openrouter.ai/api/v1/chat/completions';
  
  const payload = {
    model: modelName,
    messages: messages,
    temperature: 0.7
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/ImFardad/telegram-agent-bot',
      'X-Title': 'Telegram Agent Bot'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenRouter API Error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const textContent = data.choices?.[0]?.message?.content;

  if (!textContent) {
    throw new Error('Empty response from OpenRouter API');
  }

  return textContent;
}

/**
 * Main Router endpoint for text generation
 */
export async function generateText({ tier, prompt, systemInstruction = '', history = [], forceModel = null }) {
  const modelName = forceModel || MODEL_MAPPING[tier] || MODEL_MAPPING.LITE;
  
  // Prepare Gemini context format
  const contents = [];
  
  // Add history if present
  for (const h of history) {
    contents.push({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }]
    });
  }
  
  // Add current prompt
  contents.push({
    role: 'user',
    parts: [{ text: prompt }]
  });

  // Decide if we call OpenRouter (e.g. for Gemma or when forced OpenRouter)
  const isOpenRouterModel = modelName.includes('/') || tier === 'OPENROUTER';
  
  if (isOpenRouterModel) {
    const orApiKey = process.env.OPENROUTER_API_KEY;
    const formattedMessages = [];
    if (systemInstruction) {
      formattedMessages.push({ role: 'system', content: systemInstruction });
    }
    for (const h of history) {
      formattedMessages.push({ role: h.role, content: h.content });
    }
    formattedMessages.push({ role: 'user', content: prompt });

    try {
      await logSystem('ROUTER', `Routing request to OpenRouter model: ${modelName}`);
      return await callOpenRouterAPI(modelName, formattedMessages, orApiKey);
    } catch (error) {
      await logSystem('ROUTER', `OpenRouter failed: ${error.message}. Falling back to Gemini.`);
      // Fallback to Gemini
      return await callGeminiWithPool(MODEL_MAPPING.LITE, contents, systemInstruction);
    }
  } else {
    // Call Google Gemini directly via pooled key manager
    try {
      await logSystem('ROUTER', `Routing request to Gemini: ${modelName} (Tier: ${tier})`);
      return await callGeminiWithPool(modelName, contents, systemInstruction);
    } catch (error) {
      await logSystem('ROUTER', `Gemini Tier ${tier} failed: ${error.message}. Attempting fallback.`);
      
      // Fallback chain
      if (tier !== 'LITE') {
        try {
          await logSystem('ROUTER', `Attempting Lite fallback: ${MODEL_MAPPING.LITE}`);
          return await callGeminiWithPool(MODEL_MAPPING.LITE, contents, systemInstruction);
        } catch (fallbackError) {
          await logSystem('ROUTER', `Fallback failed: ${fallbackError.message}`);
        }
      }
      
      // Ultimate fallback: Try OpenRouter with a free model if key exists
      if (process.env.OPENROUTER_API_KEY && !process.env.OPENROUTER_API_KEY.startsWith('your_')) {
        try {
          const orApiKey = process.env.OPENROUTER_API_KEY;
          const freeModel = 'meta-llama/llama-3-8b-instruct:free';
          await logSystem('ROUTER', `Attempting OpenRouter Free fallback: ${freeModel}`);
          
          const formattedMessages = [];
          if (systemInstruction) {
            formattedMessages.push({ role: 'system', content: systemInstruction });
          }
          for (const h of history) {
            formattedMessages.push({ role: h.role, content: h.content });
          }
          formattedMessages.push({ role: 'user', content: prompt });
          
          return await callOpenRouterAPI(freeModel, formattedMessages, orApiKey);
        } catch (orError) {
          throw new Error(`All routing tiers failed. Last error: ${orError.message}`);
        }
      }
      
      throw error;
    }
  }
}

