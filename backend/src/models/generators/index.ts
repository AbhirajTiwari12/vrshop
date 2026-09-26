import { config } from '../../config.js';
import type { Dims } from '../../types.js';
import { generateFal } from './fal.js';
import { generateMeshy } from './meshy.js';
import { generateTripo } from './tripo.js';

export interface GenContext { dims: Dims; category: string; title: string }
export type Progress = (fraction: number, message?: string) => void;

/** Image -> textured GLB (raw provider output; caller normalizes scale/pivot/textures). */
export async function generateModel(imageUrl: string, ctx: GenContext, onProgress: Progress): Promise<Buffer> {
  switch (config.gen.provider) {
    case 'fal': return generateFal(imageUrl, ctx, onProgress);
    case 'meshy': return generateMeshy(imageUrl, ctx, onProgress);
    case 'tripo': return generateTripo(imageUrl, ctx, onProgress);
    default: throw new Error('No image-to-3D provider configured');
  }
}
