import { config } from '../../config.js';
import type { Dims } from '../../types.js';
import { generateFal } from './fal.js';
import { generateMeshy } from './meshy.js';
import { generateTripo } from './tripo.js';

export interface GenContext { dims: Dims; category: string; title: string; falModel?: string }
export type Progress = (fraction: number, message?: string) => void;

/** Photos (best first) -> textured GLB (raw provider output; caller normalizes scale/pivot/textures). */
export async function generateModel(images: string[], ctx: GenContext, onProgress: Progress): Promise<Buffer> {
  switch (config.gen.provider) {
    case 'fal': return generateFal(images, ctx, onProgress);
    case 'meshy': return generateMeshy(images[0], ctx, onProgress);
    case 'tripo': return generateTripo(images[0], ctx, onProgress);
    default: throw new Error('No image-to-3D provider configured');
  }
}
