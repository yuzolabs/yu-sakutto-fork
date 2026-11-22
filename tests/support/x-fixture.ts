import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Loads one of the synthetic x.com pages from `e2e/fixtures/` into a document and runs its
 * toggle script, which mimics X's own "Show original" / "Show translation" control. The same
 * files back the browser tests, so the markup the unit tests read is the markup e2e serves.
 *
 * Returns a cleanup that removes the listeners the fixture script added.
 */
export function loadXFixture(name: 'x-body.html' | 'x-article.html', target: Document): () => void {
  const html = readFileSync(join(import.meta.dirname, '../../e2e/fixtures', name), 'utf8');
  const parsed = new DOMParser().parseFromString(html, 'text/html');
  target.documentElement.lang = parsed.documentElement.lang;
  target.body.innerHTML = parsed.body.innerHTML;
  target.getElementById('x-fixture-toggle')?.remove();

  const script = parsed.getElementById('x-fixture-toggle')?.textContent ?? '';
  const listeners: Array<[string, EventListenerOrEventListenerObject]> = [];
  const tracked = new Proxy(target, {
    get(object, property) {
      if (property === 'addEventListener') {
        return (type: string, listener: EventListenerOrEventListenerObject) => {
          listeners.push([type, listener]);
          object.addEventListener(type, listener);
        };
      }
      const value: unknown = Reflect.get(object, property, object);
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(object)
        : value;
    },
  });
  if (script.length > 0) {
    // The fixture's own script, run against the target document instead of the global one.
    const run = new Function('document', script) as (doc: Document) => void;
    run(tracked);
  }
  return () => {
    for (const [type, listener] of listeners) target.removeEventListener(type, listener);
  };
}

/** How many times the fixture recorded a "Show original" press, per item. */
export function fixturePresses(target: Document): Record<string, number> {
  const raw = target.documentElement.dataset.fixturePresses;
  return raw ? (JSON.parse(raw) as Record<string, number>) : {};
}
