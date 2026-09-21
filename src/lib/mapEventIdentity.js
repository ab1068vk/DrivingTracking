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

/** Enough of an event to tell one from another without holding a reference. */
export const mapEventIdentity = (event) => (
  event && typeof event === 'object'
    ? `${event.type || ''}:${event.timestamp || event.time || ''}:${event.lat ?? ''}:${event.lng ?? ''}:${event.severity ?? ''}`
    : String(event)
);

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
