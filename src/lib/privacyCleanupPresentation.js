const count = (value) => Math.max(0, Math.floor(Number(value) || 0));

const item = (value, singular, plural = `${singular}s`) => {
  const total = count(value);
  return `${total} ${total === 1 ? singular : plural}`;
};

export function buildPrivacyCleanupPresentation({
  purgeResult = null,
  speedKnowledgeCleanup = null,
} = {}) {
  const gpsPoints = count(purgeResult?.pointsPurged);
  const eventLocations = count(purgeResult?.eventsPurged);
  const trips = count(purgeResult?.tripsAffected);
  const cells = count(speedKnowledgeCleanup?.cellsPurged);
  const rules = count(speedKnowledgeCleanup?.correctionsPurged);
  const roadMemory = count(speedKnowledgeCleanup?.roadMemoryCandidatesPurged);
  const history = count(speedKnowledgeCleanup?.historySnapshotsPurged);
  const replayMarkers = count(speedKnowledgeCleanup?.processedTripMarkersPurged);
  const exclusions = count(speedKnowledgeCleanup?.exclusionsPurged);
  const derivedTotal = count(speedKnowledgeCleanup?.totalRecordsPurged);

  return {
    gpsPoints,
    eventLocations,
    trips,
    cells,
    rules,
    roadMemory,
    history,
    replayMarkers,
    exclusions,
    derivedTotal,
    rawSummary: `${item(gpsPoints, 'stored GPS point')} and ${item(eventLocations, 'event location')} across ${item(trips, 'trip')}`,
    speedSummary: `${item(derivedTotal, 'saved road-speed record')} (${item(cells, 'cell')}, ${item(rules, 'rule')}, ${item(roadMemory, 'Road Memory corridor')}, ${item(history, 'history snapshot')}, ${item(replayMarkers, 'replay marker')}, and ${item(exclusions, 'exclusion')})`,
    description: `Raw GPS cleanup: ${item(gpsPoints, 'stored GPS point')} and ${item(eventLocations, 'event location')} across ${item(trips, 'trip')}. Saved road-speed cleanup: ${item(derivedTotal, 'record')} (${item(cells, 'cell')}, ${item(rules, 'rule')}, ${item(roadMemory, 'Road Memory corridor')}, ${item(history, 'history snapshot')}, ${item(replayMarkers, 'replay marker')}, and ${item(exclusions, 'exclusion')}).`,
  };
}

export function buildHeightenedPrivacyCleanupPresentation(result = {}) {
  return `Removed ${item(result.pointsPurged, 'stored GPS point')}, ${item(result.eventsPurged, 'event location')}, and ${item(result.speedKnowledgeRecordsPurged, 'saved road-speed record')} from ${item(result.zoneCount, 'configured privacy zone')}.`;
}
