import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

const traverse = traverseModule.default || traverseModule;
const ROOT = process.cwd();
const now = new Date().toISOString();

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.gradle-home', '.codex-smoke', '.idea', 'test-results', 'playwright-report']);
const MACHINE_LOCAL_FILES = new Set(['android/local.properties']);
const TEXT_EXTENSIONS = new Set([
  '.js', '.jsx', '.ts', '.tsx', '.mjs', '.java', '.gradle', '.xml', '.json', '.css', '.html',
  '.properties', '.md', '.yml', '.yaml', '.config', '.txt',
]);
const CODE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.java']);
const APP_CODE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs']);
const EXCLUDE_GENERATED_DOCS = new Set(['TECHNICAL_REFERENCE.md']);

function rel(file) {
  return path.relative(ROOT, file).replaceAll(path.sep, '/');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
      continue;
    }
    const full = path.join(dir, entry.name);
    const relative = rel(full);
    if (MACHINE_LOCAL_FILES.has(relative)) continue;
    if (relative.startsWith('android/app/src/main/assets/')) continue;
    if (EXCLUDE_GENERATED_DOCS.has(relative)) continue;
    const ext = path.extname(entry.name);
    if (TEXT_EXTENSIONS.has(ext) || entry.name.includes('.config.')) out.push(full);
  }
  return out.sort((a, b) => rel(a).localeCompare(rel(b)));
}

const files = walk(ROOT);
const sourceFiles = files.filter((file) => CODE_EXTENSIONS.has(path.extname(file)));
const appSourceFiles = sourceFiles.filter((file) => !rel(file).includes('__tests__/') && !rel(file).endsWith('.test.js'));
const productionBehaviorFiles = appSourceFiles.filter((file) => {
  const relative = rel(file);
  return relative.startsWith('src/') || relative.startsWith('android/app/src/main/java/');
});
const testFiles = sourceFiles.filter((file) => {
  const relative = rel(file);
  return relative.startsWith('e2e/')
    || relative.includes('__tests__/')
    || relative.endsWith('.test.js')
    || relative.endsWith('.spec.js')
    || relative.includes('/test/');
});

function read(file) {
  return fs.readFileSync(file, 'utf8');
}

function linesOf(file) {
  return read(file).split(/\r?\n/);
}

function lineAt(lines, line) {
  return (lines[line - 1] || '').trim();
}

function escapeCell(value) {
  return String(value ?? '')
    .replace(/\r?\n/g, '<br>')
    .replaceAll('|', '\\|');
}

function mdLink(file, line = null) {
  const label = line ? `${rel(file)}:${line}` : rel(file);
  return `[${label}](${rel(file)}${line ? `#L${line}` : ''})`;
}

function headingId(text) {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-');
}

function parseJs(file) {
  const ext = path.extname(file);
  if (!APP_CODE_EXTENSIONS.has(ext)) return null;
  try {
    return parse(read(file), {
      sourceType: 'module',
      errorRecovery: true,
      plugins: [
        'jsx',
        'typescript',
        'decorators-legacy',
        'classProperties',
        'classPrivateProperties',
        'classPrivateMethods',
        'dynamicImport',
        'importMeta',
        'objectRestSpread',
        'optionalChaining',
        'nullishCoalescingOperator',
      ],
    });
  } catch {
    return null;
  }
}

function nodeName(node) {
  if (!node) return '';
  if (node.name) return node.name;
  if (node.id?.name) return node.id.name;
  if (node.key?.name) return node.key.name;
  if (node.key?.value) return String(node.key.value);
  if (node.property?.name) return node.property.name;
  if (node.property?.value) return String(node.property.value);
  if (node.type === 'MemberExpression') return `${nodeName(node.object)}.${nodeName(node.property)}`.replace(/^\./, '');
  if (node.type === 'StringLiteral' || node.type === 'NumericLiteral') return String(node.value);
  return node.type || '';
}

function paramsOf(node, sourceLines) {
  const params = node.params || [];
  return params.map((param) => {
    if (param.name) return param.name;
    if (param.type === 'AssignmentPattern') return `${nodeName(param.left)} = ${sourceLines[param.loc.start.line - 1].slice(param.loc.start.column, param.loc.end.column)}`;
    if (param.type === 'RestElement') return `...${nodeName(param.argument)}`;
    if (param.type === 'ObjectPattern') return '{...}';
    if (param.type === 'ArrayPattern') return '[...]';
    return nodeName(param);
  }).join(', ');
}

function nearestFunction(functions, line) {
  return functions.find((fn) => line >= fn.start && line <= fn.end)?.name || '(module scope)';
}

function collectJsFacts(file) {
  const ast = parseJs(file);
  const lines = linesOf(file);
  const facts = {
    imports: [],
    exports: [],
    functions: [],
    env: [],
    routes: [],
    apiCalls: [],
  };
  if (!ast) return facts;

  traverse(ast, {
    ImportDeclaration(p) {
      const specifiers = p.node.specifiers.map((s) => {
        if (s.type === 'ImportDefaultSpecifier') return s.local.name;
        if (s.type === 'ImportNamespaceSpecifier') return `* as ${s.local.name}`;
        return `${nodeName(s.imported)} as ${s.local.name}`.replace(/ as \1$/, '');
      });
      facts.imports.push({ line: p.node.loc.start.line, source: p.node.source.value, specifiers });
    },
    ExportNamedDeclaration(p) {
      const line = p.node.loc.start.line;
      if (p.node.declaration) {
        const declaration = p.node.declaration;
        if (declaration.id?.name) facts.exports.push({ line, name: declaration.id.name, kind: declaration.type });
        if (declaration.declarations) {
          declaration.declarations.forEach((d) => facts.exports.push({ line, name: nodeName(d.id), kind: 'named const' }));
        }
      }
      p.node.specifiers?.forEach((s) => facts.exports.push({ line, name: nodeName(s.exported), kind: 'named export' }));
    },
    ExportDefaultDeclaration(p) {
      facts.exports.push({ line: p.node.loc.start.line, name: nodeName(p.node.declaration) || 'default', kind: 'default export' });
    },
    FunctionDeclaration(p) {
      facts.functions.push(functionFact(file, lines, p.node, p.node.id?.name || '(anonymous function)', 'function'));
    },
    VariableDeclarator(p) {
      if (['ArrowFunctionExpression', 'FunctionExpression'].includes(p.node.init?.type)) {
        facts.functions.push(functionFact(file, lines, p.node.init, nodeName(p.node.id), p.node.init.type === 'ArrowFunctionExpression' ? 'arrow function' : 'function expression'));
      }
    },
    ObjectMethod(p) {
      facts.functions.push(functionFact(file, lines, p.node, nodeName(p.node.key), 'object method'));
    },
    ClassMethod(p) {
      facts.functions.push(functionFact(file, lines, p.node, nodeName(p.node.key), 'class method'));
    },
    CallExpression(p) {
      const callee = nodeName(p.node.callee);
      const firstArg = p.node.arguments?.[0];
      const line = p.node.loc?.start?.line;
      if (!line) return;
      if (callee === 'fetch') facts.apiCalls.push({ line, method: 'FETCH', target: sourceText(lines, firstArg) });
      if (callee.startsWith('apiClient.')) facts.apiCalls.push({ line, method: callee.replace('apiClient.', '').toUpperCase(), target: sourceText(lines, firstArg) });
      if (callee === 'Route' || callee.endsWith('.Route')) facts.routes.push({ line, code: lineAt(lines, line) });
      if (callee === 'import' && firstArg?.value) facts.imports.push({ line, source: firstArg.value, specifiers: ['dynamic import'] });
    },
    JSXOpeningElement(p) {
      if (nodeName(p.node.name) !== 'Route') return;
      const pathAttr = p.node.attributes.find((a) => a.name?.name === 'path');
      const pathValue = pathAttr?.value?.value || '*';
      facts.routes.push({ line: p.node.loc.start.line, path: pathValue, code: lineAt(lines, p.node.loc.start.line) });
    },
    MemberExpression(p) {
      const text = sourceText(lines, p.node);
      const line = p.node.loc?.start?.line;
      if (line && /import\.meta\.env|process\.env/.test(text)) facts.env.push({ line, code: lineAt(lines, line) });
    },
  });

  facts.functions.sort((a, b) => a.start - b.start || a.name.localeCompare(b.name));
  return facts;
}

function sourceText(lines, node) {
  if (!node?.loc) return '';
  if (node.loc.start.line === node.loc.end.line) {
    return lines[node.loc.start.line - 1].slice(node.loc.start.column, node.loc.end.column).trim();
  }
  return lineAt(lines, node.loc.start.line);
}

function stripComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

function functionFact(file, sourceLines, node, name, kind) {
  const start = node.loc.start.line;
  const end = node.loc.end.line;
  const snippet = sourceLines.slice(start - 1, Math.min(end, start + 60)).join('\n');
  const codeOnlySnippet = stripComments(snippet);
  const loopCount = (codeOnlySnippet.match(/\b(for|while|forEach|map|reduce|filter|sort)\b/g) || []).length;
  const nested = /for[\s\S]{0,400}for|while[\s\S]{0,400}while/.test(codeOnlySnippet);
  const sideEffects = [];
  if (/\b(fetch|apiClient\.|LocalNotifications|Geolocation|Preferences|localStorage|sessionStorage|indexedDB|getSharedPreferences|SharedPreferences)\b/.test(snippet)) sideEffects.push('storage/network/native I/O');
  if (/\bset[A-Z]\w*\(|\.push\(|\.splice\(|\.sort\(|\.set\(|\.delete\(|\.remove\(|\.create\(|\.update\(/.test(snippet)) sideEffects.push('mutation');
  if (/\bthrow new|Promise\.reject/.test(snippet)) sideEffects.push('throws');
  return {
    file: rel(file),
    name,
    kind,
    signature: `${node.async ? 'async ' : ''}${name}(${paramsOf(node, sourceLines)})`,
    start,
    end,
    sideEffects: sideEffects.length ? [...new Set(sideEffects)].join(', ') : 'none detected',
    complexity: nested ? 'Time: O(n^2) candidate; Space: context dependent' : loopCount ? 'Time: O(n) candidate; Space: context dependent' : 'Time: O(1) candidate; Space: O(1) candidate',
  };
}

const allFacts = new Map(sourceFiles.map((file) => [rel(file), collectJsFacts(file)]));

function collectJavaFacts(file) {
  if (path.extname(file) !== '.java') return { imports: [], exports: [], functions: [] };
  const lines = linesOf(file);
  const imports = [];
  const functions = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    const importMatch = trimmed.match(/^import\s+(.+);$/);
    if (importMatch) imports.push({ line: index + 1, source: importMatch[1], specifiers: ['Java import'] });
    const methodMatch = trimmed.match(/^(public|private|protected)?\s*(static\s+)?([\w<>\[\], ?]+)\s+(\w+)\s*\(([^)]*)\)/);
    if (methodMatch && !trimmed.startsWith('if ') && !trimmed.startsWith('for ') && !trimmed.startsWith('while ')) {
      functions.push({
        file: rel(file),
        name: methodMatch[4],
        kind: 'java method',
        signature: `${methodMatch[1] || 'package'} ${methodMatch[2] || ''}${methodMatch[3]} ${methodMatch[4]}(${methodMatch[5]})`.replace(/\s+/g, ' ').trim(),
        start: index + 1,
        end: index + 1,
        sideEffects: /SharedPreferences|Location|Notification|startService|sendBroadcast|write|put|remove|get/.test(trimmed) ? 'native/storage I/O candidate' : 'none detected',
        complexity: 'Time: inspect method body; Space: inspect method body',
      });
    }
  });
  return { imports, exports: [], functions };
}

for (const file of sourceFiles.filter((file) => path.extname(file) === '.java')) {
  allFacts.set(rel(file), collectJavaFacts(file));
}

function calculationKind(code) {
  const lower = code.toLowerCase();
  if (/score|penalty|deduct|rating|tier/.test(lower)) return 'scoring';
  if (/risk|danger|forecast|prediction|predictive/.test(lower)) return 'risk/prediction';
  if (/distance|haversine|lat|lng|radius|bearing|heading|route|map|playback|segment/.test(lower)) return 'map/route';
  if (/speed|accel|brak|jerk|turn|gforce|corner|idle|duration|time|second|minute|hour/.test(lower)) return 'driving physics';
  if (/fuel|co2|carbon|cost|liter|kwh|econom/.test(lower)) return 'economics';
  if (/notification|cooldown|retry|timeout|interval/.test(lower)) return 'timing/control';
  return 'general calculation';
}

function extractFormula(code) {
  let formula = code
    .replace(/^\s*(const|let|var)\s+/, '')
    .replace(/;$/, '')
    .replace(/\?\?/g, ' default ')
    .replace(/&&/g, ' AND ')
    .replace(/\|\|/g, ' OR ')
    .replace(/\*\*/g, '^')
    .replace(/\*/g, ' x ')
    .replace(/\//g, ' / ')
    .replace(/\s+/g, ' ')
    .trim();
  if (formula.length > 180) formula = `${formula.slice(0, 177)}...`;
  return formula;
}

function isCalculationLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('import ') || trimmed.startsWith('export {')) return false;
  if (/className=|style=|from ['"]|require\(|console\.|describe\(|it\(|test\(|expect\(/.test(trimmed)) return false;
  if (/^[{}()[\],]+$/.test(trimmed)) return false;
  const mathOperator = /(^|[^/])(\+|-|\*|\/|%|\*\*|<=|>=|<|>)/.test(trimmed);
  const mathCall = /\b(Math\.|Number\.isFinite|parseFloat|parseInt|round|clamp|average|percentile|haversine|calculate|score|risk|distance|duration|speed|accel|brak|corner|fuel|co2|cost|ratio|rate|delta|bearing|heading|lat|lng|prediction|playback|map|kmh|ms2|meter|second|minute|hour)\b/i.test(trimmed);
  return mathOperator && mathCall;
}

function collectCalculations(includeTests = false) {
  const targetFiles = includeTests ? sourceFiles : productionBehaviorFiles;
  const rows = [];
  for (const file of targetFiles) {
    const fileLines = linesOf(file);
    const facts = allFacts.get(rel(file)) || { functions: [] };
    fileLines.forEach((line, index) => {
      if (!isCalculationLine(line)) return;
      const lineNo = index + 1;
      const code = line.trim();
      rows.push({
        file: rel(file),
        line: lineNo,
        kind: calculationKind(code),
        function: nearestFunction(facts.functions || [], lineNo),
        formula: extractFormula(code),
        code,
      });
    });
  }
  return rows;
}

const productionCalculations = collectCalculations(false);
const testCalculations = collectCalculations(true).filter((row) => row.file.includes('__tests__/') || row.file.endsWith('.test.js'));

function literalKind(value) {
  if (/^['"`]/.test(value)) {
    if (/https?:\/\//.test(value)) return 'inline URL';
    if (/^['"`]\/|[A-Z0-9_]{3,}/.test(value)) return 'string constant/key';
    return 'string literal';
  }
  if (/true|false/.test(value)) return 'boolean flag';
  return 'numeric literal';
}

function semanticName(code, value) {
  const left = code.match(/\b(?:public|private|protected)?\s*static\s+final\s+[A-Za-z0-9_<>\[\]]+\s+([A-Z0-9_a-z]+)/)?.[1]
    || code.match(/(?:const|let|var)\s+([A-Z0-9_a-z]+)/)?.[1]
    || code.match(/([A-Z0-9_a-z]+)\s*[:=]/)?.[1]
    || code.match(/([A-Z0-9_a-z]+)\s*[<>=!+\-*/]/)?.[1]
    || 'inline_value';
  return left.replace(/[^A-Za-z0-9_]/g, '_') || String(value).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 30);
}

function collectLiterals() {
  const rows = [];
  const literalRegex = /(['"`])(?:(?=(\\?))\2.)*?\1|-?\b\d+(?:\.\d+)?\b|\btrue\b|\bfalse\b/g;
  for (const file of productionBehaviorFiles) {
    const relative = rel(file);
    if (relative === 'src/pages/AndroidReference.jsx') continue;
    const fileLines = linesOf(file);
    fileLines.forEach((line, index) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('import ') || trimmed.startsWith('//') || trimmed.startsWith('*')) return;
      if (/className=|className:|style=|style:|cva\(|cn\(|variant:|size:/.test(trimmed)) return;
      for (const match of trimmed.matchAll(literalRegex)) {
        const value = match[0];
        if (/^['"`][A-Za-z0-9_@./:-]+['"`]$/.test(value) && trimmed.startsWith('from ')) continue;
        rows.push({
          file: relative,
          line: index + 1,
          value,
          type: literalKind(value),
          semanticName: semanticName(trimmed, value),
          code: trimmed,
        });
      }
    });
  }
  return rows;
}

const literals = collectLiterals();

function collectEnv() {
  const rows = [];
  const regex = /(import\.meta\.env\.[A-Z0-9_]+|process\.env\.[A-Z0-9_]+)/g;
  for (const file of files) {
    const fileLines = linesOf(file);
    fileLines.forEach((line, index) => {
      for (const match of line.matchAll(regex)) {
        rows.push({ file: rel(file), line: index + 1, variable: match[1].split('.').pop(), code: line.trim() });
      }
    });
  }
  return rows;
}

function collectTests() {
  const rows = [];
  const regex = /\b(describe|it|test)\s*\(\s*['"`]([^'"`]+)['"`]/g;
  for (const file of testFiles) {
    const fileLines = linesOf(file);
    fileLines.forEach((line, index) => {
      for (const match of line.matchAll(regex)) {
        rows.push({ file: rel(file), line: index + 1, kind: match[1], scenario: match[2] });
      }
    });
  }
  return rows;
}

function packageFacts() {
  const pkg = JSON.parse(read(path.join(ROOT, 'package.json')));
  const lock = JSON.parse(read(path.join(ROOT, 'package-lock.json')));
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  return Object.entries(deps).sort(([a], [b]) => a.localeCompare(b)).map(([name, spec]) => {
    const lockEntry = lock.packages?.[`node_modules/${name}`];
    return {
      name,
      spec,
      installed: lockEntry?.version || 'not found in lockfile',
      scope: pkg.dependencies?.[name] ? 'production' : 'development/test',
    };
  });
}

function purposeFor(file) {
  const name = path.basename(file);
  if (file.startsWith('src/pages/')) return 'Routed React page/view with data loading, derived presentation metrics, and user actions.';
  if (file.startsWith('src/components/ui/')) return 'Reusable shadcn/Radix UI wrapper component.';
  if (file.startsWith('src/components/')) return 'Feature UI component for trips, maps, playback, cards, overlays, or layout.';
  if (file.startsWith('src/api/')) return 'API service adapter with local-first fallback behavior.';
  if (file.startsWith('src/lib/')) return 'Domain/service library for scoring, tracking, storage, reports, context, or native integration.';
  if (file.startsWith('src/hooks/')) return 'Reusable React hook.';
  if (file.startsWith('e2e/')) return 'Playwright browser smoke test for the built application shell.';
  if (file.startsWith('android/')) return 'Android Capacitor shell, native service, resource, Gradle, or manifest file.';
  if (file.startsWith('scripts/')) return 'Repository automation script.';
  if (name === 'package.json') return 'Node package metadata, scripts, and dependency declarations.';
  if (name === 'README.md') return 'Human entry-point documentation.';
  return 'Project configuration or static asset metadata.';
}

function table(headers, rows) {
  return [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(escapeCell).join(' | ')} |`),
  ].join('\n');
}

function groupedDetails(title, rows, renderRow, empty = 'None found.') {
  if (!rows.length) return `<details>\n<summary>${title} (0)</summary>\n\n${empty}\n\n</details>`;
  return `<details>\n<summary>${title} (${rows.length})</summary>\n\n${renderRow(rows)}\n\n</details>`;
}

function codeBlock(code, lang = '') {
  return `\`\`\`${lang}\n${code}\n\`\`\``;
}

function extractSnippet(file, start, end) {
  const lines = linesOf(path.join(ROOT, file));
  return lines.slice(start - 1, end).join('\n');
}

function calcRowsByKind(kind) {
  return productionCalculations.filter((row) => row.kind === kind);
}

function renderCalcIndex(rows) {
  const byFile = Map.groupBy(rows, (row) => row.file);
  return [...byFile.entries()].map(([file, fileRows]) => {
    const sample = fileRows.map((row) => `| ${row.line} | ${escapeCell(row.function)} | ${escapeCell(row.formula)} | \`${escapeCell(row.code)}\` |`).join('\n');
    return `#### ${file}\n\n| Line | Function | Formula / derived value | Exact code |\n|---|---|---|---|\n${sample}`;
  }).join('\n\n');
}

function moduleMap() {
  const rows = files.map((file) => {
    const relative = rel(file);
    const facts = allFacts.get(relative) || { imports: [], exports: [], functions: [] };
    const calcCount = productionCalculations.filter((row) => row.file === relative).length;
    const literalCount = literals.filter((row) => row.file === relative).length;
    const imports = (facts.imports || []).map((i) => i.source).slice(0, 8).join(', ');
    const exports = (facts.exports || []).map((e) => e.name).slice(0, 10).join(', ');
    return [relative, purposeFor(relative), imports || 'none', exports || 'none', facts.functions?.length || 0, calcCount, literalCount];
  });
  return table(['File', 'Responsibility', 'Imports', 'Exports', 'Functions/methods', 'Calc lines', 'Hard-coded values'], rows);
}

function importExportMap() {
  return sourceFiles.map((file) => {
    const relative = rel(file);
    const facts = allFacts.get(relative) || { imports: [], exports: [] };
    const imports = facts.imports?.length
      ? facts.imports.map((item) => `- ${relative}:${item.line} imports \`${item.specifiers.join(', ') || '*'}\` from \`${item.source}\``).join('\n')
      : '- No imports.';
    const exports = facts.exports?.length
      ? facts.exports.map((item) => `- ${relative}:${item.line} exports \`${item.name}\` (${item.kind})`).join('\n')
      : '- No exports.';
    return `### ${relative}\n\n${imports}\n\n${exports}`;
  }).join('\n\n');
}

function functionCatalog() {
  const rowsByFile = Map.groupBy([...allFacts.values()].flatMap((facts) => facts.functions || []), (fn) => fn.file);
  return [...rowsByFile.entries()].map(([file, rows]) => {
    return `### ${file}\n\n${table(
      ['Line', 'Kind', 'Signature', 'Side effects / I/O', 'Complexity'],
      rows.map((fn) => [fn.start, fn.kind, `\`${fn.signature}\``, fn.sideEffects, fn.complexity]),
    )}`;
  }).join('\n\n');
}

function literalRegistry() {
  const byFile = Map.groupBy(literals, (row) => row.file);
  return [...byFile.entries()].map(([file, rows]) => groupedDetails(
    file,
    rows,
    (items) => table(
      ['Line', 'Value', 'Type', 'Semantic name', 'Why hard-coded / risk if changed'],
      items.map((row) => [
        row.line,
        `\`${row.value}\``,
        row.type,
        row.semanticName,
        reasonForLiteral(row),
      ]),
    ),
  )).join('\n\n');
}

function reasonForLiteral(row) {
  if (row.type === 'inline URL') {
    return 'External service endpoint or help text; changing may redirect data or break integration.';
  }
  if (row.type === 'numeric literal') {
    return 'Named or inline threshold, weight, scale, limit, timing value, or native constant; changing can alter scoring, risk classification, UX timing, or Android behavior.';
  }
  if (row.type === 'boolean flag') {
    return 'Inline state/default flag; changing can flip behavior.';
  }
  return 'Label, key, enum, event name, route, selector, or message; changing can break storage/API/UI contracts.';
}

function constantsRegistry() {
  const namedRows = literals
    .filter((row) => {
      const declaresNamedConst = /\b(?:export\s+)?(?:const|let|var)\s+[A-Z0-9_]+\b/.test(row.code)
        || /\b(?:public|private|protected)?\s*static\s+final\b/.test(row.code);
      const uppercaseObjectEntry = /^[A-Z0-9_]+\s*:/.test(row.code);
      return declaresNamedConst || uppercaseObjectEntry;
    })
    .slice(0, 500)
    .map((row) => [
      `${row.file}:${row.line}`,
      row.semanticName,
      `\`${row.value}\``,
      reasonForLiteral(row),
      `\`${row.code}\``,
    ]);
  const literalConstantKeys = new Set(namedRows.map((row) => `${row[0]}:${row[1]}`));
  const derivedRows = collectDerivedNamedConstants()
    .filter((row) => !literalConstantKeys.has(`${row.source}:${row.name}`))
    .map((row) => [
      row.source,
      row.name,
      `\`${row.expression}\``,
      'Named constant derived from configuration or a migration registry; changing the source expression can alter storage, scoring, or upgrade behavior.',
      `\`${row.code}\``,
    ]);
  return table(['Source', 'Name', 'Value', 'Reason', 'Exact code'], [...namedRows, ...derivedRows]);
}

function collectDerivedNamedConstants() {
  const rows = [];
  for (const file of productionBehaviorFiles) {
    const relative = rel(file);
    const fileLines = linesOf(file);
    fileLines.forEach((line, index) => {
      const trimmed = line.trim();
      const match = trimmed.match(/^(?:export\s+)?const\s+([A-Z0-9_]+)\s*=\s*(.+?);?$/);
      if (!match) return;
      const [, name, rawExpression] = match;
      const hasInlineLiteral = literals.some((row) => row.file === relative && row.line === index + 1);
      if (hasInlineLiteral) return;
      rows.push({
        source: `${relative}:${index + 1}`,
        name,
        expression: rawExpression.replace(/;$/, ''),
        code: trimmed,
      });
    });
  }
  return rows;
}

function dependencyTable() {
  return table(
    ['Package', 'package.json spec', 'Lockfile version', 'Scope', 'Purpose in this app', 'CVE note'],
    packageFacts().map((dep) => [
      dep.name,
      dep.spec,
      dep.installed,
      dep.scope,
      dep.name.includes('capacitor') ? 'Native mobile bridge/platform package.'
        : dep.name.includes('radix') ? 'Accessible UI primitive.'
          : dep.name.includes('react') ? 'React runtime, routing, forms, charts, or UI integration.'
            : dep.name.includes('vite') || dep.name.includes('eslint') || dep.name.includes('typescript') || dep.name.includes('vitest') ? 'Build, lint, typecheck, or test tool.'
              : 'Application feature dependency.',
      'No live CVE lookup performed; lockfile pins the installed version for audit tooling.',
    ]),
  );
}

function testCoverage() {
  return table(
    ['File', 'Line', 'Kind', 'Scenario / invariant'],
    collectTests().map((row) => [row.file, row.line, row.kind, row.scenario]),
  );
}

function envTable() {
  const env = collectEnv();
  const envDefaults = {
    VITE_API_URL: 'empty means local-first storage',
    VITE_DB_NAME: 'drivesense_mobile',
    VITE_DEFAULT_MAP_LAT: '43.6532',
    VITE_DEFAULT_MAP_LNG: '-79.3832',
    VITE_DEFAULT_OSRM_URL: 'blank',
    VITE_OSRM_TIMEOUT_MS: '12000',
  };
  const envDescriptions = {
    VITE_API_URL: 'Optional backend API base URL.',
    VITE_DB_NAME: 'IndexedDB database name for local trip storage; changed names trigger a one-time copy-and-delete migration.',
    VITE_DEFAULT_MAP_LAT: 'Absolute last fallback latitude for map playback before any trip or user context exists.',
    VITE_DEFAULT_MAP_LNG: 'Absolute last fallback longitude for map playback before any trip or user context exists.',
    VITE_DEFAULT_OSRM_URL: 'Optional self-hosted OSRM endpoint for deployments that operate a trusted routing server.',
    VITE_OSRM_TIMEOUT_MS: 'Default OSRM map-matching request timeout in milliseconds; user Settings can override it with a 5-30 second slider.',
    CI: 'Continuous-integration switch for test/reporting behavior.',
    DEV: 'Vite development-mode boolean used for debug-only routes and actions.',
    VITE_SHOW_DEBUG_ROUTES: 'Debug-route switch for non-production diagnostics access.',
    LIVE_EXTERNAL_CONTRACTS: 'Manual opt-in for tests that call public external services.',
  };
  return table(
    ['Variable', 'Type', 'Required', 'Default', 'Description', 'Used in'],
    env.map((row) => [
      row.variable,
      row.variable.startsWith('VITE_') ? 'Vite string' : 'Node string',
      row.variable === 'VITE_API_URL' ? 'No' : 'No',
      envDefaults[row.variable] ?? 'false/undefined unless set',
      envDescriptions[row.variable] ?? 'Feature/debug/build-time switch.',
      `${row.file}:${row.line} \`${row.code}\``,
    ]),
  );
}

function routeReference() {
  const app = sourceFiles.find((file) => rel(file) === 'src/App.jsx');
  const facts = allFacts.get('src/App.jsx') || { routes: [] };
  return table(
    ['Route', 'File/line', 'Element / behavior', 'Auth'],
    facts.routes.map((route) => [
      route.path || '*',
      `src/App.jsx:${route.line}`,
      `\`${route.code}\``,
      'Public local-first shell; optional backend token is attached only when configured.',
    ]),
  );
}

function apiReference() {
  const apiFiles = sourceFiles.filter((file) => rel(file).startsWith('src/api/') || rel(file).startsWith('src/lib/mapMatching') || rel(file).startsWith('src/lib/weatherContext') || rel(file).startsWith('src/lib/speedLimitSource'));
  const rows = [];
  for (const file of apiFiles) {
    const facts = allFacts.get(rel(file)) || { apiCalls: [] };
    for (const call of facts.apiCalls || []) {
      rows.push([call.method, call.target || 'dynamic', `${rel(file)}:${call.line}`, 'Session token when API backend exists; public external API calls have no app auth.', 'Throws or returns status object depending on caller.']);
    }
  }
  return table(['Method', 'Path/target', 'Declared at', 'Auth', 'Error behavior'], rows);
}

function functionSnippet(title, file, functionName, lang = 'js') {
  const fact = (allFacts.get(file)?.functions || []).find((entry) => entry.name === functionName);
  if (!fact) return '';
  return `### ${title}\n\nSource: \`${file}:${fact.start}-${fact.end}\`\n\n${codeBlock(extractSnippet(file, fact.start, fact.end), lang)}`;
}

function topCalculationSnippets() {
  const snippets = [
    functionSnippet('Score evidence envelopes and export-facing component contract', 'src/lib/tripEngine.js', 'createComponentScore'),
    functionSnippet('Score provenance snapshot and version checks', 'src/lib/tripEngine.js', 'buildScoreProvenance'),
    functionSnippet('Trip scoring weights, confidence, diagnostic gates, and final score', 'src/lib/tripEngine.js', 'calculateTripScores'),
    functionSnippet('Eco score, cruise band, idle penalty', 'src/lib/tripEngine.js', 'calculateEcoDrivingScore'),
    functionSnippet('Historical context estimate', 'src/lib/predictiveRouteRisk.js', 'estimatePredictiveRouteRisk'),
    functionSnippet('Pre-trip readiness risk', 'src/lib/preTripRisk.js', 'computePreTripRisk'),
    functionSnippet('Daily fatigue readiness accumulation', 'src/lib/dailyFatigueEngine.js', 'computeDailyFatigue'),
    functionSnippet('Route risk segment index and GPS snapping', 'src/lib/routeRiskIndex.js', 'buildRouteRiskIndex'),
    functionSnippet('Phone-use Usage Access scoring', 'src/lib/phoneUsageAccess.js', 'buildPhoneUseFromAndroidUsage'),
    functionSnippet('Phone-use signal merge and diagnostic gate', 'src/lib/phoneUsageAccess.js', 'mergePhoneUseSignals'),
    functionSnippet('Estimated score display formatting', 'src/lib/scoreDisplay.js', 'formatScoreWithProvenance'),
    functionSnippet('Retired event migration for local trips', 'src/lib/localTripRepository.js', 'normalizeRetiredTripEventTypes'),
    functionSnippet('UBI report category scoring and minimum-distance gate', 'src/lib/ubiReport.js', 'computeUBIReport'),
    functionSnippet('Threshold calibration suggestions', 'src/lib/thresholdCalibration.js', 'computeCalibrationProfile'),
  ];
  const androidFile = 'android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java';
  if (fs.existsSync(path.join(ROOT, androidFile))) {
    snippets.push(`### Android native distance, gap-corrected duration, and speed service math\n\nSource: \`${androidFile}:921-1115\`\n\n${codeBlock(extractSnippet(androidFile, 921, 1115), 'java')}`);
  }
  return snippets.filter(Boolean).join('\n\n');
}

function storageCatalogue() {
  const rows = [];
  const regex = /\b(localStorage|sessionStorage|Preferences|indexedDB|SharedPreferences|getSharedPreferences|Filesystem|LocalNotifications|Geolocation)\b/g;
  for (const file of productionBehaviorFiles) {
    linesOf(file).forEach((line, index) => {
      if (regex.test(line)) rows.push([rel(file), index + 1, line.trim()]);
      regex.lastIndex = 0;
    });
  }
  return table(['File', 'Line', 'Storage/native surface'], rows);
}

function errorCatalogue() {
  const rows = [];
  const regex = /\btry\b|\bcatch\s*\(|\.catch\s*\(|throw new|Promise\.reject|Error\(|logError\(/g;
  for (const file of productionBehaviorFiles) {
    linesOf(file).forEach((line, index) => {
      if (regex.test(line)) {
        const strategy = /logError\(/.test(line)
          ? 'writes tracking diagnostic event'
          : /\.catch\s*\(\s*\(\s*\)\s*=>\s*\{\s*\}\s*\)/.test(line)
            ? 'silent optional fallback; verify low impact'
            : /catch/.test(line)
              ? 'handled fallback or diagnostic logging'
              : /throw|reject/.test(line)
                ? 'raises failure to caller'
                : 'protected operation';
        rows.push([rel(file), index + 1, line.trim(), strategy]);
      }
      regex.lastIndex = 0;
    });
  }
  return table(['File', 'Line', 'Code', 'Recovery strategy'], rows);
}

function buildDoc() {
  const tocItems = [
    'Coverage And Reading Guide',
    'System Overview',
    'Architecture And Module Map',
    'Import Export Map',
    'Function And Method Catalogue',
    'Calculation Deep Dives With Actual Code',
    'Complete Calculation Snippet Index',
    'Hard-Coded Values And Constants Registry',
    'Data Models State And Storage',
    'Routes And API Reference',
    'Configuration And Environment',
    'Error Handling Catalogue',
    'Security Analysis',
    'Performance Characteristics',
    'Testing Coverage Map',
    'Dependency Audit',
    'Deployment And Infra',
  ];

  const doc = [];
  doc.push('# Road Sage Technical Reference');
  doc.push('');
  doc.push(`Updated: ${now}`);
  doc.push('');
  doc.push('This document is generated from the current repository. It keeps the reference readable by using tables and collapsible indexes, while still including actual code snippets for the calculation-heavy parts of the app.');
  doc.push('');
  doc.push('## Table Of Contents');
  doc.push('');
  doc.push(tocItems.map((item) => `- [${item}](#${headingId(item)})`).join('\n'));
  doc.push('');
  doc.push('---');

  doc.push('## Coverage And Reading Guide');
  doc.push('');
  doc.push(`- Text/code files scanned: ${files.length}`);
  doc.push(`- App/source files scanned: ${sourceFiles.length}`);
  doc.push(`- Machine-local files excluded from scanning: ${[...MACHINE_LOCAL_FILES].map((file) => `\`${file}\``).join(', ')}`);
  doc.push(`- Production calculation lines indexed: ${productionCalculations.length}`);
  doc.push(`- Test calculation/assertion lines indexed separately: ${testCalculations.length}`);
  doc.push(`- Hard-coded production literals indexed: ${literals.length}`);
  doc.push(`- Functions/methods catalogued: ${[...allFacts.values()].flatMap((f) => f.functions || []).length}`);
  doc.push('');
  doc.push('> WARNING - ASSUMPTION: There is no server code in this repository. REST endpoints documented here are the optional backend contract called by the client when `VITE_API_URL` is configured; otherwise the app uses local repositories.');
  doc.push('');
  doc.push('> NOTE: Scoring thresholds and domain-significant constants now live in named registries such as `DEFAULT_THRESHOLDS`, `ECO_DEFAULTS`, `SVI_DEFAULTS`, `src/lib/appConstants.js` clock/display/storage/score-normalization constants, historical-context `ROUTE_RISK_CONSTANTS`, repeated-event-area `RISK_CONSTANTS`, `PRE_TRIP_RISK_SIGNAL_GATES`, `HABIT_CONSTANTS`, and `DAILY_FATIGUE_THRESHOLDS`. The literal registry below remains useful for auditing labels, keys, Android IDs, and remaining inline policy values.');
  doc.push('');
  doc.push('---');

  doc.push('## System Overview');
  doc.push('');
  doc.push(table(
    ['Item', 'Value'],
    [
      ['Application', 'Road Sage (`drivesense-app`)'],
      ['Version', JSON.parse(read(path.join(ROOT, 'package.json'))).version],
      ['Purpose', 'Local-first driving tracker for trip recording, scoring, playback, reports, evidence-aware context estimates, coaching, backup/import, and Android background auto tracking.'],
      ['Architecture', 'React/Vite single-page app plus Capacitor Android shell and native background services. Domain logic is concentrated in `src/lib/*`, API adapters in `src/api/*`, UI in `src/pages/*` and `src/components/*`.'],
      ['Primary storage', 'IndexedDB/localStorage/sessionStorage/Capacitor Preferences/Android SharedPreferences.'],
      ['Optional backend', '`VITE_API_URL`; absent by default.'],
      ['Local trip database name', '`VITE_DB_NAME`; defaults to `drivesense_mobile` and triggers an IndexedDB copy/delete rename migration when changed.'],
      ['Shared numeric clamp', '`src/lib/mathUtils.js` exports the canonical `clamp(value, min, max)` helper. Invalid numeric input returns `min`, preventing NaN from leaking through score, risk, report, and playback calculations.'],
      ['Weighted evidence scoring', '`weightedBlend` is the canonical composite helper: null or blank component scores are omitted from the denominator instead of being converted to perfect 100s. Safety, Smoothness, Eco, Overall, Defensive, weather-adjusted Overall, merge summaries, peak stress, and compliance paths use unavailable evidence as neutral rather than a bonus.'],
      ['Metric and confidence contract', '`src/lib/metricRegistry.js` defines display names, human-readable data-source labels, evidence minimums, permission requirements, and calibration notes for component/report metrics. `component_scores` envelopes carry value, internal evidence (`high`, `developing`, `low`, or `unavailable`), data sources, and sample counts; public score surfaces render `developing` as "limited evidence", suppress `high` evidence badges, and suppress unavailable values rather than rendering zero. CSV exports add a metric-metadata row and monthly/UBI PDFs add metric-reference pages.'],
      ['Score display and insurance limitation', '`src/lib/scoreDisplay.js` centralizes estimated-score formatting. Approximate score surfaces use a leading `~`, monthly PDFs include "Scores are estimates - not validated against real-world crash data", and UBI score-card UI/PDF output is visibly labelled `NOT AN INSURANCE RATING` so internal coaching estimates are not presented as underwriting, pricing, or eligibility decisions.'],
      ['Scoring calibration and provenance', '`src/lib/scoringConstants.js` owns provisional scoring/risk/UBI constants and their affected metrics. Stored score output is versioned with a generated content-hash `SCORING_VERSION`, and each newly scored trip stores `score_provenance` with its component evidence and scoring-input snapshot. Settings lists provenance/input mismatches for explicit re-score actions and marks provisional output as approximate. `PENALTY_SCALE_FACTOR_CALIBRATION_PROCESS` documents the labeled-dataset requirements, fitting command, validation outputs, and promotion checklist before penalty-rate scaling can be treated as calibrated.'],
      ['Post-trip calibration labels', 'Trip Detail offers a dismissible optional survey after scored trips. Feedback remains local in this local-only app, is preserved in backups, appears in System Logs, and is used by Settings as a calibration signal. It does not upload anywhere, automatically change scores, or automatically tune thresholds. `npm run calibration:fit` refuses calibrated constants until at least 2,000 eligible labeled trips are available.'],
      ['Penalty-rate normalization policy', '`PENALTY_SCALE_FACTOR` is the named provisional base-score conversion constant. Its current value of 40 makes 2.5 severity-weighted penalty points per km reach a 100-point deduction and the zero-score floor. Recalibrate this value against a labeled driving dataset before treating it as empirically validated policy.'],
      ['Fatigue-to-Safety deduction policy', '`FATIGUE_SAFETY_PENALTY_SCALE = 0.15` is a cited conversion from the normalized 0-100 fatigue proxy into raw Safety penalty points, capped by `FATIGUE_SAFETY_MAX_PENALTY = 15` after event-rate normalization. Maximum reported fatigue therefore maps conservatively to the 0.05% BAC-equivalent impairment level reported by Williamson & Feyer (Occupational and Environmental Medicine, 2000); this coefficient is not calibrated against collision outcome data.'],
      ['OBD-II optional evidence', '`src/lib/obdBluetooth.js` parses BLE OBD-II PID responses for speed, RPM, throttle, engine load, coolant temperature, and mass-air-flow. Route points annotated with OBD data can supply vehicle-speed sources when GPS accuracy is weak, refine eco/engine-stress signals, and appear in component provenance as `obd_bluetooth`; GPS remains the fallback and Classic Bluetooth still requires native support outside this helper.'],
      ['Sensor fusion and possible incident signals', '`src/lib/sensorFusionModel.js` normalizes browser and Android native IMU samples, summarizes peak linear/rotation motion, calibrates phone orientation from harsh-brake events, enriches event evidence, and can raise `possible_crash` incident signals only when impact-like motion is followed by stopped/still evidence. Diagnostics shows motion permission, sample quality, and crash-readiness state; these signals are emergency workflow cues, not crash diagnoses.'],
      ['Lane-changing score', '`detectLaneChanges` combines highway-speed GPS heading patterns with calibrated IMU yaw when available, otherwise using a lower-confidence GPS-only fallback. `lane_changing_score` requires at least 5 km and two detected lane-change manoeuvres, penalizes unsafe simultaneous-braking changes, contributes a provisional 5% Safety blend weight when enabled, and clearly states that it cannot detect turn signals, following gaps, slow-traffic changes, or curved-road context reliably.'],
      ['Jerk score reliability', '`calculateJerkScore` returns `null` with `jerk_score_confidence: insufficient_data` below 0.5 km or without usable movement samples. Trips from 0.5 km to under 3 km store the real 0-100 jerk score with low confidence, and low-confidence jerk evidence is suppressed from Smoothness blending.'],
      ['Intersection stop reliability', '`analyzeIntersectionBehavior` counts traffic-stop windows from at least two valid sub-10 km/h samples spanning 4 seconds, with at most 10 seconds between samples; privacy-masked samples break a window. Routes under 0.5 km or with no observed traffic stops report a null intersection score; observed stops score across the full 0-100 range, with late approaches penalized more heavily than rolling stops.'],
      ['Stop-start pattern proxy', '`detectStopStartPatterns` emits low-confidence `stop_start_pattern` events from GPS speed only. `stop_start_pattern_score` now blends contextual city-speed and highway estimates: urban mode can appear after 2 km of eligible city-speed evidence, highway mode after 5 km of highway evidence. Context-specific counts/scores are stored separately, defensive blending requires the matching urban/highway sample gate, and the app explicitly states it cannot measure lead-vehicle distance.'],
      ['Brake onset smoothness', '`calculateBrakeOnsetSmoothness` reports low-confidence `brake_onset_smoothness_*` fields only after five detected harsh-braking sequences and uses `100 - clamp(peakDecelerationMs2 / rampDurationSeconds, 0, 100)`. Public UI and CSV labels no longer claim human reaction time and Trip Detail displays the disclaimer.'],
      ['Estimated brake-turn manoeuvre alert', 'New detections are low-confidence `close_proximity` events after at least 1.5 seconds of simultaneous braking and heading change at 30 km/h or above, with defaults of 4.0 m/s2 and 25 deg/s. They do not establish object proximity or a near miss and are advisory-only; they are excluded from Safety, weather score adjustment, historical-context risk weighting, repeated-event areas, and repeated-event route layers.'],
      ['Heading drift Beta', '`detectHeadingDriftBeta` evaluates sustained five-minute highway-speed GPS-heading drift windows, marks confidence low, and applies a 2.5x circadian multiplier between 02:00 and 05:00. Public UI describes a GPS-only attention pattern signal rather than a fatigue measurement, and heading drift no longer feeds the fatigue-to-Safety penalty.'],
      ['Heading event Beta', '`detectHeadingDeviationEvents` emits low-confidence `heading_deviation` events labelled Heading Event (Beta) as diagnostic evidence even when Advanced Safety scoring is off. These legacy-compatible heading events are shown for review and no longer deduct from Safety scoring; current lane-changing scoring uses the separate `lane_changing_score` path.'],
      ['Overtake pattern Beta', '`detectAggressiveOvertakes` is diagnostic only. It requires a baseline of at least 1 km of straight driving above 80 km/h, a minimum 3.0 m/s2 acceleration threshold, and a bilateral out-and-back heading pattern within 15 seconds. `calculateTripScores` excludes `aggressive_overtake` from Safety, Aggression, coaching, route risk, achievements, and ordinary phone/safety event scoring.'],
      ['Eco score reliability', '`ECO_DEFAULTS` supplies cruise and parked-idle scoring fallbacks when migrated settings omit or corrupt the relevant thresholds. `calculateEcoDrivingScore` clamps idle ratios to 0-1, reports `eco_score_confidence: invalid_thresholds` with a null component when both effective multipliers are zero, and `calculateTripScores` then blends only remaining eco evidence.'],
      ['Speed variability reliability', '`SVI_DEFAULTS` excludes stopped samples at or below 5 km/h, requires at least ten moving samples, applies separate city and highway variability penalties, and blends mixed routes by observed segment distance. Insufficient SVI evidence is null and neutral in smoothness, reports, coaching summaries, and week-to-week comparisons.'],
      ['Driver signature braking confidence', '`buildDriverSignature` excludes trips without measured braking efficiency from its braking dimension, keeps `dimensions.brakingStyle` null until at least three scored trips exist, and exposes `braking_confidence` from 0 to 1 based on up to ten observed braking trips. Driving Coach shows unavailable braking evidence as an em dash rather than a perfect score.'],
      ['Predictive maintenance brake evidence', '`calculatePredictiveMaintenance` excludes trips without finite braking efficiency from brake-stress averaging. `brake_stress_index` remains null until there are at least five completed trips and three observed braking scores; unavailable braking evidence is neutral in the combined service-interval adjustment.'],
      ['Tire wear missing-speed evidence', '`calculateTireWearUnits` applies a neutral 1.0 speed factor when harsh-braking or sharp-turn speed evidence is unavailable, and stores `trip_tire_wear_has_missing_speed_data` plus the affected-event count. Predictive maintenance exposes `has_missing_speed_data`, vehicle health carries tire-wear-specific evidence metadata, and Vehicles labels the resulting tire-life estimate when it includes missing-speed events.'],
      ['Historical context estimate evidence gate', '`estimatePredictiveRouteRisk` sorts completed trips newest-first by `startTime`/`start_time` before applying the recent-trip window and returns `status: insufficient_history` with a null score when the window has no observed completed-trip distance or no scored-distance baseline. The dashboard displays Not enough driving history / Not enough scored driving history rather than constructing an estimate from a default score.'],
      ['Personal baseline confidence', '`computePersonalBaseline` withholds a dashboard baseline until 10 completed trips are available in the recent window, then uses exponential recency weighting and displays a confidence interval rather than an unstable simple mean.'],
      ['Personal percentile and best-window gates', '`computePersonalBaseline` labels percentile as "Percentile among your recorded weeks" and withholds it until at least four recorded weeks exist. `buildDrivingCoachInsights` requires at least three trips in a time-of-day bucket before selecting a best driving window and includes that sample count in coaching copy.'],
      ['Context-aware score evidence', 'Braking-efficiency grades use urban or highway thresholds and display their driving context. Hill-driving uses named provisional GPS/altitude-derived assumptions (`HILL_ACCEL_THRESHOLD_MS2 = 2.5` and `HILL_INFRACTION_PENALTY_POINTS_PER_KM = 8`), returns `hill_route: false` with a null score when not applicable, and displays its measurement limitation in Trip Detail. Hill infractions are normalized per km of climb/descent distance instead of using an absolute route count; the rate should still be recalibrated against labelled hill-driving evidence. Null component evidence stays out of composite decisions and score confidence metadata supports low-data UI suppression.'],
      ['Fatigue and playback time integrity', '`calculateFatigueScore` stores a normalized 0-100 fatigue risk. Its contribution to Safety uses the cited named `FATIGUE_SAFETY_PENALTY_SCALE` and `FATIGUE_SAFETY_MAX_PENALTY`, not a crash-outcome calibrated impairment-risk model. Fatigue heatmaps use named 30-second segments and require 20 segments before display. Trip duration subtracts tracking gaps, including native Android stats, and map playback uses timestamp progress with index progress only as a missing-time fallback.'],
      ['Phone-use scoring policy', 'Phone-use scoring requires Android Usage Access evidence. GPS micro-steering windows are collected only as diagnostics with a six-oscillation, 15-second threshold and GPS-accuracy gate; unavailable Usage Access produces `phone_use_score: null` / `usage_access_required`, Trip Card and Trip Detail show a permission banner/action, and proxy events are excluded from Safety, coaching, live warnings, route risk, and normal trip events.'],
      ['Weather context availability', '`fetchWeatherContext` returns source-attributed unavailable weather when weather is disabled, the route is empty, all weather points are private, or Open-Meteo has no matching hourly sample. `applyWeatherRiskToScores` distinguishes `open_meteo`, `gps_inference`, and `unavailable`; GPS stopping-distance context can label weather context for display but unavailable Open-Meteo risk remains neutral in scoring and historical-context weighting.'],
      ['OSRM consent and health checks', 'OSRM route snapping is disabled until the user saves a private/trusted endpoint, explicitly consents to sending sampled GPS coordinates, and the app records endpoint health. The public demo endpoint is shown as an example but is rejected for saved settings; `VITE_DEFAULT_OSRM_URL` can prefill trusted deployments and `VITE_OSRM_TIMEOUT_MS` sets the build default timeout before the user overrides it.'],
      ['Speed-limit fallback provenance', '`src/lib/speedLimitSource.js` supports global, Canada, United States, United Kingdom, Germany, Australia, and France fallback road-type profiles when OpenStreetMap supplies no posted `maxspeed` tag. Settings labels inferred values approximate, `fallback_country` is preserved through route points, events, context patches, backups, CSV exports, and Trip Detail, and inferred speed-limit scoring adds an explanatory note while half-weighting speeding penalties.'],
      ['Historical context normalization', '`estimatePredictiveRouteRisk` normalizes and clamps scored personal baseline, verified driving-event density, repeated driving-event areas, available weather, and time inputs before applying fractional weights. `ROUTE_RISK_CONSTANTS.EVENT_DENSITY_MAX_EVENTS_PER_KM = 5` and `DANGER_ZONE_SATURATION_COUNT = 5` are named provisional saturation assumptions, not collision- or casualty-calibrated thresholds. Low-confidence proxy counts such as current `close_proximity_count` and legacy `near_miss_count` are excluded from context weighting. The dashboard labels this as an estimated historical-context signal, not route prediction, and exposes weighted signal contributions. Repeated-event route indexing snaps nearby GPS cells within 15 m to limit same-road fragmentation and excludes proxy events.'],
      ['Route risk segment weighting', '`buildRouteRiskIndex` applies named internal pattern weights through `ROUTE_RISK_CONSTANTS`: a general observed event adds `ROUTE_RISK_EVENT_WEIGHT = 20` points per traversal rate and a harsh-event classification adds `ROUTE_RISK_HARSH_WEIGHT = 40` additional points per traversal rate. These map and alert indicators are not calibrated to collision or casualty outcomes.'],
      ['UBI minimum evidence and weighting', '`computeUBIReport` returns null score, grade, tier, and category scores until 50 km is observed, uses actual distance for event rates, reduces GPS-heading-derived cornering weight to 5% while shifting weight toward braking, and uses configurable mileage assumptions that default to 10,000 km/year optimal mileage with an 8,000 km spread. Named night-driving and per-100-km event-rate deduction constants are explicitly internal approximations, not insurer-validated rates: `TIME_OF_DAY_NIGHT_MULTIPLIER = 150`, `BRAKING_PENALTY_PER_100KM = 8`, `ACCEL_PENALTY_PER_100KM = 8`, `CORNERING_PENALTY_PER_100KM = 6`, and `SPEED_PENALTY_PER_100KM = 10`. Report UI, tooltips, and UBI PDFs now repeat that the score card is not an insurance rating.'],
      ['Commute and coaching policy', '`COMMUTE_MATCH_RADIUS_M` documents the 225 m commute route-match radius shown in Settings. Weekly coaching is local/rules-based, returns unavailable when no valid scored distance exists, uses one focus metric, and requires a score delta greater than 3 points; score tips require at least 2 km and confidence of at least 0.5.'],
      ['Economics and carbon claims', '`estimateTripEconomics` labels cost/CO2 as estimates, caps eco-driving consumption adjustment to +/-8%, and withholds fuel/CO2 savings until an assigned vehicle baseline is available. Carbon impact and achievement badges use the same vehicle-aware economics source so badges and reports do not disagree.'],
      ['Legacy and native score provenance', 'Legacy completed trips without current provenance are tagged `unknown_legacy_unrescored` rather than being marked as current scoring output. If more than 20% of recent completed trips in the 28-day window have outdated provenance, local storage auto-re-scores the affected recent trips and broadcasts progress through `road-sage:rescore-progress`; Android native completed trips write null score fields with `score_status: pending_javascript_scoring` until JavaScript scoring calculates evidence-backed values.'],
      ['Map fallback center policy', 'Trip playback no longer hard-codes a London map view for empty routes. It prefers the saved last map center, then last parked location, privacy-zone context, device location, and finally `VITE_DEFAULT_MAP_LAT`/`VITE_DEFAULT_MAP_LNG`; valid trip playback persists a new contextual center for later empty-state maps.'],
      ['Trip readiness display honesty', '`computePreTripRisk` no longer fills missing personal time/trend history with generic clock-risk defaults. It records signal provenance, fallback and missing-core signal keys, and actual-user signal counts; Dashboard displays "Not enough data yet" or limited-data copy unless evidence is high and withholds a confident readiness number when the input signal set is too thin.'],
      ['UI section recovery', '`src/components/SectionErrorBoundary.jsx` isolates calculation-heavy route maps, trip playback, Trip Detail score summaries, the Trip Detail page shell, and the Dashboard readiness/context panel. Caught render errors are logged through `logError` and show a reloadable fallback instead of blanking the app.'],
      ['Handled operation failures', '`src/lib/errorReporting.js` exports `logError(context, error, extra)` for critical async failures. Post-trip notifications, achievement sync, odometer sync, and driver-signature persistence now write tracking diagnostics instead of disappearing behind bare catches.'],
      ['Shared time-risk windows', '`src/lib/appConstants.js` owns night (22:00-04:59), morning-rush (07:00-09:59 by hourly bucket), and evening-rush (16:00-18:59) boundaries used by habit, pre-trip, historical context risk, automatic trip tagging, and fixed-hour trip-engine fallback behavior. Android fixed-hour night classification now evaluates that same 22:00-04:59 boundary in the device local timezone, matching JavaScript `Date#getHours()` semantics for native and JS rescoring agreement. Legacy sunset-mode settings migrate to this fallback; custom night hours remain configurable.'],
      ['Backup migrations', '`src/lib/dataBackup.js` migrates schema versions 1 through 7 before import, accepts trip notes up to 10,000 characters, counts affected truncated notes, and requires explicit confirmation in Settings before completing a truncating import. v6 relabels retired `lane_change` records as `heading_deviation_legacy`; v7 preserves local calibration survey labels and answered/skipped markers through backup import/export.'],
      ['Development verification fixtures', 'Development Diagnostics can seed and remove twelve local synthetic completed trips only in development builds with the explicit `allowSyntheticTestData` guard. Production calls throw instead of creating fake trips. Human-verified scoring golden fixtures lock the generated scoring-version contract, while shared Android/JavaScript parity and advanced-feature fixtures exercise native stats, local-time night classification, conservative GPS noise-floor behavior, OBD parsing, sensor fusion, lane-change scoring, and crash-readiness diagnostics.'],
      ['Bounded UI lists', 'Risk hotspots initially show 6 and route history stretches initially show 3 through named constants, with a show-all control and hidden-item count.'],
    ],
  ));
  doc.push('');
  doc.push('> SAFETY LIMITATION: Road Sage has no hazard-stimulus timestamp, lead-vehicle ranging sensor, lane camera/HD-lane geometry, turn-signal state, or driver-monitoring sensor. Brake onset smoothness, stop-start patterns, estimated brake-turn manoeuvre alerts, heading events, heading drift Beta, GPS phone-use proxy, OBD-refined powertrain signals, IMU-assisted lane-changing, and overtake-pattern outputs are behavior proxies rather than validated safety outcomes. Estimated brake-turn alerts, overtake patterns, and GPS phone-use proxy outputs are excluded from trip Safety scoring; lane-changing remains provisional and evidence-weighted. Legacy stored identifiers remain readable for older trip records only.');
  doc.push('');
  doc.push('```mermaid\nflowchart TD\n  UI[React pages/components] --> Services[src/api services]\n  UI --> Domain[src/lib scoring, tracking, reports]\n  Domain --> Local[(localStorage / IndexedDB / Preferences)]\n  Services -->|VITE_API_URL set| Backend[Optional REST API]\n  Services -->|VITE_API_URL empty| LocalRepo[local repositories]\n  Android[Capacitor Android services] --> NativePrefs[(SharedPreferences)]\n  Android --> Domain\n  Domain --> External[OSM / Open-Meteo / optional OSRM]\n  Domain --> Reports[CSV/PDF/backup exports]\n```');
  doc.push('');
  doc.push(table(
    ['Technology', 'Exact project version'],
    packageFacts().filter((d) => ['react', 'react-dom', 'vite', '@capacitor/core', '@capacitor/android', 'leaflet', 'react-leaflet', 'vitest', 'typescript'].includes(d.name)).map((d) => [d.name, d.installed]),
  ));
  doc.push('');
  doc.push('Entry points: `index.html` loads `src/main.jsx`; `src/App.jsx` defines app routes and bootstraps theme, notifications, onboarding, and Android auto tracking; `android/app/src/main/java/com/drivesense/app/MainActivity.java` hosts the Capacitor app; `android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java` handles native tracking.');
  doc.push('');
  doc.push('---');

  doc.push('## Architecture And Module Map');
  doc.push('');
  doc.push(moduleMap());
  doc.push('');
  doc.push('---');

  doc.push('## Import Export Map');
  doc.push('');
  doc.push(importExportMap());
  doc.push('');
  doc.push('---');

  doc.push('## Function And Method Catalogue');
  doc.push('');
  doc.push(functionCatalog());
  doc.push('');
  doc.push('---');

  doc.push('## Calculation Deep Dives With Actual Code');
  doc.push('');
  doc.push('These are the main production calculations that drive trip physics, scoring, route playback, prediction, reports, and Android tracking. The complete line-by-line index follows in the next section.');
  doc.push('');
  doc.push(topCalculationSnippets());
  doc.push('');
  doc.push('---');

  doc.push('## Complete Calculation Snippet Index');
  doc.push('');
  doc.push('Every production calculation-like line found by the scanner is grouped by domain below. Each row includes the exact line of code. Test calculations are listed at the end so expected-value math is not mixed with production behavior.');
  doc.push('');
  for (const kind of ['scoring', 'risk/prediction', 'map/route', 'driving physics', 'economics', 'timing/control', 'general calculation']) {
    const rows = calcRowsByKind(kind);
    doc.push(groupedDetails(`${kind} calculations`, rows, renderCalcIndex));
    doc.push('');
  }
  doc.push(groupedDetails('test calculation/assertion lines', testCalculations, renderCalcIndex));
  doc.push('');
  doc.push('---');

  doc.push('## Hard-Coded Values And Constants Registry');
  doc.push('');
  doc.push('Named thresholds and policies are centralized around `SCORING_CONSTANTS`, `DEFAULT_THRESHOLDS`, `ECO_DEFAULTS`, `SVI_DEFAULTS`, `PENALTY_SCALE_FACTOR`, `FATIGUE_SAFETY_PENALTY_SCALE`, `src/lib/appConstants.js`, `PERSONAL_BASELINE_MIN_TRIPS`, `PERSONAL_PERCENTILE_MIN_WEEKS`, `BEST_WINDOW_MIN_TRIPS`, `FATIGUE_HEATMAP_SEGMENT_SECONDS`, `COMMUTE_MATCH_RADIUS_M`, `MIN_UBI_REPORT_DISTANCE_KM`, `TIME_OF_DAY_NIGHT_MULTIPLIER`, UBI per-100-km rate deduction constants, historical-context and segment-index `ROUTE_RISK_CONSTANTS`, pre-trip-risk, habit-profile, daily-fatigue, and repeated-event-area constants. `METRIC_REGISTRY` supplies exported metric descriptions, evidence minimums, sources, and calibration notes. The app also contains intentional literals for route labels, feature flags, UI labels, named Android notification IDs, and tests; these are grouped by file so reviewers can see why each value exists.');
  doc.push('');
  doc.push(literalRegistry());
  doc.push('');
  doc.push('### Generated Named Constants Index');
  doc.push('');
  doc.push(constantsRegistry());
  doc.push('');
  doc.push('---');

  doc.push('## Data Models State And Storage');
  doc.push('');
  doc.push('Core persisted models are plain JSON trip, vehicle, settings, backup, diagnostic, route-risk-index, privacy-zone, motion-sample, OBD-annotated route-point, and Android native event records. Completed trips now include canonical `component_scores` evidence envelopes and `score_provenance` for scoring version/input auditing. Local trip reads run a one-time retired-event migration that converts legacy `lane_change` records to diagnostic `heading_deviation_legacy` records and remaps matching event-feedback keys. There is no ORM schema in this repo; IndexedDB schema creation lives in `src/lib/localTripRepository.js`, local/mobile storage helpers live in `src/lib/mobileStorage.js` and `src/lib/trackingStore.js`, and Android SharedPreferences records live in `DriveSenseNativeTripStore.java` and `DriveSenseAutoTrackingService.java`.');
  doc.push('');
  doc.push(storageCatalogue());
  doc.push('');
  doc.push('---');

  doc.push('## Routes And API Reference');
  doc.push('');
  doc.push('### React Routes');
  doc.push('');
  doc.push(routeReference());
  doc.push('');
  doc.push('### REST / External Calls');
  doc.push('');
  doc.push(apiReference());
  doc.push('');
  doc.push('---');

  doc.push('## Configuration And Environment');
  doc.push('');
  doc.push(envTable());
  doc.push('');
  doc.push('App commands: `npm run dev`, `npm run build`, `npm run test`, `npm run lint`, `npm run typecheck`, `npm run android:sync`, `android/gradlew.bat assembleDebug`.');
  doc.push('');
  doc.push('Android SDK location is intentionally machine-local. `android/local.properties` is ignored by `android/.gitignore`, excluded from this generator, and checked by `npm run check:repo-hygiene` so local `sdk.dir` paths are not committed.');
  doc.push('');
  doc.push('---');

  doc.push('## Error Handling Catalogue');
  doc.push('');
  doc.push('Critical async operations should call `logError(context, error, extra)` when a failure is handled locally. This records an `operation_error` diagnostic with sanitized message and stack preview so Diagnostics can explain missing notifications, stale odometers, failed coaching persistence, or isolated React section crashes without surfacing an unhandled rejection.');
  doc.push('');
  doc.push(errorCatalogue());
  doc.push('');
  doc.push('---');

  doc.push('## Security Analysis');
  doc.push('');
  doc.push('- Auth: optional backend bearer token is read from `sessionStorage`; legacy `localStorage` tokens are migrated and removed.');
  doc.push('- Authorization: no in-repo backend role matrix exists. The local app is single-user local-first; backend authorization must be enforced by the external API if configured.');
  doc.push('- User-controlled data surfaces: backup import JSON, settings import, trip/vehicle forms, route points, privacy zones, OSRM endpoint input, external context fetches, CSV/PDF export content, and Android native intent extras.');
  doc.push('- Leaflet popups: route labels, event metadata, speed-limit road/source data, repeated-event route segments, repeated driving-event areas, privacy labels, and parked addresses are HTML-escaped before insertion into popup template strings.');
  doc.push('- External data sharing: Overpass gets route-area boxes, Open-Meteo gets midpoint/date, and OSRM receives sampled raw GPS coordinate pairs only when route snapping is explicitly enabled, a trusted endpoint is saved, data sharing has been consented to, and the user requests road data. Settings rejects saving the public OSRM demo endpoint, stores endpoint health, and shows the raw-coordinate warning beside the custom endpoint input because user-provided endpoints can be untrusted external servers.');
  doc.push('- Backup restore: schema versions 1 through 6 are migrated before merge; retired `lane_change` events are relabelled as diagnostic `heading_deviation_legacy` records; untrusted records are whitelisted and field-limited, and any note truncation reports the affected trip count and requires explicit user confirmation before completion.');
  doc.push('- Secrets: no secrets are checked into this repo by the scanner; `VITE_API_URL` is configuration, not a secret.');
  doc.push('- Main residual risks: remaining literals outside domain constant groups still need review before scoring policy changes; optional backend API security is outside this repo; user-provided OSRM endpoint can receive sampled raw coordinate pairs by design after explicit consent; OBD and IMU signals improve provenance but do not create a validated crash/claims model.');
  doc.push('');
  doc.push('---');

  doc.push('## Performance Characteristics');
  doc.push('');
  doc.push('- Critical loops: trip stats, erratic-speed deque windows, braking-sequence scoring, night detection, fatigue progression, and route playback are linear over route points. Road-type scores pre-classify route points in fixed windows and assign cached full-trip events through indexed or binary timestamp lookup, avoiding the prior quadratic route scan pattern. Route-risk index creation remains an O(trips x route segments x event-proximity checks) candidate; import/export and full-history reports are O(number of local records).');
  doc.push('- Platform detection is memoized once at module load, so native/local-store branching does not repeatedly call Capacitor during render or tracking loops.');
  doc.push('- Long-trip scoring has a regression budget: a synthetic 2,000-point trip must complete stats plus score calculation in under 500 ms in the trip engine test suite.');
  doc.push('- Frontend bundle splitting: `vite.config.js` manually chunks React, charts, html2canvas, jsPDF, and Capacitor vendors.');
  doc.push('- Map rendering: `prepareMapRoutePoints`, `downsampleRoutePoints`, route smoothing, and privacy masking constrain heavy routes before Leaflet/SVG playback rendering.');
  doc.push('- Render fault isolation: TripMap, TripPlayback, the Trip Detail score overview, the Trip Detail page shell, and the Dashboard readiness/context panel are wrapped with `SectionErrorBoundary` so malformed trip data can fail one section with a reload prompt instead of unmounting the full app tree.');
  doc.push('- Native background tracking: Android service filters noisy points, caps native motion samples at 5,000, records compact trip/motion records, and leaves JavaScript scoring/rescoring to compute evidence-backed scores after import.');
  doc.push('- Bottleneck candidates are visible in the calculation index: repeated `sort`, `map`, `filter`, route-window scans, and report aggregation loops.');
  doc.push('');
  doc.push('---');

  doc.push('## Testing Coverage Map');
  doc.push('');
  doc.push(testCoverage());
  doc.push('');
  doc.push('Coverage boundaries inferred from source shape: browser e2e covers smoke navigation; Android tests cover native trip-store persistence plus shared JavaScript/native trip-stat and noise-floor fixtures; Vitest locks the scoring contract with human-verified golden fixtures, metric-registry coverage, and local synthetic test-trip construction; deterministic tests mock Overpass/Open-Meteo/OSRM contracts; opt-in live contract tests call all three public services through `npm run test:contracts:live`.');
  doc.push('');
  doc.push('---');

  doc.push('## Dependency Audit');
  doc.push('');
  doc.push(dependencyTable());
  doc.push('');
  doc.push('---');

  doc.push('## Deployment And Infra');
  doc.push('');
  doc.push('- Web build: `npm run build` runs Vite and emits `dist/`.');
  doc.push('- Android sync: `npm run android:sync` builds web assets, runs Capacitor sync, and reapplies the tracked AGP 9 compatibility patch for generated/plugin Gradle scripts.');
  doc.push('- Android debug build: run `android/gradlew.bat assembleDebug` from the repository root or Android directory as configured.');
  doc.push('- CI/CD: `.github/workflows/security-ci.yml` installs dependencies, audits packages, blocks forbidden source imports, runs repository hygiene checks, unit/component tests, Playwright browser smoke e2e, Android instrumentation on an emulator, builds, and scans the production bundle for localhost API fallback on pushes and pull requests. Live public-service contracts run on the weekly schedule or manual workflow dispatch so third-party outages do not block ordinary changes.');
  doc.push('- Docker/container setup: no Dockerfile found in the scanned repository.');
  doc.push('- Rollback: deploy previous web artifact or Android build; local data is stored client-side and should not require backend rollback unless `VITE_API_URL` points at a managed API.');
  doc.push('');
  doc.push('---');

  return `${doc.join('\n')}\n`;
}

function buildReadme() {
  const version = JSON.parse(read(path.join(ROOT, 'package.json'))).version;
  return [
    '# Road Sage',
    '',
    'Road Sage is a local-first driving tracker built with React, Vite, Capacitor, and Android native services. It records trips, maps routes, detects driving events, scores driving behavior, generates reports, and keeps trip history on the device unless an optional backend is configured.',
    '',
    '## Current App Surface',
    '',
    '- Dashboard, trip history, trip detail, live map, driving coach, insights, achievements, reports, diagnostics, settings, and vehicles pages.',
    '- Manual trip capture, foreground auto-detect, and Android native background auto tracking with activity recognition, GPS fallback, quick settings tile support, pause/resume controls, and native trip import.',
    '- Trip scoring for safety, GPS/OBD motion smoothness, eco driving estimates, confirmed Android Usage Access phone-use evidence, speed compliance with posted-or-inferred limit provenance, road-type segments, brake onset smoothness, cornering, braking efficiency, optional IMU-assisted lane-changing, contextual urban/highway stop-start patterns, fatigue exposure, heading drift Beta, source-attributed weather context, estimated brake-turn manoeuvre alerts, historical context signals, and diagnostic-only GPS phone/overtake pattern counts.',
    '- Map playback with route simplification, stop handling, privacy-masked coordinate handling, HTML-escaped Leaflet popups, speed-limit coloring, fatigue overlays, event markers, repeated-route comparison support, persisted fallback map centers, last-parked context, and deployment-configurable default coordinates.',
    '- Vehicle profiles with fuel/electric economy, odometer estimates, maintenance reminders, renewal tracking, localized per-car cost, CO2 estimate metadata, and engine-health summaries, default vehicle handling, and vehicle comparison.',
    '- Reports with CSV export carrying metric provenance metadata, monthly and UBI PDF metric-reference pages, estimated-score notation, UBI score-card PDF export gated until 50 km of evidence and visibly marked not an insurance rating, confidence-aware rolling baseline comparison, carbon impact, configurable-currency estimated fuel cost, and vehicle-backed CO2/fuel savings estimates that stay unavailable without an assigned vehicle baseline.',
    '- Full backup export/import for trips, GPS route points, events, vehicles, settings, privacy-zone metadata, saved filters, reviewed event feedback, fallback speed-limit provenance, and legacy heading-event migration, with confirmation required before importing truncated notes.',
    '- Diagnostics capture unhandled app errors, handled critical operation failures, isolated React section crashes, OBD/Web Bluetooth readiness, motion-sensor readiness, possible incident-signal readiness, and native sensor evidence with sanitized messages and stack previews; development builds can seed and remove local synthetic trips only behind the explicit synthetic-test-data guard.',
    '',
    '## GPS-Derived Safety Proxy Limits',
    '',
    'Road Sage observes the ego vehicle GPS speed and heading stream, optionally enriched by Android Usage Access, OBD-II Bluetooth, and device-motion samples when those permissions or adapters are available. It still has no hazard-stimulus timestamp, forward-ranging sensor, lane camera/HD-lane geometry, turn-signal state, or driver-monitoring sensor. The following values are behavioral proxies, not confirmations of human reaction time, following gap, near misses, lane position, phone distraction, overtaking safety, crashes, or physiological fatigue.',
    '',
    '| Current field or display | What is observed | Current behavior and limitation |',
    '| --- | --- | --- |',
    '| `brake_onset_smoothness_*` | Ramp duration and peak GPS-derived deceleration during detected harsh braking. | Hidden until five sequences exist, is always low confidence, and contributes 10% of Smoothness. The UI disclaimer states it is not neurological reaction time. |',
    '| `stop_start_pattern_*` | Repeated cruise then deceleration/speed-drop cycles in GPS speed data. | Contextual urban/highway estimates are hidden until enough evidence exists: 2 km city-speed evidence for urban mode or 5 km highway evidence for highway mode. It contributes 5% of Safety when present and cannot measure following distance. |',
    '| `close_proximity` manoeuvre alert | At least 1.5 s of coincident braking and heading change at 30+ km/h; defaults are 4.0 m/s2 and 25 deg/s. | Always low confidence and advisory-only; excluded from Safety, weather score adjustment, historical-context risk weighting, repeated-event areas, and repeated-event route layers. It does not establish object proximity or a near miss. |',
    '| `heading_drift_beta_*` | Sustained five-minute GPS heading-drift windows at highway speed. | Always low confidence, labelled Beta, and presented as a GPS-only attention pattern signal rather than a fatigue measurement; the 02:00-05:00 window increases proxy risk by 2.5x. |',
    '| `heading_deviation` / Heading Event (Beta); `heading_deviation_legacy` | Counter-steering GPS-heading shape above 50 km/h with context suppression; migrated legacy lane-change records. | Collected as diagnostic evidence even when Advanced Safety scoring is off, and removed from Safety scoring because it cannot verify a lane change. Retired `lane_change` backups/local records migrate to `heading_deviation_legacy` and remain diagnostic only. |',
    '| `lane_changing_score` / Lane Changing | Highway-speed GPS heading pattern plus calibrated IMU yaw when motion samples are available. | Requires at least 5 km and two detected manoeuvres, contributes a provisional 5% Safety blend weight when enabled, downweights GPS-only confidence, and cannot verify turn signals, lane markings, following gap, or slow-traffic lane changes. |',
    '| `aggressive_overtake` / Overtake Pattern (Beta) | Straight-highway baseline, acceleration, and bilateral heading-return pattern in GPS speed/heading. | Diagnostic only, always Beta/low confidence, excluded from Safety, Aggression, route risk, coaching, achievements, and headline trip risk. It cannot prove a lane crossing or actual overtake from GPS alone. |',
    '| `phone_proxy_*` / GPS phone-use proxy | Repetitive GPS heading oscillations at driving speed. | Diagnostic only. Requires at least six oscillations in 15 seconds and acceptable GPS accuracy; no phone-use score is shown unless Android Usage Access evidence is available. |',
    '| `possible_crash` / Possible Incident Signal | Impact-like device-motion samples followed by low movement or still activity. | Emergency workflow cue only; unavailable without motion samples and never a crash diagnosis. |',
    '',
    '## Recent Update Coverage',
    '',
    'The markdown is regenerated from the current source tree and reflects the latest vehicle-health, tracking, scoring, privacy, storage, and documentation behavior.',
    '',
    '- Documentation was converted into a source-generated technical reference with module inventory, imports/exports, function catalogue, calculation snippets, constants, storage, routes, error handling, tests, dependencies, and deployment notes.',
    '- Shared application policy now lives in `src/lib/appConstants.js`: fallback night and rush-hour boundaries are consistent across habit, predictive-route, pre-trip, trip-tagging, trip-engine fallback, settings defaults, and Android fixed-hour classification. Android evaluates the fixed 22:00-04:59 night window in the device local timezone, matching JavaScript `Date#getHours()` when native trips are later rescored. Legacy sunset-mode defaults migrate from 06:00 to the shared 05:00 end; deliberately custom night hours remain configurable. Saved UI preference keys, initial display limits, and provisional base-score and fatigue-to-Safety penalty scales are named in one place.',
    '- Calculation-heavy UI is isolated with `SectionErrorBoundary`: TripMap, TripPlayback, the Trip Detail score summary, the Trip Detail page shell, and the Dashboard readiness/context panel now show a friendly reloadable fallback and log the caught error instead of blanking the whole app.',
    '- Critical post-trip and persistence operations now log handled failures through `logError`: completed-trip notifications, confirmed phone-use alerts, style-shift alerts, achievement notification sync, daily fatigue warnings, vehicle odometer sync, and driver-signature saves all write diagnostic events instead of being silently swallowed.',
    '- Vehicle odometer sync still retries on the next vehicle/trip refresh, and repeated failures in a session show a non-blocking toast so stale odometer estimates are visible without blocking the Vehicles page.',
    '- Numeric clamping is centralized in `src/lib/mathUtils.js`; score, historical-context risk, repeated-event route layers, fatigue, weather, report, playback, calibration, and import sanitization paths now share the same NaN-safe boundary behavior.',
    '- Daily fatigue readiness now uses break-corrected active driving minutes instead of a hard 60-minute day total. The default onset is 90 active minutes, learned habit-profile onset is honored by dashboard and post-trip warnings, and breaks over 30 minutes reduce accumulated fatigue on a 180-minute recovery curve.',
    '- Scoring was stabilized around explicit defaults: noisy-signal filtering, rate-normalized scoring, traffic-stop grace periods, privacy-masked coordinate exclusion, Android phone-use source gating, diagnostic proxy separation, finite anomaly/sensor scores, reviewed-event rescoring, and weighted evidence blends that omit unavailable components instead of filling them with 100.',
    '- Score display is centralized in `src/lib/scoreDisplay.js`: approximate score surfaces use a leading `~`, monthly PDFs state that scores are estimates not validated against crash data, and UBI score-card UI/PDF output is visibly labelled `NOT AN INSURANCE RATING`.',
    '- Scoring and calibration policy is centralized in `src/lib/scoringConstants.js`: provisional thresholds, blends, risk assumptions, UBI assumptions, and `PENALTY_SCALE_FACTOR_CALIBRATION_PROCESS` declare affected metrics, labeled-dataset requirements, fitting steps, and promotion criteria. New score records carry a generated content-hash `SCORING_VERSION`, `component_scores` evidence envelopes, and `score_provenance`; Trip Detail and Settings expose provenance and approximate calibration status instead of presenting provisional output as validated.',
    '- Trip Detail includes a dismissible post-trip calibration survey for optional 1-5 drive ratings, score-accuracy feedback, driver/passenger confirmation, difficulty, and context tags. Feedback stays local in this local-only app, is preserved in backups, appears in System Logs, and is used by Settings as a calibration signal; it does not upload anywhere, automatically change scores, or automatically tune thresholds. Passenger, short, low-quality GPS, heavily privacy-masked, test/debug, incomplete, or crash-recovered trips are excluded from calibration.',
    '- Base score penalty normalization now uses named `PENALTY_SCALE_FACTOR = 40`: under the current provisional calibration, 2.5 severity-weighted penalty points per km reaches the score floor. This factor must be recalibrated against a labeled driving dataset before being treated as validated.',
    '- Fatigue contribution to Safety now uses named `FATIGUE_SAFETY_PENALTY_SCALE = 0.15` and `FATIGUE_SAFETY_MAX_PENALTY = 15`: maximum normalized fatigue adds a capped 15-point Safety deduction after event-rate normalization. This cited coefficient maps the maximum fatigue proxy to a conservative 0.05% BAC-equivalent impairment assumption from Williamson & Feyer (Occupational and Environmental Medicine, 2000); it is not crash-outcome calibrated.',
    '- Optional OBD-II Bluetooth support parses RPM, throttle, engine load, vehicle speed, coolant temperature, and mass-air-flow PID responses. OBD speed can replace weak GPS speed for calculations, OBD RPM/throttle refine eco and engine-stress evidence, and score provenance displays `OBD-II Bluetooth` as a source when those samples are present.',
    '- Sensor fusion now records browser or Android native motion samples, summarizes IMU quality, calibrates phone orientation from harsh-brake evidence, enriches event confirmation, and supports possible incident signals. Diagnostics exposes motion permission/readiness; possible incident signals are not crash diagnoses.',
    '- Lane-changing scoring is now a first-class provisional metric. It uses calibrated IMU yaw with GPS validation when available, falls back to lower-confidence GPS heading at highway speed, requires 5 km and two manoeuvres before scoring, and can be disabled in Detection Features. It is limited to a provisional 5% Safety blend weight.',
    '- Jerk scoring now returns `null` with `jerk_score_confidence: insufficient_data` for trips under 0.5 km or without usable movement samples. Trips from 0.5 km to under 3 km keep the real 0-100 jerk score with low confidence, and low-confidence jerk evidence is suppressed from Smoothness blending.',
    '- Intersection scoring now recognizes traffic stops from continuous sub-10 km/h samples spanning at least four seconds, labels them separately from extended stopped periods, and discards privacy-masked windows. Unobserved/under-0.5 km routes expose no intersection score, and Overall score renormalizes the remaining observed components instead of awarding a perfect intersection score.',
    '- `stop_start_pattern_score` replaces following-distance claims for new scored trips. It is low confidence, blends contextual urban/highway estimates when evidence exists, is hidden below 2 km of city-speed evidence or 5 km of highway evidence, contributes 5% of Safety only when present, and is the only Defensive proxy in that slot because GPS speed cannot measure vehicle gap.',
    '- `brake_onset_smoothness_*` replaces public reaction-time output in the UI and CSV. It uses peak deceleration divided by ramp duration, requires five detected braking sequences, is always low confidence, and is hidden until evidence exists. The UI disclaimer states that it is not neurological reaction time.',
    '- Cornering lateral-G detection now ignores speeds below 25 km/h, smooths heading from route geometry over three points, and requires sustained lateral-G over consecutive GPS samples before creating sharp-turn events.',
    '- GPS heading-deviation detection emits low-confidence `heading_deviation` / Heading Event (Beta) records as diagnostic evidence even when Advanced Safety scoring is off. It requires a straight approach above 50 km/h, suppresses common context windows, and no longer affects Safety scoring.',
    '- Estimated brake-turn manoeuvre alerts require at least 1.5 seconds of concurrent braking and heading change at 30+ km/h with default thresholds of 4.0 m/s2 and 25 deg/s. They remain low-confidence advisory signals and are excluded from Safety, weather score adjustment, historical-context risk weighting, repeated-event areas, and repeated-event route layers.',
    '- Heading drift Beta evaluates GPS-only drift patterns over sustained five-minute highway-speed windows, remains low confidence, and applies circadian weighting between 02:00 and 05:00. Public wording presents it as an attention pattern signal rather than a fatigue measurement, and it no longer feeds the trip fatigue Safety penalty.',
    '- Monthly PDF exports include estimated-score and GPS-only proxy limitations alongside Safety and Smoothness results; GPS phone, heading-event, and overtake patterns are described as diagnostics only, while Heading Drift Beta is shown only when advanced detection was enabled for the rescored trip. The central metric registry now supplies evidence/source/calibration metadata to CSV exports and metric-reference pages in monthly and UBI PDFs.',
    '- Multi-trip score summaries use distance-weighted averages for weekly summaries, goals, route/day/vehicle/report comparisons, historical context estimates, PDF summaries, and dashboard rollups. The personal baseline is intentionally different: it appears only after 10 completed recent trips and uses exponential recency weighting with a displayed confidence interval. Personal percentile is labelled as percentile among your recorded weeks and is hidden until at least four recorded weeks exist.',
    '- Braking-efficiency grades are contextual: urban and highway driving use separate thresholds, and the displayed grade identifies its context. Hill control now names its provisional GPS/altitude-derived threshold and rate penalty assumptions (`2.5 m/s2` and `8` points per inferred infraction per hill-driving km), stores flat or altitude-insufficient routes as not applicable, and displays its GPS-only limitation in Trip Detail.',
    '- Score confidence is evidence-aware rather than distance-only. Safety, Smoothness, Eco, and Distraction still store internal `high`, `developing`, `low`, or `unavailable` evidence based on contributing signals; the UI renders `developing` as "limited evidence", hides redundant `high evidence` badges, and repeats badges only for low or unavailable component evidence. Unavailable phone-use or intersection evidence prevents a long trip from appearing fully evidenced, and coaching remains suppressed when overall evidence is low.',
    '- Driver signatures now treat missing braking-efficiency evidence as unavailable rather than perfect. Braking style stays blank until at least three scored braking trips exist, `braking_confidence` increases with observed evidence, speed-tolerance uses actual speeding-event rate rather than average route speed, and Driving Coach labels low-confidence or unavailable braking data instead of charting false certainty.',
    '- Trip-stat hot paths now avoid repeated route rescans: sunset night windows are cached once per trip date, erratic-speed windows maintain sliding summaries, event-to-point lookup is binary-search based, and road-type scores partition full-trip detected events rather than rerunning detection per type.',
    '- Eco driving scoring now resolves missing or malformed tuning through named `ECO_DEFAULTS`, clamps impossible parked-idle ratios, penalizes sustained parked idle instead of unavoidable traffic-stop idle, reports invalid zero-multiplier configurations as unavailable rather than a fixed score, blocks Settings changes that would disable both eco multipliers, and blends remaining eco evidence into the trip score.',
    '- Speed variability scoring now ignores stopped traffic samples, requires sufficient moving evidence, scores city and highway variability separately through `SVI_DEFAULTS`, distance-weights mixed routes, and omits unavailable SVI from coaching/report trend comparisons.',
    '- Phone-use scoring now requires Android Usage Access evidence. Without Usage Access, `phone_use_score` is unavailable, Trip Card and Trip Detail show a permission-required state, and the UI asks for permission instead of showing a proxy score. GPS micro-steering detections are stored as `phone_proxy_*` diagnostics only, require at least six oscillations in a 15-second window with acceptable GPS accuracy, and do not affect Safety, coaching, live warnings, route risk, or ordinary trip-event lists.',
    '- Overtake detection is marked Beta and diagnostic-only. It now requires at least 1 km of prior straight highway driving above 80 km/h, a minimum 3.0 m/s2 acceleration threshold, and a bilateral out-and-back heading signature within 15 seconds. Overtake quality/counts are exported and displayed as diagnostics but excluded from Safety, Aggression, route risk, coaching, achievements, and UBI-style scoring.',
    '- Historical context wording replaces route-prediction/risk wording unless a real planned route is supplied. It requires observed completed-trip distance and a scored-distance baseline; without either, the dashboard shows Not enough driving history / Not enough scored driving history and no context number. Once evidence exists, it sorts completed trips newest-first, excludes unscored trips and tiny-trip event-density distortion, normalizes all weighted components to 0-100, and clamps available weather/baseline input before scoring. Its named saturation assumptions remain provisional: five eligible verified driving events per km or five nearby repeated driving-event areas each saturate their respective signal without a collision-outcome calibration claim. Low-confidence proxy events such as current brake-turn alerts and ambiguous legacy `near_miss` counts are excluded from context weighting. The dashboard labels the value as estimated and exposes weighted signal contributions. Repeated-event route index cells are coarser, merge nearby segment midpoints within 15 m to reduce GPS fragmentation, and exclude proxy events.',
    '- UBI reports require at least 50 km before generating a score, use actual distance in per-100-km rates, score time-of-day exposure by night driving minutes, reduce noisy GPS-derived cornering to a 5% weight, and use configurable mileage assumptions that default to an optimal 10,000 km/year with an 8,000 km spread. The named night-exposure and category-rate penalty constants remain internal, uncalibrated approximations rather than insurer-validated rates; the score-card UI/PDF now presents that limitation and states that it is not an insurance rating alongside any displayed score.',
    '- Vehicle engine-health summaries now average only finite stored engine stress scores. Trips without a usable score are excluded, and vehicles with no scored samples show `N/A` instead of a misleading maximum-stress fallback.',
    '- Predictive maintenance no longer treats trips without braking evidence as perfectly gentle braking. Brake stress is averaged only from observed braking-efficiency scores and remains unavailable until at least five completed trips include three scored braking samples; unavailable braking evidence is neutral when adjusting service intervals. Tire-wear events without recorded speed use a neutral factor and are flagged in maintenance and vehicle health summaries rather than silently treated as fully measured.',
    '- Currency and economics baselines are configurable in Settings, including cost symbol, average vehicle CO2 per 100 km, EV kWh per 100 km, grid CO2 intensity, and tree-year equivalents. Vehicle fuel type is used for trip CO2 estimates; ICE economy below 3 L/100km is rejected and unusually high values receive a confirmation warning.',
    '- Fuel and CO2 estimates now cap eco-driving consumption adjustment to +/-8%. Missing eco-driving evidence applies no adjustment, Trip Detail marks values as estimates with confidence bands, fuel/CO2 savings show unavailable until a vehicle is assigned, and EV CO2 savings remain unavailable unless grid CO2 intensity is configured.',
    '- Backup import is hardened and versioned: v1-v7 backups migrate before merge, retired `lane_change` events become diagnostic `heading_deviation_legacy` events, local calibration survey labels are preserved in full backups, files over 50 MB are rejected before reading, records are sanitized, trip notes allow 10,000 characters, and any truncation reports the affected trip count and requires explicit user acknowledgement before import completes.',
    '- Native-safe UI preferences now use the mobile storage layer for saved trip filters, dismissed tag suggestions, and first-launch permission prompting. Backup export/import reads and writes saved filters through that same layer on Android.',
    '- Local trip storage uses IndexedDB when available, with a migration runner and localStorage fallback. `VITE_DB_NAME` can rename the local database with a copy/count-verify/delete migration. Legacy/schema-upgrade refreshes populate current component evidence and score provenance; Settings identifies current scoring-input/version mismatches, auto-re-scores recent trips when more than 20% of the 28-day window is stale, and lets the user deliberately queue affected completed trips for re-score.',
    '- API behavior is local-first by default. Trips and vehicles use local repositories when `VITE_API_URL` is absent or the app is running natively; configured backends fail clearly instead of silently falling back to localhost.',
    '- Auth tokens are session-scoped. Legacy `localStorage` tokens are migrated into `sessionStorage` and removed, and logout clears both token names from browser storage.',
    '- Open road context is explicit and privacy-aware. OpenStreetMap speed limits and Open-Meteo weather are manual by default unless automatic context fetch is enabled. When weather is disabled, unavailable, privacy-skipped, or has no matching hourly sample, the app stores weather risk as null with source attribution and displays it as unavailable instead of defaulting to low risk; GPS stopping-distance context can be shown separately as a weather-context fallback. When a posted map speed limit is absent, Settings can choose Global, Canada, United States, United Kingdom, Germany, Australia, or France approximate road-type defaults, with the chosen fallback provenance preserved in reports, backups, Trip Detail, and context metadata. OSRM route snapping requires a trusted custom endpoint, explicit raw-coordinate data-sharing consent, endpoint health metadata, and a manual Get Road Data action; the public demo endpoint is rejected for saved settings.',
    '- Trip Detail and Map no longer silently hide additional repeated-event route stretches or repeated driving-event areas: initial lists remain compact, and show-all controls report hidden counts. Trip Detail separates scored driving events from diagnostic-only events, shows feedback-adjusted event counts, shows inferred speed-limit scoring notes, and displays a Usage Access banner when phone-use evidence is unavailable. Heading drift Beta color and fatigue critical markers now follow actual levels and exported thresholds, and compliance bars use the canonical score color tiers.',
    '- Settings now explains tracking, Android permissions, privacy, notifications, speed warnings, detection features, currency/economics, advanced models, and data controls with searchable sections, safer validation, OSRM endpoint health checks, OBD connection actions, motion-sensor permission actions, and rescore progress.',
    '- Android tracking updates include immediate native notification state, quick settings tile sync, clearer off/paused handling, named notification identifiers, device-local fixed-hour night classification aligned to the shared 22:00-04:59 window, deduplicated trip/safety notifications, battery optimization guidance, phone usage access support, native IMU motion samples capped at 5,000 per trip, and native diagnostics surfaced in the app. Android Gradle setup now removes obsolete AGP flags and reapplies clean AGP 9-compatible plugin DSL patches after install or sync.',
    '- Privacy-zone and map fixes keep private locations masked, allow radius editing, hide private events, exclude masked null coordinates from distance/playback math, HTML-escape user/external values in Leaflet popups, and preserve original GPS geometry when route snapping or old map-matching data would collapse playback.',
    '- Calculation fixes keep map-matching confidence and snapped coverage numeric even when OSRM sends invalid confidence, omit invalid speed limits from popups, preserve Android `ON_BICYCLE` as `on_bicycle` while retaining legacy `cycling`, and make native platform checks module-level constants.',
    '- Repeated-event route layers and fatigue are more graduated: repeated-route speed contribution scales above 100 km/h instead of using a binary bonus, and route segment event-rate weights are now named internal approximations (`20` for any observed event and an additional `40` for a harsh classification), not collision-outcome calibrated coefficients. Fatigue is normalized on a 0-100 scale, its Safety conversion is explicitly provisional, and heatmaps use documented 30-second segments with a 20-segment minimum for display.',
    '- Recorded trip duration now excludes long background tracking gaps in both JavaScript and Android native statistics. Map playback progress is timestamp-based, with index-based progress retained only as a fallback when timestamps are unavailable. Empty playback maps no longer default to London; they use last map center, last parked location, privacy-zone context, device location, or deployment-configured coordinates.',
    '- Commute matching uses the named `COMMUTE_MATCH_RADIUS_M` 225 m threshold exposed in Advanced settings. Weekly coaching is a local rules-based summary, stays unavailable without valid scored distance, avoids duplicate metric advice, and only comments on score changes larger than 3 points. Best-window coaching requires at least three trips in a time bucket and shows the sample size.',
    '- Achievement notifications display up to six labels and keep every earned achievement ID in notification extras when a larger batch is condensed.',
    '- CO2 and fuel savings are treated as vehicle-backed estimates rather than exact facts. Carbon reports and achievements recalculate savings through the same assigned-vehicle economics source, label comparisons with confidence bands, show unavailable without assigned vehicle context, and avoid positive EV savings claims without known grid carbon intensity.',
    '- Score rings and aggregate score surfaces now use canonical score color and estimated-score formatting policy, including SVG stroke colors and score provenance, so score labels, fills, circular rings, reports, notifications, vehicle comparisons, maps, insights, and coaching surfaces share one display contract. They render developing internal evidence as "limited evidence" and omit high-evidence labels to reduce repetitive confidence copy.',
    '- Vehicle fuel/energy price validation now uses a currency-neutral 100-per-unit cap instead of a narrow 20-per-litre cap.',
    '- Android native tracking constants now name the 120-second stats gap, 2-minute Usage Access lookback, sustained-turn heading threshold, TTS speech rate, and 30-minute terminal idle cap; the stats loop uses one explicit duration guard and an else branch for moving vs idle time.',
    '- Test coverage now includes backend fallback, auth migration, backup schema migration and note truncation disclosure, settings import security, IndexedDB rename/provenance migrations, notifications, currency formatting, vehicle economy validation and empty-score handling, generated scoring-version checks, score-provenance and metric-registry behavior, human-verified scoring golden fixtures, local synthetic test-trip fixtures, OBD parsing, sensor fusion, lane-change scoring, shared JavaScript/Android trip-stat and noise-floor parity, shared time-risk boundaries, native/JS local-time night classification agreement, scoring consistency, privacy zones, route risk, tracking diagnostics, deterministic and opt-in live external service contract tests, core page render smoke tests, Playwright browser smoke navigation, Android native trip-store instrumentation, and release-blocker regressions.',
    '- CI runs stable unit/component, Playwright browser smoke, and Android emulator instrumentation checks on pushes and pull requests. Live Overpass, Open-Meteo, and OSRM checks are manual or weekly because they depend on public external services.',
    '- Repository hygiene now blocks machine-local Android SDK files from the tracked tree: `android/local.properties` remains ignored, is excluded from generated technical-reference scans, and is checked in CI with `npm run check:repo-hygiene`.',
    '',
    '## Documentation',
    '',
    'The production technical reference is [TECHNICAL_REFERENCE.md](TECHNICAL_REFERENCE.md). It is generated from the repository by `scripts/generate-technical-reference.mjs` and includes:',
    '',
    '- source/module inventory, import/export map, and function/method catalogue',
    '- actual calculation snippets for scoring, trip physics, playback, route risk, predictions, reports, imports/exports, and Android native tracking',
    '- grouped calculation index with file/line references',
    '- named constants, hard-coded values, and literal rationale for scoring and integration review',
    '- routes, optional REST/external calls, storage surfaces, security analysis, performance notes, test coverage, dependencies, and deployment notes',
    '',
    'Regenerate it after meaningful code or README changes:',
    '',
    '```bash',
    'node scripts/generate-technical-reference.mjs',
    '```',
    '',
    '## Architecture And Data',
    '',
    '- Package: `drivesense-app`',
    `- Version: \`${version}\``,
    '- Web stack: React 18, Vite 6, React Router, TanStack Query, Tailwind, Radix UI, Leaflet, Recharts, jsPDF, Vitest, ESLint',
    '- Native stack: Capacitor 8 Android shell plus custom Java services/plugins for activity recognition, background tracking, phone usage evidence, native IMU motion sampling, native downloads, notifications, quick settings tile, and SharedPreferences storage',
    '- Optional device evidence: Android Usage Access for confirmed phone use, Web Bluetooth OBD-II for speed/RPM/throttle/engine-load evidence where available, and browser/native motion sensors for IMU summaries, lane-changing confidence, and possible incident signals.',
    '- Primary storage: IndexedDB, localStorage, sessionStorage, Capacitor Preferences, Android SharedPreferences, native motion samples on trips, and native download files',
    '- Optional backend: set `VITE_API_URL`; when it is absent, trips and vehicles use local repositories',
    '- Local trip database: set `VITE_DB_NAME` to override the IndexedDB name. The default is `drivesense_mobile`; when the configured name changes, startup copies trips from the previously recorded database name and then removes the old database after count verification.',
    '- Optional external services: OpenStreetMap Overpass for speed limits, Open-Meteo for weather context, and trusted user-configured OSRM for route snapping after explicit consent. Set `VITE_OSRM_TIMEOUT_MS` to tune the build default OSRM timeout; users can override it in Settings from 5 to 30 seconds.',
    '',
    '## Privacy And Security Defaults',
    '',
    '- Trips, vehicles, settings, diagnostics, and reports stay local by default.',
    '- No ads are implemented. Calibration-label sharing is opt-in only; without that setting, survey feedback stays local and raw GPS, exact addresses, route polylines, personal identifiers, and trip notes are never included in calibration payloads.',
    '- OSRM route snapping is disabled until the user saves a trusted endpoint, consents to raw sampled GPS coordinate sharing, and requests road data. The public demo endpoint is rejected for saved settings.',
    '- Automatic road/weather context fetch is off by default; manual Get Road Data prompts before sending route context to external services.',
    '- Privacy zones mask route points and events around private places; backups do not restore private coordinates for privacy zones.',
    '- Imported backups and settings are treated as untrusted input, migrated from supported legacy schemas, sanitized before merge, and require confirmation before any note-truncating import completes.',
    '- Leaflet popup values from trips, routes, events, repeated driving-event areas, privacy zones, and parked locations are escaped before rendering as HTML.',
    '',
    '## Local Setup',
    '',
    'Optional environment configuration is documented in `.env.example`; local-first defaults work without a `.env` file.',
    '',
    '```bash',
    'npm install',
    'npm run dev',
    '```',
    '',
    'Build the web app:',
    '',
    '```bash',
    'npm run build',
    '```',
    '',
    'Run tests:',
    '',
    '```bash',
    'npm run test',
    '```',
    '',
    '`npm run build` regenerates `src/lib/scoringVersion.generated.js`; `npm run test` checks that the generated scoring version matches the scoring constants before running Vitest.',
    '',
    'Run browser smoke e2e tests:',
    '',
    '```bash',
    'npm run test:e2e',
    '```',
    '',
    'Run live external contract tests (hits Overpass, Open-Meteo, and OSRM):',
    '',
    '```bash',
    'npm run test:contracts:live',
    '```',
    '',
    '### Test Strategy',
    '',
    '- `npm run test` runs deterministic Vitest coverage for calculations, repositories, security safeguards, page rendering, and mocked Overpass/Open-Meteo/OSRM request-response contracts. The live external-service file is skipped in this fast default suite.',
    '- `npm run test:e2e` builds the app, starts a local preview server, and drives Chromium through core Dashboard, Settings, and Trips navigation flows.',
    '- `npm run test:contracts:live` makes real network requests to Open-Meteo forecast, Overpass interpreter, and the public OSRM matching endpoint to detect upstream response-contract changes.',
    '- Android instrumentation tests exercise native trip-store persistence and malformed-storage recovery; compile them with `android/gradlew.bat assembleDebugAndroidTest` and execute them on an emulator or device with `connectedDebugAndroidTest`.',
    '- CI runs deterministic tests, browser smoke e2e, and Android instrumentation on an emulator for pushes and pull requests. Live external checks run weekly or by manual dispatch because public service availability is outside the app release boundary.',
    '',
    'Run lint and type checking:',
    '',
    '```bash',
    'npm run lint',
    'npm run typecheck',
    '```',
    '',
    'Check repository hygiene before pushing machine-specific files:',
    '',
    '```bash',
    'npm run check:repo-hygiene',
    '```',
    '',
    '## Android Setup',
    '',
    'After changing web or native code, sync Capacitor:',
    '',
    '```bash',
    'npm run android:sync',
    '```',
    '',
    'Build the Android debug APK from the `android` directory:',
    '',
    '```bash',
    '.\\\\gradlew.bat assembleDebug',
    '```',
    '',
    '`android/local.properties` is generated locally by Android tooling and contains your Android SDK path. Keep it untracked; `android/.gitignore` ignores it and CI fails if it is ever committed.',
    '',
    'Android tracking needs Location, Background Location, Physical Activity, Notifications, and background tracking permissions. Disable or relax battery optimization for best background reliability.',
    '',
  ].join('\n');
}

fs.writeFileSync(path.join(ROOT, 'TECHNICAL_REFERENCE.md'), buildDoc(), 'utf8');
fs.writeFileSync(path.join(ROOT, 'README.md'), buildReadme(), 'utf8');

console.log(`Wrote TECHNICAL_REFERENCE.md and README.md`);
console.log(`Production calculations indexed: ${productionCalculations.length}`);
console.log(`Hard-coded literals indexed: ${literals.length}`);
