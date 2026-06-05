import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function loadTrips(tripsFile) {
  const resolved = path.resolve(tripsFile);
  const raw = await readFile(resolved, 'utf8');
  const parsed = JSON.parse(raw);
  const trips = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.trips)
      ? parsed.trips
      : Array.isArray(parsed.completed_trips)
        ? parsed.completed_trips
        : null;

  if (!trips) {
    throw new Error('Trips file must be an array or contain a trips/completed_trips array.');
  }

  console.log(`Loaded ${trips.length.toLocaleString()} trips from ${resolved}`);
  return { trips, tripsFile: resolved };
}
