import { logSystem, registerModel, clearRegisteredModels } from './database.js';
import { generateText } from './router.js';
import { addTraceStep } from './trace.js';

export async function discoverFreeModels() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || apiKey.startsWith('your_')) {
    await logSystem('DISCOVERY', 'Skipping OpenRouter discovery: No valid API key provided.');
    return [];
  }

  await logSystem('DISCOVERY', 'Starting OpenRouter free models discovery...');
  addTraceStep('DISCOVERY', 'pending', 'Fetching raw list of models from OpenRouter API');

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

    await logSystem('DISCOVERY', `Found ${freeModels.length} free models on OpenRouter. Handing list to Gemma for evaluation...`);
    addTraceStep('DISCOVERY', 'pending', `Gemma evaluating ${freeModels.length} free models`);

    // 3. Ask Gemma to analyze and select the top 8 models for our bot tasks
    const simplifiedList = freeModels.map(m => ({
      id: m.id,
      name: m.name,
      context_length: m.context_length,
      description: (m.description || '').substring(0, 150)
    }));

    const evaluationPrompt = `
You are the Group Observer and Discovery Agent. Below is a list of free models currently available on OpenRouter:
${JSON.stringify(simplifiedList, null, 2)}

Analyze this list. Filter out legacy, deprecated, or unstable test models. Select up to 8 of the best active models suitable for general chat, logical tasks, or tool execution.
Determine if they likely support tool-calling based on their model type (e.g. Llama-3, Gemma-2, Qwen-2, Mistral).

Your output MUST be a valid JSON array of objects. Do not include markdown codeblocks (like \`\`\`json). Output raw JSON only.
Match this schema for each object in the array:
{
  "model_id": "string (the exact id from the list)",
  "name": "string (name from list)",
  "context_length": number,
  "supports_tools": number (1 if it supports tool calling/functions, otherwise 0)
}
`;

    let selectedModels = [];
    try {
      const gemmaEvaluation = await generateText({
        tier: 'GEMMA_PLANNER',
        prompt: evaluationPrompt,
        systemInstruction: 'You are a precise technical evaluator. Output raw JSON arrays only.',
        jsonMode: true
      });

      let cleaned = gemmaEvaluation.trim();
      const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        cleaned = arrayMatch[0];
      } else if (cleaned.startsWith('```')) {
        cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
      }
      selectedModels = JSON.parse(cleaned);
      await logSystem('DISCOVERY', `Gemma successfully selected and ranked ${selectedModels.length} models.`);
    } catch (gemmaError) {
      await logSystem('DISCOVERY', `Gemma evaluation failed: ${gemmaError.message}. Falling back to default slicing.`);
      // Slicing fallback
      selectedModels = freeModels.slice(0, 8).map(m => ({
        model_id: m.id,
        name: m.name,
        context_length: m.context_length || 4096,
        supports_tools: m.id.includes('llama-3') || m.id.includes('gemma-2') ? 1 : 0
      }));
    }

    addTraceStep('DISCOVERY', 'pending', `Benchmarking latency for ${selectedModels.length} selected models`);
    await clearRegisteredModels();

    const discovered = [];

    // 4. Benchmark each selected model
    for (const model of selectedModels) {
      await logSystem('DISCOVERY', `Testing model latency: ${model.model_id}`);
      
      const startTime = Date.now();
      let success = false;
      let latency = 9999;

      try {
        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: model.model_id,
            messages: [{ role: 'user', content: 'Ping. Reply with "Pong" only.' }],
            temperature: 0.1,
            max_tokens: 5
          })
        });

        if (response.ok) {
          const result = await response.json();
          const reply = result?.choices?.[0]?.message?.content;
          if (reply && reply.toLowerCase().includes('pong')) {
            success = true;
            latency = Date.now() - startTime;
          }
        } else {
          const errText = await response.text();
          let parsedErr = errText;
          try {
            const parsed = JSON.parse(errText);
            if (parsed.error && parsed.error.message) {
              parsedErr = parsed.error.message;
            }
          } catch (e) {}
          await logSystem('DISCOVERY', `OpenRouter API error (${response.status}) for ${model.model_id}: ${parsedErr}`);
        }
      } catch (err) {
        await logSystem('DISCOVERY', `Error testing ${model.model_id}: ${err.message}`);
      }

      if (success) {
        // Scoring formula
        const contextScore = Math.min(model.context_length / 16384, 2);
        const latencyScore = Math.max(10 - (latency / 1000), 0);
        const toolScore = model.supports_tools ? 3 : 0;
        const score = (contextScore * 2) + latencyScore + toolScore;

        const modelEntry = {
          model_id: model.model_id,
          name: model.name || model.model_id,
          context_length: model.context_length || 4096,
          supports_tools: model.supports_tools || 0,
          latency: latency,
          reliability: 1.0,
          score: parseFloat(score.toFixed(2))
        };

        await registerModel(modelEntry);
        discovered.push(modelEntry);
        await logSystem('DISCOVERY', `Registered: ${model.model_id} | Score: ${modelEntry.score} | Latency: ${latency}ms`);
      } else {
        await logSystem('DISCOVERY', `Skipping ${model.model_id} (failed benchmark test)`);
      }
    }

    await logSystem('DISCOVERY', `OpenRouter discovery finished. Registered ${discovered.length} active models.`);
    addTraceStep('DISCOVERY', 'success', `OpenRouter discovery completed. Registered ${discovered.length} active models.`);
    return discovered;

  } catch (error) {
    await logSystem('DISCOVERY', `Discovery job failed: ${error.message}`);
    addTraceStep('DISCOVERY', 'failed', `Discovery failed: ${error.message}`);
    return [];
  }
}

// Start discovery interval (runs every 24 hours)
export function startDiscoverySchedule() {
  setTimeout(async () => {
    try {
      await discoverFreeModels();
    } catch (err) {
      console.error('Initial model discovery failed:', err);
    }
  }, 10000);

  const INTERVAL_24H = 24 * 60 * 60 * 1000;
  setInterval(async () => {
    try {
      await discoverFreeModels();
    } catch (err) {
      console.error('Scheduled model discovery failed:', err);
    }
  }, INTERVAL_24H);
}
