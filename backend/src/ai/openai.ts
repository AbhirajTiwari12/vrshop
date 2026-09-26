import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { config } from '../config.js';
import { fetchWithTimeout } from '../util/http.js';
import { log } from '../util/log.js';

// Minimal OpenAI client over fetch (Chat Completions + Structured Outputs, and transcription).
// Models are configurable in .env; reasoning models (gpt-5*, o*) get reasoning_effort instead of temperature.

export const hasOpenAI = () => !!config.openai.key;

type Part = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };
export interface ChatMessage { role: 'system' | 'user' | 'assistant'; content: string | Part[] }

const isReasoningModel = (m: string) => /^(gpt-[5-9]|o\d)/i.test(m);
// Original gpt-5 / -mini / -nano call the lowest effort 'minimal'; gpt-5.1+ and gpt-6 call it 'none'.
const effortFor = (m: string, e: Effort) => (e === 'none' && /^gpt-5(-mini|-nano)?$/i.test(m) ? 'minimal' : e);
export type Effort = 'none' | 'low' | 'medium' | 'high';

export async function chatJson<T>(opts: {
  model?: string;
  messages: ChatMessage[];
  schemaName: string;
  schema: object;
  effort?: Effort;
  timeoutMs?: number;
}): Promise<T> {
  if (!config.openai.key) throw new Error('OPENAI_API_KEY not set');
  const model = opts.model ?? config.openai.model;
  const body: Record<string, unknown> = {
    model,
    messages: opts.messages,
    response_format: { type: 'json_schema', json_schema: { name: opts.schemaName, strict: true, schema: opts.schema } },
    max_completion_tokens: 8000,
  };
  if (isReasoningModel(model)) body.reasoning_effort = effortFor(model, opts.effort ?? 'low');
  else body.temperature = 0.4;

  const res = await fetchWithTimeout(`${config.openai.baseUrl}/chat/completions`, {
    method: 'POST',
    timeoutMs: opts.timeoutMs ?? 90000,
    headers: { Authorization: `Bearer ${config.openai.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${text.slice(0, 400)}`);
  const data = JSON.parse(text);
  const choice = data.choices?.[0];
  if (choice?.message?.refusal) throw new Error(`OpenAI refused: ${choice.message.refusal}`);
  const content = choice?.message?.content;
  if (!content) throw new Error(`OpenAI returned no content (finish_reason=${choice?.finish_reason})`);
  const usage = data.usage ? `${data.usage.prompt_tokens}+${data.usage.completion_tokens} tok` : '';
  log.info('openai', `${opts.schemaName} via ${model} ${usage}`);
  return JSON.parse(content) as T;
}

/** Downscale a local photo and return a data URL (keeps vision requests small and fast). */
export async function photoDataUrl(filePath: string, maxSide = 1280): Promise<string> {
  const buf = await sharp(filePath).rotate().resize(maxSide, maxSide, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer();
  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

export async function transcribe(audio: Buffer, filename = 'speech.wav'): Promise<string> {
  if (!config.openai.key) throw new Error('OPENAI_API_KEY not set');
  const form = new FormData();
  form.append('model', config.openai.transcribeModel);
  form.append('file', new Blob([new Uint8Array(audio)], { type: mimeFor(filename) }), filename);
  const res = await fetchWithTimeout(`${config.openai.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    timeoutMs: 60000,
    headers: { Authorization: `Bearer ${config.openai.key}` },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`OpenAI transcription ${res.status}: ${text.slice(0, 300)}`);
  return (JSON.parse(text).text ?? '').trim();
}

function mimeFor(name: string) {
  const ext = path.extname(name).toLowerCase();
  return ext === '.mp3' ? 'audio/mpeg' : ext === '.m4a' ? 'audio/mp4' : ext === '.webm' ? 'audio/webm' : 'audio/wav';
}

export const fileExists = (p: string) => fs.existsSync(p);
