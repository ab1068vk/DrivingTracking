/**
 * P7 release source audit — by **symbol and caller context** (Annex B §B5.2).
 *
 * The P3.5 audit (`wholeHistoryReleaseAudit.test.js`) classifies by repository
 * *filename*, and a blanket repository exemption can let a routine page caller
 * survive. That is unsafe now that the browser backend is the ordinary shipping
 * authority, so P7 adds this classifier, which asks two independent questions
 * about every call edge:
 *
 *   1. **symbol + caller context** — is a frozen legacy symbol reached from a
 *      ROUTINE edge (mount, render, effect, focus, resume, cache invalidation)
 *      rather than from a named intentional user action?
 *   2. **declared edge** — does the consumer that makes the call declare that
 *      read in its ledger Q graph (Annex B §B5.1)?
 *
 * The classifier is a static heuristic and is deliberately **fail-closed**: an
 * edge it cannot attribute to a named user action is reported as
 * `UNCLASSIFIED`, and the release gate treats `UNCLASSIFIED` as `ROUTINE`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

export const CALLER_CONTEXT = Object.freeze({
  ROUTINE: 'ROUTINE',
  EXPLICIT: 'EXPLICIT',
  UNCLASSIFIED: 'UNCLASSIFIED',
});

/** Constructs that make an edge reachable from mount/render/effect/refetch. */
const ROUTINE_MARKERS = [
  /\buseEffect\s*\(/, /\buseLayoutEffect\s*\(/, /\buseQuery\s*\(/, /\buseQueries\s*\(/,
  /\bqueryFn\s*:/, /\bqueryOptions\b/, /\brefetchInterval\b/, /\buseInfiniteQuery\s*\(/,
];

/**
 * Named function bindings, including the `useCallback` / `useMemo` wrappers a
 * React handler is usually written with.
 *
 * Without the wrapper alternative, `const onThing = useCallback(async () => {`
 * bound no name, so every call inside it attributed to the **component**
 * function instead — and a component always contains a `useQuery`, so the edge
 * came back `ROUTINE` however explicit the handler really was. That is a blind
 * spot, not a safeguard: it hid real caller context rather than withholding a
 * pass. Seeing the binding can only turn an edge explicit where an actual
 * `onX={handler}` reference exists; with no such reference the closure still
 * ends `UNCLASSIFIED`, which the gate treats as routine.
 */
/**
 * Frozen routine contexts, as the **constructs that execute a callback**.
 *
 * `ROUTINE_MARKERS` above answers "is this call site textually inside a
 * routine construct". That is not enough: a function can be *executed* by a
 * routine construct while being *defined* somewhere else entirely, and passed
 * to it by reference. `useEffect(legacy, [])` and `useQuery({queryFn: legacy})`
 * both run `legacy` on mount, and neither contains `legacy(`.
 *
 * Each entry is an opener; `routineReferenceSpans` takes the argument list or
 * option value that follows it, and any bare identifier inside that span is a
 * routine reference edge to the binding of the same name.
 */
const ROUTINE_REFERENCE_OPENERS = Object.freeze([
  // Effects.
  { pattern: /\buseEffect\s*\(/g, kind: 'call' },
  { pattern: /\buseLayoutEffect\s*\(/g, kind: 'call' },
  { pattern: /\buseInsertionEffect\s*\(/g, kind: 'call' },
  // Query declarations, including every option that runs a function.
  { pattern: /\buseQuery\s*\(/g, kind: 'call' },
  { pattern: /\buseQueries\s*\(/g, kind: 'call' },
  { pattern: /\buseInfiniteQuery\s*\(/g, kind: 'call' },
  { pattern: /\buseSuspenseQuery\s*\(/g, kind: 'call' },
  { pattern: /\bprefetchQuery\s*\(/g, kind: 'call' },
  { pattern: /\bfetchQuery\s*\(/g, kind: 'call' },
  { pattern: /\bensureQueryData\s*\(/g, kind: 'call' },
  { pattern: /\bqueryFn\s*:/g, kind: 'value' },
  { pattern: /\bselect\s*:/g, kind: 'value' },
  { pattern: /\bcombine\s*:/g, kind: 'value' },
  { pattern: /\bqueryOptions\s*\(/g, kind: 'call' },
  // Refetch, focus, resume and invalidation paths.
  { pattern: /\brefetch\w*\s*:/g, kind: 'value' },
  { pattern: /\brefetchInterval\s*:/g, kind: 'value' },
  { pattern: /\bonFocus\s*:/g, kind: 'value' },
  { pattern: /\bonResume\s*:/g, kind: 'value' },
  { pattern: /\bonAppStateChange\s*:/g, kind: 'value' },
  { pattern: /\bonVisibilityChange\s*:/g, kind: 'value' },
  { pattern: /\binvalidateQueries\s*\(/g, kind: 'call' },
  { pattern: /\bsetInterval\s*\(/g, kind: 'call' },
  { pattern: /\bsetTimeout\s*\(/g, kind: 'call' },
  { pattern: /\brequestIdleCallback\s*\(/g, kind: 'call' },
  { pattern: /\bscheduleIdleWork\s*\(/g, kind: 'call' },
  {
    // Browser lifecycle listeners: focus, visibility, resume, reconnect.
    pattern: /\baddEventListener\s*\(\s*['"`](?:focus|blur|visibilitychange|resume|pause|online|offline|pageshow|appStateChange)['"`]\s*,/g,
    kind: 'value',
  },
  {
    // Capacitor / emitter lifecycle listeners. `App.addListener('appStateChange',
    // legacy)` and `Network.addListener('networkStatusChange', legacy)` execute
    // their callback on resume and on reconnect exactly as the DOM listener
    // above does, and neither is spelled `addEventListener`. Without this
    // opener those edges reached only `UNCLASSIFIED` — fail-closed, but it
    // withheld the reason rather than naming it.
    pattern: /\b(?:addListener|once|on)\s*\(\s*['"`](?:appStateChange|appUrlOpen|resume|pause|appRestoredResult|networkStatusChange|focus|blur|visibilitychange|online|offline)['"`]\s*,/g,
    kind: 'value',
  },
]);

/**
 * JSX handler props that are **lifecycle**, not a named user action.
 *
 * P7-IMPL-F04. `onFocus`/`onBlur` fire from autofocus, from restoring a tab,
 * from a screen reader moving the caret and from React remounting a subtree —
 * none of which is a user asking for the work. Treating `onFocus={legacy}` as
 * an explicit root is a fail-open: the P7 law is that a routine root anywhere
 * in the closure dominates, and a focus handler is a routine root.
 *
 * `onClick`, `onSubmit`, `onPress` and the rest stay explicit. This list only
 * removes the handlers whose firing is not a user decision.
 */
const ROUTINE_JSX_HANDLERS = Object.freeze([
  'onFocus', 'onBlur', 'onFocusCapture', 'onBlurCapture',
  'onVisibilityChange', 'onResume', 'onAppStateChange', 'onLoad', 'onMount',
  'onReconnect', 'onOnline', 'onOffline', 'onIdle', 'onAnimationStart',
]);

const ROUTINE_JSX_HANDLER_PATTERN = new RegExp(
  `\\b(?:${ROUTINE_JSX_HANDLERS.join('|')})\\s*=\\s*\\{`, 'g'
);

/** The `{...}` span of a JSX attribute value starting at `open` (the `{`). */
const jsxBraceSpan = (text, open) => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1, Math.min(text.length, open + 2000));
};

/** The balanced `(...)` span starting at `open` (the index of the `(`). */
const balancedSpan = (text, open) => {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1, Math.min(text.length, open + 2000));
};

/**
 * The text spans in which a bare identifier is executed by a routine construct.
 *
 * A `value` opener contributes the option value that follows it, cut at the
 * first depth-zero `,` or `}` so a sibling option cannot be swept in.
 */
const routineReferenceSpans = (source) => {
  const spans = [];
  // The raw source, deliberately: the lifecycle-listener opener matches on a
  // quoted event name, and stripping literals would erase it. Scanning raw
  // text can only over-detect a routine reference, which is the safe
  // direction — this rule never withholds a routine verdict.
  const text = source;
  for (const { pattern, kind } of ROUTINE_REFERENCE_OPENERS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match) {
      if (kind === 'call') {
        const open = text.indexOf('(', match.index + match[0].length - 1);
        if (open >= 0) spans.push(balancedSpan(text, open));
      } else {
        let depth = 0;
        let end = match.index + match[0].length;
        while (end < text.length) {
          const char = text[end];
          if (char === '(' || char === '[' || char === '{') depth += 1;
          else if (char === ')' || char === ']') depth -= 1;
          else if (char === '}') { if (depth === 0) break; depth -= 1; }
          else if (char === ',' && depth === 0) break;
          else if (char === '\n' && depth === 0) break;
          end += 1;
        }
        spans.push(text.slice(match.index + match[0].length, end));
      }
      match = pattern.exec(text);
    }
  }
  // JSX lifecycle handler props. Their braced value is a routine reference
  // span, so `onFocus={legacy}` reaches `legacy` routinely — the same edge a
  // `useEffect(legacy)` makes, written in JSX.
  ROUTINE_JSX_HANDLER_PATTERN.lastIndex = 0;
  let jsx = ROUTINE_JSX_HANDLER_PATTERN.exec(text);
  while (jsx) {
    const open = text.indexOf('{', jsx.index + jsx[0].length - 1);
    if (open >= 0) spans.push(jsxBraceSpan(text, open));
    jsx = ROUTINE_JSX_HANDLER_PATTERN.exec(text);
  }
  return spans;
};

/**
 * Every binding name executed by a routine construct **by reference**.
 *
 * A bare `name` counts; `name(` inside the same span is an ordinary call and
 * is already covered by the call-edge closure, but it is equally routine, so
 * it is accepted here too. The rule only ever adds routine reachability.
 */
const routineReferencedNames = (source, names) => {
  const spans = routineReferenceSpans(source);
  const referenced = new Set();
  for (const name of names) {
    const reference = new RegExp(`(?:^|[^\\w.$])${name}(?![\\w$])`);
    if (spans.some((span) => reference.test(span))) referenced.add(name);
  }
  return referenced;
};

const FUNCTION_BINDING = new RegExp([
  // const|let|var NAME = [async] (args) => | ident =>
  '^(\\s*)(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>',
  // const|let|var NAME = useCallback|useMemo( [async] (args) =>
  '^(\\s*)(?:export\\s+)?(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*(?:useCallback|useMemo)\\s*\\(\\s*(?:async\\s*)?(?:\\([^)]*\\)|[A-Za-z_$][\\w$]*)\\s*=>',
  // [export] [default] [async] function NAME
  '^(\\s*)(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+([A-Za-z_$][\\w$]*)',
].join('|'));

/** Crude literal stripper so braces inside strings do not skew the balance. */
const withoutLiterals = (text) => text
  .replace(/'(?:\\.|[^'\\])*'/g, "''")
  .replace(/"(?:\\.|[^"\\])*"/g, '""')
  .replace(/`(?:\\.|[^`\\])*`/g, '``');

/** Strip block and line comments so documentation of a retired pattern is not read as a call. */
export const withoutComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
  .replace(/(^|[^:])\/\/.*$/gm, '$1');

/** Every production `.js`/`.jsx` file under `dir`, tests and fixtures excluded. */
export function productionSourceFiles(dir = SRC_ROOT) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      if (['__tests__', '__fixtures__', 'node_modules'].includes(name)) continue;
      out.push(...productionSourceFiles(full));
      continue;
    }
    if (/\.(js|jsx)$/.test(name) && !/\.test\.jsx?$/.test(name)) out.push(full);
  }
  return out;
}

/** Named function bindings in a file, with the line span each covers. */
function functionBindings(lines) {
  const bindings = [];
  lines.forEach((text, index) => {
    const match = FUNCTION_BINDING.exec(text);
    if (!match) return;
    const indent = (match[1] ?? match[3] ?? match[5] ?? '').length;
    const name = match[2] ?? match[4] ?? match[6];
    bindings.push({ name, indent, start: index, end: lines.length - 1 });
  });
  // A binding ends where its own brace balance returns to zero. Indent alone is
  // not enough: an unmatched top-level arrow would otherwise swallow the whole
  // component and make every call inside it look reachable from every query.
  for (const binding of bindings) {
    let depth = 0;
    let opened = false;
    for (let line = binding.start; line < lines.length; line += 1) {
      const text = withoutLiterals(lines[line]);
      for (const char of text) {
        if (char === '{') { depth += 1; opened = true; } else if (char === '}') depth -= 1;
      }
      if (opened && depth <= 0) { binding.end = line; break; }
      if (!opened && /;\s*$/.test(text) && line > binding.start) { binding.end = line; break; }
      binding.end = line;
    }
  }
  return bindings;
}

const enclosing = (bindings, line) => {
  let best = null;
  for (const binding of bindings) {
    if (line >= binding.start && line <= binding.end) {
      if (!best || binding.indent >= best.indent) best = binding;
    }
  }
  return best;
};

/**
 * Classify one call site inside one file.
 *
 * Returns `UNCLASSIFIED` when the enclosing function has no caller **in this
 * file** — which is the normal case for a module whose entry point is imported
 * elsewhere. `resolveCrossFileContext` below can upgrade that verdict, and only
 * that verdict; a `ROUTINE` classification is never downgraded by anything.
 *
 * @returns {'ROUTINE'|'EXPLICIT'|'UNCLASSIFIED'}
 */
export function classifyCallerContext(source, line) {
  const lines = source.split('\n');
  const bindings = functionBindings(lines);

  const host = enclosing(bindings, line);

  // A routine marker in the query/effect option object the call sits inside.
  // The lookback never crosses the start of the enclosing binding: a `queryFn:`
  // a few lines above a *different* helper says nothing about that helper.
  const from = Math.max(0, host ? Math.max(host.start, line - 8) : line - 8);
  const near = lines.slice(from, line + 2).join('\n');
  if (ROUTINE_MARKERS.some((marker) => marker.test(near))) return CALLER_CONTEXT.ROUTINE;

  if (!host) return CALLER_CONTEXT.ROUTINE; // bare render-body / module-body code

  // Reachability closure over same-file edges. A reference is an edge: passing
  // `legacy` to something that will call it reaches `legacy` just as surely as
  // writing `legacy()`, and only the second shape used to be seen.
  const callersOf = new Map();
  for (const binding of bindings) {
    const body = lines.slice(binding.start, binding.end + 1).join('\n');
    for (const other of bindings) {
      if (other.name === binding.name) continue;
      const called = new RegExp(`\\b${other.name}\\s*\\(`).test(body);
      const referenced = routineReferencedNames(body, [other.name]).has(other.name);
      if (called || referenced) {
        if (!callersOf.has(other.name)) callersOf.set(other.name, new Set());
        callersOf.get(other.name).add(binding.name);
      }
    }
  }

  const names = bindings.map((binding) => binding.name);
  // Names a routine construct executes by reference anywhere in this file.
  const routineByReference = routineReferencedNames(source, names);

  const explicitRoots = new Set();
  const routineRoots = new Set();
  for (const binding of bindings) {
    const name = binding.name;
    const referencedByHandler = new RegExp(`on[A-Z]\\w*\\s*=\\s*\\{[^}]*\\b${name}\\b`).test(source)
      || new RegExp(`on[A-Z]\\w*\\s*=\\s*\\{\\s*\\(\\)\\s*=>\\s*\\{[\\s\\S]{0,400}?\\b${name}\\s*\\(`).test(source);
    if (referencedByHandler) explicitRoots.add(name);

    // A routine reference makes the binding a routine root **whatever else**
    // references it. This used to be suppressed when a handler referenced the
    // same name, which is the fail-open the check exists to close: a function
    // wired to both an `onClick` and a `useEffect` is executed on mount, and
    // a user action cannot un-execute it.
    if (routineByReference.has(name)) routineRoots.add(name);
    const body = lines.slice(binding.start, binding.end + 1).join('\n');
    if (ROUTINE_MARKERS.some((marker) => marker.test(body))) {
      // The binding itself is (or contains) a query/effect declaration.
      routineRoots.add(name);
    }
  }

  // Routine reachability dominates. The walk no longer stops at the first
  // explicit root it meets: it visits the whole closure, and one routine root
  // anywhere in it decides the verdict.
  const seen = new Set();
  const stack = [host.name];
  let sawExplicit = false;
  let sawRoutine = false;
  while (stack.length) {
    const name = stack.pop();
    if (seen.has(name)) continue;
    seen.add(name);
    if (routineRoots.has(name)) sawRoutine = true;
    if (explicitRoots.has(name)) sawExplicit = true;
    for (const caller of callersOf.get(name) ?? []) stack.push(caller);
  }

  if (sawRoutine) return CALLER_CONTEXT.ROUTINE;
  if (sawExplicit) return CALLER_CONTEXT.EXPLICIT;
  return CALLER_CONTEXT.UNCLASSIFIED;
}

/**
 * Find every call edge to any of `symbols`, with its caller context.
 *
 * @param {string[]} symbols dotted or bare symbol names, e.g. `tripService.list`
 * @param {{files?: string[], exclude?: RegExp}} [options]
 * @returns {{file: string, symbol: string, line: number, context: string}[]}
 */
export function findSymbolCallEdges(symbols, options = {}) {
  const files = options.files ?? productionSourceFiles();
  const edges = [];
  for (const file of files) {
    const relative = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    if (options.exclude?.test(relative)) continue;
    const source = withoutComments(readFileSync(file, 'utf8'));
    const lines = source.split('\n');
    for (const symbol of symbols) {
      // A dotted symbol is matched exactly; a bare method name is matched with
      // an optional receiver, so `tripService.listForSpeedMap(` is found by
      // `listForSpeedMap`. The trailing `(` keeps `listAll` from matching
      // `listAllForExport(`.
      const pattern = symbol.includes('.')
        ? new RegExp(`(?:^|[^\\w.$])${symbol.replace(/\./g, '\\.')}\\s*\\(`)
        : new RegExp(`(?:^|[^\\w.$])(?:[\\w$]+\\.)?${symbol}\\s*\\(`);
      lines.forEach((text, index) => {
        if (!pattern.test(text)) return;
        let context = classifyCallerContext(source, index);
        if (context === CALLER_CONTEXT.UNCLASSIFIED && options.crossFile !== false) {
          // Only an unclassified verdict is revisited, and only upward.
          context = resolveCrossFileContext({ file: relative, line: index + 1 }, source, files);
        }
        edges.push({ file: relative, symbol, line: index + 1, context });
      });
    }
  }
  return edges;
}

/**
 * Resolve an `UNCLASSIFIED` edge across the module boundary (Annex B §B5.2:
 * classification is by **symbol and caller context**, not by filename).
 *
 * The rule is deliberately one-directional and fail-closed:
 *
 * - only an `UNCLASSIFIED` verdict is ever revisited — a `ROUTINE` one stands,
 *   whatever the importers look like;
 * - the host function must be **exported**, or there is nothing to resolve;
 * - **every** importing call site must classify `EXPLICIT`. One routine
 *   importer, one importer whose own context is unclassified, or no importer
 *   at all, and the edge stays `UNCLASSIFIED` — which the gate treats as
 *   routine.
 *
 * So this can only ever prove an edge explicit. It cannot excuse one.
 *
 * @param {{file: string, line: number}} edge
 * @param {string} source the edge's own file contents, comments already stripped
 * @param {string[]} [files] production sources to search for importers
 */
export function resolveCrossFileContext(edge, source, files = productionSourceFiles()) {
  const lines = source.split('\n');
  const bindings = functionBindings(lines);
  const isExported = (name) => new RegExp(
    `export\\s+(?:async\\s+)?(?:function\\s+${name}\\b|(?:const|let|var)\\s+${name}\\b)`
  ).test(source) || new RegExp(`export\\s*\\{[^}]*\\b${name}\\b`).test(source);

  // Walk outward from the innermost enclosing function to the first exported
  // one. A local helper defined inside an exported function is reachable only
  // through that function, so the export is the boundary importers can see.
  const host = bindings
    .filter((binding) => edge.line - 1 >= binding.start && edge.line - 1 <= binding.end)
    .sort((left, right) => right.indent - left.indent)
    .find((binding) => isExported(binding.name));
  if (!host) return CALLER_CONTEXT.UNCLASSIFIED;

  const moduleName = edge.file.replace(/\.jsx?$/, '').split('/').pop();
  const callPattern = new RegExp(`(?:^|[^\\w.$])${host.name}\\s*\\(`);

  let sawCall = false;
  for (const file of files) {
    const relative = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    if (relative === edge.file) continue;
    const importer = withoutComments(readFileSync(file, 'utf8'));
    // The importer must actually import from this module, so a same-named
    // local helper in an unrelated file cannot stand in for the real caller.
    if (!new RegExp(`from\\s+['"\`][^'"\`]*${moduleName}['"\`]`).test(importer)) continue;
    if (!new RegExp(`\\b${host.name}\\b`).test(importer)) continue;

    // A routine construct in the importer that executes the symbol by
    // reference is a routine edge across the module boundary, and settles the
    // verdict immediately: nothing downstream can make it explicit again.
    if (routineReferencedNames(importer, [host.name]).has(host.name)) {
      return CALLER_CONTEXT.ROUTINE;
    }

    const importerLines = importer.split('\n');
    for (let index = 0; index < importerLines.length; index += 1) {
      if (!callPattern.test(importerLines[index])) continue;
      sawCall = true;
      if (classifyCallerContext(importer, index) !== CALLER_CONTEXT.EXPLICIT) {
        return CALLER_CONTEXT.UNCLASSIFIED;
      }
    }
  }

  return sawCall ? CALLER_CONTEXT.EXPLICIT : CALLER_CONTEXT.UNCLASSIFIED;
}

/** The gate treats anything not proven explicit as routine. */
export const isRoutineEdge = (edge) => edge.context !== CALLER_CONTEXT.EXPLICIT;

/**
 * Definition sites, not call edges: a repository/service file that *declares* a
 * method is not a caller of it. These prefixes are excluded from the caller
 * sweep and are policed by the existing P3.5 file/category audit instead.
 */
export const DEFINITION_FILES = Object.freeze([
  'lib/localTripRepository.js',
  'lib/nativeTripRepository.js',
  'lib/nativeSpeedKnowledgeStore.js',
  'api/trips.js',
]);

/**
 * Contract-declaration modules. They *name* the frozen legacy symbols in string
 * literals so the audit knows what to look for; naming a symbol is not calling
 * it, and these modules issue no query at all.
 */
export const CONTRACT_DECLARATION_FILES = Object.freeze([
  'lib/tripQueryContracts.js',
  'lib/tripProjectionConsumers.js',
]);

export const EXCLUDE_DEFINITIONS = new RegExp(
  `^(${[...DEFINITION_FILES, ...CONTRACT_DECLARATION_FILES]
    .map((file) => file.replace(/[.]/g, '\\.'))
    .join('|')}|lib/queryContracts/.*)$`
);

/** Symbols that acquire retained trip data on a page, used for ledger completeness. */
const ACQUISITION_SYMBOLS = /limitedTripSummaryQueryOptions\s*\(|tripService\.(?:list|listSummaries|listForSpeedMap|getById|getFullById|getOverview)\s*\(|tripDetailQueryOptions\s*\(|readSpeedGeometryIndex\s*\(/;

/**
 * Ledger completeness (Annex B §B5.1): every production consumer of a trip /
 * analytics / geometry read must appear in the ledger. A missing consumer fails
 * the build.
 *
 * @param {string[]} ledgerPaths consumer paths declared by the ledger
 * @param {string[]} [files] production source files to scan
 * @returns {string[]} acquisition files absent from the ledger
 */
export function findUndeclaredConsumerFiles(ledgerPaths, files = productionSourceFiles()) {
  const declared = new Set(ledgerPaths.map((entry) => entry.replace(/ .*$/, '')));
  const undeclared = [];
  for (const file of files) {
    const relative = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    if (!/^(pages|components|hooks)\//.test(relative) && relative !== 'App.jsx') continue;
    const source = withoutComments(readFileSync(file, 'utf8'));
    if (!ACQUISITION_SYMBOLS.test(source)) continue;
    if (!declared.has(`src/${relative}`)) undeclared.push(`src/${relative}`);
  }
  return undeclared;
}

/**
 * Duplicate / overlapping history acquisition per consumer (V18 negative
 * control). Counts the top-level history acquisitions a page performs.
 */
export function findDuplicateHistoryAcquisitions(files = productionSourceFiles()) {
  const ACQUISITION = [
    /limitedTripSummaryQueryOptions\s*\(/g,
    /tripService\.listSummaries\s*\(/g,
    /tripService\.list\s*\(/g,
    /tripService\.listForSpeedMap\s*\(/g,
  ];
  const findings = [];
  for (const file of files) {
    const relative = path.relative(SRC_ROOT, file).split(path.sep).join('/');
    if (EXCLUDE_DEFINITIONS.test(relative)) continue;
    if (!/^(pages|components|hooks)\//.test(relative) && relative !== 'App.jsx') continue;
    const source = withoutComments(readFileSync(file, 'utf8'));
    let count = 0;
    for (const pattern of ACQUISITION) count += (source.match(pattern) ?? []).length;
    if (count > 1) findings.push({ file: relative, acquisitions: count });
  }
  return findings;
}
