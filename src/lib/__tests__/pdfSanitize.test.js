import { describe, expect, it } from 'vitest';
import { cloneForCapture } from '@/lib/pdfSanitize';

class FakeElement {
  constructor(tagName, attrs = {}, children = []) {
    this.tagName = tagName;
    this.removed = false;
    this.attributes = Object.entries(attrs).map(([name, value]) => ({ name, value }));
    this.children = children;
  }

  cloneNode(deep) {
    return new FakeElement(
      this.tagName,
      Object.fromEntries(this.attributes.map((attr) => [attr.name, attr.value])),
      deep ? this.children.map((child) => child.cloneNode(true)) : []
    );
  }

  querySelectorAll(selector) {
    const all = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (!child.removed && child.matches(selector)) all.push(child);
        visit(child);
      }
    };
    visit(this);
    return all;
  }

  matches(selector) {
    if (selector === '*') return true;
    if (selector === 'link[rel="import"]') {
      return this.tagName.toLowerCase() === 'link' && this.getAttribute('rel') === 'import';
    }
    return this.tagName.toLowerCase() === selector.toLowerCase();
  }

  remove() {
    this.removed = true;
  }

  getAttribute(name) {
    return this.attributes.find((attr) => attr.name === name)?.value ?? null;
  }

  removeAttribute(name) {
    this.attributes = this.attributes.filter((attr) => attr.name !== name);
  }
}

const liveNode = () => new FakeElement('section', { onclick: 'liveHandler()' }, [
  new FakeElement('svg', {}, [
    new FakeElement('foreignObject', {}, [
      new FakeElement('script', {}, []),
    ]),
  ]),
  new FakeElement('a', { href: ' javascript:alert(1)', onmouseover: 'steal()' }, []),
  new FakeElement('img', { src: 'https://example.invalid/image.png', onerror: 'steal()' }, []),
  new FakeElement('link', { rel: 'import', href: 'https://example.invalid/import.html' }, []),
]);

describe('pdfSanitize', () => {
  it('removes script-capable nodes and attributes from a cloned capture tree', () => {
    const original = liveNode();

    const clone = cloneForCapture(original);

    expect(original.getAttribute('onclick')).toBe('liveHandler()');
    expect(clone.getAttribute('onclick')).toBeNull();
    expect(original.querySelectorAll('foreignObject')).toHaveLength(1);
    expect(clone.querySelectorAll('foreignObject')).toHaveLength(0);
    expect(clone.querySelectorAll('script')).toHaveLength(0);
    expect(clone.querySelectorAll('link[rel="import"]')).toHaveLength(0);
    expect(clone.querySelectorAll('*').every((node) => (
      node.attributes.every((attr) => !/^on/i.test(attr.name))
    ))).toBe(true);
    expect(clone.querySelectorAll('a')[0].getAttribute('href')).toBeNull();
    expect(clone.querySelectorAll('img')[0].getAttribute('src')).toBe('https://example.invalid/image.png');
  });

  it('rejects non-elements instead of silently sanitizing nothing', () => {
    expect(() => cloneForCapture(null)).toThrow(TypeError);
  });
});
