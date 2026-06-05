export const CURRENCY_SYMBOL_OPTIONS = [
  { value: '$', label: '$' },
  { value: '\u20ac', label: '\u20ac' },
  { value: '\u00a3', label: '\u00a3' },
  { value: 'kr', label: 'kr' },
  { value: '\u00a5', label: '\u00a5' },
  { value: '\u20b9', label: '\u20b9' },
  { value: '\u20ba', label: '\u20ba' },
];

const DEFAULT_CURRENCY_SYMBOL = '$';
const ALLOWED_SYMBOLS = new Set(CURRENCY_SYMBOL_OPTIONS.map((option) => option.value));

export function normalizeCurrencySymbol(value, fallback = DEFAULT_CURRENCY_SYMBOL) {
  const symbol = String(value ?? '').trim();
  return ALLOWED_SYMBOLS.has(symbol) ? symbol : fallback;
}

/**
 * @param {number} amount
 * @param {string|{currencySymbol?:string}} settingsOrSymbol
 */
export function formatCurrencyAmount(amount, settingsOrSymbol = DEFAULT_CURRENCY_SYMBOL) {
  const symbol = normalizeCurrencySymbol(
    typeof settingsOrSymbol === 'string' ? settingsOrSymbol : settingsOrSymbol?.currencySymbol
  );
  const value = Number(amount);
  return `${symbol}${Number.isFinite(value) ? value.toFixed(2) : '0.00'}`;
}
