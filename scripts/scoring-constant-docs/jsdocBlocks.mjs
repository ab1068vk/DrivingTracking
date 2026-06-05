export function extractJsdocBlocks(source) {
  const blocks = [];
  const blockPattern = /\/\*\*[\s\S]*?\*\//g;
  let match;

  while ((match = blockPattern.exec(source)) !== null) {
    blocks.push({
      text: match[0],
      startIndex: match.index,
      endIndex: blockPattern.lastIndex,
    });
  }

  return blocks;
}
