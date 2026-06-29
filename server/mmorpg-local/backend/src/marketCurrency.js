import { CUR } from './economy.js';

export const MARKET_CURRENCIES = [CUR.copper, CUR.silver, CUR.gold, CUR.diamond];
const BASE = 1000;

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

const toInt = (v) => Math.trunc(Number(v) || 0);

export function splitMarketMoney(total) {
  const n = Math.max(0, toInt(total));
  return {
    gold: Math.floor(n / (BASE * BASE)),
    silver: Math.floor(n / BASE) % BASE,
    copper: n % BASE,
  };
}

export function displayMarketPrice(currencyId, price) {
  const id = Number(currencyId) || CUR.copper;
  const n = Math.max(0, toInt(price));
  if (id === CUR.diamond) {
    return { currencyId: CUR.diamond, currency: 'diamond', price: n, diamond: n };
  }
  const total = id === CUR.gold ? n * BASE * BASE
    : id === CUR.silver ? n * BASE
      : n;
  return { currencyId: CUR.copper, currency: 'money', price: total, money: splitMarketMoney(total) };
}

export function normalizeMarketPrice(raw, fallback = {}) {
  raw = raw && typeof raw === 'object' ? raw : {};
  const requestedCurrency = normalizeMarketCurrency(raw.currencyId ?? raw.currency ?? fallback.currencyId);
  const wantsDiamond = requestedCurrency === CUR.diamond || raw.priceMode === 'diamond' || raw.mode === 'diamond';
  if (wantsDiamond) {
    const amount = toInt(raw.diamond ?? raw.price ?? fallback.price);
    if (amount < 1) return null;
    return { currencyId: CUR.diamond, price: amount };
  }

  const money = raw.money && typeof raw.money === 'object' ? raw.money : raw;
  const hasParts = ['gold', 'silver', 'copper'].some((k) => money[k] != null);
  if (!hasParts) {
    const oldCurrency = requestedCurrency || normalizeMarketCurrency(fallback.currencyId) || CUR.copper;
    const amount = toInt(raw.price ?? fallback.price);
    if (amount < 1) return null;
    if (oldCurrency === CUR.diamond) return { currencyId: CUR.diamond, price: amount };
    const display = displayMarketPrice(oldCurrency, amount);
    return { currencyId: CUR.copper, price: display.price };
  }

  const gold = toInt(money.gold);
  const silver = toInt(money.silver);
  const copper = toInt(money.copper);
  if (gold < 0 || silver < 0 || copper < 0 || silver >= BASE || copper >= BASE) return null;
  const total = gold * BASE * BASE + silver * BASE + copper;
  if (total < 1) return null;
  return { currencyId: CUR.copper, price: total };
}
