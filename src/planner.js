import { logSystem, getUserProfile, getRecentMessages, createUserProfile, addMessageToBuffer } from './database.js';
import { generateText } from './router.js';
import { startNewTrace, addTraceStep } from './trace.js';
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

You are the Planner & Brain (Coordinating Memory, Creative, and Persona Agents). Your job is to analyze the incoming message, check the sender's long-term memory, and decide:
1. Whether we should respond at all.
2. If we need to call any of our available tools (memory, moderation, search, maps, vision).
3. How the final text response should be drafted (instructions, tone, key details).
4. Which model tier should generate the final message:
   - GEMMA: For very simple greetings (like "سلام", "چطور مطوری", "چه خبر"), short acknowledgements, or simple casual chitchat. (Highly optimized, zero Gemini quota cost).
   - LITE: For general conversation, questions, and descriptions requiring standard reasoning or general knowledge (uses Gemini Lite).
   - FLASH: For complex logic, coding, technical assistance, or deep mathematical analysis (uses Gemini Flash).

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
- followDiscussion(): Summarizes the last 100 messages in the group to catch up on the ongoing conversation. Call this tool when a user tags you and asks for your opinion on the recent discussion, or asks you to summarize what happened.

Your output MUST be a valid JSON object. Do not include markdown codeblocks (like \`\`\`json) in your final reply. Output raw JSON only, matching this schema:
{
  "should_respond": true/false,
  "tool_to_call": "toolName" or null,
  "tool_args": [arg1, arg2] or null,
  "generation_instructions": "Guidelines for drafting the response, including tone, style, and what memory facts to reference.",
  "assigned_tier": "GEMMA" | "LITE" | "FLASH",
  "intermediate_message": "Required ONLY when tool_to_call is 'followDiscussion'. Set this to a natural, witty, and friendly message in Persian saying you are going to read the recent messages to catch up (e.g. 'یک لحظه وایسا ببینم چیه بحث...'). Otherwise set to null."
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
  const messageText = message.text || message.caption || '[Attachment]';

  // 1. Initialize message trace for the Visualizer
  startNewTrace(message.message_id, fullName, messageText);
  addTraceStep('CLASSIFY', 'success', `Classified message as: ${category}`);
  
  await logSystem('PLANNER', `Processing message from ${fullName} in chat ${chatId}`);

  // 2. Fetch or create sender profile
  let profile = await getUserProfile(userId);
  if (!profile) {
    profile = await createUserProfile(userId, fullName);
    await logSystem('PLANNER', `Created new user profile for ${fullName} (${userId})`);
  }

  // 3. Fetch short memory context (last 15 messages)
  const historyRaw = await getRecentMessages(chatId, 15);
  const formattedHistory = historyRaw.reverse().map(msg => ({
    role: msg.user_id === ctx.me.id ? 'assistant' : 'user',
    content: `[${msg.user_fullname}]: ${msg.content}`
  }));

  // 4. Compose current state for the Planner
  const userFactSummary = profile ? JSON.stringify({
    name: profile.name,
    nicknames: profile.nicknames,
    interests: profile.interests,
    skills: profile.skills,
    projects: profile.projects,
    facts: profile.facts
  }, null, 2) : '{}';

  const repliedMessage = message.reply_to_message;
  let repliedMessageSummary = 'None';
  if (repliedMessage) {
    const repliedSenderName = [repliedMessage.from?.first_name, repliedMessage.from?.last_name].filter(Boolean).join(' ') || 'Unknown';
    const repliedText = repliedMessage.text || repliedMessage.caption || '[Attachment]';
    repliedMessageSummary = `"[${repliedSenderName}]: ${repliedText}" (Message ID: ${repliedMessage.message_id})`;
  }

  const currentPrompt = `
Category determined by classifier: ${category}
Incoming message details:
- Sender Name: ${fullName} (Username: @${username})
- Sender User ID: ${userId}
- Message ID: ${message.message_id}
- Message Content: "${messageText}"
- Reply to Message: ${repliedMessageSummary}

Sender Long-Term Memory Profile:
${userFactSummary}

Decide on should_respond, tool executions, and generation instructions. Respond with JSON only.
`;

  try {
    addTraceStep('PLANNER', 'pending', 'Invoking Gemma Planner Agent (brain logic)');
    
    // Planner uses the GEMMA_PLANNER tier (Gemma 4 31B -> Gemma 4 26B -> Gemini 3.1 Lite)
    const plannerResponseText = await generateText({
      tier: 'GEMMA_PLANNER',
      prompt: currentPrompt,
      systemInstruction: PLANNER_SYSTEM_INSTRUCTION,
      history: formattedHistory,
      jsonMode: true
    });

    const decision = parseLLMResponse(plannerResponseText);
    await logSystem('PLANNER', `Planner decision: should_respond=${decision.should_respond}, tool_to_call=${decision.tool_to_call}`);
    addTraceStep('PLANNER', 'success', `Planner decided should_respond=${decision.should_respond}, tool_to_call=${decision.tool_to_call || 'none'}, tier=${decision.assigned_tier}`);

    let toolResult = null;

    // Send intermediate message immediately if tool is followDiscussion
    if (decision.tool_to_call === 'followDiscussion') {
      if (!decision.intermediate_message) {
        decision.intermediate_message = "یک لحظه اجازه بده بحث‌های اخیر رو بخونم ببینم در چه مورده... 🧐";
      }
      try {
        const sentIntMsg = await ctx.reply(decision.intermediate_message, {
          reply_parameters: { message_id: message.message_id }
        });
        
        // Save intermediate message to buffer
        const intRecord = {
          telegram_message_id: sentIntMsg.message_id,
          chat_id: chatId,
          user_id: ctx.me.id,
          username: ctx.me.username || '',
          user_fullname: ctx.me.first_name || 'Bot',
          content: decision.intermediate_message,
          reply_to_message_id: message.message_id
        };
        await addMessageToBuffer(intRecord);
      } catch (err) {
        await logSystem('PLANNER', `Failed to send intermediate message: ${err.message}`);
      }
    }

    // 5. Handle Tool Execution
    if (decision.tool_to_call) {
      const toolName = decision.tool_to_call;
      const args = decision.tool_args || [];
      
      await logSystem('PLANNER', `Executing tool: ${toolName} with args: ${JSON.stringify(args)}`);
      
      try {
        if (toolName === 'remember') {
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
        } else if (toolName === 'followDiscussion') {
          toolResult = await tools.followDiscussion(chatId);
        } else if (toolName === 'analyzeImage') {
          const photoFileId = message.photo?.[message.photo.length - 1]?.file_id ||
                              (message.document && message.document.mime_type?.startsWith('image/') ? message.document.file_id : null) ||
                              message.reply_to_message?.photo?.[message.reply_to_message.photo.length - 1]?.file_id ||
                              (message.reply_to_message?.document && message.reply_to_message.document.mime_type?.startsWith('image/') ? message.reply_to_message.document.file_id : null) ||
                              args[0];
          if (photoFileId) {
            toolResult = await tools.analyzeImage(photoFileId);
          } else {
            toolResult = { success: false, error: 'No image attachment found.' };
            addTraceStep('TOOL', 'failed', 'No image attachment found for analyzeImage');
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

    // If the followDiscussion tool failed, force gemma to write a Persian message explaining the error
    let assignedTier = decision.assigned_tier || 'LITE';
    let generationInstructions = decision.generation_instructions;

    if (decision.tool_to_call === 'followDiscussion' && (!toolResult || !toolResult.success)) {
      assignedTier = 'GEMMA';
      generationInstructions = `The Live API WebSocket model (models/gemini-3-flash-live) failed after 5 retries. Write a witty, friendly, or polite message in Persian explaining that you had a technical issue and couldn't read the chat history to give your opinion.`;
    }

    if (!decision.should_respond) {
      addTraceStep('SYNTHESIS', 'success', 'Planner decided not to respond.');
      return null;
    }



    // 7. Build Response Synthesis Prompt and invoke Specialist Worker Model
    const synthesisSystemInstruction = `
${CORE_PROMPT}

Style Guidelines:
- Tone: Friendly, conversational, dry-witted when appropriate, never robotic.
- Format: Keep responses concise. Max 2 short paragraphs. Avoid excessive emojis (max 1 per message).
- Identity: Speak directly as a long-term group member. Avoid generic greeting lines (like "Hello there, Fardad!").
`;

    let synthesisPrompt = `
You are replying to: "${messageText}" sent by ${fullName}.
Sender Memory Profile: ${userFactSummary}

Instructions from Planner:
${generationInstructions}
`;

    if (toolResult) {
      synthesisPrompt += `\nTool executed during planning: ${decision.tool_to_call}\nTool Output Result: ${JSON.stringify(toolResult)}\nInclude this information naturally if appropriate.`;
    }

    addTraceStep('SYNTHESIS', 'pending', `Invoking Social Persona Agent (Tier: ${assignedTier})`);
    
    // Generate response text using the assigned worker model tier (LITE or FLASH)
    const replyText = await generateText({
      tier: assignedTier,
      prompt: synthesisPrompt,
      systemInstruction: synthesisSystemInstruction,
      history: formattedHistory
    });

    addTraceStep('SYNTHESIS', 'success', `Response compiled successfully`);
    return replyText;

  } catch (error) {
    await logSystem('PLANNER', `Error in Planner loop: ${error.message}`);
    addTraceStep('PLANNER', 'failed', `Error: ${error.message}`);
    if (category !== 'IGNORE') {
      return "مشکلی در پردازش پیام پیش اومده. همه‌چیز مرتبه؟";
    }
    return null;
  }
}
