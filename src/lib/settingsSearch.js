const normalizeSearchText = (value) => String(value || '')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

const searchWords = (value) => normalizeSearchText(value).split(/\s+/).filter(Boolean);

const maxTypoDistance = (term) => {
  if (term.length < 4) return 0;
  if (term.length < 8) return 1;
  return 2;
};

const damerauLevenshteinDistance = (left, right) => {
  if (left === right) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;

  const matrix = Array.from({ length: left.length + 1 }, () => Array(right.length + 1).fill(0));
  for (let row = 0; row <= left.length; row += 1) matrix[row][0] = row;
  for (let column = 0; column <= right.length; column += 1) matrix[0][column] = column;

  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const substitutionCost = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row][column] = Math.min(
        matrix[row - 1][column] + 1,
        matrix[row][column - 1] + 1,
        matrix[row - 1][column - 1] + substitutionCost
      );

      if (
        row > 1
        && column > 1
        && left[row - 1] === right[column - 2]
        && left[row - 2] === right[column - 1]
      ) {
        matrix[row][column] = Math.min(matrix[row][column], matrix[row - 2][column - 2] + 1);
      }
    }
  }

  return matrix[left.length][right.length];
};

const fuzzyWordDistance = (term, words) => {
  const allowedDistance = maxTypoDistance(term);
  if (!allowedDistance) return null;

  let bestDistance = Number.POSITIVE_INFINITY;
  words.forEach((word) => {
    if (Math.abs(word.length - term.length) > allowedDistance) return;
    bestDistance = Math.min(bestDistance, damerauLevenshteinDistance(term, word));
  });

  return bestDistance <= allowedDistance ? bestDistance : null;
};

const prepareSearchItem = (item) => {
  const label = normalizeSearchText(item.label);
  const section = normalizeSearchText(item.section);
  const detail = normalizeSearchText(item.detail);
  const keywords = normalizeSearchText(item.keywords);
  return {
    ...item,
    searchText: `${label} ${section} ${detail} ${keywords}`,
    searchFields: {
      label,
      section,
      detail,
      keywords,
    },
    searchWords: {
      label: searchWords(label),
      section: searchWords(section),
      detail: searchWords(detail),
      keywords: searchWords(keywords),
    },
  };
};

const searchItemForSection = (section) => prepareSearchItem({
  kind: 'area',
  label: section.title,
  section: section.title,
  sectionId: section.id,
  detail: section.detail,
  keywords: section.keywords,
});

const searchItemsForSection = (section) => (section.searchItems || []).map((item) => {
  const normalizedItem = typeof item === 'string' ? { label: item } : item;
  return prepareSearchItem({
    kind: 'setting',
    label: normalizedItem.label,
    section: section.title,
    sectionId: section.id,
    targetLabel: normalizedItem.targetLabel || normalizedItem.label,
    detail: normalizedItem.detail || section.detail,
    keywords: `${section.keywords || ''} ${normalizedItem.keywords || ''}`,
  });
});

const scoreSearchItem = (item, query, terms) => {
  const { label, section, detail, keywords } = item.searchFields;
  const fieldWords = item.searchWords;
  const termMatches = terms.map((term) => {
    if (item.searchText.includes(term)) return { exact: true, fuzzyScore: 0 };

    const fuzzyCandidates = [
      { distance: fuzzyWordDistance(term, fieldWords.label), weight: 22 },
      { distance: fuzzyWordDistance(term, fieldWords.section), weight: 14 },
      { distance: fuzzyWordDistance(term, fieldWords.detail), weight: 8 },
      { distance: fuzzyWordDistance(term, fieldWords.keywords), weight: 5 },
    ].filter((candidate) => candidate.distance != null);

    if (!fuzzyCandidates.length) return null;
    const fuzzyScore = Math.max(...fuzzyCandidates.map(
      (candidate) => Math.max(2, candidate.weight - candidate.distance * 3)
    ));
    return { exact: false, fuzzyScore };
  });

  if (termMatches.some((match) => match == null)) return 0;

  let score = item.kind === 'setting' ? 8 : 0;
  if (label === query) score += 140;
  else if (label.startsWith(query)) score += 90;
  else if (label.includes(query)) score += 60;

  if (section === query) score += 100;
  else if (section.startsWith(query)) score += 55;
  else if (section.includes(query)) score += 35;

  if (detail.includes(query)) score += 18;
  if (keywords.includes(query)) score += 14;

  terms.forEach((term, index) => {
    const match = termMatches[index];
    if (!match.exact) {
      score += match.fuzzyScore;
      return;
    }

    if (label.startsWith(term)) score += 22;
    else if (label.includes(term)) score += 15;

    if (section.startsWith(term)) score += 12;
    else if (section.includes(term)) score += 8;

    if (detail.includes(term)) score += 4;
    if (keywords.includes(term)) score += 3;
  });

  return score;
};

export function buildSettingsSearchIndex(sections) {
  return sections.flatMap((section) => [
    searchItemForSection(section),
    ...searchItemsForSection(section),
  ]);
}

export function searchSettingsIndex(index, rawQuery, limit = 8) {
  const query = normalizeSearchText(rawQuery);
  if (!query) return [];

  const terms = query.split(/\s+/).filter(Boolean);

  return index
    .map((item) => ({ ...item, score: scoreSearchItem(item, query, terms) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .slice(0, limit);
}

export function searchSettingsSections(sections, rawQuery, limit = 8) {
  return searchSettingsIndex(buildSettingsSearchIndex(sections), rawQuery, limit);
}
