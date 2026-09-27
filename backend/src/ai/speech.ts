import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { dirs, hash } from '../store.js';
import { log, errMsg } from '../util/log.js';
import { hasOpenAI, synthesizeSpeech } from './openai.js';

// The designer's spoken voice. A reply gets a URL right away (synthesis starts in the background) and the headset
// fetches the WAV a moment later. Every line is cached on disk, so repeated lines (greetings) are free and instant.

const pending = new Map<string, string>(); // id -> text not yet on disk
const inflight = new Map<string, Promise<Buffer>>();
const file = (id: string) => path.join(dirs.tts, `${id}.wav`);

/** Plain text a voice can read: no rich-text tags, bullets or symbols that would be read out literally. */
export function forSpeech(text: string): string {
  return String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s*[•·|]\s*/g, ', ')
    .replace(/(\d)\s*[×x]\s*(?=\d)/g, '$1 by ')
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600);
}

/** Registers a line to speak and returns its (relative) WAV URL, or undefined when speech isn't available. */
export function speechUrl(text: string): string | undefined {
  const t = forSpeech(text);
  if (!t || !hasOpenAI()) return undefined;
  const id = hash(`${config.openai.ttsModel}|${config.openai.ttsVoice}|${config.openai.ttsInstructions}|${t}`, 24);
  if (!fs.existsSync(file(id))) {
    pending.set(id, t);
    if (pending.size > 300) pending.delete(pending.keys().next().value!);
    void speechAudio(id).catch(() => {}); // warm it up; errors surface when the headset fetches it
  }
  return `/api/speech/${id}.wav`;
}

/** WAV bytes for a registered line (synthesized once, then served from disk). */
export async function speechAudio(id: string): Promise<Buffer> {
  const f = file(id);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  const running = inflight.get(id);
  if (running) return running;
  const text = pending.get(id);
  if (!text) throw Object.assign(new Error('Speech not found'), { status: 404 });
  const job = synthesizeSpeech(text)
    .then((wav) => {
      fs.writeFileSync(f, wav);
      pending.delete(id);
      return wav;
    })
    .catch((e) => {
      log.warn('speech', `"${text.slice(0, 60)}": ${errMsg(e)}`);
      throw Object.assign(new Error(`Speech failed: ${errMsg(e)}`), { status: 502 });
    })
    .finally(() => inflight.delete(id));
  inflight.set(id, job);
  return job;
}
