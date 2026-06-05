const MAX_LOOKAHEAD_CHARS = 500;

const constantPatterns = Object.freeze([
  /^export\s+const\s+([A-Z0-9_]+)/,
  /^([A-Z0-9_]+)\s*:\s*constant\s*\(/,
]);

export function constantNameAfterBlock(source, block) {
  const nextSource = source.slice(block.endIndex, block.endIndex + MAX_LOOKAHEAD_CHARS).trimStart();
  const match = constantPatterns
    .map((pattern) => nextSource.match(pattern))
    .find(Boolean);

  return match?.[1] || 'UNKNOWN_CONSTANT';
}
