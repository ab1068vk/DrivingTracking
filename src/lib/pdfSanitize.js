const BLOCKED_ELEMENTS = [
  'script',
  'iframe',
  'object',
  'embed',
  'link[rel="import"]',
  'foreignObject',
];

const URL_ATTRIBUTES = ['href', 'src', 'action', 'formaction', 'xlink:href'];

export function cloneForCapture(element) {
  if (!element || typeof element.cloneNode !== 'function') {
    throw new TypeError('cloneForCapture requires a DOM element.');
  }

  const clone = element.cloneNode(true);

  for (const selector of BLOCKED_ELEMENTS) {
    clone.querySelectorAll(selector).forEach((blocked) => blocked.remove());
  }

  [clone, ...clone.querySelectorAll('*')].forEach((child) => {
    if (!child.attributes) return;

    for (const attr of [...child.attributes]) {
      if (/^on/i.test(attr.name)) {
        child.removeAttribute(attr.name);
      }
    }

    for (const urlAttr of URL_ATTRIBUTES) {
      const value = child.getAttribute(urlAttr);
      if (value && /^\s*javascript:/i.test(value)) {
        child.removeAttribute(urlAttr);
      }
    }
  });

  return clone;
}
