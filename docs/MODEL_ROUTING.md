# Model Routing & API Usage

This document details the different model tiers and APIs used by the Telegram Agent Bot, explaining their specific roles and fallback strategies.

## 🧠 Model Tiers

The bot uses a multi-tier model approach to balance reasoning quality, speed, and API quota costs.

| Tier | Primary Model | Provider | Purpose |
| :--- | :--- | :--- | :--- |
| **GEMMA_PLANNER** | Gemma 4 31B | OpenRouter | **The "Brain"**: Analyzes incoming messages, decides whether to respond, and selects tools. |
| **GEMMA** | Gemma 4 31B/26B | OpenRouter | **Social Observer & Simple Chitchat**: Handles background group vibe analysis, relationship extraction, and short casual replies. |
| **LITE** | Gemini 3.1 Flash Lite | Google AI Studio | **General Persona**: Handles standard conversational replies, general knowledge questions, and descriptions. |
| **FLASH** | Gemini 3.5 Flash | Google AI Studio | **Advanced Reasoning**: Used for complex logic, coding tasks, and deep analysis. |
| **LIVE_DIGEST** | Gemini 3 Flash Live | Google AI Studio | **High-Volume Observer**: Used for real-time discussion summarization and processing high message volume via WebSockets. |

## 🛠️ API Providers

The system rotates between two main API providers:

1.  **OpenRouter**: Used primarily for the **Gemma** models. OpenRouter allows us to access high-quality open-source models like Gemma 31B which provide the "Identity" of the bot.
2.  **Google AI Studio (Gemini API)**: Used for high-capacity, low-latency processing and specialized tools (Vision, Live summarization, Search grounding).

### API Key Management & Rotation
- **Sticky Rotation**: The bot uses a "sticky per-model" strategy for Gemini keys. A key is used for a specific model until it hits a quota error (429), at which point it rotates to the next available key in the pool (Active or Backup).
- **Throttling**: A global 10-second gap is enforced between all API requests (both Google and OpenRouter) to prevent aggressive rate limiting.

## 📊 Feature-Specific Logic

### 1. Relational & Collective Memory
- **Extraction**: Handled by the **GEMMA** tier in the background (every 30 mins). It parses recent transcripts to find relationships (social graph) and shared events.
- **Retrieval**: Stored in SQLite. The **GEMMA_PLANNER** calls local tools (`getSocialGraph`, `getCollectiveMemory`) only when the context of the conversation requires it, keeping the primary prompt "lean."

### 2. Group Vibe Analysis
- **Analysis**: Performed by the **GEMMA** tier periodically. It detects the mood (tension, joy, tiredness) of the group.
- **Integration**: The current vibe is injected into both the Planner and the Synthesis prompts so the bot's response tone always "aligns" with the atmosphere.

### 3. Vision & Search
- **Vision**: Uses **Gemini 3.1 Flash Lite** for OCR and image description.
- **Search**: Uses **Gemini 3.1 Flash Lite** with Google Search Grounding. If Google search fails, it falls back to a DuckDuckGo scraper.

## 🔄 Fallback Chain

If a primary model fails or hits a quota limit, the system automatically falls back through a pre-defined chain:
- **Gemma Tiers**: Fall back to Gemini 3.1 Flash Lite if OpenRouter is unreachable or both Gemma models (31B/26B) are failing.
- **Gemini Tiers**: Fall back to lighter or alternative Gemini models (e.g., Flash -> Lite).
- **Ultimate Fallback**: If all else fails, the bot attempts to use a free Llama 3 model via OpenRouter as a last resort.
