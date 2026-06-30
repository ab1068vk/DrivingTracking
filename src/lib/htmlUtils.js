export const escapeHtml = (value) => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

export const escapeCssIdentifier = (value) => String(value ?? '')
  .replace(/[^a-zA-Z0-9_-]/g, '_')
  .slice(0, 80);

export const sanitizeCssColor = (value, fallback = 'transparent') => {
  const color = String(value ?? '').trim();
  if (!color || color.length > 120) return fallback;

  if (/^#[0-9a-fA-F]{3,8}$/.test(color)) return color;
  if (/^(?:rgb|rgba|hsl|hsla)\([0-9\s,./%+-]+\)$/.test(color)) return color;
  if (/^(?:rgb|rgba|hsl|hsla)\(\s*var\(--[a-zA-Z0-9_-]+\)(?:\s*\/\s*[0-9.]+%?)?\s*\)$/.test(color)) return color;
  if (/^var\(--[a-zA-Z0-9_-]+\)$/.test(color)) return color;
  if (/^[a-zA-Z]+$/.test(color)) return color;

  return fallback;
};
