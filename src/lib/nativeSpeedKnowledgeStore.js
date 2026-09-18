import {
  encodeBase64Bytes,
  nativeTripArchive,
  readNativeSpeedBucket,
  sha256Hex,
} from '@/lib/nativeTripArchive';

const GLOBAL_BUCKET = 'zzzz';
const PREFIX_PATTERN = /^[0-9bcdefghjkmnpqrstuvwxyz]{4}$/;

export const speedBucketId = (geohash) => {
  const value = String(geohash || '').trim().toLowerCase().slice(0, 4);
  return PREFIX_PATTERN.test(value) ? value : GLOBAL_BUCKET;
};

const emptyModel = () => ({
  schemaVersion: 1,
  knowledgeRevision: 0,
  knowledgeUpdatedAt: null,
  cells: {},
  corrections: [],
  excludedSections: [],
  roadMemory: { version: 3, candidates: [], processedTrips: {}, intelligence: null },
  history: { undo: [], redo: [] },
});

const mergeModel = (target, source = {}) => {
  Object.assign(target.cells, source.cells || {});
  target.corrections.push(...(source.corrections || []));
  target.excludedSections.push(...(source.excludedSections || []));
  target.roadMemory.candidates.push(...(source.roadMemory?.candidates || []));
  if (source.global) {
    target.schemaVersion = Number(source.global.schemaVersion) || target.schemaVersion;
    target.knowledgeRevision = Math.max(target.knowledgeRevision, Number(source.global.knowledgeRevision) || 0);
    target.knowledgeUpdatedAt = source.global.knowledgeUpdatedAt || target.knowledgeUpdatedAt;
    target.roadMemory.processedTrips = source.global.processedTrips || {};
    target.roadMemory.intelligence = source.global.intelligence || null;
    target.history = source.global.history || target.history;
  }
  return target;
};

const bucketDocument = (model, bucketId) => ({
  bucketId,
  schemaVersion: 1,
  cells: Object.fromEntries(Object.entries(model.cells || {}).filter(([id]) => speedBucketId(id) === bucketId)),
  corrections: (model.corrections || []).filter((item) => speedBucketId(item?.geohash) === bucketId),
  excludedSections: (model.excludedSections || []).filter((item) => speedBucketId(item?.geohash) === bucketId),
  roadMemory: {
    candidates: (model.roadMemory?.candidates || []).filter((item) => speedBucketId(item?.geohash) === bucketId),
  },
  ...(bucketId === GLOBAL_BUCKET ? {
    global: {
      schemaVersion: model.schemaVersion,
      knowledgeRevision: model.knowledgeRevision,
      knowledgeUpdatedAt: model.knowledgeUpdatedAt,
      processedTrips: model.roadMemory?.processedTrips || {},
      intelligence: model.roadMemory?.intelligence || null,
      history: model.history || { undo: [], redo: [] },
    },
  } : {}),
});

const documentCellCount = (document) => Object.keys(document.cells || {}).length +
  (document.corrections || []).length + (document.excludedSections || []).length +
  (document.roadMemory?.candidates || []).length;

export async function readNativeSpeedBuckets(bucketIds = []) {
  const ids = [...new Set([...bucketIds.map(speedBucketId), GLOBAL_BUCKET])];
  const metadata = await nativeTripArchive.querySpeedBucketMetadata(ids);
  const present = new Set((metadata.items || []).map((item) => item.bucketId));
  const model = emptyModel();
  for (const id of ids) {
    if (present.has(id)) mergeModel(model, await readNativeSpeedBucket(id));
  }
  return model;
}

export async function writeNativeSpeedBuckets(model, bucketIds, { p6Automatic = false } = {}) {
  const ids = [...new Set([...bucketIds.map(speedBucketId), GLOBAL_BUCKET])];
  const descriptors = [];
  const planned = p6Automatic
    ? await nativeTripArchive.beginSpeedBucketBatchPlan(ids.length, { p6Automatic: true })
    : await nativeTripArchive.beginSpeedBucketBatchPlan(ids.length);
  try {
    for (const bucketId of ids) {
      const document = bucketDocument(model, bucketId);
      const bytes = new TextEncoder().encode(JSON.stringify(document));
      try {
        const descriptor = { bucketId, expectedBytes: bytes.byteLength, cellCount: documentCellCount(document), payloadHash: await sha256Hex(bytes) };
        descriptors.push(descriptor);
        await nativeTripArchive.addSpeedBucketDescriptors(planned.batchId, [descriptor]);
      } finally {
        bytes.fill(0);
      }
    }
    const started = await nativeTripArchive.sealSpeedBucketBatchPlan(planned.batchId);
      for (const descriptor of descriptors) {
        const document = bucketDocument(model, descriptor.bucketId);
        const bytes = new TextEncoder().encode(JSON.stringify(document));
        try {
          if (await sha256Hex(bytes) !== descriptor.payloadHash || bytes.byteLength !== descriptor.expectedBytes) {
            throw new Error('Speed bucket changed between descriptor and transfer');
          }
          let chunkIndex = 0;
          for (let cursor = 0; cursor < bytes.length; cursor += 256 * 1024) {
            await nativeTripArchive.appendSpeedBucketChunk({
              batchId: started.batchId,
              bucketId: descriptor.bucketId,
              chunkIndex,
              chunkBase64: encodeBase64Bytes(bytes.subarray(cursor, cursor + 256 * 1024)),
            });
            chunkIndex += 1;
          }
        } finally {
          bytes.fill(0);
        }
      }
      const finished = await nativeTripArchive.finishSpeedBucketBatch(started.batchId);
      if (finished?.status === 'OBSOLETE') {
        const error = new Error('P6_SPEED_STAGE_OBSOLETE');
        error.code = 'P6_SPEED_STAGE_OBSOLETE';
        throw error;
      }
  } catch (error) {
    await nativeTripArchive.abortSpeedBucketBatch(planned.batchId).catch(() => {});
    throw error;
  } finally { descriptors.length = 0; }
}

export async function readAllNativeSpeedKnowledge({ onPage } = {}) {
  const model = emptyModel();
  let cursor = '';
  do {
    const page = await nativeTripArchive.querySpeedBucketPage(cursor, 32);
    for (const item of page.items || []) mergeModel(model, await readNativeSpeedBucket(item.bucketId));
    onPage?.({ bucketCount: (page.items || []).length, cursor: page.nextCursor || null });
    cursor = page.nextCursor || '';
  } while (cursor);
  return model;
}

export async function readNativeSpeedKnowledgeSample(maxBuckets = 8) {
  const page = await nativeTripArchive.querySpeedBucketPage('', Math.max(1, Math.min(32, maxBuckets)));
  return readNativeSpeedBuckets((page.items || []).map((item) => item.bucketId));
}

export function speedBucketsForPoints(points = []) {
  return [...new Set(points.map((point) => speedBucketId(point?.geohash)).filter(Boolean))];
}
