import { reverseGeocodeIfPermitted } from '@/lib/geocoding';

export const shortenParkedAddress = (address) => {
  const trimmed = String(address || '').trim();
  if (!trimmed) return null;

  const parts = trimmed.split(',').map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return `${parts[0]}, ${parts[1]}`;
  return trimmed;
};

export async function reverseGeocodeParkedLocation(lat, lng, options = {}) {
  return reverseGeocodeIfPermitted(lat, lng, {
    ...options,
    shorten: true,
    shortenAddress: shortenParkedAddress,
  });
}
