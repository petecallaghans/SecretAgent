import OpenAI from 'openai';
import type { Config } from '../types.js';

export type DelegateTier = 'nano' | 'mini' | 'smart';

export interface DelegateInput {
  task: string;
  tier?: DelegateTier;
  json?: boolean;
  system?: string;
}

export async function runDelegate(config: Config, input: DelegateInput): Promise<string> {
  if (!config.openaiApiKey) {
    return 'Error: OPENAI_API_KEY not set. Delegation requires an OpenAI key.';
  }

  const model = pickModel(config, input.tier || 'mini');
  const openai = new OpenAI({ apiKey: config.openaiApiKey });

  const messages: { role: 'system' | 'user'; content: string }[] = [];
  if (input.system) {
    messages.push({ role: 'system', content: input.system });
  } else {
    messages.push({
      role: 'system',
      content: 'You are a helper assistant. Complete the task concisely and return only the answer. No preamble.',
    });
  }
  messages.push({ role: 'user', content: input.task });

  try {
    const completion = await openai.chat.completions.create({
      model,
      messages,
      response_format: input.json ? { type: 'json_object' } : undefined,
    });
    const text = completion.choices[0]?.message?.content?.trim() || '';
    return text || '(empty response)';
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // Auto-fallback if model id rejected
    if (model !== config.openaiDelegateMini && /model|not found|404|invalid/i.test(msg)) {
      const fallback = await openai.chat.completions.create({
        model: config.openaiDelegateMini,
        messages,
        response_format: input.json ? { type: 'json_object' } : undefined,
      });
      const text = fallback.choices[0]?.message?.content?.trim() || '';
      return text || '(empty response)';
    }
    throw new Error(`Delegate failed (${model}): ${msg}`);
  }
}

function pickModel(config: Config, tier: DelegateTier): string {
  switch (tier) {
    case 'nano': return config.openaiDelegateNano;
    case 'smart': return config.openaiDelegateSmart;
    case 'mini':
    default: return config.openaiDelegateMini;
  }
}
