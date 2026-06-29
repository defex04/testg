import { CUR } from './economy.js';

export const MARKET_CURRENCIES = [CUR.copper, CUR.silver, CUR.gold, CUR.diamond];

export const MARKET_CURRENCY_CODE = {
  [CUR.copper]: 'copper',
  [CUR.silver]: 'silver',
  [CUR.gold]: 'gold',
  [CUR.diamond]: 'diamond',
};

const MARKET_CURRENCY_ID = Object.fromEntries(
  Object.entries(MARKET_CURRENCY_CODE).map(([id, code]) => [code, Number(id)]),
);

export function normalizeMarketCurrency(raw) {
  if (raw == null || raw === '') return CUR.copper;
  if (typeof raw === 'string' && MARKET_CURRENCY_ID[raw]) return MARKET_CURRENCY_ID[raw];
  const id = Number(raw);
  return MARKET_CURRENCIES.includes(id) ? id : null;
}

export function marketCurrencyCode(id) {
  return MARKET_CURRENCY_CODE[Number(id)] || MARKET_CURRENCY_CODE[CUR.copper];
}
