// @ts-check
import premiumMapControlLayers from '@/assets/premium-map-control-layers.webp';
import premiumMapControlPlayback from '@/assets/premium-map-control-playback.webp';
import premiumMapControlView from '@/assets/premium-map-control-view.webp';

const CONTROLS = Object.freeze([
  {
    id: 'map',
    label: 'Map View',
    description: 'Explore the map',
    art: premiumMapControlView,
    tone: 'navigation',
    tab: 'mode',
  },
  {
    id: 'playback',
    label: 'Playback',
    description: 'Replay route history',
    art: premiumMapControlPlayback,
    tone: 'playback',
    tab: 'mode',
  },
  {
    id: 'layers',
    label: 'Layers',
    description: 'Manage map overlays',
    art: premiumMapControlLayers,
    tone: 'layers',
    tab: 'utility',
  },
]);

/**
 * Premium-only presentation for the map's existing mode and layer controls.
 * The standard controls remain in MapScreen so disabling premium visuals
 * preserves their markup and styling exactly.
 *
 * @param {{
 *   playbackMode: boolean,
 *   showLayerPanel: boolean,
 *   onShowMap: () => void,
 *   onShowPlayback: () => void,
 *   onToggleLayers: () => void,
 * }} props
 */
export default function PremiumMapControls({
  playbackMode,
  showLayerPanel,
  onShowMap,
  onShowPlayback,
  onToggleLayers,
}) {
  const stateById = {
    map: !playbackMode,
    playback: playbackMode,
    layers: showLayerPanel,
  };
  const actionById = {
    map: onShowMap,
    playback: onShowPlayback,
    layers: onToggleLayers,
  };

  return (
    <nav className="premium-map-controls" aria-label="Map view controls">
      {CONTROLS.map(({ id, label, description, art, tone, tab }) => (
        <button
          key={id}
          type="button"
          className="premium-map-control"
          data-control={id}
          data-tone={tone}
          data-map-tab={tab}
          aria-pressed={stateById[id]}
          onClick={actionById[id]}
        >
          <span className="premium-map-control-visual" aria-hidden="true">
            <img loading="lazy" src={art} alt="" />
          </span>
          <span className="premium-map-control-copy">
            <strong>{label}</strong>
            <small>{description}</small>
          </span>
        </button>
      ))}
    </nav>
  );
}
