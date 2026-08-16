export const DIAGNOSTICS_DB_NAME = 'roadsage_diagnostics';
export const DIAGNOSTICS_DB_VERSION = 1;
export const DIAGNOSTICS_EVENTS_STORE = 'events';
export const DIAGNOSTICS_META_STORE = 'meta';

export const DIAGNOSTICS_EVENT_KINDS = Object.freeze([
  'performance',
  'system_log',
  'app_experience',
]);

export const MAX_FLUSH_BATCH = 64;
export const MAX_PRUNE_DELETES_PER_TX = 128;

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
const EVENT_KIND_SET = new Set(DIAGNOSTICS_EVENT_KINDS);

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
  if (typeof record.eventUid !== 'string' || !record.eventUid) {
    throw new TypeError('eventUid must be a non-empty string.');
  }
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
  return record;
};

const recordsMatchForRetry = (stored, prepared) => {
  if (!stored || typeof stored !== 'object') return false;
  const { ingestSeq: _storedIngestSeq, ...storedPrepared } = stored;
  try {
    return JSON.stringify(storedPrepared) === JSON.stringify(prepared);
  } catch {
    return false;
  }
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

export const createDiagnosticsStorage = (options = {}) => {
  const indexedDbFactory = hasOwn(options, 'indexedDbFactory')
    ? options.indexedDbFactory
    : globalIndexedDb();
  const now = options.now ?? (() => Date.now());
  const uidFactory = options.uidFactory ?? createDefaultUidFactory();
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

  const prepareEvent = (kind, payload, eventOptions = {}) => {
    requireEventKind(kind);
    const nowMs = requireFiniteNumber(now(), 'Diagnostics clock');
    const payloadTimestampMs = hasOwn(eventOptions, 'payloadTimestampMs')
      ? requireFiniteNumber(eventOptions.payloadTimestampMs, 'payloadTimestampMs')
      : nowMs;
    const clearEpoch = hasOwn(eventOptions, 'clearEpoch')
      ? requireNonNegativeInteger(eventOptions.clearEpoch, 'clearEpoch')
      : 0;
    const suppliedUid = eventOptions.eventUid;
    const uidPart = suppliedUid === undefined ? uidFactory({ kind, nowMs }) : null;
    if (suppliedUid === undefined && (typeof uidPart !== 'string' || !uidPart)) {
      throw new TypeError('Diagnostics UID factory must return a non-empty string.');
    }
    const generatedUid = suppliedUid ?? `live:${kind}:${uidPart}`;
    if (typeof generatedUid !== 'string' || !generatedUid) {
      throw new TypeError('Diagnostics UID factory must return a non-empty value.');
    }

    const record = {
      kind,
      eventUid: generatedUid,
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

  const prepareMigratedEvent = (kind, payload, eventOptions) => {
    if (!eventOptions || typeof eventOptions !== 'object') {
      throw new TypeError('Migration event options are required.');
    }
    const migrationGeneration = String(eventOptions.migrationGeneration ?? '');
    const migrationOrdinal = requireNonNegativeInteger(eventOptions.migrationOrdinal, 'migrationOrdinal');
    if (!migrationGeneration) throw new TypeError('migrationGeneration must not be empty.');
    return prepareEvent(kind, payload, {
      ...eventOptions,
      eventUid: createDeterministicLegacyEventUid(kind, migrationGeneration, migrationOrdinal),
      migrationGeneration,
      migrationOrdinal,
    });
  };

  const appendPreparedEvents = async (records) => {
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

    const db = await open();
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
          resolve(storedRecords);
        } catch (error) {
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

  return Object.freeze({
    appendPreparedEvents,
    close,
    getMeta,
    open,
    prepareEvent,
    prepareMigratedEvent,
    runTransaction,
    setMeta,
  });
};
