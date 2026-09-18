/**
 * P7 independent observers (Annex B §B5.3).
 *
 * Implementation-owned counters (`projectionCounters`,
 * `localTripRepository.js:678-692`) remain useful and remain asserted — but they
 * **cannot be the release proof for their own code**. Everything measured here
 * is measured at a boundary *outside* the code under test:
 *
 *   - IndexedDB is observed by wrapping the factory/database/transaction/store/
 *     index/cursor objects the repository receives, so every statement, cursor
 *     advance and delivered row is counted without importing a repository module;
 *   - decryption is observed at the `securePayloadCrypto` module boundary;
 *   - point decoding is observed at the decoder boundary;
 *   - the native bridge is observed by wrapping the registered Capacitor plugin
 *     object, counting invocations and JSON payload bytes in both directions.
 *
 * These observers never read an implementation accounting field and never
 * change a product result: every wrapper forwards its call unchanged and returns
 * the real value.
 */

const encoder = new TextEncoder();

/** Byte size of a value as it crosses a boundary. Structural, not an accounting field. */
export const observedBytes = (value) => {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'string') return encoder.encode(value).byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  try {
    return encoder.encode(JSON.stringify(value)).byteLength;
  } catch {
    return 0;
  }
};

const emptyIdbCounts = () => ({
  databasesOpened: 0,
  transactions: 0,
  objectStoreOpens: 0,
  indexOpens: 0,
  statements: 0,
  getCalls: 0,
  getAllCalls: 0,
  countCalls: 0,
  openCursorCalls: 0,
  cursorAdvances: 0,
  // Rows delivered by a **cursor walk**. A cursor traversal is the source scan,
  // so this is the quantity the growth law bounds at `k + 1`. Point reads by key
  // are counted separately: conflating them would make a page of `k` rows look
  // like `2k + 1` source rows and hide a real regression behind a noisy budget.
  sourceRowsVisited: 0,
  pointReads: 0,
  rowsDelivered: 0,
  bytesDelivered: 0,
  wholeStoreGetAlls: 0,
  byStore: {},
});

/**
 * Wrap an IndexedDB factory so every call the code under test makes is counted.
 *
 * @param {{open: Function}} factory the `indexedDB` object (real or fake)
 * @returns {{factory: object, counts: object, reset: () => void}}
 */
export function observeIndexedDb(factory) {
  const counts = emptyIdbCounts();
  const bump = (store, field, by = 1) => {
    counts[field] += by;
    const bucket = counts.byStore[store] ?? (counts.byStore[store] = {
      statements: 0, rowsDelivered: 0, cursorAdvances: 0, bytesDelivered: 0,
    });
    if (field in bucket) bucket[field] += by;
  };

  /**
   * Observe a request by intercepting `result`.
   *
   * Charging on read rather than on the success event works identically for a
   * real `IDBRequest` (whose `result` is a prototype accessor) and for a test
   * double (which assigns an own data property), and it never replaces the
   * caller's `onsuccess` handler — so the observer cannot change what the code
   * under test sees or when it sees it.
   */
  const watchRequest = (request, store, { isCursor = false, unbounded = false } = {}) => {
    if (!request || typeof request !== 'object') return request;

    const prototypeResult = (() => {
      let proto = Object.getPrototypeOf(request);
      while (proto) {
        const descriptor = Object.getOwnPropertyDescriptor(proto, 'result');
        if (descriptor?.get) return descriptor.get;
        proto = Object.getPrototypeOf(proto);
      }
      return null;
    })();

    let own;
    let hasOwn = Object.prototype.hasOwnProperty.call(request, 'result');
    if (hasOwn) own = request.result;
    let lastCharged;
    let cursorSeen = false;

    const charge = (result) => {
      if (isCursor) {
        if (!result) return;
        if (cursorSeen) bump(store, 'cursorAdvances');
        cursorSeen = true;
        bump(store, 'rowsDelivered');
        counts.sourceRowsVisited += 1;
        bump(store, 'bytesDelivered', observedBytes(result.value));
        return;
      }
      if (Array.isArray(result)) {
        bump(store, 'rowsDelivered', result.length);
        counts.pointReads += result.length;
        if (unbounded) counts.wholeStoreGetAlls += 1;
      } else if (result !== undefined && result !== null) {
        bump(store, 'rowsDelivered');
        counts.pointReads += 1;
      }
      bump(store, 'bytesDelivered', observedBytes(result));
    };

    Object.defineProperty(request, 'result', {
      configurable: true,
      get() {
        const value = hasOwn ? own : prototypeResult?.call(request);
        if (value !== undefined && value !== lastCharged) {
          lastCharged = value;
          charge(value);
        }
        return value;
      },
      set(value) {
        hasOwn = true;
        own = value;
      },
    });
    return request;
  };

  const wrapQueryable = (target, storeName, kind) => new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      if (prop === 'index') {
        return (...args) => {
          counts.indexOpens += 1;
          return wrapQueryable(value.apply(obj, args), `${storeName}#${args[0]}`, 'index');
        };
      }
      if (['get', 'getAll', 'getAllKeys', 'count', 'openCursor', 'openKeyCursor'].includes(prop)) {
        return (...args) => {
          bump(storeName, 'statements');
          if (prop === 'get') counts.getCalls += 1;
          if (prop === 'getAll' || prop === 'getAllKeys') counts.getAllCalls += 1;
          if (prop === 'count') counts.countCalls += 1;
          const isCursor = prop === 'openCursor' || prop === 'openKeyCursor';
          if (isCursor) counts.openCursorCalls += 1;
          const unbounded = (prop === 'getAll' || prop === 'getAllKeys')
            && kind === 'store' && (args[0] === undefined || args[0] === null);
          return watchRequest(value.apply(obj, args), storeName, { isCursor, unbounded });
        };
      }
      return value.bind(obj);
    },
  });

  const wrapTransaction = (transaction) => new Proxy(transaction, {
    get(obj, prop, receiver) {
      if (prop === 'objectStore') {
        return (name) => {
          counts.objectStoreOpens += 1;
          return wrapQueryable(obj.objectStore(name), name, 'store');
        };
      }
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });

  const wrapDatabase = (database) => new Proxy(database, {
    get(obj, prop, receiver) {
      if (prop === 'transaction') {
        return (...args) => {
          counts.transactions += 1;
          return wrapTransaction(obj.transaction(...args));
        };
      }
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });

  const wrappedFactory = new Proxy(factory, {
    get(obj, prop, receiver) {
      if (prop === 'open') {
        return (...args) => {
          counts.databasesOpened += 1;
          const request = obj.open(...args);
          // Same read-time interception as `watchRequest`: the database the
          // caller receives is the wrapped one, whether the underlying request
          // exposes `result` as a prototype accessor or as an own property.
          const prototypeResult = (() => {
            let proto = Object.getPrototypeOf(request);
            while (proto) {
              const descriptor = Object.getOwnPropertyDescriptor(proto, 'result');
              if (descriptor?.get) return descriptor.get;
              proto = Object.getPrototypeOf(proto);
            }
            return null;
          })();
          let own;
          let hasOwn = Object.prototype.hasOwnProperty.call(request, 'result');
          if (hasOwn) own = request.result;
          let source;
          let wrapped;
          Object.defineProperty(request, 'result', {
            configurable: true,
            get() {
              const value = hasOwn ? own : prototypeResult?.call(request);
              if (!value) return value;
              if (value !== source) { source = value; wrapped = wrapDatabase(value); }
              return wrapped;
            },
            set(value) { hasOwn = true; own = value; },
          });
          return request;
        };
      }
      const value = Reflect.get(obj, prop, receiver);
      return typeof value === 'function' ? value.bind(obj) : value;
    },
  });

  return {
    factory: wrappedFactory,
    counts,
    reset: () => Object.assign(counts, emptyIdbCounts()),
  };
}

const emptyCryptoCounts = () => ({
  decryptCalls: 0,
  valuesDecrypted: 0,
  decodedBytes: 0,
  fullTripDecrypts: 0,
  projectionDecrypts: 0,
  byContext: {},
});

/**
 * Wrap the `securePayloadCrypto` decrypt boundary.
 *
 * Use from a test with a passthrough module mock:
 *
 *   const crypto = createCryptoObserver();
 *   vi.mock('@/lib/securePayloadCrypto', async (importOriginal) =>
 *     crypto.wrapModule(await importOriginal()));
 *
 * A full-trip decrypt is identified by its context (`trip:<id>`); a projection
 * decrypt by the projection context. Neither classification reads an
 * implementation counter.
 *
 * @param {{fullTripContext?: RegExp, projectionContext?: RegExp}} [options]
 */
export function createCryptoObserver(options = {}) {
  const fullTripContext = options.fullTripContext ?? /^trip:/;
  const projectionContext = options.projectionContext ?? /projection/i;
  const counts = emptyCryptoCounts();

  const charge = (context, value) => {
    const key = String(context ?? 'unknown');
    counts.valuesDecrypted += 1;
    counts.decodedBytes += observedBytes(value);
    counts.byContext[key] = (counts.byContext[key] ?? 0) + 1;
    if (fullTripContext.test(key)) counts.fullTripDecrypts += 1;
    else if (projectionContext.test(key)) counts.projectionDecrypts += 1;
  };

  return {
    counts,
    reset: () => Object.assign(counts, emptyCryptoCounts()),
    wrapModule(original) {
      return {
        ...original,
        decryptSensitiveValue: async (payload, context) => {
          counts.decryptCalls += 1;
          const result = await original.decryptSensitiveValue(payload, context);
          charge(context, result);
          return result;
        },
        decryptSensitiveValues: async (entries = [], opts) => {
          counts.decryptCalls += 1;
          const result = await original.decryptSensitiveValues(entries, opts);
          entries.forEach((item, index) => charge(item?.context, result?.[index]));
          return result;
        },
      };
    },
  };
}

const emptyBridgeCounts = () => ({ invocations: 0, bytesSent: 0, bytesReceived: 0, byMethod: {} });

/**
 * Wrap a registered Capacitor plugin object so every bridge crossing is counted
 * with its payload size in both directions.
 * @param {object} plugin
 */
export function observeBridge(plugin) {
  const counts = emptyBridgeCounts();
  const wrapped = new Proxy(plugin, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== 'function') return value;
      return async (...args) => {
        const method = String(prop);
        counts.invocations += 1;
        counts.bytesSent += observedBytes(args[0]);
        counts.byMethod[method] = (counts.byMethod[method] ?? 0) + 1;
        const result = await value.apply(obj, args);
        counts.bytesReceived += observedBytes(result);
        return result;
      };
    },
  });
  return { plugin: wrapped, counts, reset: () => Object.assign(counts, emptyBridgeCounts()) };
}

const emptyPointCounts = () => ({ decodeCalls: 0, pointsDecoded: 0, decodedBytes: 0 });

/**
 * Wrap a route-point decoder so decoded points and bytes are observed outside
 * the decoding implementation.
 * @param {Function} decode
 */
export function observePointDecoding(decode) {
  const counts = emptyPointCounts();
  const wrapped = (...args) => {
    counts.decodeCalls += 1;
    const result = decode(...args);
    if (Array.isArray(result)) {
      counts.pointsDecoded += result.length;
      counts.decodedBytes += observedBytes(result);
    }
    return result;
  };
  return { decode: wrapped, counts, reset: () => Object.assign(counts, emptyPointCounts()) };
}

/**
 * The native-side observations that are not visible from JS. Stage 2 and Stage
 * 10 supply them from the Android instrumentation harness; the shape is frozen
 * here so the evidence is comparable across stages.
 */
export const P7_NATIVE_OBSERVER_CONTRACT = Object.freeze({
  bridgeInvocationCount: 'observed in JS by observeBridge()',
  bridgePayloadBytes: 'observed in JS by observeBridge()',
  sqliteStatementsExecuted: 'Android instrumentation — count statements compiled/executed per request',
  sqliteQueryPlan: 'Android instrumentation — EXPLAIN QUERY PLAN for every history and aggregate query',
  sqliteRowVisits: 'Android instrumentation — observed row work where observable',
});

/**
 * The growth law, restated as the assertion every page/query budget test makes.
 * For a fixed page request these must hold and be invariant in N, P and S.
 */
export const P7_GROWTH_LAW = Object.freeze({
  sourceRowsVisited: '<= k + 1',
  projectionDecrypts: '<= k',
  fullTripDecrypts: 0,
  historySorts: 0,
  wholeStoreGetAlls: 0,
  topLevelCompositionsPerEvent: 1,
  duplicateHistoryAcquisitionsPerRender: 0,
  wallClock: 'observational evidence only, never the sole proof',
});
