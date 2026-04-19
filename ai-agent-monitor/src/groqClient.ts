import * as vscode from 'vscode';
import * as https from 'https';
import { CoachInsight, ConversationChat } from './types';

interface GroqResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
}

export async function analyzeChatWithGroq(chat: ConversationChat): Promise<CoachInsight[]> {
  const config = vscode.workspace.getConfiguration('aiAgentMonitor');
  const apiKey = config.get<string>('groqApiKey', '');

  if (!apiKey || apiKey.trim().length === 0) {
    return [];
  }

  // Extract the last 4 turns to avoid context overflow and save latency
  const recentTurns = chat.turns.slice(-4);
  if (recentTurns.length === 0) {
    return [];
  }

  const conversationText = recentTurns.map((turn, index) => {
    return `Turn ${index + 1}:\nUser Prompt: ${turn.blocks['user-input']?.content ?? ''}\n` +
           `Agent Output Preview: ${(turn.blocks['agent-output']?.content ?? '').substring(0, 500)}...`;
  }).join('\n\n');

  const systemPrompt = `You are an expert AI Developer Coach monitoring a programmer's chat session with an AI coding assistant.
Analyze the provided recent conversation history. 
Identify if the user is making common mistakes such as:
1. "Error Loop": Pasting the exact same terminal error multiple times without changing their approach or analyzing the root cause.
2. "Context Rot": Including massive files but asking trivial questions, or attaching dead files that the AI obviously doesn't need.
3. "Prompt Drift": Getting frustrated and sending increasingly vague or aggressive commands.
4. "Topic Switch / Unrelated Task": The user is asking the AI to do a completely new task (like "Now write a python script for X") that has NOTHING to do with the previous 30 turns of history. Tell them to start a new chat!
5. "Overly Restrictive Constraints": Forcing the AI into a corner (e.g. "Fix this bug but absolutely do not modify any CSS files or use any new variables") when a standard refactor would be much better.

Return ONLY a valid JSON object with this schema, and nothing else (no markdown blocks):
{
  "insights": [
    {
      "id": "unique-string",
      "level": "warn" | "danger" | "success",
      "title": "Short actionable title",
      "detail": "1 sentence explanation of what to do differently"
    }
  ]
}
If the conversation is fine, return {"insights": []}.`;

  const requestBody = JSON.stringify({
    model: 'llama-3.3-70b-versatile',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: conversationText }
    ],
    temperature: 0.2,
    response_format: { type: 'json_object' } // Groq supports JSON mode
  });

  return new Promise((resolve) => {
    const req = https.request('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey.trim()}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(requestBody)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          if (res.statusCode !== 200) {
            console.error('[Groq] Error fetching insights:', data);
            return resolve([]);
          }
          const payload = JSON.parse(data) as GroqResponse;
          const text = payload.choices[0]?.message?.content || '[]';
          // Since Groq returns an object in JSON mode, we wrapped our expected array in an object...
          // Wait, if we use json_object, the output MUST be a JSON object, not an array.
          // Fallback parsing:
          const result = JSON.parse(text);
          if (Array.isArray(result)) {
             resolve(result);
          } else if (result.insights && Array.isArray(result.insights)) {
             resolve(result.insights);
          } else {
             resolve([]);
          }
        } catch (e) {
          console.error('[Groq] JSON Parse Error:', e);
          resolve([]);
        }
      });
    });

    req.on('error', (e) => {
      console.error('[Groq] Request failed:', e);
      resolve([]);
    });

    req.write(requestBody);
    req.end();
  });
}
