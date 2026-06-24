import { getRecentMessages, logSystem, updateGroupVibe, addCollectiveMemory, updateSocialLink } from './database.js';
import { generateText } from './router.js';
import { addTraceStep } from './trace.js';
import { remember } from './tools.js';

/**
 * Sweeps the last X messages of a chat and generates a comprehensive group digest,
 * extracting sentiments, active topics, user relations, and new facts.
 */
export async function runObserverDigest(chatId, limit = 100) {
  await logSystem('OBSERVER', `Starting Group Observer Sweep for chat ${chatId} (limit: ${limit} messages)...`);
  addTraceStep('OBSERVER', 'pending', `Loading last ${limit} messages for passive analysis`);

  try {
    const messages = await getRecentMessages(chatId, limit);
    if (messages.length === 0) {
      await logSystem('OBSERVER', 'No recent messages to analyze.');
      addTraceStep('OBSERVER', 'success', 'Observer sweep finished: No messages found.');
      return { success: true, message: 'No messages to analyze.' };
    }

    // Format chat logs as transcript
    const transcript = messages
      .reverse()
      .map(msg => `[${new Date(msg.timestamp).toLocaleTimeString()}] ${msg.user_fullname} (${msg.user_id}): ${msg.content}`)
      .join('\n');

    addTraceStep('OBSERVER', 'pending', `Ingesting transcript (${transcript.length} characters) via Gemma Tier`);

    const digestPrompt = `
You are the Group Observer Agent. Your role is to passively observe the group transcript, analyze the dynamics, extract cognitive user updates, and summarize the conversation.
Analyze the following private group chat transcript:

--- TRANSCRIPT START ---
${transcript}
--- TRANSCRIPT END ---

Identify:
1. **Active Topics**: What is being discussed?
2. **Sentiment & Vibe**: What is the overall mood of the group? (e.g., tiredness, excitement, tension, joy).
3. **Relationships (Mental Graph)**: Are there specific interactions or connections between users? (e.g. User A is helping User B, User C is teasing User D).
4. **Collective Memories**: Are there any shared events, jokes, or significant group milestones mentioned or occurred in this transcript?
5. **Cognitive Facts**: Did any user state facts about themselves (interests, skills, current projects, hobbies, facts) that are not already known?

Output a structured JSON summary matching this schema:
{
  "topics": ["topic1", "topic2"],
  "vibe": "string description of mood",
  "relationships": [
    {
      "user_a_id": number,
      "user_b_id": number,
      "type": "string (e.g. mentor, friend, rival)",
      "description": "short description of their current interaction/link"
    }
  ],
  "collective_memories": ["description of shared memory or event"],
  "extracted_facts": [
    {
      "user_id": number (the user_id from transcript),
      "user_fullname": "string name",
      "fact": "string fact extracted"
    }
  ]
}
`;

    // Use GEMMA tier for background vibe and relationship analysis as requested
    const responseText = await generateText({
      tier: 'GEMMA',
      prompt: digestPrompt,
      systemInstruction: 'You are an objective group observer. Output raw JSON objects only matching the schema.',
      jsonMode: true
    });

    let cleaned = responseText.trim();
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleaned = jsonMatch[0];
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```json\s*/i, '').replace(/```$/, '').trim();
    }
    
    const digest = JSON.parse(cleaned);

    await logSystem('OBSERVER', `Digest completed. Topics: ${digest.topics.join(', ')}. Extracted ${digest.extracted_facts.length} new facts.`);
    addTraceStep('OBSERVER', 'success', `Observer sweep completed. Mood: ${digest.vibe}.`);

    // 1. Update Group Vibe
    if (digest.vibe) {
      await updateGroupVibe(chatId, digest.vibe);
    }

    // 2. Persist Collective Memories
    if (digest.collective_memories && digest.collective_memories.length > 0) {
      for (const mem of digest.collective_memories) {
        await addCollectiveMemory(chatId, mem);
      }
    }

    // 3. Update Social Graph (Relationships)
    if (digest.relationships && digest.relationships.length > 0) {
      for (const rel of digest.relationships) {
        if (rel.user_a_id && rel.user_b_id) {
          await updateSocialLink(chatId, rel.user_a_id, rel.user_b_id, rel.type, rel.description);
        }
      }
    }

    // 4. Feed extracted facts to the Memory Agent (remember facts automatically)
    if (digest.extracted_facts && digest.extracted_facts.length > 0) {
      addTraceStep('OBSERVER', 'pending', `Memory Agent storing ${digest.extracted_facts.length} extracted facts in SQLite`);
      for (const item of digest.extracted_facts) {
        if (item.user_id && item.fact) {
          try {
            await remember(item.user_id, item.fact, item.user_fullname);
          } catch (memErr) {
            await logSystem('OBSERVER', `Failed to remember fact for ${item.user_fullname}: ${memErr.message}`);
          }
        }
      }
      addTraceStep('OBSERVER', 'success', 'All extracted facts stored in user profiles');
    }

    return {
      success: true,
      digest
    };
  } catch (error) {
    await logSystem('OBSERVER', `Group Observer Sweep failed: ${error.message}`);
    addTraceStep('OBSERVER', 'failed', `Observer sweep failed: ${error.message}`);
    return { success: false, error: error.message };
  }
}
