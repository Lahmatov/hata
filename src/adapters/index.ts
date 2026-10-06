import type { Adapter } from '../types.ts';
import { casasapo } from './casasapo.ts';
import { custojusto } from './custojusto.ts';
import { idealista } from './idealista.ts';
import { imovirtual } from './imovirtual.ts';
import { trovit } from './trovit.ts';

/**
 * Active sources. See README "Sources" for the probe results of the others
 * (blocked, JS-only, or no own portal) and why they are not used.
 */
// CustoJusto: its robots.txt disallows the search pages (seen on the first real run), so it stays off.
// Casa Sapo and Trovit answer from a home connection but block datacenter IPs (GitHub): run on the Mac.
export const adapters: Adapter[] = [imovirtual, casasapo, trovit, idealista]; // idealista: only with an API key
export const disabled: Adapter[] = [custojusto];
