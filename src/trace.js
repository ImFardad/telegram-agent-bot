import { AsyncLocalStorage } from 'node:async_hooks';

const asyncLocalStorage = new AsyncLocalStorage();
const activeTraces = new Map();
let latestActiveTraceId = null;

export function startNewTrace(msgId, username, text) {
  const trace = {
    id: msgId,
    user: username,
    message: text,
    steps: [] // Array of { stage: string, status: 'pending' | 'success' | 'failed', details: string, timestamp: number }
  };
  activeTraces.set(msgId, trace);
  latestActiveTraceId = msgId;
  
  // Enter the async storage context for this message execution thread
  asyncLocalStorage.enterWith(msgId);
  
  addTraceStep('RECEIVE', 'success', `Message received from ${username}: "${text.substring(0, 40)}${text.length > 40 ? '...' : ''}"`);
}

export function addTraceStep(stage, status, details) {
  const msgId = asyncLocalStorage.getStore();
  let trace = activeTraces.get(msgId);
  
  // Fallback to the latest active trace if context isn't set (e.g. background discovery)
  if (!trace) {
    if (latestActiveTraceId) {
      trace = activeTraces.get(latestActiveTraceId);
    } else {
      return;
    }
  }
  
  trace.steps.push({
    stage,
    status,
    details,
    timestamp: Date.now()
  });
  console.log(`[TRACE] [${stage}] [${status}] ${details}`);
  
  // Clean up old traces to prevent memory leaks (keep max 100)
  if (activeTraces.size > 100) {
    const oldestKey = activeTraces.keys().next().value;
    activeTraces.delete(oldestKey);
  }
}

export function getCurrentTrace() {
  return activeTraces.get(latestActiveTraceId) || { id: null, user: '', message: '', steps: [] };
}
