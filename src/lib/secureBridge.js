import { registerPlugin } from '@capacitor/core';

import {
  closeP0Span,
  openP0Span,
  recordP0NativeBlock,
  recordP0Phase,
  tagP0PayloadKind,
  tagP0SecureSpan,
} from '@/lib/p0Probe';

const BRIDGE_VERSION = 1;
const BRIDGE_CONTEXT = 'drivesense-secure-bridge-v1';

const SecureBridge = registerPlugin('SecureBridge');

let sessionPromise = null;
let lastNonce = 0;
let bridgeCallQueue = Promise.resolve();

/**
 * P0 queue contract: the number of secure calls already pending or in flight.
 * Snapshotted before chaining, incremented once, and decremented exactly once
 * when the call settles — including rejection and immediate settlement.
 */
let pendingSecureCalls = 0;

const p0Now = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
);

const cryptoApi = () => {
  const api = globalThis.crypto;
  if (!api?.subtle || typeof api.getRandomValues !== 'function') {
    throw new Error('Secure bridge cryptography is unavailable on this device.');
  }
  return api;
};

const bytesToBase64 = (bytes) => {
  let binary = '';
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
};

const base64ToBytes = (value) => {
  const binary = atob(String(value || ''));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const concatBytes = (...parts) => {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  parts.forEach((part) => {
    out.set(part, offset);
    offset += part.length;
  });
  return out;
};

const associatedData = (sessionId, pluginName, method, nonce) => (
  `${BRIDGE_CONTEXT}|${sessionId}|${pluginName}|${method}|${nonce}`
);

const nextNonce = () => {
  lastNonce = Math.max(Date.now(), lastNonce + 1);
  return lastNonce;
};

async function createSession() {
  const api = cryptoApi();
  const keyPair = await api.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    ['deriveBits']
  );
  const clientPublicKey = await api.subtle.exportKey('spki', keyPair.publicKey);

  // The handshake is measured deliberately, not incidentally. Native gates all
  // P0 work on receiving a valid inbound `call_id`, so it only times and
  // attaches a block when this span exists — which means a probe-off handshake
  // does no native P0 work, and an instrumented one is never an orphan block
  // that nothing ingests.
  const span = openP0Span('secure_call');
  if (span) tagP0SecureSpan(span, 'SecureBridge', 'initSession');
  const request = {
    version: BRIDGE_VERSION,
    clientPublicKey: bytesToBase64(new Uint8Array(clientPublicKey)),
  };
  let sendWallMs = 0;
  if (span) {
    sendWallMs = Date.now();
    span.wall_pre_native_ms = sendWallMs;
    request._p0 = { call_id: span.call_id, send_wall_ms: sendWallMs };
  }

  let session;
  let handshakeOutcome = 'error';
  try {
    const initInvokeStart = span ? p0Now() : 0;
    let initPromise;
    try {
      initPromise = SecureBridge.initSession(request);
    } catch (error) {
      if (span) recordP0Phase(span, 'native_invoke', initInvokeStart, p0Now());
      throw error;
    }
    const initInvokeEnd = span ? p0Now() : 0;
    if (span) recordP0Phase(span, 'native_invoke', initInvokeStart, initInvokeEnd);

    try {
      session = await initPromise;
    } catch (error) {
      if (span) recordP0Phase(span, 'native_await', initInvokeEnd, p0Now());
      throw error;
    }
    if (span) {
      span.wall_post_native_ms = Date.now();
      recordP0Phase(span, 'native_await', initInvokeEnd, p0Now());
      let nativeBlock = null;
      try {
        nativeBlock = session && typeof session === 'object' ? session._p0 : null;
      } catch {
        nativeBlock = null;
      }
      if (nativeBlock) recordP0NativeBlock(span, nativeBlock, sendWallMs);
    }

    // A malformed handshake response is a failed handshake; the span must say so.
    if (!session?.sessionId || !session?.nativePublicKey) {
      throw new Error('Secure bridge session could not be established.');
    }
    handshakeOutcome = 'success';
  } finally {
    // `session` never reaches a caller — `createSession` returns only the
    // derived key and session id — so no `_p0` strip is needed here.
    if (span) closeP0Span(span, handshakeOutcome);
  }

  const nativePublicKey = await api.subtle.importKey(
    'spki',
    base64ToBytes(session.nativePublicKey),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    []
  );
  const sharedSecret = new Uint8Array(await api.subtle.deriveBits(
    { name: 'ECDH', public: nativePublicKey },
    keyPair.privateKey,
    256
  ));
  const context = new TextEncoder().encode(`${BRIDGE_CONTEXT}:${session.sessionId}`);
  const digest = await api.subtle.digest('SHA-256', concatBytes(sharedSecret, context));
  const key = await api.subtle.importKey(
    'raw',
    digest,
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt']
  );

  return { key, sessionId: session.sessionId };
}

const getSession = () => {
  if (!sessionPromise) {
    sessionPromise = createSession().catch((error) => {
      sessionPromise = null;
      throw error;
    });
  }
  return sessionPromise;
};

/**
 * Remove the outer P0 diagnostic block from a caller-visible plaintext result.
 *
 * `_p0` is unauthenticated diagnostic metadata attached outside the ciphertext
 * and AAD. The encrypted branch returns the decrypted inner payload, so nothing
 * leaks there by construction — but the non-encrypted branch returns the native
 * result object directly, so the field must be stripped explicitly.
 */
const stripP0Block = (result) => {
  if (!result || typeof result !== 'object') return result;
  try {
    if (!('_p0' in result)) return result;
    delete result._p0;
    return result;
  } catch {
    // Non-configurable `_p0`, or a hostile trap on `in`/`delete`. Rebuild from
    // property *descriptors*: reading `result[key]` here would invoke every
    // getter on the object, which can throw or hand the caller a different
    // value than the uninstrumented code path returned.
    try {
      const descriptors = Object.getOwnPropertyDescriptors(result);
      delete descriptors._p0;
      return Object.create(Object.getPrototypeOf(result), descriptors);
    } catch {
      // Nothing further is safe to do without risking the caller's result.
      return result;
    }
  }
};

/**
 * Expressions below are split into named statements purely so each phase can be
 * timed. Values, evaluation order, crypto, AAD, nonce handling and call order
 * are unchanged from the pre-instrumentation implementation.
 */
async function performSecureCall(pluginName, method, data, p0 = null) {
  const span = p0?.span ?? null;
  // Reading the clock only when a span exists keeps Arm D (probe off) free of
  // per-phase timing cost.
  const mark = () => (span ? p0Now() : 0);
  // Every phase below is committed as soon as its end timestamp is known,
  // never batched behind a later await. A rejected WebCrypto or native call
  // must leave the intervals that *did* complete on the record, plus the failed
  // await interval — otherwise the error path measures as free.
  let outcome = 'error';

  try {
    if (span) {
      // Queue wait runs from the sample taken immediately before chaining to
      // this function's entry — not from span creation, which happens earlier.
      recordP0Phase(span, 'queue_wait', p0.enqueuePerfMs, p0Now());
      span.queue_depth_at_enqueue = p0.queueDepth;
      tagP0SecureSpan(span, pluginName, method);
      if (p0.payloadKind) tagP0PayloadKind(span, p0.payloadKind);
      if (p0.parentOpId) span.parent_op_id = p0.parentOpId;
    }

    const api = cryptoApi();
    const sessionWaitStart = mark();
    let session;
    try {
      session = await getSession();
    } catch (error) {
      if (span) recordP0Phase(span, 'session_wait', sessionWaitStart, p0Now());
      throw error;
    }
    if (span) recordP0Phase(span, 'session_wait', sessionWaitStart, p0Now());
    const { key, sessionId } = session;

    const nonce = nextNonce();
    const iv = api.getRandomValues(new Uint8Array(12));
    const additionalData = new TextEncoder().encode(associatedData(sessionId, pluginName, method, nonce));

    // Each interval is committed the moment its own end timestamp exists, never
    // after a later operation succeeds. A synchronous throw from `stringify`,
    // `encode` or `subtle.encrypt` must leave the completed intervals — and its
    // own partial interval — on the record.
    const reqJsonStart = mark();
    let requestJson;
    try {
      requestJson = JSON.stringify(data ?? {});
    } catch (error) {
      if (span) recordP0Phase(span, 'req_json', reqJsonStart, p0Now());
      throw error;
    }
    const reqJsonEnd = mark();
    if (span) recordP0Phase(span, 'req_json', reqJsonStart, reqJsonEnd);

    let encodedRequest;
    try {
      encodedRequest = new TextEncoder().encode(requestJson);
    } catch (error) {
      if (span) recordP0Phase(span, 'req_encode', reqJsonEnd, p0Now());
      throw error;
    }
    const reqEncodeEnd = mark();
    if (span) {
      recordP0Phase(span, 'req_encode', reqJsonEnd, reqEncodeEnd);
      span.req_plaintext_bytes = encodedRequest.byteLength;
    }

    let encryptPromise;
    try {
      encryptPromise = api.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData },
        key,
        encodedRequest
      );
    } catch (error) {
      if (span) recordP0Phase(span, 'wc_encrypt_invoke', reqEncodeEnd, p0Now());
      throw error;
    }
    const encryptInvokeEnd = mark();
    if (span) recordP0Phase(span, 'wc_encrypt_invoke', reqEncodeEnd, encryptInvokeEnd);

    let encrypted;
    try {
      encrypted = await encryptPromise;
    } catch (error) {
      if (span) recordP0Phase(span, 'wc_encrypt_await', encryptInvokeEnd, p0Now());
      throw error;
    }
    const encryptAwaitEnd = mark();
    if (span) {
      recordP0Phase(span, 'wc_encrypt_await', encryptInvokeEnd, encryptAwaitEnd);
      span.req_ciphertext_bytes = encrypted.byteLength;
    }

    const plugin = pluginName === 'SecureBridge'
      ? SecureBridge
      : globalThis.Capacitor?.Plugins?.[pluginName];
    if (!plugin || typeof plugin[method] !== 'function') {
      throw new Error(`Secure bridge plugin method is unavailable: ${pluginName}.${method}`);
    }

    const ivB64Start = mark();
    let ivBase64;
    try {
      ivBase64 = bytesToBase64(iv);
    } catch (error) {
      if (span) recordP0Phase(span, 'req_b64_iv', ivB64Start, p0Now());
      throw error;
    }
    const ivB64End = mark();
    if (span) recordP0Phase(span, 'req_b64_iv', ivB64Start, ivB64End);

    // The one most likely to throw in practice: a multi-megabyte payload here
    // spreads 32k arguments per chunk and can exhaust the call stack.
    let dataBase64;
    try {
      dataBase64 = bytesToBase64(new Uint8Array(encrypted));
    } catch (error) {
      if (span) recordP0Phase(span, 'req_b64_data', ivB64End, p0Now());
      throw error;
    }
    const dataB64End = mark();
    if (span) recordP0Phase(span, 'req_b64_data', ivB64End, dataB64End);

    const envelope = {
      encrypted: true,
      version: BRIDGE_VERSION,
      sessionId,
      iv: ivBase64,
      data: dataBase64,
      nonce,
    };
    // Outer diagnostic metadata only: a privacy-safe call id and the send wall
    // time. Outside the ciphertext and AAD; native never trusts it.
    const sendWallMs = span ? Date.now() : 0;
    if (span) {
      span.wall_pre_native_ms = sendWallMs;
      span.req_b64_chars = dataBase64.length;
      envelope._p0 = { call_id: span.call_id, send_wall_ms: sendWallMs };
    }

    const nativeInvokeStart = mark();
    let nativePromise;
    try {
      nativePromise = plugin[method](envelope);
    } catch (error) {
      // A Capacitor plugin method can throw synchronously before returning a
      // promise; the serialization work it did first is still real.
      if (span) recordP0Phase(span, 'native_invoke', nativeInvokeStart, p0Now());
      throw error;
    }
    const nativeInvokeEnd = mark();
    if (span) recordP0Phase(span, 'native_invoke', nativeInvokeStart, nativeInvokeEnd);
    let result;
    try {
      result = await nativePromise;
    } catch (error) {
      if (span) {
        span.wall_post_native_ms = Date.now();
        recordP0Phase(span, 'native_await', nativeInvokeEnd, p0Now());
      }
      throw error;
    }
    const nativeAwaitEnd = mark();
    if (span) {
      span.wall_post_native_ms = Date.now();
      recordP0Phase(span, 'native_await', nativeInvokeEnd, nativeAwaitEnd);
      // Read the unauthenticated diagnostic block defensively: a throwing getter
      // must not be able to fail the call it is describing.
      let nativeBlock = null;
      try {
        nativeBlock = result && typeof result === 'object' ? result._p0 : null;
      } catch {
        nativeBlock = null;
      }
      if (nativeBlock) recordP0NativeBlock(span, nativeBlock, sendWallMs);
    }

    if (!result?.encrypted) {
      const plain = stripP0Block(result);
      outcome = 'success';
      return plain;
    }

    const resultNonce = Number(result.nonce);
    const resB64IvStart = mark();
    let responseIv;
    try {
      responseIv = base64ToBytes(result.iv);
    } catch (error) {
      if (span) recordP0Phase(span, 'res_b64_iv', resB64IvStart, p0Now());
      throw error;
    }
    const resB64IvEnd = mark();
    if (span) {
      recordP0Phase(span, 'res_b64_iv', resB64IvStart, resB64IvEnd);
      span.res_b64_chars = typeof result.data === 'string' ? result.data.length : -1;
    }

    // The response AAD encode sits between the two base64 phases with no phase
    // id of its own, by ruling. It stays a visible unattributed residual.
    const responseAad = new TextEncoder().encode(
      associatedData(sessionId, pluginName, `${method}:result`, resultNonce)
    );
    const responseAadEnd = mark();

    // The prime suspect for population B: a per-character callback over a
    // multi-megabyte string. If it throws, its partial interval is the single
    // most valuable row in the trace.
    let responseBytes;
    try {
      responseBytes = base64ToBytes(result.data);
    } catch (error) {
      if (span) recordP0Phase(span, 'res_b64_data', responseAadEnd, p0Now());
      throw error;
    }
    const resB64DataEnd = mark();
    if (span) {
      recordP0Phase(span, 'res_b64_data', responseAadEnd, resB64DataEnd);
      span.res_ciphertext_bytes = responseBytes.byteLength;
    }

    let decryptPromise;
    try {
      decryptPromise = api.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: responseIv,
          additionalData: responseAad,
        },
        key,
        responseBytes
      );
    } catch (error) {
      if (span) recordP0Phase(span, 'wc_decrypt_invoke', resB64DataEnd, p0Now());
      throw error;
    }
    const decryptInvokeEnd = mark();
    if (span) recordP0Phase(span, 'wc_decrypt_invoke', resB64DataEnd, decryptInvokeEnd);

    let plaintext;
    try {
      plaintext = await decryptPromise;
    } catch (error) {
      if (span) recordP0Phase(span, 'wc_decrypt_await', decryptInvokeEnd, p0Now());
      throw error;
    }
    const decryptAwaitEnd = mark();
    if (span) {
      recordP0Phase(span, 'wc_decrypt_await', decryptInvokeEnd, decryptAwaitEnd);
      span.res_plaintext_bytes = plaintext.byteLength;
    }

    const decodeStart = mark();
    const decoded = new TextDecoder().decode(plaintext);
    const decodeEnd = mark();
    if (span) recordP0Phase(span, 'res_decode', decodeStart, decodeEnd);
    // A parse failure is real synchronous work; record the interval it consumed
    // before rethrowing rather than losing it with the call.
    let parsed;
    try {
      parsed = JSON.parse(decoded);
    } catch (error) {
      if (span) recordP0Phase(span, 'res_json', decodeEnd, p0Now());
      throw error;
    }
    const parseEnd = mark();
    if (span) recordP0Phase(span, 'res_json', decodeEnd, parseEnd);

    outcome = 'success';
    return parsed;
  } finally {
    if (p0) {
      // The call's own `finally`: it runs on rejection, on immediate
      // settlement, and before any caller continuation can enqueue the next
      // call and observe a stale depth.
      try {
        if (span) closeP0Span(span, outcome);
      } catch {
        // Diagnostics can never change a caller-visible result.
      }
      if (!p0.released) {
        p0.released = true;
        pendingSecureCalls -= 1;
      }
    }
  }
}

/**
 * @param {string} pluginName
 * @param {string} method
 * @param {any} data
 * @param {{ parentOpId?: number, payloadKind?: string }} [p0Meta]
 *   Optional P0 correlation metadata supplied by an explicit caller. Parentage
 *   is never inferred; only a caller that actually owns the logical operation
 *   passes it.
 */
export function secureCall(pluginName, method, data, p0Meta) {
  const span = openP0Span('secure_call');
  // With the probe off (Arm D and every release build) this allocates no
  // metadata object, touches no counter, and creates no extra promise link —
  // the A/D CDP comparison exists to measure exactly that allocation and
  // microtask cost, and cannot if the "off" arm pays part of it.
  const p0 = span
    ? {
      span,
      // Snapshot before incrementing: the depth is what was already pending or
      // in flight, excluding this call.
      queueDepth: pendingSecureCalls,
      parentOpId: p0Meta?.parentOpId ?? 0,
      payloadKind: p0Meta?.payloadKind ?? '',
      enqueuePerfMs: 0,
      released: false,
    }
    : null;
  if (p0) {
    pendingSecureCalls += 1;
    p0.enqueuePerfMs = p0Now();
  }

  // Chain identity and returned-promise identity are exactly as they were
  // before instrumentation: no `.then`/`.finally` is attached to `call`.
  const call = bridgeCallQueue.then(() => performSecureCall(pluginName, method, data, p0));
  bridgeCallQueue = call.catch(() => undefined);
  return call;
}

/** Test-only view of the queue counter. */
export const __pendingSecureCallsForTests = () => pendingSecureCalls;

export async function secureSetPreference({ key, value, context, encryptAtRest = false }) {
  return secureCall('SecureBridge', 'setPreference', {
    key,
    value,
    context,
    encryptAtRest,
  });
}

