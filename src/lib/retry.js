const circuits = new Map();

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const circuitFor = (key) => {
  const current = circuits.get(key) || { failures: 0, openedUntil: 0 };
  if (current.openedUntil <= Date.now()) return current;
  const error = new Error(`${key} temporarily unavailable`);
  error.name = 'CircuitOpenError';
  throw error;
};

export async function withRetry(key, operation, {
  retries = 1,
  delayMs = 2000,
  cooldownMs = 30000,
  shouldRetry = (error) => error?.name !== 'AbortError',
} = {}) {
  circuitFor(key);
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const result = await operation(attempt);
      circuits.set(key, { failures: 0, openedUntil: 0 });
      return result;
    } catch (error) {
      lastError = error;
      if (attempt >= retries || !shouldRetry(error)) break;
      await sleep(delayMs);
    }
  }

  const current = circuits.get(key) || { failures: 0, openedUntil: 0 };
  const failures = current.failures + 1;
  circuits.set(key, {
    failures,
    openedUntil: failures >= 3 ? Date.now() + cooldownMs : 0,
  });
  throw lastError;
}

export function resetRetryCircuits() {
  circuits.clear();
}
