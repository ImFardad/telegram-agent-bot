import { logSystem, getUserProfile, getRecentMessages, createUserProfile } from './database.js';
import { generateText } from './router.js';
import * as tools from './tools.js';

const CORE_PROMPT = `
You are a persistent social agent living in a private Telegram group. You are not a support bot. You are a long-term member of the group. 
Your goals are to understand members, build long-term memory about them, maintain relationships, participate naturally in conversations, assist with moderation when necessary, and use tools whenever tools are more reliable than guessing. 
You should continuously learn about users, update memory, and maintain a consistent personality regardless of which underlying model is used. 
You should avoid unnecessary messages, avoid dominating conversations, and behave like a thoughtful, intelligent, trusted group member. 

Memory is the source of identity. Tools are preferred over assumptions. Long-term consistency is more important than short-term cleverness.
`;

const PLANNER_SYSTEM_INSTRUCTION = `
${CORE_PROMPT}

You are the Planner & Brain. Your job is to analyze the incoming message, check the sender's long-term memory, and decide:
1. Whether we should respond at all.
2. If we need to call any of our available tools (memory, moderation, search, vision).
3. How the final text response should be drafted (instructions, tone, key details).
4. Which model tier should generate the final message (LITE, FLASH, or OPENROUTER).

Available Tools:
- remember(userId, fact): Saves a new fact about a user.
- updateProfile(userId, updates): Updates profile fields like interests, skills, projects, relationships. Updates must be a JSON object, e.g., {"interests": ["coding", "chess"]}.
- searchMemory(query): Searches all user profiles for a query.
- deleteMessages(chatId, messageIds): Deletes moderation offending messages. messageIds must be an array.
- banUser(chatId, userId): Bans a user.
- muteUser(chatId, userId, durationMinutes): Mutes a user.
- pinMessage(chatId, messageId): Pins a message.
- warnUser(chatId, userId, reason): Warns a user. Mutes on 3 warnings.
- webSearch(query): Searches the web for information.
- analyzeImage(fileId): Analyzes an image and gets its text/description.

Your output MUST be a valid JSON object. Do not include markdown codeblocks (like \`\`\`json) in your final reply. Output raw JSON only, matching this schema:
{
  "should_respond": true/false,
  "tool_to_call": "toolName" or null,
  "tool_args": [arg1, arg2] or null,
  "generation_instructions": "Guidelines for drafting the response, including tone, style, and what memory facts to reference.",
  "assigned_tier": "LITE" | "FLASH" | "OPENROUTER"
}
`;

// Helper to clean and parse JSON from LLM output
function parseLLMResponse(text) {
  let cleaned = text.trim();
  // Strip code blocks if present
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
  }
  
  try {
    return JSON.parse(cleaned);
  } catch (error) {
    // Attempt parsing with regex fallback if JSON is broken but contains schema
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      try {
        return JSON.parse(jsonMatch[0]);
      } catch (nestedErr) {
        logSystem('PLANNER', 'Failed to parse extracted JSON object');
      }
    }
    throw new Error(`JSON parsing failed: ${error.message}. Raw: ${text}`);
  }
}

export async function runPlanner(ctx, category) {
  const message = ctx.message;
  const chatId = ctx.chat.id;
  const userId = message.from.id;
  const username = message.from.username || '';
  const fullName = [message.from.first_name, message.from.last_name].filter(Boolean).join(' ');

  await logSystem('PLANNER', `Processing message from ${fullName} in chat ${chatId}`);

  // 1. Fetch or create sender profile
  let profile = await getUserProfile(userId);
  if (!profile) {
    profile = await createUserProfile(userId, fullName);
    await logSystem('PLANNER', `Created new user profile for ${fullName} (${userId})`);
  }

  // 2. Fetch short memory context (last 15 messages)
  const historyRaw = await getRecentMessages(chatId, 15);
  const formattedHistory = historyRaw.reverse().map(msg => ({
    role: msg.user_id === ctx.me.id ? 'assistant' : 'user',
    content: `[${msg.user_fullname}]: ${msg.content}`
  }));

  // 3. Compose current state for the Planner
  const userFactSummary = profile ? JSON.stringify({
    name: profile.name,
    nicknames: profile.nicknames,
    interests: profile.interests,
    skills: profile.skills,
    projects: profile.projects,
    facts: profile.facts
  }, null, 2) : '{}';

  const currentPrompt = `
Category determined by classifier: ${category}
Incoming message details:
- Sender Name: ${fullName} (Username: @${username})
- Sender User ID: ${userId}
- Message ID: ${message.message_id}
- Message Content: "${message.text || message.caption || '[Attachment]'}"
- Reply to Message ID: ${message.reply_to_message?.message_id || 'None'}

Sender Long-Term Memory Profile:
${userFactSummary}

Decide on should_respond, tool executions, and generation instructions. Respond with JSON only.
`;

  try {
    const plannerResponseText = await generateText({
      tier: 'PLANNER',
      prompt: currentPrompt,
      systemInstruction: PLANNER_SYSTEM_INSTRUCTION,
      history: formattedHistory
    });

    const decision = parseLLMResponse(plannerResponseText);
    await logSystem('PLANNER', `Planner decision: should_respond=${decision.should_respond}, tool_to_call=${decision.tool_to_call}`);

    let toolResult = null;

    // 4. Handle Tool Execution
    if (decision.tool_to_call) {
      const toolName = decision.tool_to_call;
      const args = decision.tool_args || [];
      
      await logSystem('PLANNER', `Executing tool: ${toolName} with args: ${JSON.stringify(args)}`);
      
      try {
        if (toolName === 'remember') {
          // ensure correct userId is passed
          const targetUserId = args[0] === 'sender' || !args[0] ? userId : Number(args[0]);
          toolResult = await tools.remember(targetUserId, args[1], fullName);
        } else if (toolName === 'updateProfile') {
          const targetUserId = args[0] === 'sender' || !args[0] ? userId : Number(args[0]);
          toolResult = await tools.updateProfile(targetUserId, args[1], fullName);
        } else if (toolName === 'searchMemory') {
          toolResult = await tools.searchMemory(args[0]);
        } else if (toolName === 'deleteMessages') {
          toolResult = await tools.deleteMessages(chatId, args[0]);
        } else if (toolName === 'banUser') {
          toolResult = await tools.banUser(chatId, args[0]);
        } else if (toolName === 'muteUser') {
          toolResult = await tools.muteUser(chatId, args[0], args[1]);
        } else if (toolName === 'pinMessage') {
          toolResult = await tools.pinMessage(chatId, args[0]);
        } else if (toolName === 'warnUser') {
          toolResult = await tools.warnUser(chatId, args[0], args[1]);
        } else if (toolName === 'webSearch') {
          toolResult = await tools.webSearch(args[0]);
        } else if (toolName === 'analyzeImage') {
          // If the message contains photo, use that file_id, otherwise use the argument
          const photoFileId = message.photo?.[message.photo.length - 1]?.file_id || args[0];
          if (photoFileId) {
            toolResult = await tools.analyzeImage(photoFileId);
          } else {
            toolResult = { success: false, error: 'No image attachment found.' };
          }
        } else {
          await logSystem('PLANNER', `Unknown tool: ${toolName}`);
        }
      } catch (toolError) {
        await logSystem('PLANNER', `Tool execution error: ${toolError.message}`);
        toolResult = { success: false, error: toolError.message };
      }
      
      await logSystem('PLANNER', `Tool Execution Result: ${JSON.stringify(toolResult)}`);
    }

    if (!decision.should_respond) {
      return null;
    }

    // 5. Build Response Synthesis Prompt and invoke Specialist Worker Model
    const synthesisSystemInstruction = `
${CORE_PROMPT}

Style Guidelines:
- Tone: Friendly, conversational, dry-witted when appropriate, never robotic.
- Format: Keep responses concise. Max 2 short paragraphs. Avoid excessive emojis (max 1 per message).
- Identity: Speak directly as a long-term group member. Avoid generic greeting lines (like "Hello there, Fardad!").
`;

    let synthesisPrompt = `
You are replying to: "${message.text || message.caption || '[Attachment]'}" sent by ${fullName}.
Sender Memory Profile: ${userFactSummary}

Instructions from Planner:
${decision.generation_instructions}
`;

    if (toolResult) {
      synthesisPrompt += `\nTool executed during planning: ${decision.tool_to_call}\nTool Output Result: ${JSON.stringify(toolResult)}\nInclude this information naturally if appropriate.`;
    }

    // Generate response text using the assigned worker model tier
    const replyText = await generateText({
      tier: decision.assigned_tier || 'LITE',
      prompt: synthesisPrompt,
      systemInstruction: synthesisSystemInstruction,
      history: formattedHistory
    });

    return replyText;

  } catch (error) {
    await logSystem('PLANNER', `Error in Planner loop: ${error.message}`);
    // Safe fallback message to avoid breaking bot
    if (category !== 'IGNORE') {
      return "I'm having a hard time processing that right now. Everything okay?";
    }
    return null;
  }
}
