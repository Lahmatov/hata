import { expect, test } from '@playwright/test';
import { condoFee, costsLine, imtHpp, jovemTaxes, purchaseCosts } from '../src/costs.ts';

test('IMT 2026 (own permanent home): brackets join without jumps', () => {
  expect(imtHpp(100_000)).toBe(0);
  expect(imtHpp(400_000)).toBeCloseTo(400_000 * 0.08 - 13_763.35, 2);
  for (const limit of [106_346, 145_470, 198_347, 330_539]) expect(Math.abs(imtHpp(limit) - imtHpp(limit + 1))).toBeLessThan(0.1);
  expect(imtHpp(700_000)).toBeCloseTo(42_000, 2);
});

test('purchase costs and mortgage payment', () => {
  const c = purchaseCosts(400_000, { jovem: false, share: 0.8, rate: 0.032, years: 30, registry: 700 });
  expect(Math.round(c.imt)).toBe(18_237);
  expect(c.selo).toBe(3200);
  expect(c.seloLoan).toBeCloseTo(1920, 6);
  expect(Math.round(c.monthly)).toBe(1384);
  expect(costsLine(400_000, 'Condomínio: 45€/mês', { jovem: false, share: 0.8, rate: 0.032, years: 30, registry: 700 }))
    .toBe('💶 при покупке ≈ 24,1 тыс. € (IMT 18,2 · гербовый 3,2 + 1,9 · регистрация 0,7) · ипотека 80% на 30 лет под 3,2%: ≈ 1 384 €/мес · кондоминиум 45 €/мес');
});

test('condominium fee only when the ad states it', () => {
  expect(condoFee('Despesas de condomínio de 60 € mensais')).toBe(60);
  expect(condoFee('condominio 35,50€')).toBe(36);
  expect(condoFee('Preço 395.000 €, condomínio fechado')).toBeNull();
  expect(condoFee(null)).toBeNull();
});

test('IMT Jovem: nothing up to 330 539 €, 8% and 0.8% on the part above, full rates over 660 982 €', () => {
  expect(jovemTaxes(300_000)).toEqual({ imt: 0, selo: 0 });
  const t = jovemTaxes(400_000);
  expect(t.imt).toBeCloseTo(69_461 * 0.08, 6);
  expect(t.selo).toBeCloseTo(69_461 * 0.008, 6);
  expect(jovemTaxes(700_000).imt).toBeCloseTo(42_000, 2);
  const c = purchaseCosts(400_000, { jovem: true, share: 0.8, rate: 0.032, years: 30, registry: 700 });
  expect(Math.round(c.total)).toBe(Math.round(5_556.88 + 555.69 + 1_920 + 700));
  expect(costsLine(400_000, null, { jovem: true, share: 0.8, rate: 0.032, years: 30, registry: 700 })).toContain('(IMT Jovem 5,6 · гербовый 0,6 + 1,9 · регистрация 0,7)');
});
