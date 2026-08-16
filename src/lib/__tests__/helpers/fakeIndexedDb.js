const makeDomStringList = (values) => ({
  contains: (value) => values.has(value),
  item: (index) => [...values][index] ?? null,
  get length() {
    return values.size;
  },
  [Symbol.iterator]: () => values[Symbol.iterator](),
});

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
    if (this.state.indexes.has(name)) throw new Error(`Index already exists: ${name}`);
    const index = { name, keyPath, unique: Boolean(options.unique), multiEntry: Boolean(options.multiEntry) };
    this.state.indexes.set(name, index);
    return index;
  }

  get(key) {
    return this.transaction.enqueue(() => this.state.records.get(key));
  }

  put(value) {
    return this.transaction.enqueue(() => {
      const key = value?.[this.keyPath];
      if (key === undefined) throw new Error(`Missing key path: ${this.keyPath}`);
      this.state.records.set(key, structuredClone(value));
      this.state.putCount += 1;
      return key;
    });
  }
}

class FakeTransaction {
  constructor(databaseState, storeNames, mode) {
    this.databaseState = databaseState;
    this.storeNames = storeNames;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.aborted = false;
    this.completed = false;
    this.queue = [];
    this.processing = false;
    queueMicrotask(() => this.drain());
  }

  objectStore(name) {
    if (!this.storeNames.includes(name)) throw new Error(`Store not in transaction: ${name}`);
    const state = this.databaseState.stores.get(name);
    if (!state) throw new Error(`Missing object store: ${name}`);
    return new FakeObjectStore(this, state);
  }

  enqueue(run) {
    if (this.aborted || this.completed) throw new Error('TransactionInactiveError');
    const request = new FakeRequest();
    this.queue.push({ request, run });
    this.drain();
    return request;
  }

  abort() {
    if (this.aborted || this.completed) return;
    this.aborted = true;
    this.error ??= new Error('AbortError');
    queueMicrotask(() => this.onabort?.({ target: this }));
  }

  drain() {
    if (this.processing || this.aborted || this.completed) return;
    const next = this.queue.shift();
    if (!next) {
      this.processing = true;
      queueMicrotask(() => {
        this.processing = false;
        if (this.aborted || this.completed || this.queue.length > 0) {
          this.drain();
          return;
        }
        this.completed = true;
        this.oncomplete?.({ target: this });
      });
      return;
    }

    this.processing = true;
    queueMicrotask(() => {
      try {
        next.request.result = next.run();
        next.request.onsuccess?.({ target: next.request });
      } catch (error) {
        next.request.error = error;
        this.error = error;
        next.request.onerror?.({ target: next.request, preventDefault() {} });
        this.onerror?.({ target: this, preventDefault() {} });
        this.abort();
      } finally {
        this.processing = false;
        this.drain();
      }
    });
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
    if (this.state.stores.has(name)) throw new Error(`Object store already exists: ${name}`);
    const state = {
      indexes: new Map(),
      keyPath: options.keyPath,
      putCount: 0,
      records: new Map(),
    };
    this.state.stores.set(name, state);
    return new FakeObjectStore(new FakeTransaction(this.state, [name], 'versionchange'), state);
  }

  transaction(storeNames, mode = 'readonly') {
    if (this.closed) throw new Error('InvalidStateError');
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    names.forEach((name) => {
      if (!this.state.stores.has(name)) throw new Error(`Missing object store: ${name}`);
    });
    this.factory.transactionCount += 1;
    return new FakeTransaction(this.state, names, mode);
  }

  close() {
    this.closed = true;
  }
}

export class FakeIndexedDb {
  constructor() {
    this.databases = new Map();
    this.openCalls = [];
    this.transactionCount = 0;
  }

  open(name, version) {
    this.openCalls.push({ name, version });
    const request = new FakeRequest();
    request.transaction = null;
    request.onblocked = null;
    request.onupgradeneeded = null;

    queueMicrotask(() => {
      let state = this.databases.get(name);
      const oldVersion = state?.version ?? 0;
      if (oldVersion > version) {
        request.error = new Error('VersionError');
        request.onerror?.({ target: request });
        return;
      }
      if (!state) {
        state = { stores: new Map(), version };
        this.databases.set(name, state);
      }
      request.result = new FakeDatabase(this, state);
      if (oldVersion < version) {
        state.version = version;
        request.transaction = new FakeTransaction(state, [...state.stores.keys()], 'versionchange');
        request.onupgradeneeded?.({ oldVersion, newVersion: version, target: request });
      }
      request.onsuccess?.({ target: request });
    });

    return request;
  }

  getStoreState(databaseName, storeName) {
    return this.databases.get(databaseName)?.stores.get(storeName) ?? null;
  }
}
