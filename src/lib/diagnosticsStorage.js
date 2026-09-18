export const DIAGNOSTICS_DB_NAME = 'roadsage_diagnostics';
export const DIAGNOSTICS_DB_VERSION = 1;
export const DIAGNOSTICS_EVENTS_STORE = 'events';
export const DIAGNOSTICS_META_STORE = 'meta';

export const DIAGNOSTICS_EVENT_KINDS = Object.freeze([
  'performance',
  'system_log',
  'app_experience',
]);

export const DIAGNOSTICS_PRIVACY_CLASSES = Object.freeze([
  'sensitive',
  'standard',
]);

export const MAX_FLUSH_BATCH = 64;
export const MAX_PRUNE_DELETES_PER_TX = 128;

export const deleteDiagnosticsDatabase = (indexedDbFactory = globalThis.indexedDB) => new Promise((resolve, reject) => {
  if (!indexedDbFactory || typeof indexedDbFactory.deleteDatabase !== 'function') {
    resolve({ deleted: false, reason: 'indexeddb_unavailable' });
    return;
  }
  let request;
  try {
    request = indexedDbFactory.deleteDatabase(DIAGNOSTICS_DB_NAME);
  } catch (error) {
    reject(error);
    return;
  }
  request.onsuccess = () => resolve({ deleted: true, database: DIAGNOSTICS_DB_NAME });
  request.onerror = () => reject(request.error ?? new Error('Diagnostics database deletion failed.'));
  request.onblocked = () => reject(new Error('Diagnostics database deletion was blocked.'));
});

export const DIAGNOSTICS_EVENT_INDEXES = Object.freeze([
  Object.freeze({
    name: 'by_kind_payload_time',
    keyPath: Object.freeze(['kind', 'payloadTimestampMs', 'ingestSeq']),
    unique: false,
    multiEntry: false,
  }),
  Object.freeze({
    name: 'by_kind_ingest_seq',
    keyPath: Object.freeze(['kind', 'ingestSeq']),
    unique: false,
    multiEntry: false,
  }),
  Object.freeze({
    name: 'by_kind_expiry',
    keyPath: Object.freeze(['kind', 'expiresAtMs', 'ingestSeq']),
    unique: false,
    multiEntry: false,
  }),
  Object.freeze({
    name: 'by_kind_privacy_time',
    keyPath: Object.freeze(['kind', 'privacyClass', 'payloadTimestampMs', 'ingestSeq']),
    unique: false,
    multiEntry: false,
  }),
  Object.freeze({
    name: 'by_kind_generation_ordinal',
    keyPath: Object.freeze(['kind', 'migrationGeneration', 'migrationOrdinal']),
    unique: false,
    multiEntry: false,
  }),
]);

const INGEST_SEQUENCE_META_KEY = 'ingest_sequence';
const MIGRATION_EVENT_UID_PREFIX = 'migration:';
const EVENT_KIND_SET = new Set(DIAGNOSTICS_EVENT_KINDS);
const PRIVACY_CLASS_SET = new Set(DIAGNOSTICS_PRIVACY_CLASSES);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);

const requireEventKind = (kind) => {
  if (!EVENT_KIND_SET.has(kind)) {
    throw new TypeError(`Unsupported diagnostics event kind: ${String(kind)}`);
  }
  return kind;
};

const requireFiniteNumber = (value, label) => {
  if (!Number.isFinite(value)) throw new TypeError(`${label} must be a finite number.`);
  return value;
};

const requireNonNegativeInteger = (value, label) => {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative safe integer.`);
  }
  return value;
};

const requireEventUid = (value, { allowMigration = false, label = 'eventUid' } = {}) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new TypeError(`${label} must be a non-empty, whitespace-trimmed string.`);
  }
  if (!allowMigration && value.startsWith(MIGRATION_EVENT_UID_PREFIX)) {
    throw new TypeError(`${label} uses the reserved migration namespace.`);
  }
  return value;
};

const requirePrivacyClass = (value) => {
  if (!PRIVACY_CLASS_SET.has(value)) {
    throw new TypeError(`privacyClass must be one of: ${DIAGNOSTICS_PRIVACY_CLASSES.join(', ')}.`);
  }
  return value;
};

const encodeUidPart = (value, label) => {
  const normalized = String(value);
  if (!normalized) throw new TypeError(`${label} must not be empty.`);
  return encodeURIComponent(normalized);
};

export const createDeterministicLegacyEventUid = (kind, generation, ordinal) => (
  `migration:${encodeUidPart(requireEventKind(kind), 'kind')}:${encodeUidPart(generation, 'generation')}:${requireNonNegativeInteger(ordinal, 'ordinal')}`
);

const createDefaultUidFactory = () => {
  let fallbackOrdinal = 0;
  return ({ nowMs }) => {
    const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : null;
    if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID();
    if (typeof cryptoApi?.getRandomValues === 'function') {
      const words = new Uint32Array(4);
      cryptoApi.getRandomValues(words);
      return [...words].map((word) => word.toString(16).padStart(8, '0')).join('');
    }
    fallbackOrdinal += 1;
    return `${nowMs.toString(36)}-${fallbackOrdinal.toString(36)}-${Math.random().toString(36).slice(2)}`;
  };
};

const hasStore = (db, storeName) => db.objectStoreNames.contains(storeName);
const hasIndex = (store, indexName) => store.indexNames.contains(indexName);

const getUpgradeStore = (db, transaction, storeName, keyPath) => {
  if (!hasStore(db, storeName)) return db.createObjectStore(storeName, { keyPath });
  if (!transaction) throw new Error(`Missing upgrade transaction for ${storeName}.`);
  return transaction.objectStore(storeName);
};

export const upgradeDiagnosticsSchema = (db, transaction) => {
  const events = getUpgradeStore(db, transaction, DIAGNOSTICS_EVENTS_STORE, 'eventUid');
  DIAGNOSTICS_EVENT_INDEXES.forEach((index) => {
    if (!hasIndex(events, index.name)) {
      events.createIndex(index.name, [...index.keyPath], {
        multiEntry: index.multiEntry,
        unique: index.unique,
      });
    }
  });
  getUpgradeStore(db, transaction, DIAGNOSTICS_META_STORE, 'key');
};

const transactionError = (transaction, fallback) => (
  transaction.error ?? new Error(fallback)
);

const transactionDone = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onerror = () => reject(transactionError(transaction, 'IndexedDB transaction failed.'));
  transaction.onabort = () => reject(transactionError(transaction, 'IndexedDB transaction aborted.'));
});

const isThenable = (value) => (
  value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function'
);

const abortAndDrain = async (transaction, done) => {
  try {
    transaction.abort();
  } catch {
    // A completed/aborted transaction needs no further action.
  }
  await done.catch(() => {});
};

const validatePreparedEvent = (record) => {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('A prepared diagnostics event must be an object.');
  }
  requireEventKind(record.kind);
  requireFiniteNumber(record.payloadTimestampMs, 'payloadTimestampMs');
  requireNonNegativeInteger(record.clearEpoch, 'clearEpoch');
  if (!hasOwn(record, 'payload')) throw new TypeError('A prepared diagnostics event must contain payload.');
  if (hasOwn(record, 'ingestSeq')) {
    throw new TypeError('ingestSeq is allocated by diagnostics storage.');
  }
  if (hasOwn(record, 'expiresAtMs')) requireFiniteNumber(record.expiresAtMs, 'expiresAtMs');
  if (hasOwn(record, 'privacyRulesVersion')) {
    requireNonNegativeInteger(record.privacyRulesVersion, 'privacyRulesVersion');
  }
  if (hasOwn(record, 'migrationOrdinal')) {
    requireNonNegativeInteger(record.migrationOrdinal, 'migrationOrdinal');
  }
  const migrationUid = typeof record.eventUid === 'string'
    && record.eventUid.startsWith(MIGRATION_EVENT_UID_PREFIX);
  if (migrationUid) {
    if (!hasOwn(record, 'migrationGeneration') || !hasOwn(record, 'migrationOrdinal')) {
      throw new TypeError('A migration eventUid requires deterministic migration metadata.');
    }
    const expectedUid = createDeterministicLegacyEventUid(
      record.kind,
      record.migrationGeneration,
      record.migrationOrdinal,
    );
    if (record.eventUid !== expectedUid) {
      throw new TypeError('A migration eventUid must match its deterministic migration metadata.');
    }
    requireEventUid(record.eventUid, { allowMigration: true });
  } else {
    requireEventUid(record.eventUid);
  }
  if (record.kind === 'system_log' || hasOwn(record, 'privacyClass')) {
    requirePrivacyClass(record.privacyClass);
  }
  return record;
};

const logicalValuesEqual = (left, right, seen = new WeakMap()) => {
  if (Object.is(left, right)) return true;
  if (
    left === null
    || right === null
    || typeof left !== 'object'
    || typeof right !== 'object'
  ) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (!Array.isArray(left)) {
    const leftPrototype = Object.getPrototypeOf(left);
    const rightPrototype = Object.getPrototypeOf(right);
    const plainLeft = leftPrototype === Object.prototype || leftPrototype === null;
    const plainRight = rightPrototype === Object.prototype || rightPrototype === null;
    if (!plainLeft || !plainRight || leftPrototype !== rightPrototype) return false;
  }
  const priorRight = seen.get(left);
  if (priorRight !== undefined) return priorRight === right;
  seen.set(left, right);
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key, index) => (
    key === rightKeys[index] && logicalValuesEqual(left[key], right[key], seen)
  ));
};

const recordsMatchForRetry = (stored, prepared) => {
  if (!stored || typeof stored !== 'object') return false;
  const { ingestSeq: _storedIngestSeq, ...storedPrepared } = stored;
  return logicalValuesEqual(storedPrepared, prepared);
};

const readHighWater = (metaRecord) => {
  if (metaRecord === undefined) return 0;
  if (!metaRecord || metaRecord.key !== INGEST_SEQUENCE_META_KEY) {
    throw new Error('Diagnostics ingest-sequence metadata is malformed.');
  }
  return requireNonNegativeInteger(metaRecord.value, 'Stored ingest sequence');
};

const globalIndexedDb = () => {
  try {
    return typeof indexedDB === 'undefined' ? null : indexedDB;
  } catch {
    return null;
  }
};

const globalKeyRange = () => {
  try {
    return typeof IDBKeyRange === 'undefined' ? null : IDBKeyRange;
  } catch {
    return null;
  }
};

const createRange = (factory, descriptor) => {
  if (!descriptor) return null;
  if (!factory) throw new Error('IndexedDB key ranges are unavailable.');
  if (hasOwn(descriptor, 'only')) return factory.only(descriptor.only);
  if (hasOwn(descriptor, 'lower') && hasOwn(descriptor, 'upper')) {
    return factory.bound(
      descriptor.lower,
      descriptor.upper,
      Boolean(descriptor.lowerOpen),
      Boolean(descriptor.upperOpen),
    );
  }
  if (hasOwn(descriptor, 'lower')) return factory.lowerBound(descriptor.lower, Boolean(descriptor.lowerOpen));
  if (hasOwn(descriptor, 'upper')) return factory.upperBound(descriptor.upper, Boolean(descriptor.upperOpen));
  throw new TypeError('Invalid diagnostics key-range descriptor.');
};

const requireBoundedCount = (value, label, maximum) => {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${label} must be between 1 and ${maximum}.`);
  }
  return value;
};

export const createDiagnosticsStorage = (options = {}) => {
  const indexedDbFactory = hasOwn(options, 'indexedDbFactory')
    ? options.indexedDbFactory
    : globalIndexedDb();
  const now = options.now ?? (() => Date.now());
  const uidFactory = options.uidFactory ?? createDefaultUidFactory();
  const keyRangeFactory = hasOwn(options, 'keyRangeFactory')
    ? options.keyRangeFactory
    : globalKeyRange();
  let connection = null;
  let openPromise = null;

  const close = () => {
    connection?.close();
    connection = null;
    openPromise = null;
  };

  const open = () => {
    if (connection) return Promise.resolve(connection);
    if (openPromise) return openPromise;
    if (!indexedDbFactory || typeof indexedDbFactory.open !== 'function') {
      return Promise.reject(new Error('IndexedDB unavailable.'));
    }

    openPromise = new Promise((resolve, reject) => {
      const request = indexedDbFactory.open(DIAGNOSTICS_DB_NAME, DIAGNOSTICS_DB_VERSION);
      let settled = false;
      const settle = (finish, value) => {
        if (settled) return;
        settled = true;
        finish(value);
      };

      request.onupgradeneeded = () => {
        try {
          upgradeDiagnosticsSchema(request.result, request.transaction);
        } catch (error) {
          try {
            request.transaction?.abort();
          } catch {
            // The original schema error is more useful than a second abort error.
          }
          settle(reject, error);
        }
      };
      request.onblocked = () => settle(reject, new Error('IndexedDB open blocked for roadsage_diagnostics.'));
      request.onerror = () => settle(reject, request.error ?? new Error('IndexedDB open failed.'));
      request.onsuccess = () => {
        if (settled) {
          request.result?.close();
          return;
        }
        connection = request.result;
        connection.onversionchange = close;
        settle(resolve, connection);
      };
    }).catch((error) => {
      openPromise = null;
      throw error;
    });

    return openPromise;
  };

  const runTransaction = async (storeNames, mode, queueRequests) => {
    if (typeof queueRequests !== 'function') {
      throw new TypeError('IndexedDB transaction request scheduler must be a function.');
    }
    const db = await open();
    const transaction = db.transaction(storeNames, mode);
    const done = transactionDone(transaction);
    let queued;
    try {
      queued = queueRequests({
        objectStore: (storeName) => transaction.objectStore(storeName),
        transaction,
      });
      if (isThenable(queued)) {
        throw new TypeError('IndexedDB transaction request scheduling must be synchronous.');
      }
    } catch (error) {
      await abortAndDrain(transaction, done);
      throw error;
    }

    await done;
    return typeof queued === 'function' ? queued() : queued;
  };

  const buildPreparedEvent = (kind, payload, eventOptions = {}, { allowMigrationUid = false } = {}) => {
    requireEventKind(kind);
    const nowMs = requireFiniteNumber(now(), 'Diagnostics clock');
    const payloadTimestampMs = hasOwn(eventOptions, 'payloadTimestampMs')
      ? requireFiniteNumber(eventOptions.payloadTimestampMs, 'payloadTimestampMs')
      : nowMs;
    const clearEpoch = hasOwn(eventOptions, 'clearEpoch')
      ? requireNonNegativeInteger(eventOptions.clearEpoch, 'clearEpoch')
      : 0;
    const suppliedUid = eventOptions.eventUid;
    let eventUid;
    if (suppliedUid === undefined) {
      const uidPart = requireEventUid(uidFactory({ kind, nowMs }), {
        allowMigration: true,
        label: 'Diagnostics UID factory result',
      });
      eventUid = `live:${kind}:${uidPart}`;
    } else {
      eventUid = requireEventUid(suppliedUid, { allowMigration: allowMigrationUid });
    }

    const record = {
      kind,
      eventUid,
      payloadTimestampMs,
      clearEpoch,
    };
    [
      'expiresAtMs',
      'privacyClass',
      'privacyRulesVersion',
      'migrationGeneration',
      'migrationOrdinal',
      'migrationSource',
    ].forEach((key) => {
      if (hasOwn(eventOptions, key)) record[key] = eventOptions[key];
    });
    record.payload = payload;
    return validatePreparedEvent(record);
  };

  const prepareEvent = (kind, payload, eventOptions = {}) => (
    buildPreparedEvent(kind, payload, eventOptions)
  );

  const prepareMigratedEvent = (kind, payload, eventOptions) => {
    if (!eventOptions || typeof eventOptions !== 'object') {
      throw new TypeError('Migration event options are required.');
    }
    const migrationGeneration = String(eventOptions.migrationGeneration ?? '');
    const migrationOrdinal = requireNonNegativeInteger(eventOptions.migrationOrdinal, 'migrationOrdinal');
    if (!migrationGeneration) throw new TypeError('migrationGeneration must not be empty.');
    return buildPreparedEvent(kind, payload, {
      ...eventOptions,
      eventUid: createDeterministicLegacyEventUid(kind, migrationGeneration, migrationOrdinal),
      migrationGeneration,
      migrationOrdinal,
    }, { allowMigrationUid: true });
  };

  const appendPreparedEvents = async (records, instrumentation = {}) => {
    if (!Array.isArray(records)) throw new TypeError('Diagnostics event batch must be an array.');
    if (records.length > MAX_FLUSH_BATCH) {
      throw new RangeError(`Diagnostics event batch exceeds MAX_FLUSH_BATCH (${MAX_FLUSH_BATCH}).`);
    }
    if (records.length === 0) return [];
    records.forEach(validatePreparedEvent);
    const uids = new Set();
    records.forEach(({ eventUid }) => {
      if (uids.has(eventUid)) throw new Error(`Duplicate eventUid in diagnostics batch: ${eventUid}`);
      uids.add(eventUid);
    });

    const syncNow = instrumentation.now ?? (() => Date.now());
    const recordSync = typeof instrumentation.recordSync === 'function'
      ? instrumentation.recordSync
      : null;
    const db = await open();
    const scheduleStart = recordSync ? syncNow() : 0;
    const transaction = db.transaction(
      [DIAGNOSTICS_EVENTS_STORE, DIAGNOSTICS_META_STORE],
      'readwrite',
    );
    const done = transactionDone(transaction);
    const events = transaction.objectStore(DIAGNOSTICS_EVENTS_STORE);
    const meta = transaction.objectStore(DIAGNOSTICS_META_STORE);

    const staged = new Promise((resolve, reject) => {
      let pendingReads = records.length + 1;
      let highWaterRecord;
      const existing = new Map();
      let failed = false;

      const fail = (error) => {
        if (failed) return;
        failed = true;
        try {
          transaction.abort();
        } catch {
          // Transaction completion will surface the original error below.
        }
        reject(error);
      };

      const finishReads = () => {
        pendingReads -= 1;
        if (pendingReads !== 0 || failed) return;
        const callbackStart = recordSync ? syncNow() : 0;
        try {
          let highWater = readHighWater(highWaterRecord);
          let insertedAny = false;
          const storedRecords = records.map((record) => {
            const prior = existing.get(record.eventUid);
            if (prior !== undefined) {
              if (!recordsMatchForRetry(prior, record)) {
                throw new Error(`Diagnostics eventUid collision: ${record.eventUid}`);
              }
              return prior;
            }
            highWater += 1;
            insertedAny = true;
            const stored = { ...record, ingestSeq: highWater };
            events.put(stored);
            return stored;
          });
          if (insertedAny) meta.put({ key: INGEST_SEQUENCE_META_KEY, value: highWater });
          if (recordSync) recordSync('diag_transform', callbackStart, syncNow());
          resolve(storedRecords);
        } catch (error) {
          if (recordSync) recordSync('diag_transform', callbackStart, syncNow());
          fail(error);
        }
      };

      const highWaterRequest = meta.get(INGEST_SEQUENCE_META_KEY);
      highWaterRequest.onsuccess = () => {
        highWaterRecord = highWaterRequest.result;
        finishReads();
      };
      highWaterRequest.onerror = () => fail(highWaterRequest.error ?? new Error('Failed to read ingest sequence.'));

      records.forEach((record) => {
        const request = events.get(record.eventUid);
        request.onsuccess = () => {
          if (request.result !== undefined) existing.set(record.eventUid, request.result);
          finishReads();
        };
        request.onerror = () => fail(request.error ?? new Error(`Failed to read diagnostics event ${record.eventUid}.`));
      });
    });
    if (recordSync) recordSync('diag_set', scheduleStart, syncNow());

    try {
      const storedRecords = await staged;
      await done;
      return storedRecords;
    } catch (error) {
      await abortAndDrain(transaction, done);
      throw error;
    }
  };

  const getMeta = (key) => {
    let request;
    return runTransaction(DIAGNOSTICS_META_STORE, 'readonly', ({ objectStore }) => {
      request = objectStore(DIAGNOSTICS_META_STORE).get(key);
      return () => request.result?.value;
    });
  };

  const setMeta = (key, value) => runTransaction(
    DIAGNOSTICS_META_STORE,
    'readwrite',
    ({ objectStore }) => {
      objectStore(DIAGNOSTICS_META_STORE).put({ key, value });
    },
  );

  const deleteMeta = (key) => runTransaction(
    DIAGNOSTICS_META_STORE,
    'readwrite',
    ({ objectStore }) => {
      objectStore(DIAGNOSTICS_META_STORE).delete(key);
    },
  );

  const readEventsByIndex = (indexName, {
    range = null,
    limit = 5000,
    direction = 'next',
  } = {}) => {
    requireBoundedCount(limit, 'Indexed diagnostics read limit', 10000);
    if (!['next', 'prev'].includes(direction)) throw new TypeError('Unsupported diagnostics index direction.');
    let request;
    return runTransaction(DIAGNOSTICS_EVENTS_STORE, 'readonly', ({ objectStore }) => {
      const index = objectStore(DIAGNOSTICS_EVENTS_STORE).index(indexName);
      request = index.getAll(createRange(keyRangeFactory, range), limit);
      return () => {
        const records = Array.isArray(request.result) ? request.result : [];
        return direction === 'prev' ? records.reverse() : records;
      };
    });
  };

  const readEventsByUids = (eventUids) => {
    if (!Array.isArray(eventUids)) throw new TypeError('Diagnostics point-read keys must be an array.');
    if (eventUids.length > MAX_PRUNE_DELETES_PER_TX) {
      throw new RangeError(
        `Diagnostics point-read batch exceeds MAX_PRUNE_DELETES_PER_TX (${MAX_PRUNE_DELETES_PER_TX}).`,
      );
    }
    if (eventUids.length === 0) return Promise.resolve([]);
    const normalizedUids = eventUids.map((eventUid) => (
      requireEventUid(eventUid, { allowMigration: true })
    ));
    let requests;
    return runTransaction(DIAGNOSTICS_EVENTS_STORE, 'readonly', ({ objectStore }) => {
      const events = objectStore(DIAGNOSTICS_EVENTS_STORE);
      requests = normalizedUids.map((eventUid) => events.get(eventUid));
      return () => requests
        .map((request) => request.result)
        .filter((record) => record !== undefined);
    });
  };

  const readEventKeysByIndex = (indexName, { range = null, limit = MAX_PRUNE_DELETES_PER_TX } = {}) => {
    requireBoundedCount(limit, 'Indexed diagnostics key limit', MAX_PRUNE_DELETES_PER_TX);
    let request;
    return runTransaction(DIAGNOSTICS_EVENTS_STORE, 'readonly', ({ objectStore }) => {
      const index = objectStore(DIAGNOSTICS_EVENTS_STORE).index(indexName);
      request = index.getAllKeys(createRange(keyRangeFactory, range), limit);
      return () => (Array.isArray(request.result) ? request.result : []);
    });
  };

  const countEventsByIndex = (indexName, { range = null } = {}) => {
    let request;
    return runTransaction(DIAGNOSTICS_EVENTS_STORE, 'readonly', ({ objectStore }) => {
      const index = objectStore(DIAGNOSTICS_EVENTS_STORE).index(indexName);
      request = index.count(createRange(keyRangeFactory, range));
      return () => Number(request.result) || 0;
    });
  };

  const deleteEventUids = (eventUids) => {
    if (!Array.isArray(eventUids)) throw new TypeError('Diagnostics delete keys must be an array.');
    if (eventUids.length > MAX_PRUNE_DELETES_PER_TX) {
      throw new RangeError(`Diagnostics delete batch exceeds MAX_PRUNE_DELETES_PER_TX (${MAX_PRUNE_DELETES_PER_TX}).`);
    }
    return runTransaction(DIAGNOSTICS_EVENTS_STORE, 'readwrite', ({ objectStore }) => {
      const events = objectStore(DIAGNOSTICS_EVENTS_STORE);
      eventUids.forEach((eventUid) => events.delete(requireEventUid(eventUid, { allowMigration: true })));
    });
  };

  const putStoredEvents = (records) => {
    if (!Array.isArray(records)) throw new TypeError('Stored diagnostics update must be an array.');
    if (records.length > MAX_PRUNE_DELETES_PER_TX) {
      throw new RangeError(`Stored diagnostics update exceeds MAX_PRUNE_DELETES_PER_TX (${MAX_PRUNE_DELETES_PER_TX}).`);
    }
    records.forEach((record) => {
      const { ingestSeq, ...prepared } = record ?? {};
      validatePreparedEvent(prepared);
      requireNonNegativeInteger(ingestSeq, 'ingestSeq');
    });
    return runTransaction(DIAGNOSTICS_EVENTS_STORE, 'readwrite', ({ objectStore }) => {
      const events = objectStore(DIAGNOSTICS_EVENTS_STORE);
      records.forEach((record) => events.put(record));
    });
  };

  return Object.freeze({
    appendPreparedEvents,
    close,
    countEventsByIndex,
    deleteEventUids,
    deleteMeta,
    getMeta,
    open,
    prepareEvent,
    prepareMigratedEvent,
    putStoredEvents,
    readEventKeysByIndex,
    readEventsByIndex,
    readEventsByUids,
    runTransaction,
    setMeta,
  });
};
