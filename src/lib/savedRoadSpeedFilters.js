// @ts-check

export const savedRoadSpeedSearchText = (row = {}, conflict = null) => [
  row.geohash,
  row.roadName,
  row.contextLabel,
  row.note,
  row.source,
  row.limitKmh,
  conflict?.observedLimitKmh,
].filter((value) => value != null && value !== '').join(' ').toLowerCase();

export const matchesSavedRoadSpeedFilter = (row = {}, conflict = null, filter = 'all') => {
  if (filter === 'historical') return row.historicalVersion === true;
  if (row.historicalVersion === true && filter !== 'all') return false;
  if (filter === 'conflicts') return Boolean(conflict);
  if (filter === 'posted') return row.source === 'user_confirmed_posted_sign';
  if (filter === 'estimates') return row.source !== 'user_confirmed_posted_sign';
  if (filter === 'timeRules') {
    return row.timeRule?.enabled === true || row.directionMode === 'forward' || row.directionMode === 'reverse';
  }
  if (filter === 'expiring') return Boolean(row.expiresAt);
  return true;
};

export const sortSavedRoadSpeedRows = (items = [], sortMode = 'updated') => [...items].sort((a, b) => {
  if (sortMode === 'impact') {
    return (Number(b.conflict?.deltaKmh) || 0) - (Number(a.conflict?.deltaKmh) || 0);
  }
  if (sortMode === 'road') {
    return String(a.row.roadName || a.row.contextLabel || a.row.geohash)
      .localeCompare(String(b.row.roadName || b.row.contextLabel || b.row.geohash));
  }
  if (sortMode === 'limit') {
    return (Number(a.row.limitKmh) || 0) - (Number(b.row.limitKmh) || 0);
  }
  return new Date(b.row.appliedAt || 0).getTime() - new Date(a.row.appliedAt || 0).getTime();
});
