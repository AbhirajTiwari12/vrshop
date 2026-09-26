import { categoryDef, round3 } from '../catalog.js';
import type { Dims } from '../types.js';
import { chatJson, hasOpenAI } from './openai.js';

// Listings often omit dimensions. Ask the model for its best estimate of THIS product
// (it knows e.g. that a "3-seater" is ~2.1 m wide), then sanity-clamp against the category.
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['widthM', 'depthM', 'heightM'],
  properties: { widthM: { type: 'number' }, depthM: { type: 'number' }, heightM: { type: 'number' } },
};

export async function estimateDims(title: string, category: string): Promise<Dims | null> {
  if (!hasOpenAI()) return null;
  const def = categoryDef(category);
  try {
    const r = await chatJson<{ widthM: number; depthM: number; heightM: number }>({
      messages: [
        { role: 'system', content: 'Estimate real-world assembled product dimensions in meters. Width = left-right as seen from the front, depth = front-back, height = floor to top. Output only JSON.' },
        { role: 'user', content: `Product: ${title}\nCategory: ${def.label} (typical ${def.dims.w} x ${def.dims.d} x ${def.dims.h} m)` },
      ],
      schemaName: 'dims',
      schema: SCHEMA,
      effort: 'none',
      timeoutMs: 30000,
    });
    const clamp = (v: number, typical: number) => (Number.isFinite(v) && v > typical * 0.25 && v < typical * 4 ? round3(v) : typical);
    return { w: clamp(r.widthM, def.dims.w), d: clamp(r.depthM, def.dims.d), h: clamp(r.heightM, def.dims.h) };
  } catch {
    return null;
  }
}
