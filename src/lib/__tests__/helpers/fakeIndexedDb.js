const makeDomStringList = (values) => ({
  contains: (value) => values.has(value),
  item: (index) => [...values][index] ?? null,
  get length() {
    return values.size;
  },
  [Symbol.iterator]: () => values[Symbol.iterator](),
});

const cloneValue = (value) => (value === undefined ? undefined : structuredClone(value));
const primaryMapKey = (key) => Array.isArray(key) ? `compound:${JSON.stringify(key)}` : key;
const INVALID_INDEX_KEY = Symbol('invalid-index-key');

const valueAtKeyPath = (value, keyPath) => {
  let current = value;
  for (const part of keyPath.split('.')) {
    if (current === null || typeof current !== 'object' || !(part in current)) {
      return INVALID_INDEX_KEY;
    }
    current = current[part];
  }
  return current;
};

// The diagnostics indexes use only strings, finite numbers, and compound arrays
// of those values. Modeling that exact domain is enough to expose silent sparse-
// index omissions without turning this helper into a complete IndexedDB clone.
const isDiagnosticsIndexKey = (value) => (
  (typeof value === 'string')
  || (typeof value === 'number' && Number.isFinite(value))
  || (Array.isArray(value) && value.every(isDiagnosticsIndexKey))
);

const evaluateIndexKey = (value, keyPath) => {
  const candidate = Array.isArray(keyPath)
    ? keyPath.map((part) => valueAtKeyPath(value, part))
    : valueAtKeyPath(value, keyPath);
  return isDiagnosticsIndexKey(candidate) ? candidate : INVALID_INDEX_KEY;
};

const compareKeys = (left, right) => {
  if (Array.isArray(left) !== Array.isArray(right)) return Array.isArray(left) ? 1 : -1;
  if (!Array.isArray(left) && typeof left !== typeof right) return typeof left === 'number' ? -1 : 1;
  if (Array.isArray(left) && Array.isArray(right)) {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const comparison = compareKeys(left[index], right[index]);
      if (comparison !== 0) return comparison;
    }
    return left.length - right.length;
  }
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

const keyInRange = (key, range) => {
  if (!range) return true;
  // Native IndexedDB accepts a scalar or compound key anywhere a key range is
  // accepted. Treat those as exact matches before inspecting range fields.
  if (typeof range !== 'object' || Array.isArray(range)) return compareKeys(key, range) === 0;
  if ('only' in range) return compareKeys(key, range.only) === 0;
  if ('lower' in range) {
    const comparison = compareKeys(key, range.lower);
    if (comparison < 0 || (comparison === 0 && range.lowerOpen)) return false;
  }
  if ('upper' in range) {
    const comparison = compareKeys(key, range.upper);
    if (comparison > 0 || (comparison === 0 && range.upperOpen)) return false;
  }
  return true;
};

class FakeIndex {
  constructor(transaction, state, definition) {
    this.transaction = transaction;
    this.state = state;
    this.definition = definition;
  }

  entries(records) {
    const entries = [];
    records.forEach((record, primaryKey) => {
      const key = evaluateIndexKey(record, this.definition.keyPath);
      if (key !== INVALID_INDEX_KEY) entries.push({ key, primaryKey, record });
    });
    return entries.sort((left, right) => (
      compareKeys(left.key, right.key) || compareKeys(left.primaryKey, right.primaryKey)
    ));
  }

  get(range = null) {
    return this.transaction.enqueue(this.state.name, 'index.get', (records) => {
      const match = this.entries(records).find(({ key }) => keyInRange(key, range));
      return match ? cloneValue(match.record) : undefined;
    });
  }

  getKey(range = null) {
    return this.transaction.enqueue(this.state.name, 'index.getKey', (records) => {
      const match = this.entries(records).find(({ key }) => keyInRange(key, range));
      return match ? cloneValue(match.primaryKey) : undefined;
    });
  }

  getAll(range = null, count = undefined) {
    return this.transaction.enqueue(this.state.name, 'index.getAll', (records) => this.entries(records)
      .filter(({ key }) => keyInRange(key, range))
      .slice(0, count)
      .map(({ record }) => cloneValue(record)));
  }

  getAllKeys(range = null, count = undefined) {
    return this.transaction.enqueue(this.state.name, 'index.getAllKeys', (records) => this.entries(records)
      .filter(({ key }) => keyInRange(key, range))
      .slice(0, count)
      .map(({ primaryKey }) => cloneValue(primaryKey)));
  }

  count(range = null) {
    return this.transaction.enqueue(this.state.name, 'index.count', (records) => this.entries(records)
      .filter(({ key }) => keyInRange(key, range)).length);
  }

  /**
   * Real `IDBObjectStore.openKeyCursor` yields a cursor with **no `value`**.
   * The double must model that, because "did this walk deserialize the record?"
   * is exactly the question DPD-015B turned on: the settings rediscovery read a
   * page of whole trip rows to learn a page of ids, and a fake that quietly
   * handed back `value` anyway would let that regress unnoticed.
   */
  openKeyCursor(range = null, direction = 'next') {
    const request = this.openCursor(range, direction);
    const strip = (cursor) => (cursor ? new Proxy(cursor, {
      get: (target, prop, receiver) => {
        if (prop === 'value') return undefined;
        if (prop === 'continue') {
          return () => {
            target.continue();
            return undefined;
          };
        }
        return Reflect.get(target, prop, receiver);
      },
      has: (target, prop) => (prop === 'value' ? false : Reflect.has(target, prop)),
    }) : cursor);
    return new Proxy(request, {
      get: (target, prop, receiver) => (
        prop === 'result' ? strip(target.result) : Reflect.get(target, prop, receiver)
      ),
      set: (target, prop, value, receiver) => Reflect.set(target, prop, value, receiver),
    });
  }

  openCursor(range = null, direction = 'next') {
    let rows = null;
    let position = 0;
    let request;
    const buildCursor = (records) => {
      if (!rows) {
        rows = this.entries(records).filter(({ key }) => keyInRange(key, range));
        if (direction === 'prev' || direction === 'prevunique') rows.reverse();
      }
      const row = rows[position];
      if (!row) return null;
      return {
        key: cloneValue(row.key),
        primaryKey: cloneValue(row.primaryKey),
        value: cloneValue(row.record),
        delete: () => this.transaction.enqueue(this.state.name, 'cursor.delete', (current) => {
          if (this.transaction.mode === 'readonly') throw new Error('ReadOnlyError');
          current.delete(row.primaryKey);
        }),
        continue: () => {
          position += 1;
          const continuation = this.transaction.enqueue(this.state.name, 'index.cursor.continue', buildCursor);
          continuation.onsuccess = () => {
            request.result = continuation.result;
            request.onsuccess?.({ target: request });
          };
          continuation.onerror = (event) => {
            request.error = continuation.error;
            request.onerror?.(event);
          };
        },
        continuePrimaryKey: (key, primaryKey) => {
          // Real IndexedDB throws DataError when the requested position is not
          // strictly ahead of the cursor. The double used to accept it, so a
          // paged delete that asked the cursor to stand still passed here and
          // threw only on device (DPD-015). Enforce the spec constraint.
          const current = rows[position];
          if (current) {
            const byKey = compareKeys(current.key, key);
            const notAhead = byKey > 0
              || (byKey === 0 && compareKeys(current.primaryKey, primaryKey) >= 0);
            if (notAhead) {
              throw new DOMException(
                "Failed to execute 'continuePrimaryKey' on 'IDBCursor': "
                + "The parameter is less than or equal to this cursor's position.",
                'DataError',
              );
            }
          }
          position += 1;
          while (position < rows.length && (
            compareKeys(rows[position].key, key) < 0
            || (compareKeys(rows[position].key, key) === 0
              && compareKeys(rows[position].primaryKey, primaryKey) <= 0)
          )) position += 1;
          const continuation = this.transaction.enqueue(
            this.state.name, 'index.cursor.continuePrimaryKey', buildCursor,
          );
          continuation.onsuccess = () => {
            request.result = continuation.result;
            request.onsuccess?.({ target: request });
          };
          continuation.onerror = (event) => {
            request.error = continuation.error;
            request.onerror?.(event);
          };
        },
      };
    };
    request = this.transaction.enqueue(this.state.name, 'index.openCursor', buildCursor);
    return request;
  }
}

class FakeRequest {
  constructor() {
    this.error = null;
    this.result = undefined;
    this.onsuccess = null;
    this.onerror = null;
  }
}

class FakeObjectStore {
  constructor(transaction, state) {
    this.transaction = transaction;
    this.state = state;
    this.keyPath = state.keyPath;
  }

  get indexNames() {
    return makeDomStringList(new Set(this.state.indexes.keys()));
  }

  createIndex(name, keyPath, options = {}) {
    const failure = this.transaction.factory.consumeSchemaFailure('createIndex', name);
    if (failure) throw failure;
    if (this.state.indexes.has(name)) throw new Error(`Index already exists: ${name}`);
    const index = {
      name,
      keyPath,
      unique: Boolean(options.unique),
      multiEntry: Boolean(options.multiEntry),
    };
    this.state.indexes.set(name, index);
    return index;
  }

  deleteIndex(name) {
    const failure = this.transaction.factory.consumeSchemaFailure('deleteIndex', name);
    if (failure) throw failure;
    if (!this.state.indexes.has(name)) throw new Error(`Index not found: ${name}`);
    this.state.indexes.delete(name);
  }

  get(key) {
    return this.transaction.enqueue(this.state.name, 'get', (records) => cloneValue(records.get(primaryMapKey(key))));
  }

  getAll(range = null, count = undefined) {
    return this.transaction.enqueue(this.state.name, 'getAll', (records) => [...records.values()]
      .filter((record) => keyInRange(evaluateIndexKey(record, this.keyPath), range))
      .sort((a, b) => compareKeys(evaluateIndexKey(a, this.keyPath), evaluateIndexKey(b, this.keyPath)))
      .slice(0, count).map(cloneValue));
  }

  openCursor(range = null, direction = 'next') {
    let rows = null;
    let position = 0;
    let request;
    const buildCursor = (records) => {
      if (!rows) {
        rows = [...records.values()]
          .map((record) => ({
            key: evaluateIndexKey(record, this.keyPath),
            value: cloneValue(record),
          }))
          .filter(({ key }) => key !== INVALID_INDEX_KEY && keyInRange(key, range))
          .sort((left, right) => compareKeys(left.key, right.key));
        if (direction === 'prev' || direction === 'prevunique') rows.reverse();
      }
      const row = rows[position];
      if (!row) return null;
      return {
        key: cloneValue(row.key),
        primaryKey: cloneValue(row.key),
        value: cloneValue(row.value),
        delete: () => this.delete(row.key),
        continue: () => {
          position += 1;
          const continuation = this.transaction.enqueue(this.state.name, 'cursor.continue', buildCursor);
          continuation.onsuccess = () => {
            request.result = continuation.result;
            request.onsuccess?.({ target: request });
          };
          continuation.onerror = (event) => {
            request.error = continuation.error;
            request.onerror?.(event);
          };
        },
      };
    };
    request = this.transaction.enqueue(this.state.name, 'openCursor', buildCursor);
    return request;
  }

  add(value) {
    return this.transaction.enqueue(this.state.name, 'add', (records) => {
      if (this.transaction.mode === 'readonly') throw new Error('ReadOnlyError');
      const key = evaluateIndexKey(value, this.keyPath);
      if (key === INVALID_INDEX_KEY) throw new Error('DataError');
      if (records.has(primaryMapKey(key))) throw new Error('ConstraintError');
      records.set(primaryMapKey(key), cloneValue(value));
      this.transaction.recordPut(this.state.name);
      return key;
    });
  }

  clear() {
    return this.transaction.enqueue(this.state.name, 'clear', (records) => {
      if (this.transaction.mode === 'readonly') throw new Error('ReadOnlyError');
      records.clear();
    });
  }

  put(value) {
    return this.transaction.enqueue(this.state.name, 'put', (records) => {
      if (this.transaction.mode === 'readonly') throw new Error('ReadOnlyError');
      const key = evaluateIndexKey(value, this.keyPath);
      if (!isDiagnosticsIndexKey(key)) throw new Error(`Invalid key path: ${this.keyPath}`);
      records.set(primaryMapKey(key), cloneValue(value));
      this.transaction.recordPut(this.state.name);
      return key;
    });
  }

  delete(key) {
    return this.transaction.enqueue(this.state.name, 'delete', (records) => {
      if (this.transaction.mode === 'readonly') throw new Error('ReadOnlyError');
      records.delete(primaryMapKey(key));
      return undefined;
    });
  }

  index(name) {
    const definition = this.state.indexes.get(name);
    if (!definition) throw new Error(`Missing index: ${name}`);
    return new FakeIndex(this.transaction, this.state, definition);
  }
}

class FakeTransaction {
  constructor(factory, databaseState, storeNames, mode, { managed = true } = {}) {
    this.factory = factory;
    this.databaseState = databaseState;
    this.storeNames = storeNames;
    this.mode = mode;
    this.managed = managed;
    this.error = null;
    this._oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.aborted = false;
    this.completed = false;
    this.started = false;
    this.finished = false;
    this.queue = [];
    this.processing = false;
    this.workingRecords = null;
    this.putDeltas = new Map();
  }

  set oncomplete(handler) {
    this._oncomplete = handler;
    // IndexedDB dispatches completion as a later event. Preserve that useful
    // ordering when a test attaches the handler after awaiting the final
    // request microtask.
    if (handler && this.completed) queueMicrotask(() => handler({ target: this }));
  }

  get oncomplete() { return this._oncomplete; }

  objectStore(name) {
    // A versionchange transaction covers stores created earlier in the same
    // upgrade callback even though they were not present when the transaction
    // object was constructed.
    if (!this.storeNames.includes(name) && this.mode === 'versionchange'
      && this.databaseState.stores.has(name)) this.storeNames.push(name);
    if (!this.storeNames.includes(name)) throw new Error(`Store not in transaction: ${name}`);
    const state = this.databaseState.stores.get(name);
    if (!state) throw new Error(`Missing object store: ${name}`);
    return new FakeObjectStore(this, state);
  }

  start() {
    if (this.aborted || this.completed || this.started) return;
    this.started = true;
    if (this.mode === 'readwrite') {
      this.workingRecords = new Map(this.storeNames.map((name) => {
        const records = this.databaseState.stores.get(name).records;
        return [name, new Map([...records].map(([key, value]) => [key, cloneValue(value)]))];
      }));
    }
    queueMicrotask(() => this.drain());
  }

  enqueue(storeName, operation, run) {
    if (this.aborted || this.completed) throw new Error('TransactionInactiveError');
    const request = new FakeRequest();
    this.queue.push({ request, run, storeName, operation });
    if (this.started) this.drain();
    return request;
  }

  recordPut(storeName) {
    this.putDeltas.set(storeName, (this.putDeltas.get(storeName) ?? 0) + 1);
  }

  recordsFor(storeName) {
    if (this.mode === 'readwrite') return this.workingRecords.get(storeName);
    return this.databaseState.stores.get(storeName).records;
  }

  abort() {
    if (this.aborted || this.completed) return;
    this.aborted = true;
    this.error ??= new Error('AbortError');
    queueMicrotask(() => this.onabort?.({ target: this }));
    this.finish();
  }

  commit() {
    if (this.mode !== 'readwrite') return;
    this.storeNames.forEach((name) => {
      const state = this.databaseState.stores.get(name);
      state.records = this.workingRecords.get(name);
      state.putCount += this.putDeltas.get(name) ?? 0;
    });
  }

  finish() {
    if (this.finished) return;
    this.finished = true;
    if (this.managed) this.factory.finishTransaction(this.databaseState, this);
  }

  failRequest(request, error) {
    request.error = error;
    this.error = error;
    request.onerror?.({ target: request, preventDefault() {} });
    if (!this.aborted) this.onerror?.({ target: this, preventDefault() {} });
    if (!this.aborted) this.abort();
  }

  drain() {
    if (!this.started || this.processing || this.aborted || this.completed) return;
    const next = this.queue.shift();
    if (!next) {
      this.processing = true;
      queueMicrotask(() => {
        this.processing = false;
        if (this.aborted || this.completed || this.queue.length > 0) {
          this.drain();
          return;
        }
        try {
          this.commit();
          this.completed = true;
          this.oncomplete?.({ target: this });
          this.finish();
        } catch (error) {
          this.error = error;
          this.onerror?.({ target: this, preventDefault() {} });
          this.abort();
        }
      });
      return;
    }

    this.processing = true;
    const execute = () => {
      try {
        const injectedFailure = this.factory.consumeRequestFailure(next.storeName, next.operation);
        if (injectedFailure) throw injectedFailure;
        next.request.result = next.run(this.recordsFor(next.storeName));
        next.request.onsuccess?.({ target: next.request });
      } catch (error) {
        this.failRequest(next.request, error);
      } finally {
        this.processing = false;
        this.drain();
      }
    };
    const delayMs = this.factory.consumeRequestDelay(next.storeName, next.operation);
    if (delayMs > 0) setTimeout(execute, delayMs);
    else queueMicrotask(execute);
  }
}

class FakeDatabase {
  constructor(factory, state) {
    this.factory = factory;
    this.state = state;
    this.onversionchange = null;
    this.closed = false;
  }

  get objectStoreNames() {
    return makeDomStringList(new Set(this.state.stores.keys()));
  }

  createObjectStore(name, options) {
    const failure = this.factory.consumeSchemaFailure('createObjectStore', name);
    if (failure) throw failure;
    if (this.state.stores.has(name)) throw new Error(`Object store already exists: ${name}`);
    const state = {
      name,
      indexes: new Map(),
      keyPath: options.keyPath,
      putCount: 0,
      records: new Map(),
    };
    this.state.stores.set(name, state);
    return new FakeObjectStore(this.state.upgradeTransaction, state);
  }

  transaction(storeNames, mode = 'readonly') {
    if (this.closed) throw new Error('InvalidStateError');
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    names.forEach((name) => {
      if (!this.state.stores.has(name)) throw new Error(`Missing object store: ${name}`);
    });
    this.factory.transactionCount += 1;
    const transaction = new FakeTransaction(this.factory, this.state, names, mode);
    this.factory.queueTransaction(this.state, transaction);
    return transaction;
  }

  close() {
    this.closed = true;
  }
}

const cloneIndex = (index) => ({
  ...index,
  keyPath: Array.isArray(index.keyPath) ? [...index.keyPath] : index.keyPath,
});

const cloneDatabaseState = (state, version) => ({
  activeTransaction: null,
  stores: new Map([...(state?.stores ?? [])].map(([name, store]) => [name, {
    name,
    indexes: new Map([...store.indexes].map(([indexName, index]) => [indexName, cloneIndex(index)])),
    keyPath: store.keyPath,
    putCount: store.putCount,
    records: new Map([...store.records].map(([key, value]) => [key, cloneValue(value)])),
  }])),
  transactionQueue: [],
  upgradeTransaction: null,
  version,
});

export class FakeIndexedDb {
  constructor() {
    this.databases = new Map();
    this.openActions = [];
    this.openCalls = [];
    this.requestFailures = [];
    this.requestDelays = [];
    this.schemaFailures = [];
    this.transactionCount = 0;
    this.keyRange = Object.freeze({
      bound: (lower, upper, lowerOpen = false, upperOpen = false) => ({ lower, upper, lowerOpen, upperOpen }),
      only: (only) => ({ only }),
      lowerBound: (lower, lowerOpen = false) => ({ lower, lowerOpen }),
      upperBound: (upper, upperOpen = false) => ({ upper, upperOpen }),
    });
  }

  blockNextOpen() {
    this.openActions.push({ type: 'blocked' });
  }

  failNextOpen(error) {
    this.openActions.push({ type: 'error', error });
  }

  failNextRequest({ storeName, operation, error, skip = 0 }) {
    this.requestFailures.push({ storeName, operation, error, skip });
  }

  delayNextRequest({ storeName, operation, delayMs, skip = 0 }) {
    this.requestDelays.push({ storeName, operation, delayMs, skip });
  }

  failNextSchemaOperation({ operation, storeName, error }) {
    this.schemaFailures.push({ operation, storeName, error });
  }

  consumeRequestFailure(storeName, operation) {
    const failure = this.requestFailures.find((candidate) => (
      candidate.storeName === storeName && candidate.operation === operation
    ));
    if (!failure) return null;
    if (failure.skip > 0) {
      failure.skip -= 1;
      return null;
    }
    this.requestFailures.splice(this.requestFailures.indexOf(failure), 1);
    return failure.error;
  }

  consumeRequestDelay(storeName, operation) {
    const delay = this.requestDelays.find((candidate) => (
      candidate.storeName === storeName && candidate.operation === operation
    ));
    if (!delay) return 0;
    if (delay.skip > 0) {
      delay.skip -= 1;
      return 0;
    }
    this.requestDelays.splice(this.requestDelays.indexOf(delay), 1);
    return Math.max(0, Number(delay.delayMs) || 0);
  }

  consumeSchemaFailure(operation, storeName) {
    const index = this.schemaFailures.findIndex((candidate) => (
      candidate.operation === operation && candidate.storeName === storeName
    ));
    if (index < 0) return null;
    return this.schemaFailures.splice(index, 1)[0].error;
  }

  queueTransaction(state, transaction) {
    // Serializing every fake transaction is stronger than IndexedDB requires,
    // but faithfully preserves the required ordering for overlapping scopes.
    state.transactionQueue.push(transaction);
    this.startNextTransaction(state);
  }

  startNextTransaction(state) {
    if (state.activeTransaction) return;
    const transaction = state.transactionQueue.shift();
    if (!transaction) return;
    state.activeTransaction = transaction;
    transaction.start();
  }

  finishTransaction(state, transaction) {
    if (state.activeTransaction === transaction) state.activeTransaction = null;
    else state.transactionQueue = state.transactionQueue.filter((candidate) => candidate !== transaction);
    queueMicrotask(() => this.startNextTransaction(state));
  }

  open(name, version) {
    this.openCalls.push({ name, version });
    const request = new FakeRequest();
    request.transaction = null;
    request.onblocked = null;
    request.onupgradeneeded = null;

    queueMicrotask(() => {
      const action = this.openActions.shift();
      if (action?.type === 'blocked') {
        request.onblocked?.({ target: request });
        return;
      }
      if (action?.type === 'error') {
        request.error = action.error;
        request.onerror?.({ target: request });
        return;
      }

      const previousState = this.databases.get(name);
      const oldVersion = previousState?.version ?? 0;
      if (oldVersion > version) {
        request.error = new Error('VersionError');
        request.onerror?.({ target: request });
        return;
      }

      const candidate = oldVersion < version
        ? cloneDatabaseState(previousState, oldVersion)
        : previousState;
      request.result = new FakeDatabase(this, candidate);
      if (oldVersion < version) {
        const upgradeTransaction = new FakeTransaction(
          this,
          candidate,
          [...candidate.stores.keys()],
          'versionchange',
          { managed: false },
        );
        candidate.upgradeTransaction = upgradeTransaction;
        request.transaction = upgradeTransaction;
        request.onupgradeneeded?.({ oldVersion, newVersion: version, target: request });
        if (upgradeTransaction.aborted) {
          request.error = upgradeTransaction.error;
          request.onerror?.({ target: request });
          return;
        }
        candidate.version = version;
        candidate.upgradeTransaction = null;
        this.databases.set(name, candidate);
      } else if (!previousState) {
        candidate.version = version;
        this.databases.set(name, candidate);
      }
      request.onsuccess?.({ target: request });
    });

    return request;
  }

  deleteDatabase(name) {
    const request = new FakeRequest();
    request.onblocked = null;
    queueMicrotask(() => {
      this.databases.delete(name);
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  getStoreState(databaseName, storeName) {
    return this.databases.get(databaseName)?.stores.get(storeName) ?? null;
  }

  getIndexEntries(databaseName, storeName, indexName) {
    const store = this.getStoreState(databaseName, storeName);
    const index = store?.indexes.get(indexName);
    if (!store || !index) return [];
    const entries = [];
    store.records.forEach((record, primaryKey) => {
      const key = evaluateIndexKey(record, index.keyPath);
      if (key !== INVALID_INDEX_KEY) entries.push({ key: cloneValue(key), primaryKey });
    });
    return entries;
  }
}
