import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { z } from 'zod';
import { config } from './config.ts';
import type { Store } from './db.ts';
import { log } from './log.ts';
import type { Listing } from './types.ts';

const fmtEur = (n: number) => `${Math.round(n).toLocaleString('pt-PT').replace(/\s/g, ' ')} €`;
const yn = (b: boolean | null) => (b === null ? '?' : b ? 'да' : 'нет');
const CONDITION_RU: Record<string, string> = {
  new: 'новостройка', renovated: 'после ремонта', good: 'хорошее', needs_renovation: 'нужен ремонт', unknown: '?',
};

/** Line 1: facts only, built deterministically so numbers can never be hallucinated. */
export function factsLine(l: Listing): string {
  const parts = [
    l.price !== null ? fmtEur(l.price) : 'цена ?',
    l.area_m2 !== null ? `${l.area_m2} м²` : 'м² ?',
    l.price_per_m2 !== null ? `${fmtEur(l.price_per_m2)}/м²` : null,
    `🅿️ гараж: ${yn(l.garage)}`,
    `🛁 ${l.bathrooms ?? '?'}`,
    `этаж ${l.floor ?? '?'}, лифт: ${yn(l.elevator)}`,
    `сост.: ${CONDITION_RU[l.condition ?? 'unknown']}`,
    l.commute_min !== null ? `🚗 ${l.commute_approx ? '~' : ''}${Math.round(l.commute_min)} мин до школы` : '🚗 ?',
  ];
  return parts.filter(Boolean).join(' · ');
}

/** Rule-based fallback for plus/minus when the Claude API is not configured or fails. */
export function ruleBasedProsCons(l: Listing): string {
  const c = config.criteria;
  const pros: string[] = [];
  const cons: string[] = [];
  if (l.commute_min !== null && l.commute_min <= 10) pros.push('очень близко к школе');
  if (l.condition === 'new' || l.condition === 'renovated') pros.push(CONDITION_RU[l.condition]);
  if (l.price !== null && l.price <= c.maxPrice - 30000) pros.push('заметно ниже бюджета');
  if (l.bathrooms !== null && l.bathrooms >= 3) pros.push(`${l.bathrooms} санузла`);
  if (l.price !== null && l.price > c.maxPrice) cons.push('выше бюджета, нужен торг');
  if (l.commute_min !== null && l.commute_min > c.preferredCommuteMin) cons.push(`дорога ${Math.round(l.commute_min)} мин`);
  if (l.condition === 'needs_renovation') cons.push('нужен ремонт');
  if (l.elevator === false) cons.push('нет лифта');
  return `➕ ${pros[0] ?? '—'}  ➖ ${cons[0] ?? '—'}`;
}

const Out = z.object({
  items: z.array(z.object({ id: z.string(), text: z.string() })),
});

const SYSTEM = `Ты помогаешь семье выбрать квартиру T3 рядом с международной школой в Alfragide (Amadora).
Для каждого объявления напиши ОДНУ строку на русском (до 200 символов): очень краткое описание и затем "➕ <один плюс> ➖ <один минус>".
Используй ТОЛЬКО переданные поля (включая title/description). Ничего не придумывай: если данных для плюса или минуса нет, пиши "—".
Не повторяй цену, площадь и время в пути цифрами — они уже показаны отдельно. Без markdown и HTML.`;

/** Claude-generated "description + one plus + one minus", cached per listing+price. */
export async function summarize(store: Store, listings: Listing[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const todo: Listing[] = [];
  for (const l of listings) {
    const cached = store.kvGet<string>(`sum:${l.id}:${l.price}`);
    if (cached) out.set(l.id, cached);
    else todo.push(l);
  }
  if (!todo.length) return out;
  if (!config.anthropic.enabled) {
    for (const l of todo) out.set(l.id, ruleBasedProsCons(l));
    return out;
  }
  const client = new Anthropic();
  for (let i = 0; i < todo.length; i += 15) {
    const batch = todo.slice(i, i + 15);
    const input = batch.map((l) => ({
      id: l.id, title: l.title, description: l.description?.slice(0, 600) ?? null, price_eur: l.price, area_m2: l.area_m2,
      price_per_m2: l.price_per_m2, bathrooms: l.bathrooms, garage: l.garage, floor: l.floor, elevator: l.elevator,
      condition: l.condition, neighborhood: l.neighborhood, municipality: l.municipality,
      commute_min_to_school: l.commute_min === null ? null : Math.round(l.commute_min),
      budget_eur: config.criteria.maxPrice,
    }));
    try {
      const res = await client.messages.parse({
        model: config.anthropic.model,
        max_tokens: 4000,
        system: SYSTEM,
        messages: [{ role: 'user', content: JSON.stringify(input) }],
        output_config: { format: zodOutputFormat(Out) },
      });
      const parsed = res.parsed_output;
      if (!parsed) throw new Error(`no parsed output (stop_reason=${res.stop_reason})`);
      for (const it of parsed.items) {
        if (!batch.some((l) => l.id === it.id)) continue;
        out.set(it.id, it.text);
        const l = batch.find((x) => x.id === it.id)!;
        store.kvSet(`sum:${l.id}:${l.price}`, it.text);
      }
    } catch (e) {
      log.warn(`Claude summary failed, using rule-based fallback: ${(e as Error).message}`);
    }
    for (const l of batch) if (!out.has(l.id)) out.set(l.id, ruleBasedProsCons(l));
  }
  return out;
}
