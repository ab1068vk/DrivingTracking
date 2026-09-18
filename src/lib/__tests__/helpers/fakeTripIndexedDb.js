/**
 * Shared in-memory IndexedDB double for the trip repository suites.
 *
 * Extracted from `localTripRepositoryIndexedDb.test.js` unchanged so a second
 * suite can drive the same production code without a second, subtly different
 * model of IndexedDB's typed-key and cursor rules.
 */

const makeDomStringList = (items) => ({
  contains: (item) => items.has(item),
});

const makeIdbRequest = (run) => {
  const request = {
    error: null,
    result: undefined,
    onerror: null,
    onsuccess: null,
  };

  queueMicrotask(() => {
    try {
      request.result = run();
      request.onsuccess?.({ target: request });
    } catch (error) {
      request.error = error;
      request.onerror?.({ target: request });
    }
  });

  return request;
};

/** Minimal `IDBKeyRange` matching the spec's four constructors. */
const FakeKeyRange = {
  bound: (lower, upper, lowerOpen = false, upperOpen = false) => ({ lower, upper, lowerOpen, upperOpen }),
  upperBound: (upper, upperOpen = false) => ({ upper, upperOpen }),
  lowerBound: (lower, lowerOpen = false) => ({ lower, lowerOpen }),
  only: (value) => ({ lower: value, upper: value, lowerOpen: false, upperOpen: false }),
};
if (typeof globalThis.IDBKeyRange === 'undefined') globalThis.IDBKeyRange = FakeKeyRange;

/**
 * IndexedDB key ordering: number < date < string < binary < array, and arrays
 * compare element-wise. Getting this wrong is the failure mode P3 planning
 * identified as silent — a mis-shaped bound selects everything or nothing
 * without throwing — so the fake models the real rule rather than the intent.
 */
const keyTypeRank = (key) => {
  if (Array.isArray(key)) return 4;
  if (typeof key === 'string') return 3;
  if (key instanceof Date) return 2;
  return 1;
};

const compareKeys = (a, b) => {
  const rankA = keyTypeRank(a);
  const rankB = keyTypeRank(b);
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;
  if (rankA === 4) {
    const length = Math.min(a.length, b.length);
    for (let index = 0; index < length; index += 1) {
      const cmp = compareKeys(a[index], b[index]);
      if (cmp !== 0) return cmp;
    }
    return a.length === b.length ? 0 : (a.length < b.length ? -1 : 1);
  }
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

/** A record is indexed only when every keyPath component is a valid key. */
const evaluateIndexKey = (record, keyPath) => {
  const parts = Array.isArray(keyPath) ? keyPath : [keyPath];
  const values = parts.map((part) => record?.[part]);
  if (values.some((value) => value === undefined || value === null || Number.isNaN(value))) return null;
  return Array.isArray(keyPath) ? values : values[0];
};

const inRange = (key, range) => {
  if (!range) return true;
  if (range.lower !== undefined) {
    const cmp = compareKeys(key, range.lower);
    if (cmp < 0 || (cmp === 0 && range.lowerOpen)) return false;
  }
  if (range.upper !== undefined) {
    const cmp = compareKeys(key, range.upper);
    if (cmp > 0 || (cmp === 0 && range.upperOpen)) return false;
  }
  return true;
};

class FakeIndex {
  constructor(state, name) {
    this.state = state;
    this.name = name;
    this.keyPath = state.indexKeyPaths.get(name);
  }

  entries(range, direction) {
    const rows = [];
    for (const record of this.state.records.values()) {
      const key = evaluateIndexKey(record, this.keyPath);
      if (key === null) continue;
      if (!inRange(key, range)) continue;
      rows.push({ key, primaryKey: record[this.state.keyPath], value: record });
    }
    rows.sort((a, b) => {
      const cmp = compareKeys(a.key, b.key);
      if (cmp !== 0) return cmp;
      return compareKeys(a.primaryKey, b.primaryKey);
    });
    if (direction === 'prev' || direction === 'prevunique') rows.reverse();
    return rows;
  }

  openCursor(range = null, direction = 'next') {
    const rows = this.entries(range, direction);
    this.state.cursorOpens = (this.state.cursorOpens || 0) + 1;
    const request = { onsuccess: null, onerror: null, result: null };
    let position = 0;
    const step = () => {
      if (position >= rows.length) {
        request.result = null;
      } else {
        const row = rows[position];
        this.state.cursorSteps = (this.state.cursorSteps || 0) + 1;
        request.result = {
          key: row.key,
          primaryKey: row.primaryKey,
          value: row.value,
          continue: () => { position += 1; queueMicrotask(step); },
          /**
           * Models the spec rule that makes the resume path fail for real:
           * for a `next` cursor, if `key` is at or before the current index
           * position **and** `primaryKey` is at or before the current object
           * store position, this throws `DataError`. Every tombstone shares
           * one index key, so a backwards primary key always throws.
           */
          continuePrimaryKey: (key, primaryKey) => {
            const keyCmp = compareKeys(key, row.key);
            const primaryCmp = compareKeys(primaryKey, row.primaryKey);
            if (keyCmp <= 0 && primaryCmp <= 0) {
              const error = new Error('The parameter is less than or equal to this cursor\'s position.');
              error.name = 'DataError';
              throw error;
            }
            let next = position;
            while (
              next < rows.length
              && (compareKeys(rows[next].key, key) < 0
                || (compareKeys(rows[next].key, key) === 0
                  && compareKeys(rows[next].primaryKey, primaryKey) < 0))
            ) {
              next += 1;
            }
            position = next;
            queueMicrotask(step);
          },
        };
      }
      request.onsuccess?.();
    };
    queueMicrotask(step);
    return request;
  }
}

class FakeObjectStore {
  constructor(state) {
    this.state = state;
    this.keyPath = state.keyPath;
  }

  index(name) {
    if (!this.state.indexes.has(name)) throw new Error(`Missing index: ${name}`);
    return new FakeIndex(this.state, name);
  }

  get indexNames() {
    return makeDomStringList(this.state.indexes);
  }

  createIndex(name, keyPath) {
    if (this.state.indexes.has(name)) {
      throw new Error(`Index already exists: ${name}`);
    }
    this.state.indexes.add(name);
    this.state.indexKeyPaths.set(name, keyPath);
    return { name, keyPath };
  }

  put(value) {
    return makeIdbRequest(() => {
      this.state.putAttempts += 1;
      if (this.state.failPutAt === this.state.putAttempts) {
        const error = new Error('Injected put failure');
        this.state.databaseState.activeTransaction.error = error;
        queueMicrotask(() => this.state.databaseState.activeTransaction?.onerror?.());
        throw error;
      }
      this.state.putHistory.push(value);
      this.state.records.set(value[this.keyPath], value);
      queueMicrotask(() => this.state.databaseState.activeTransaction?.oncomplete?.());
      return value[this.keyPath];
    });
  }

  get(id) {
    // P4-C-F09: every point read is counted, so a suite can assert that a
    // bounded turn's reported `examined` equals the rows it really read -
    // including the repair path's independent re-reads.
    this.state.getCount = (this.state.getCount || 0) + 1;
    return makeIdbRequest(() => this.state.records.get(id));
  }

  getAll() {
    return makeIdbRequest(() => {
      this.state.getAllCount += 1;
      return [...this.state.records.values()];
    });
  }

  /**
   * Keys are returned as stored, preserving type. Erasure enumerates by key so
   * it can reach rows the trips store never mentions — an orphan projection or
   * an orphan legacy summary.
   */
  getAllKeys() {
    return makeIdbRequest(() => {
      this.state.getAllCount += 1;
      return [...this.state.records.keys()];
    });
  }

  count() {
    return makeIdbRequest(() => this.state.records.size);
  }

  /**
   * Real object stores expose `openCursor`/`openKeyCursor`; this fake only had them on
   * indexes, so a caller doing genuinely bounded key acquisition over a store had nothing
   * to call. Modelled on the index cursor above: key order, range honoured, one step per
   * `continue()`, and every step counted so a suite can assert a turn stayed bounded.
   */
  openCursor(range = null) {
    const keys = [...this.state.records.keys()]
      .filter((key) => inRange(key, range))
      .sort(compareKeys);
    this.state.storeCursorOpens = (this.state.storeCursorOpens || 0) + 1;
    const request = { onsuccess: null, onerror: null, result: null };
    let position = 0;
    const step = () => {
      if (position >= keys.length) {
        request.result = null;
      } else {
        const key = keys[position];
        this.state.storeCursorSteps = (this.state.storeCursorSteps || 0) + 1;
        request.result = {
          key,
          primaryKey: key,
          value: this.state.records.get(key),
          continue: () => { position += 1; queueMicrotask(step); },
          delete: () => makeIdbRequest(() => { this.state.records.delete(key); }),
        };
      }
      request.onsuccess?.();
    };
    queueMicrotask(step);
    return request;
  }

  openKeyCursor(range = null) {
    return this.openCursor(range);
  }

  delete(id) {
    return makeIdbRequest(() => {
      this.state.deleteAttempts = (this.state.deleteAttempts || 0) + 1;
      if (this.state.failDeleteAt === this.state.deleteAttempts) {
        const error = new Error('Injected delete failure');
        this.state.databaseState.activeTransaction.error = error;
        queueMicrotask(() => this.state.databaseState.activeTransaction?.onerror?.());
        throw error;
      }
      this.state.records.delete(id);
      queueMicrotask(() => this.state.databaseState.activeTransaction?.oncomplete?.());
      return undefined;
    });
  }
}

class FakeTransaction {
  constructor(databaseState) {
    this.databaseState = databaseState;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.databaseState.activeTransaction = this;
  }

  objectStore(name) {
    const store = this.databaseState.stores.get(name);
    if (!store) throw new Error(`Missing object store: ${name}`);
    return new FakeObjectStore(store);
  }

  /**
   * A guarded writer that finds the row moved under it calls `tx.abort()` and returns a
   * refusal. Without this the double turned that ordinary production branch into a
   * TypeError, so a suite could not tell a refusal apart from a crash.
   */
  abort() {
    this.aborted = true;
    queueMicrotask(() => this.onabort?.());
  }
}

class FakeDatabase {
  constructor(state) {
    this.state = state;
  }

  get objectStoreNames() {
    return makeDomStringList(new Set(this.state.stores.keys()));
  }

  createObjectStore(name, options) {
    if (this.state.stores.has(name)) {
      throw new Error(`Object store already exists: ${name}`);
    }
    const store = {
      keyPath: options.keyPath,
      indexes: new Set(),
      indexKeyPaths: new Map(),
      records: new Map(),
      putHistory: [],
      putAttempts: 0,
      deleteAttempts: 0,
      getCount: 0,
      failPutAt: -1,
      failDeleteAt: -1,
      getAllCount: 0,
      databaseState: this.state,
    };
    this.state.stores.set(name, store);
    return new FakeObjectStore(store);
  }

  transaction(name, mode = 'readonly') {
    const names = Array.isArray(name) ? name : [name];
    names.forEach((storeName) => {
      if (!this.state.stores.has(storeName)) throw new Error(`Missing object store: ${storeName}`);
    });
    this.state.transactionHistory ??= [];
    this.state.transactionHistory.push({ names, mode });
    return new FakeTransaction(this.state);
  }

  close() {}
}

class FakeIndexedDb {
  constructor() {
    this.databases = new Map();
  }

  /** `indexedDB.cmp`, using the same typed-key ordering as the cursors. */
  cmp(first, second) {
    return compareKeys(first, second);
  }

  /**
   * Inspect a store's durable state, matching the sibling `fakeIndexedDb` helper.
   *
   * A suite that needs to assert what a write actually COMMITTED — the key version a
   * wrapper names, say — has no other way to look, and reaching into `databases` by hand
   * couples every caller to this double's internals.
   */
  getStoreState(databaseName, storeName) {
    return this.databases.get(databaseName)?.stores.get(storeName) ?? null;
  }

  open(name, version) {
    const request = {
      error: null,
      result: undefined,
      transaction: null,
      onerror: null,
      onsuccess: null,
      onupgradeneeded: null,
    };

    queueMicrotask(() => {
      let state = this.databases.get(name);
      const oldVersion = state?.version ?? 0;

      if (oldVersion > version) {
        request.error = new Error('VersionError');
        request.onerror?.({ target: request });
        return;
      }

      if (!state) {
        state = { version, stores: new Map() };
        this.databases.set(name, state);
      }

      request.result = new FakeDatabase(state);

      if (oldVersion < version) {
        state.version = version;
        request.transaction = new FakeTransaction(state);
        request.onupgradeneeded?.({
          oldVersion,
          newVersion: version,
          target: request,
        });
      }

      request.onsuccess?.({ target: request });
    });

    return request;
  }

  deleteDatabase(name) {
    return makeIdbRequest(() => {
      this.databases.delete(name);
      return undefined;
    });
  }
}

export {
  makeDomStringList,
  makeIdbRequest,
  FakeKeyRange,
  keyTypeRank,
  compareKeys,
  evaluateIndexKey,
  inRange,
  FakeIndex,
  FakeObjectStore,
  FakeTransaction,
  FakeDatabase,
  FakeIndexedDb,
};
