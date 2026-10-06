import type { Adapter } from '../types.ts';
import { custojusto } from './custojusto.ts';
import { idealista } from './idealista.ts';
import { imovirtual } from './imovirtual.ts';

/**
 * Active sources. See README "Sources" for the probe results of the others
 * (blocked, JS-only, or no own portal) and why they are not used.
 */
export const adapters: Adapter[] = [imovirtual, custojusto, idealista]; // idealista: only with an API key
