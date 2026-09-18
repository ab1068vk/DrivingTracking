import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';

/**
 * Bounded-consumer oracle: module graph plus a real AST.
 *
 * The previous version balanced braces by hand and started counting at the
 * function's parameter `(`, so an ordinary `function foo(a) { ... }` was
 * "extracted" as its signature and its body was never inspected. Anything that
 * relies on reading a function body has to parse, so this uses acorn with the
 * JSX plugin — the pages are `.jsx` and acorn alone cannot read them.
 *
 * This is test-time evidence only. No production module imports it, and it adds
 * no runtime scanning to any shipped code path.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const JsxParser = Parser.extend(jsx());

const resolveSpec = (spec, fromFile) => {
  let base;
  if (spec.startsWith('@/')) base = path.join(ROOT, 'src', spec.slice(2));
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec);
  else return null;
  return [base, `${base}.js`, `${base}.jsx`, path.join(base, 'index.js'), path.join(base, 'index.jsx')]
    .find((candidate) => existsSync(candidate) && /\.jsx?$/.test(candidate)) ?? null;
};

const STATIC_IMPORT = /(?:import|export)[\s\S]*?from\s*['"]([^'"]+)['"]/g;
const DYNAMIC_IMPORT = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** @returns {Map<string, string>} absolute file path -> source text */
export function closureOf(entryFile) {
  const sources = new Map();
  const queue = [path.resolve(ROOT, entryFile)];
  while (queue.length) {
    const file = queue.shift();
    if (!file || sources.has(file) || !existsSync(file)) continue;
    let source;
    try { source = readFileSync(file, 'utf8'); } catch { continue; }
    sources.set(file, source);
    for (const pattern of [STATIC_IMPORT, DYNAMIC_IMPORT]) {
      pattern.lastIndex = 0;
      let match = pattern.exec(source);
      while (match) {
        const resolved = resolveSpec(match[1], file);
        if (resolved && !sources.has(resolved)) queue.push(resolved);
        match = pattern.exec(source);
      }
    }
  }
  return sources;
}

const astCache = new Map();

const astOf = (file, source) => {
  if (astCache.has(file)) return astCache.get(file);
  let tree = null;
  try {
    tree = JsxParser.parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      allowReturnOutsideFunction: true,
    });
  } catch {
    tree = null;
  }
  astCache.set(file, tree);
  return tree;
};

/** Depth-first walk over every AST node, without a walker dependency. */
const walkAst = (node, visit) => {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, visit);
    return;
  }
  if (typeof node.type !== 'string') return;
  visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    walkAst(node[key], visit);
  }
};

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/**
 * Index every named binding in the closure to the node that defines it.
 *
 * Covers the declaration forms the bounded-consumer graph actually uses:
 * function declarations, `const x = () => {}`, `const x = function () {}`,
 * `const x = useMemo(() => {}, [])`, classes, and the exported variants of each.
 */
export function definitionIndex(sources) {
  const index = new Map();
  for (const [file, source] of sources) {
    const tree = astOf(file, source);
    if (!tree) continue;
    walkAst(tree, (node) => {
      // The function node itself is indexed, not its body: the taint analysis
      // needs the parameter list, and indexing the `BlockStatement` silently
      // makes every declared function unanalyzable.
      if (node.type === 'FunctionDeclaration' && node.id?.name) {
        index.set(node.id.name, { file, source, node });
      } else if (node.type === 'ClassDeclaration' && node.id?.name) {
        index.set(node.id.name, { file, source, node });
      } else if (node.type === 'VariableDeclarator' && node.id?.type === 'Identifier' && node.init) {
        index.set(node.id.name, { file, source, node: node.init });
      }
    });
  }
  return index;
}

/** Source text of the named binding's **body**, or null when it is not found. */
export function definitionOf(sources, symbol) {
  const found = definitionIndex(sources).get(symbol);
  if (!found) return null;
  // The *body*, which is what a caller asking for a definition wants to inspect.
  const body = FUNCTION_TYPES.has(found.node.type) ? (found.node.body ?? found.node) : found.node;
  return found.source.slice(body.start, body.end);
}

/** Does any file in the closure define or import this symbol? */
export const closureBinds = (sources, symbol) => {
  const pattern = new RegExp(String.raw`\b${symbol}\b`);
  for (const source of sources.values()) if (pattern.test(source)) return true;
  return false;
};

/** Is `field` read as a property anywhere in `source`? */
export const readsField = (source, field) => (
  new RegExp(String.raw`(?:\.${field}\b|\['${field}'\]|\["${field}"\]|\b${field}\s*[,:}])`).test(source)
);

/** Leftmost identifier of a member chain: `a.b.c` -> `a`. */
const rootIdentifier = (node) => {
  let current = node;
  while (current?.type === 'MemberExpression') current = current.object;
  return current?.type === 'Identifier' ? current.name : null;
};

const ARRAY_METHODS = new Set([
  'map', 'filter', 'forEach', 'flatMap', 'find', 'findLast', 'sort',
  'reduce', 'some', 'every', 'slice', 'concat', 'at',
]);

/**
 * Parameter names, unwrapping the forms this codebase actually uses.
 *
 * Nearly every helper here is written `fn(trip = {})` or `fn(trips = [])`, so
 * treating only bare `Identifier` params as named would silently analyze none of
 * them — the taint would have nothing to start from and the oracle would report
 * a clean bill of health for every consumer.
 */
const parameterNames = (fn) => (fn?.params ?? []).map((param) => {
  let current = param;
  if (current?.type === 'AssignmentPattern') current = current.left;
  if (current?.type === 'RestElement') current = current.argument;
  return current?.type === 'Identifier' ? current.name : null;
});

const functionNodeOf = (node) => (FUNCTION_TYPES.has(node?.type) ? node : null);

/**
 * Projection fields reachable from `symbol`, following the **bounded row** as it
 * is passed from helper to helper.
 *
 * Following every call instead would be useless: a coach helper that also calls
 * `calculateTripScores` on detail-loaded data would drag most of the schema into
 * that consumer's contract, and the compact projection exists precisely to avoid
 * carrying it. So this tracks taint — the entry point's parameters hold the
 * bounded row, a call that passes a tainted value taints the matching parameter
 * of the callee, and `rows.map(helper)` taints that helper's first parameter.
 * Only property reads on a tainted value count.
 *
 * This is what catches Dashboard -> `buildOnDeviceDriverModel` ->
 * `tripFeatureVector` -> `phone_use_pct_of_trip`, which stopping at the named
 * helper misses entirely.
 */
export function transitiveProjectionFields(sources, symbol, projectionFields, { maxDepth = 4 } = {}) {
  const index = definitionIndex(sources);
  const fields = new Set(projectionFields);
  const found = new Map();
  const visited = new Set();

  /** Analyze one function body with `tainted` holding trip-derived values. */
  const analyze = (fnNode, tainted, origin, depth) => {
    if (!fnNode || depth > maxDepth) return;

    const isTainted = (node) => {
      if (!node) return false;
      if (node.type === 'Identifier') return tainted.has(node.name);
      if (node.type === 'MemberExpression') {
        const root = rootIdentifier(node);
        return root != null && tainted.has(root);
      }
      if (node.type === 'CallExpression') {
        // `rows.filter(...)` and friends stay trip-derived.
        const callee = node.callee;
        if (callee?.type === 'MemberExpression' && ARRAY_METHODS.has(callee.property?.name)) {
          return isTainted(callee.object);
        }
      }
      if (node.type === 'ConditionalExpression') {
        return isTainted(node.consequent) || isTainted(node.alternate);
      }
      if (node.type === 'LogicalExpression') return isTainted(node.left) || isTainted(node.right);
      if (node.type === 'ArrayExpression') return (node.elements ?? []).some(isTainted);
      if (node.type === 'SpreadElement') return isTainted(node.argument);
      return false;
    };

    const record = (name) => {
      if (fields.has(name) && !found.has(name)) found.set(name, origin);
    };

    // Local aliases first, so `const t = trip;` is tainted before it is read.
    for (let pass = 0; pass < 2; pass += 1) {
      walkAst(fnNode.body ?? fnNode, (node) => {
        if (node.type !== 'VariableDeclarator' || !node.init || !isTainted(node.init)) return;
        if (node.id?.type === 'Identifier') tainted.add(node.id.name);
        else if (node.id?.type === 'ObjectPattern') {
          for (const property of node.id.properties ?? []) {
            if (property.type === 'Property' && property.key?.name) record(property.key.name);
          }
        }
      });
    }

    walkAst(fnNode.body ?? fnNode, (node) => {
      if (node.type === 'MemberExpression') {
        const root = rootIdentifier(node);
        if (root == null || !tainted.has(root)) return;
        const name = node.computed
          ? (typeof node.property?.value === 'string' ? node.property.value : null)
          : node.property?.name;
        if (name) record(name);
        return;
      }
      if (node.type !== 'CallExpression') return;

      const callee = node.callee;
      // `rows.map(helper)` / `rows.map((row) => ...)`
      if (callee?.type === 'MemberExpression' && ARRAY_METHODS.has(callee.property?.name) && isTainted(callee.object)) {
        for (const argument of node.arguments ?? []) {
          if (argument?.type === 'Identifier') step(argument.name, [0], depth);
          const inline = functionNodeOf(argument);
          if (inline) {
            const inner = new Set(tainted);
            const first = parameterNames(inline)[0];
            if (first) inner.add(first);
            analyze(inline, inner, origin, depth + 1);
          }
        }
        return;
      }

      if (callee?.type !== 'Identifier') return;
      const positions = [];
      (node.arguments ?? []).forEach((argument, position) => {
        if (isTainted(argument)) positions.push(position);
      });
      if (positions.length) step(callee.name, positions, depth);
    });
  };

  const step = (name, taintedPositions, depth) => {
    const key = `${name}:${taintedPositions.join(',')}`;
    if (visited.has(key) || depth > maxDepth) return;
    visited.add(key);
    const definition = index.get(name);
    const fnNode = functionNodeOf(definition?.node)
      // `const f = useMemo(() => {...})` and `const f = memo(function () {})`.
      ?? (definition?.node?.type === 'CallExpression'
        ? (definition.node.arguments ?? []).map(functionNodeOf).find(Boolean)
        : null);
    if (!fnNode) return;
    const names = parameterNames(fnNode);
    const tainted = new Set();
    taintedPositions.forEach((position) => {
      if (names[position]) tainted.add(names[position]);
    });
    if (!tainted.size) return;
    analyze(fnNode, tainted, name, depth + 1);
  };

  // The entry point receives the bounded row in some parameter; which one is not
  // knowable statically, so every parameter starts tainted.
  const definition = index.get(symbol);
  const entryFn = functionNodeOf(definition?.node)
    ?? (definition?.node?.type === 'CallExpression'
      ? (definition.node.arguments ?? []).map(functionNodeOf).find(Boolean)
      : null);
  if (entryFn) {
    const tainted = new Set(parameterNames(entryFn).filter(Boolean));
    if (tainted.size) analyze(entryFn, tainted, symbol, 0);
  }
  return found;
}
