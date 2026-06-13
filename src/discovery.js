import { logSystem, registerModel, clearRegisteredModels } from './database.js';

export async function discoverFreeModels() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.startsWith('your_')) {
    await logSystem('DISCOVERY', 'Skipping OpenRouter discovery: No valid API key provided.');
    return [];
  }

  await logSystem('DISCOVERY', 'Starting OpenRouter free models discovery...');

  try {
    // 1. Fetch all models from OpenRouter
    const res = await fetch('https://openrouter.ai/api/v1/models');
    if (!res.ok) throw new Error(`Failed to fetch models: ${res.statusText}`);
    const data = await res.json();
    
    if (!data.data || !Array.isArray(data.data)) {
      throw new Error('Invalid response format from OpenRouter');
    }

    // 2. Filter for free models
    const freeModels = data.data.filter(model => {
      const isFreePrice = parseFloat(model.pricing?.prompt || '1') === 0 && 
                          parseFloat(model.pricing?.completion || '1') === 0;
      const isFreeInId = model.id.endsWith(':free');
      return isFreePrice || isFreeInId;
    });

    await logSystem('DISCOVERY', `Found ${freeModels.length} free models on OpenRouter. Benchmarking top models...`);

    // We will clear registry and rebuild it with fresh test results
    await clearRegisteredModels();

    // Limit to testing the top 10 models to prevent hitting rate limits during testing
    const modelsToTest = freeModels.slice(0, 10);
    const discovered = [];

    for (const model of modelsToTest) {
      await logSystem('DISCOVERY', `Testing model: ${model.id}`);
      
      const startTime = Date.now();
      let success = false;
      let latency = 9999;
      let supportsTools = 0;

      // Check tool calling support from description or metadata
      const desc = (model.description || '').toLowerCase();
      if (desc.includes('tool calling') || desc.includes('function call') || desc.includes('function-calling') || model.id.includes('llama-3') || model.id.includes('gemma-2')) {
        supportsTools = 1;
      }

      try {
        // Quick benchmark API call
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model.id,
            messages: [{ role: 'user', content: 'Ping. Reply with "Pong" only.' }],
            temperature: 0.1,
            max_tokens: 5
          })
        });

        if (response.ok) {
          const result = await response.json();
          const reply = result.choices?.[0]?.message?.content;
          if (reply && reply.toLowerCase().includes('pong')) {
            success = true;
            latency = Date.now() - startTime;
          }
        }
      } catch (err) {
        logSystem('DISCOVERY', `Error testing ${model.id}: ${err.message}`);
      }

      if (success) {
        // Scoring calculation: Higher context and tools, lower latency
        const contextScore = Math.min(model.context_length / 16384, 2); // Cap context length weight
        const latencyScore = Math.max(10 - (latency / 1000), 0); // 0 to 10 points (lower latency is better)
        const toolScore = supportsTools ? 3 : 0;
        
        // Final Score
        const score = (contextScore * 2) + latencyScore + toolScore;

        const modelEntry = {
          model_id: model.id,
          name: model.name || model.id,
          context_length: model.context_length || 4096,
          supports_tools: supportsTools,
          latency: latency,
          reliability: 1.0,
          score: parseFloat(score.toFixed(2))
        };

        await registerModel(modelEntry);
        discovered.push(modelEntry);
        await logSystem('DISCOVERY', `Registered: ${model.id} | Score: ${modelEntry.score} | Latency: ${latency}ms`);
      } else {
        await logSystem('DISCOVERY', `Skipping ${model.id} (failed ping benchmark)`);
      }
    }

    await logSystem('DISCOVERY', `OpenRouter discovery finished. Registered ${discovered.length} active models.`);
    return discovered;

  } catch (error) {
    await logSystem('DISCOVERY', `Discovery job failed: ${error.message}`);
    return [];
  }
}

// Start discovery interval (runs every 24 hours)
export function startDiscoverySchedule() {
  // Trigger initial discovery on startup in 10 seconds to not block main thread
  setTimeout(async () => {
    try {
      await discoverFreeModels();
    } catch (err) {
      console.error('Initial model discovery failed:', err);
    }
  }, 10000);

  // Set 24 hour interval
  const INTERVAL_24H = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      await discoverFreeModels();
    } catch (err) {
      console.error('Scheduled model discovery failed:', err);
    }
  }, INTERVAL_24H);
}
