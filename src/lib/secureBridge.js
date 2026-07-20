import { registerPlugin } from '@capacitor/core';

const BRIDGE_VERSION = 1;
const BRIDGE_CONTEXT = 'drivesense-secure-bridge-v1';

const SecureBridge = registerPlugin('SecureBridge');

let sessionPromise = null;
let lastNonce = 0;
let bridgeCallQueue = Promise.resolve();

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
  const session = await SecureBridge.initSession({
    version: BRIDGE_VERSION,
    clientPublicKey: bytesToBase64(new Uint8Array(clientPublicKey)),
  });
  if (!session?.sessionId || !session?.nativePublicKey) {
    throw new Error('Secure bridge session could not be established.');
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

async function performSecureCall(pluginName, method, data) {
  const api = cryptoApi();
  const { key, sessionId } = await getSession();
  const nonce = nextNonce();
  const iv = api.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(associatedData(sessionId, pluginName, method, nonce));
  const encrypted = await api.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData },
    key,
    new TextEncoder().encode(JSON.stringify(data ?? {}))
  );

  const plugin = pluginName === 'SecureBridge'
    ? SecureBridge
    : globalThis.Capacitor?.Plugins?.[pluginName];
  if (!plugin || typeof plugin[method] !== 'function') {
    throw new Error(`Secure bridge plugin method is unavailable: ${pluginName}.${method}`);
  }

  const result = await plugin[method]({
    encrypted: true,
    version: BRIDGE_VERSION,
    sessionId,
    iv: bytesToBase64(iv),
    data: bytesToBase64(new Uint8Array(encrypted)),
    nonce,
  });

  if (!result?.encrypted) return result;

  const resultNonce = Number(result.nonce);
  const plaintext = await api.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: base64ToBytes(result.iv),
      additionalData: new TextEncoder().encode(
        associatedData(sessionId, pluginName, `${method}:result`, resultNonce)
      ),
    },
    key,
    base64ToBytes(result.data)
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

export function secureCall(pluginName, method, data) {
  const call = bridgeCallQueue.then(() => performSecureCall(pluginName, method, data));
  bridgeCallQueue = call.catch(() => undefined);
  return call;
}

export async function secureSetPreference({ key, value, context, encryptAtRest = false }) {
  return secureCall('SecureBridge', 'setPreference', {
    key,
    value,
    context,
    encryptAtRest,
  });
}

