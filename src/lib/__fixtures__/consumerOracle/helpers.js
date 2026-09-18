/**
 * Fixture helpers for the transitive consumer-oracle mutation test.
 *
 * `fixtureEntryHelper` never reads a projection field itself; the read happens
 * one call deeper, in `fixtureNestedHelper`. That is the shape the oracle used
 * to miss, and the shape the real Dashboard chain
 * (`buildOnDeviceDriverModel` -> `tripFeatureVector`) has.
 */

export function fixtureNestedHelper(trip = {}) {
  return {
    phone_pct: Number(trip.phone_use_pct_of_trip) || 0,
  };
}

export function fixtureEntryHelper(trips = []) {
  const completed = (trips || []).filter((trip) => trip.status === 'completed');
  return completed.map(fixtureNestedHelper);
}
