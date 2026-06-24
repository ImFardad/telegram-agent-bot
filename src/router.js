import dotenv from 'dotenv';
import { logSystem, incrementModelUsage } from './database.js';
import { addTraceStep } from './trace.js';

dotenv.config();

function cleanErrorMessage(msg) {
  try {
    const jsonMatch = msg.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed.error && parsed.error.message) {
        return parsed.error.message;
      }
    }
  } catch (e) {
    // Ignore JSON parsing errors
  }
  
  if (msg.length > 120) {
    return msg.substring(0, 120) + '...';
  }
  return msg;
}

function isQuotaError(err) {
  const msg = err.message.toLowerCase();
  return msg.includes('429') || msg.includes('quota') || msg.includes('rate limit');
}

// Fallback chains for different tiers
const FALLBACK_CHAINS = {
  GEMMA_PLANNER: ['gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemini-3.1-flash-lite'],
  GEMMA: ['gemma-4-26b-a4b-it', 'gemma-4-31b-it', 'gemini-3.1-flash-lite'],
  LITE: ['gemini-3.1-flash-lite', 'gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemma-4-31b-it'],
  FLASH: ['gemini-3.5-flash', 'gemini-3.1-flash-lite', 'gemma-4-31b-it', 'gemini-3-flash', 'gemini-2.5-flash'],
  LIVE_DIGEST: ['gemini-3-flash-live']
};

// Global key status tracker
const keyHealth = {
  active: [
    { name: 'GEMINI_API_KEY_1', status: 'UNKNOWN', errorCount: 0, lastUsed: 0 },
    { name: 'GEMINI_API_KEY_2', status: 'UNKNOWN', errorCount: 0, lastUsed: 0 },
    { name: 'GEMINI_API_KEY_3', status: 'UNKNOWN', errorCount: 0, lastUsed: 0 }
  ],
  backup: [
    { name: 'GEMINI_API_KEY_BACKUP_1', status: 'UNKNOWN', errorCount: 0, lastUsed: 0 },
    { name: 'GEMINI_API_KEY_BACKUP_2', status: 'UNKNOWN', errorCount: 0, lastUsed: 0 }
  ]
};

// Index tracking for per-model rotation
const activeKeyIndices = {};
const backupKeyIndices = {};

/**
 * Returns the status of the keys in the pool for the dashboard
 */
export function getKeyStatus() {
  const getPoolStatus = (pool) => {
    return pool.map(k => {
      const keyVal = process.env[k.name];
      const configured = !!keyVal && !keyVal.startsWith('your_');
      return {
        name: k.name,
        configured: configured,
        status: configured ? k.status : 'UNCONFIGURED',
        errorCount: k.errorCount,
        lastUsed: k.lastUsed ? new Date(k.lastUsed).toLocaleTimeString() : 'NEVER'
      };
    });
  };

  return {
    active: getPoolStatus(keyHealth.active),
    backup: getPoolStatus(keyHealth.backup)
  };
}

/**
 * Call Gemini API using a specific model and key
 */
async function callGeminiAPI(modelName, contents, systemInstruction = '', apiKey, grounding = null, jsonMode = false) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`;
  
  const payload = {
    contents: contents,
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 8192,
    }
  };

  if (jsonMode) {
    payload.generationConfig.responseMimeType = 'application/json';
  }

  if (systemInstruction) {
    payload.systemInstruction = {
      parts: [{ text: systemInstruction }]
    };
  }

  // Handle Search Grounding parameters if requested
  if (grounding === 'search') {
    payload.tools = [{ googleSearch: {} }];
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`API Error (${response.status}): ${errText}`);
  }

  const data = await response.json();
  const candidate = data.candidates?.[0];
  let textContent = '';
  
  if (candidate && candidate.content && Array.isArray(candidate.content.parts)) {
    // Filter out parts that have thought: true
    const nonThoughtParts = candidate.content.parts.filter(part => !part.thought);
    if (nonThoughtParts.length > 0) {
      textContent = nonThoughtParts.map(part => part.text || '').join('');
    } else {
      textContent = candidate.content.parts[0]?.text || '';
    }
  }
  
  if (!textContent) {
    throw new Error('Empty response from Gemini API');
  }

  return textContent;
}

/**
 * Call Gemini Live API via WebSocket (BidiGenerateContent)
 */
async function callGeminiLiveAPI(prompt, systemInstruction = '', apiKey) {
  if (typeof WebSocket === 'undefined') {
    throw new Error('WebSocket is not defined. Please run Node.js with --experimental-websocket flag.');
  }

  const modelName = 'models/gemini-3-flash-live';
  const url = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${apiKey}`;
  
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let fullText = '';
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        ws.close();
        reject(new Error('Live API WebSocket connection timed out (15s).'));
      }
    }, 15000);

    ws.onopen = () => {
      const setupMsg = {
        setup: {
          model: modelName,
          generationConfig: {
            responseModalities: ['TEXT']
          }
        }
      };
      if (systemInstruction) {
        setupMsg.setup.systemInstruction = {
          parts: [{ text: systemInstruction }]
        };
      }
      ws.send(JSON.stringify(setupMsg));

      const contentMsg = {
        clientContent: {
          turns: [{
            role: 'user',
            parts: [{ text: prompt }]
          }],
          turnComplete: true
        }
      };
      ws.send(JSON.stringify(contentMsg));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.serverContent?.modelTurn?.parts) {
          for (const part of data.serverContent.modelTurn.parts) {
            if (part.text) {
              fullText += part.text;
            }
          }
        }
        
        if (data.serverContent?.turnComplete) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timeout);
            ws.close();
            resolve(fullText);
          }
        }
      } catch (err) {
        // Ignore parsing errors for other frame types
      }
    };

    ws.onerror = (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    };

    ws.onclose = (event) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        if (event.code !== 1000 && event.code !== 1005 && !fullText) {
          reject(new Error(`WebSocket closed with code ${event.code}. Reason: ${event.reason || 'Unknown'}`));
        } else {
          resolve(fullText);
        }
      }
    };
  });
}

/**
 * Executes a call with automatic rotation and failover through Active and Backup pools
 */
async function executeWithPool(type, modelName, payloadData, systemInstruction = '', grounding = null, jsonMode = false) {
  let lastError = null;

  const poolConfigs = [
    { name: 'Active', keys: keyHealth.active, indices: activeKeyIndices },
    { name: 'Backup', keys: keyHealth.backup, indices: backupKeyIndices }
  ];

  for (const config of poolConfigs) {
    const validKeys = config.keys.filter(k => {
      const val = process.env[k.name];
      return val && !val.startsWith('your_');
    });

    if (validKeys.length === 0) continue;

    // Get current index for this model in this pool
    if (config.indices[modelName] === undefined) {
      config.indices[modelName] = 0;
    }

    let startIndex = config.indices[modelName] % validKeys.length;

    // Try all keys in this pool starting from the current one
    for (let i = 0; i < validKeys.length; i++) {
      const currentIdx = (startIndex + i) % validKeys.length;
      const keyObj = validKeys[currentIdx];
      const apiKey = process.env[keyObj.name];

      // Update the "sticky" index for this model
      config.indices[modelName] = currentIdx;

      let keyRetries = 0;
      const maxKeyRetries = 3;

      while (keyRetries < maxKeyRetries) {
        keyObj.lastUsed = Date.now();
        try {
          let result;
          if (type === 'LIVE') {
            result = await callGeminiLiveAPI(payloadData, systemInstruction, apiKey);
          } else {
            result = await callGeminiAPI(modelName, payloadData, systemInstruction, apiKey, grounding, jsonMode);
          }
          keyObj.status = 'HEALTHY';
          return result;
        } catch (err) {
          lastError = err;
          const cleanErr = cleanErrorMessage(err.message);

          if (isQuotaError(err)) {
            keyObj.status = 'QUOTA_EXHAUSTED';
            await logSystem('ROUTER', `${config.name} key ${keyObj.name} quota exhausted for ${modelName}. Waiting 10s before rotating...`);
            addTraceStep('ROUTER', 'failed', `${keyObj.name} quota exhausted. Waiting 10s.`);

            await new Promise(resolve => setTimeout(resolve, 10000));

            // Move sticky index to next for next attempt
            config.indices[modelName] = (currentIdx + 1) % validKeys.length;
            break; // Try next key in the pool
          } else {
            keyRetries++;
            keyObj.status = 'ERROR';
            keyObj.errorCount++;
            await logSystem('ROUTER', `${config.name} key ${keyObj.name} error for ${modelName} (Attempt ${keyRetries}/${maxKeyRetries}): ${cleanErr}`);

            if (keyRetries >= maxKeyRetries) {
              await logSystem('ROUTER', `${config.name} key ${keyObj.name} failed all ${maxKeyRetries} retries. Rotating to next key...`);
              config.indices[modelName] = (currentIdx + 1) % validKeys.length;
              break; // Try next key
            }
            // Small delay for non-quota errors before retry
            await new Promise(resolve => setTimeout(resolve, 1000));
          }
        }
      }
    }
  }

  throw new Error(`All keys in Active and Backup pools failed for ${modelName}. Last error: ${lastError?.message}`);
}

/**
 * Call OpenRouter API directly
 */
async function callOpenRouterAPI(modelName, messages, apiKey) {
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
  return data.choices?.[0]?.message?.content;
}

/**
 * Main Router endpoint for text generation (with fallback chains)
 */
export async function generateText({ tier, prompt, systemInstruction = '', history = [], forceModel = null, grounding = null, jsonMode = false, contents = null }) {
  // If forceModel is specified, we bypass fallback chains and call it directly
  const modelsToTry = forceModel ? [forceModel] : (FALLBACK_CHAINS[tier] || FALLBACK_CHAINS.LITE);
  
  addTraceStep('ROUTER', 'pending', `Starting routing for tier: ${tier || 'LITE'} (Options: ${modelsToTry.join(', ')})`);

  // Prepare Gemini context format
  let geminiContents = contents;
  if (!geminiContents) {
    geminiContents = [];
    for (const h of history) {
      geminiContents.push({
        role: h.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: h.content }]
      });
    }
    geminiContents.push({
      role: 'user',
      parts: [{ text: prompt }]
    });
  }

  let lastError = null;

  for (const model of modelsToTry) {
    // If it's an OpenRouter model identifier (contains a slash)
    const isOpenRouterModel = model.includes('/');
    
    let attempts = 0;
    const maxAttempts = 3;
    let success = false;
    let result;

    while (attempts < maxAttempts && !success) {
      attempts++;
      addTraceStep('ROUTER', 'pending', `Routing to model: ${model} (${isOpenRouterModel ? 'OpenRouter' : 'Google AI Studio'}) - Attempt ${attempts}/${maxAttempts}`);
      
      try {
        if (isOpenRouterModel) {
          const orApiKey = process.env.OPENROUTER_API_KEY;
          if (!orApiKey || orApiKey.startsWith('your_')) {
            throw new Error('OpenRouter API key is missing or unconfigured.');
          }

          const formattedMessages = [];
          if (systemInstruction) {
            formattedMessages.push({ role: 'system', content: systemInstruction });
          }
          for (const h of history) {
            formattedMessages.push({ role: h.role, content: h.content });
          }
          formattedMessages.push({ role: 'user', content: prompt });

          result = await callOpenRouterAPI(model, formattedMessages, orApiKey);
          addTraceStep('ROUTER', 'success', `Successfully generated text via OpenRouter: ${model}`);
          await incrementModelUsage(model);
          success = true;
        } else {
          // Run via Google API pool
          // executeWithPool now handles its own internal retries and rotation
          if (model === 'gemini-3-flash-live') {
            result = await executeWithPool('LIVE', model, prompt, systemInstruction, grounding, jsonMode);
          } else {
            result = await executeWithPool('TEXT', model, geminiContents, systemInstruction, grounding, jsonMode);
          }
          addTraceStep('ROUTER', 'success', `Successfully generated text via Gemini: ${model}`);
          await incrementModelUsage(model);
          success = true;
        }
      } catch (err) {
        lastError = err;
        await logSystem('ROUTER', `Model ${model} attempt ${attempts}/${maxAttempts} failed: ${err.message}`);

        // For Google models, if executeWithPool failed, it means all keys failed multiple times.
        // We probably shouldn't retry the same model again in the outer loop if it's not an OpenRouter model.
        if (!isOpenRouterModel) {
          break; // Break the while loop and try next model in fallback chain
        }

        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }

    if (success) {
      return result;
    } else {
      await logSystem('ROUTER', `Model ${model} in tier ${tier} failed all ${maxAttempts} attempts. Trying next fallback.`);
      addTraceStep('ROUTER', 'failed', `Model ${model} failed all ${maxAttempts} attempts: ${lastError.message.substring(0, 50)}...`);
    }
  }

  // Final ultimate fallback to OpenRouter free llama model if all else fails
  const orApiKey = process.env.OPENROUTER_API_KEY;
  if (orApiKey && !orApiKey.startsWith('your_')) {
    let attempts = 0;
    const maxAttempts = 3;
    const fallbackModel = 'meta-llama/llama-3-8b-instruct:free';
    
    while (attempts < maxAttempts) {
      attempts++;
      try {
        addTraceStep('ROUTER', 'pending', `Ultimate fallback attempt ${attempts}/${maxAttempts}: routing to OpenRouter free model: ${fallbackModel}`);
        const formattedMessages = [];
        if (systemInstruction) {
          formattedMessages.push({ role: 'system', content: systemInstruction });
        }
        for (const h of history) {
          formattedMessages.push({ role: h.role, content: h.content });
        }
        formattedMessages.push({ role: 'user', content: prompt });

        const result = await callOpenRouterAPI(fallbackModel, formattedMessages, orApiKey);
        addTraceStep('ROUTER', 'success', `Ultimate fallback success using: ${fallbackModel}`);
        await incrementModelUsage(fallbackModel);
        return result;
      } catch (fallbackErr) {
        lastError = fallbackErr;
        addTraceStep('ROUTER', 'failed', `Ultimate fallback attempt ${attempts}/${maxAttempts} failed: ${fallbackErr.message}`);
        if (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
    }
  }

  throw new Error(`All models in routing chain for tier ${tier} failed. Last error: ${lastError?.message}`);
}



export async function checkKeysHealthOnStartup() {
  await logSystem('ROUTER', 'Starting Google API keys startup health check...');
  
  const testKey = async (keyObj) => {
    const keyVal = process.env[keyObj.name];
    if (!keyVal || keyVal.startsWith('your_')) {
      keyObj.status = 'UNCONFIGURED';
      return;
    }

    try {
      // Test the key using gemma-4-31b-it as a cheap test request
      await callGeminiAPI(
        'gemma-4-31b-it',
        [{ role: 'user', parts: [{ text: 'Ping' }] }],
        '',
        keyVal
      );
      keyObj.status = 'HEALTHY';
      await logSystem('ROUTER', `Startup key check: ${keyObj.name} is HEALTHY ✅ (via Gemma 4 31B)`);
    } catch (err) {
      const cleanErr = cleanErrorMessage(err.message);
      keyObj.status = 'ERROR';
      keyObj.errorCount++;
      await logSystem('ROUTER', `Startup key check: ${keyObj.name} ❌ FAILED (Gemma 4 31B: ${cleanErr})`);
    }
  };

  const allKeys = [...keyHealth.active, ...keyHealth.backup];
  // Run tests in parallel
  await Promise.all(allKeys.map(k => testKey(k)));
  await logSystem('ROUTER', 'Google API keys health check completed.');

  // Select first healthy key and run a real test text generation
  const healthyKeys = allKeys.filter(k => k.status === 'HEALTHY');
  if (healthyKeys.length > 0) {
    const testKeyObj = healthyKeys[0];
    const apiKey = process.env[testKeyObj.name];
    try {
      await logSystem('ROUTER', `Running a live test message using healthy key: ${testKeyObj.name}...`);
      const response = await callGeminiAPI(
        'gemma-4-31b-it',
        [{ role: 'user', parts: [{ text: "Respond with exactly: 'Hello Fardad! API test successful'" }] }],
        '',
        apiKey
      );
      await logSystem('ROUTER', `API Live Test Response: "${response.trim()}"`);
    } catch (testErr) {
      const cleanErr = cleanErrorMessage(testErr.message);
      await logSystem('ROUTER', `API Live Test Failed: ${cleanErr}`);
    }
  } else {
    await logSystem('ROUTER', 'API Live Test Skipped: No healthy keys available.');
  }
}
