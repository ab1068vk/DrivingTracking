import { Capacitor } from '@capacitor/core';

export const CERTIFICATE_PINS = Object.freeze({
  'api.open-meteo.com': Object.freeze([
    'sha256/YAFPPxCwfYpnCvumZr5iRwQxdLb9dak90Qvb33ma0Fo=',
    'sha256/kZwN96eHtZftBWrOZUsd6cA4es80n3NzSk/XtYz2EqQ=',
  ]),
  'archive-api.open-meteo.com': Object.freeze([
    'sha256/Bhlw8LnAlZsTwkhXA0Qn5Kk7WmvoeEhHuk+juIQZaVQ=',
    'sha256/brzvtCELCIZUo4sD/qPX0ccRtPsd3DY6RfmxpOU9oB4=',
  ]),
  'overpass-api.de': Object.freeze([
    'sha256/uAD+342sjrC9Pc6amj8vUGZtGKiuGOTK5FVAKN9AzMg=',
    'sha256/iFvwVyJSxnQdyaUvUERIf+8qk7gRze3612JMwoO3zdU=',
  ]),
  'overpass.kumi.systems': Object.freeze([
    'sha256/Psda1h1uTCa01j78YJ7feYiyTyUstFDOhS9D8fDqfT0=',
    'sha256/LoMHBotttiDko50Gi13uXW71eIy7LAttI+rYT8wXF4w=',
  ]),
  'nominatim.openstreetmap.org': Object.freeze([
    'sha256/aYxG28Ea4Ja2f1RoVh73ANdittYvAQ5f+d4eJmfUt8o=',
    'sha256/LoMHBotttiDko50Gi13uXW71eIy7LAttI+rYT8wXF4w=',
  ]),
});

export const PINNED_GPS_HOSTS = Object.freeze(Object.keys(CERTIFICATE_PINS));

const inputUrl = (input) => {
  if (input instanceof URL) return input.toString();
  if (typeof Request !== 'undefined' && input instanceof Request) return input.url;
  return String(input);
};

const isNativePlatform = () => {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
};

export function pinsForHost(hostname) {
  return CERTIFICATE_PINS[String(hostname || '').toLowerCase()] || null;
}

export function assertPinnedGpsEndpoint(input) {
  const url = new URL(inputUrl(input));
  if (url.protocol !== 'https:') {
    throw new Error(`[CertPin] Refusing GPS-bearing request over ${url.protocol}`);
  }

  if (isNativePlatform() && !pinsForHost(url.hostname)) {
    throw new Error(`[CertPin] No Android certificate pins configured for ${url.hostname}`);
  }

  return url;
}

export async function pinnedFetch(input, init = {}) {
  assertPinnedGpsEndpoint(input);
  return fetch(input, init);
}
