/**
 * DPD-026 — identity stability for the map's event list.
 *
 * Pages build the list they hand to the map with `.filter()`/`.map()` during
 * render (`TripDetail.jsx` builds `mapDisplayEvents` and then `mapEvents` that
 * way), so a fresh array arrives on every render even when nothing about the trip
 * changed. That array is a dependency of the map's layer-draw effect, so an
 * unstable identity made the effect re-run, clear the layer group and rebuild
 * every polyline segment.
 *
 * Measured on the A54 at 500 trips with the page open and untouched: roughly five
 * full redraws per second, ~900 segments each, a ~380 ms long task per redraw and
 * ~110,000 DOM mutations per six seconds, against 7 mutations on a control page.
 * The map container and pane survived while every `path` element was destroyed
 * and recreated, which is what identified a re-running effect rather than a
 * remounting component.
 *
 * Comparing a short signature is O(events); rebuilding the layer is O(route
 * points) plus Leaflet DOM churn, which is the cost being avoided.
 *
 * This lives outside the map component so it can be tested without loading
 * Leaflet, which needs a `window`.
 */

/**
 * The identity of an event, for redraw purposes, is its whole content.
 *
 * A hand-picked field list was tried first and was wrong: the layer-draw effect
 * renders `speed_kmh`, `speed_limit_kmh`, `inferred_zone_kmh`,
 * `speed_limit_source`, `source`, `duration_seconds`, `durationS`, `value`,
 * `zone_confidence`, `signals_triggered` and `confidence_level` as well as the
 * obvious ones -- and `confidence_level` decides the marker colour, not just the
 * popup text. Any field left out of the signature is a field whose change is
 * silently never drawn, and a missed redraw is far worse than an extra one.
 *
 * So the signature covers everything, and stays correct when the popup learns to
 * render another field. Key order is stable for objects built by one code path;
 * if it ever varies the signature changes and the map redraws, which is the safe
 * direction to fail in.
 */
export const mapEventIdentity = (event) => {
  if (!event || typeof event !== 'object') return String(event);
  try {
    return JSON.stringify(event);
  } catch {
    // A cyclic or otherwise unserialisable event: fall back to a value that
    // never matches, so the map redraws rather than showing stale content.
    return `unserialisable:${Math.random()}`;
  }
};

/** Order matters: the map draws the list in the order it is given. */
export function contentSignature(list, identityOf) {
  return Array.isArray(list) ? list.map(identityOf).join('|') : '';
}

/**
 * The whole decision: keep the reference already held when the incoming list says
 * the same thing, adopt the new one when it does not. `useContentStableList` in
 * the map component is the `useRef` plumbing around this.
 */
export function nextStableList(held, heldSignature, list, identityOf) {
  const signature = contentSignature(list, identityOf);
  return signature === heldSignature
    ? { list: held, signature: heldSignature, adopted: false }
    : { list, signature, adopted: true };
}
