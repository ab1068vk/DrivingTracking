import { expect } from '@playwright/test';

const pageState = new WeakMap();

export function installGlobalAssert(page) {
  const state = {
    pageErrors: [],
    consoleErrors: [],
  };
  pageState.set(page, state);

  page.on('pageerror', (err) => {
    state.pageErrors.push(err.message);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') state.consoleErrors.push(msg.text());
  });
}

export async function globalAssert(page) {
  const state = pageState.get(page) || { pageErrors: [], consoleErrors: [] };

  expect(state.pageErrors.filter((message) => (
    /ReferenceError|TypeError|SyntaxError|Uncaught/.test(message)
  ))).toHaveLength(0);

  expect(state.consoleErrors.filter((message) => (
    /UnhandledPromiseRejection|Cannot read|undefined is not/.test(message)
  ))).toHaveLength(0);

  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(page).toHaveTitle(/Road Sage/i);

  const spinners = page.locator('[aria-label="Loading"], [data-testid="spinner"]');
  if (await spinners.count() > 0) {
    await expect(spinners.first()).not.toBeVisible({ timeout: 8000 });
  }
}
