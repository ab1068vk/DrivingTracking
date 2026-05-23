export const CURRENCY_SYMBOL_OPTIONS = [
  { value: '$', label: '$' },
  { value: '€', label: '€' },
  { value: '£', label: '£' },
  { value: 'kr', label: 'kr' },
  { value: '¥', label: '¥' },
  { value: '₹', label: '₹' },
  { value: '₺', label: '₺' },
];

const DEFAULT_CURRENCY_SYMBOL = '$';
const ALLOWED_SYMBOLS = new Set(CURRENCY_SYMBOL_OPTIONS.map((option) => option.value));

export function normalizeCurrencySymbol(value, fallback = DEFAULT_CURRENCY_SYMBOL) {
  const symbol = String(value ?? '').trim();
  return ALLOWED_SYMBOLS.has(symbol) ? symbol : fallback;
}

export function formatCurrencyAmount(amount, settingsOrSymbol = DEFAULT_CURRENCY_SYMBOL) {
  const symbol = normalizeCurrencySymbol(
    typeof settingsOrSymbol === 'string' ? settingsOrSymbol : settingsOrSymbol?.currencySymbol
  );
  const value = Number(amount);
  return `${symbol}${Number.isFinite(value) ? value.toFixed(2) : '0.00'}`;
}
