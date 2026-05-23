import fs from 'node:fs';
import path from 'node:path';
import { parse } from '@babel/parser';
import traverseModule from '@babel/traverse';

const traverse = traverseModule.default || traverseModule;
const ROOT = process.cwd();
const now = new Date().toISOString();

const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.gradle-home', '.codex-smoke', '.idea']);
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
const testFiles = sourceFiles.filter((file) => rel(file).includes('__tests__/') || rel(file).endsWith('.test.js') || rel(file).includes('/test/'));

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
  const left = code.match(/(?:const|let|var|static final|private static final)\s+([A-Z0-9_a-z]+)/)?.[1]
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
        row.type === 'inline URL'
          ? 'External service endpoint or help text; changing may redirect data or break integration.'
          : row.type === 'numeric literal'
            ? 'Threshold, scale, layout, ID, or test value; changing can alter scoring, UX, timing, or native behavior.'
            : row.type === 'boolean flag'
              ? 'Inline state/default flag; changing can flip behavior.'
              : 'Label, key, enum, event name, route, selector, or message; changing can break storage/API/UI contracts.',
      ]),
    ),
  )).join('\n\n');
}

function constantsRegistry() {
  const named = literals
    .filter((row) => /^[A-Z0-9_]+$/.test(row.semanticName) || /\bconst\b|\bstatic final\b/.test(row.code))
    .slice(0, 500)
    .map((row) => `/** Source: ${row.file}:${row.line}. */\nconst ${row.semanticName.toUpperCase()} = ${row.value};`);
  return codeBlock(named.join('\n'), 'js');
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
  return table(
    ['Variable', 'Type', 'Required', 'Default', 'Description', 'Used in'],
    env.map((row) => [
      row.variable,
      row.variable.startsWith('VITE_') ? 'Vite string' : 'Node string',
      row.variable === 'VITE_API_URL' ? 'No' : 'No',
      row.variable === 'VITE_API_URL' ? 'empty means local-first storage' : 'false/undefined unless set',
      row.variable === 'VITE_API_URL' ? 'Optional backend API base URL.' : 'Feature/debug/build-time switch.',
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

function topCalculationSnippets() {
  const snippets = [
    ['Trip scoring weights and final score', 'src/lib/tripEngine.js', 3925, 4135, 'js'],
    ['Eco score, cruise band, idle penalty', 'src/lib/tripEngine.js', 1253, 1325, 'js'],
    ['Map playback position interpolation', 'src/lib/mapPlaybackInsights.js', 248, 354, 'js'],
    ['Predictive route risk', 'src/lib/predictiveRouteRisk.js', 90, 170, 'js'],
    ['Pre-trip readiness risk', 'src/lib/preTripRisk.js', 118, 202, 'js'],
    ['Route risk segment index', 'src/lib/routeRiskIndex.js', 31, 108, 'js'],
    ['Phone-use risk construction', 'src/lib/phoneUsageAccess.js', 36, 119, 'js'],
    ['UBI report category scoring', 'src/lib/ubiReport.js', 1, 170, 'js'],
    ['Threshold calibration suggestions', 'src/lib/thresholdCalibration.js', 1, 135, 'js'],
    ['Android native distance and speed service math', 'android/app/src/main/java/com/drivesense/app/DriveSenseAutoTrackingService.java', 900, 1115, 'java'],
  ];
  return snippets.map(([title, file, start, end, lang]) => {
    const full = path.join(ROOT, file);
    if (!fs.existsSync(full)) return '';
    return `### ${title}\n\nSource: \`${file}:${start}-${end}\`\n\n${codeBlock(extractSnippet(file, start, end), lang)}`;
  }).filter(Boolean).join('\n\n');
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
  doc.push('> TECH DEBT: repository-wide - many calculation constants are inline in scoring/reporting files. The constants registry below identifies names that should be promoted into domain-level constants when the app is next refactored.');
  doc.push('');
  doc.push('---');

  doc.push('## System Overview');
  doc.push('');
  doc.push(table(
    ['Item', 'Value'],
    [
      ['Application', 'Road Sage (`drivesense-app`)'],
      ['Version', JSON.parse(read(path.join(ROOT, 'package.json'))).version],
      ['Purpose', 'Local-first driving tracker for trip recording, scoring, playback, reports, risk insights, coaching, backup/import, and Android background auto tracking.'],
      ['Architecture', 'React/Vite single-page app plus Capacitor Android shell and native background services. Domain logic is concentrated in `src/lib/*`, API adapters in `src/api/*`, UI in `src/pages/*` and `src/components/*`.'],
      ['Primary storage', 'IndexedDB/localStorage/sessionStorage/Capacitor Preferences/Android SharedPreferences.'],
      ['Optional backend', '`VITE_API_URL`; absent by default.'],
      ['Shared numeric clamp', '`src/lib/mathUtils.js` exports the canonical `clamp(value, min, max)` helper. Invalid numeric input returns `min`, preventing NaN from leaking through score, risk, report, and playback calculations.'],
      ['Predictive route risk window', '`estimatePredictiveRouteRisk` sorts completed trips newest-first by `startTime`/`start_time` before applying the recent-trip window, so callers do not need to pre-sort trip history.'],
      ['UI section recovery', '`src/components/SectionErrorBoundary.jsx` isolates calculation-heavy route maps, trip playback, Trip Detail score summaries, the Trip Detail page shell, and the Dashboard readiness/risk panel. Caught render errors are logged through `logError` and show a reloadable fallback instead of blanking the app.'],
      ['Handled operation failures', '`src/lib/errorReporting.js` exports `logError(context, error, extra)` for critical async failures. Post-trip notifications, achievement sync, odometer sync, and driver-signature persistence now write tracking diagnostics instead of disappearing behind bare catches.'],
    ],
  ));
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
  doc.push('The app contains many intentional literals: route labels, storage keys, feature flags, thresholds, scoring weights, UI labels, Android IDs, and test constants. They are grouped by file to keep the document readable.');
  doc.push('');
  doc.push(literalRegistry());
  doc.push('');
  doc.push('### Consolidated Constants Registry Draft');
  doc.push('');
  doc.push(constantsRegistry());
  doc.push('');
  doc.push('---');

  doc.push('## Data Models State And Storage');
  doc.push('');
  doc.push('Core persisted models are plain JSON trip, vehicle, settings, backup, diagnostic, route-risk-index, privacy-zone, and Android native event records. There is no ORM schema in this repo; IndexedDB schema creation lives in `src/lib/localTripRepository.js`, local/mobile storage helpers live in `src/lib/mobileStorage.js` and `src/lib/trackingStore.js`, and Android SharedPreferences records live in `DriveSenseNativeTripStore.java` and `DriveSenseAutoTrackingService.java`.');
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
  doc.push('- Leaflet popups: route labels, event metadata, speed-limit road/source data, route-risk segments, danger zones, privacy labels, and parked addresses are HTML-escaped before insertion into popup template strings.');
  doc.push('- External data sharing: Overpass gets route-area boxes, Open-Meteo gets midpoint/date, and OSRM receives sampled GPS points only when route snapping is explicitly enabled and requested.');
  doc.push('- Secrets: no secrets are checked into this repo by the scanner; `VITE_API_URL` is configuration, not a secret.');
  doc.push('- Main residual risks: inline constants make scoring policy harder to review; optional backend API security is outside this repo; user-provided OSRM endpoint can redirect sampled route points by design.');
  doc.push('');
  doc.push('---');

  doc.push('## Performance Characteristics');
  doc.push('');
  doc.push('- Critical loops: trip stats, trip scoring, night detection, fatigue progression, and route playback are O(n) over route points; route-risk index creation is O(trips x route segments x events proximity checks) candidate; import/export and full-history reports are O(number of local records).');
  doc.push('- Long-trip scoring has a regression budget: a synthetic 2,000-point trip must complete stats plus score calculation in under 500 ms in the trip engine test suite.');
  doc.push('- Frontend bundle splitting: `vite.config.js` manually chunks React, charts, html2canvas, jsPDF, and Capacitor vendors.');
  doc.push('- Map rendering: `prepareMapRoutePoints`, `downsampleRoutePoints`, route smoothing, and privacy masking constrain heavy routes before Leaflet/SVG playback rendering.');
  doc.push('- Render fault isolation: TripMap, TripPlayback, the Trip Detail score overview, the Trip Detail page shell, and the Dashboard readiness/risk panel are wrapped with `SectionErrorBoundary` so malformed trip data can fail one section with a reload prompt instead of unmounting the full app tree.');
  doc.push('- Native background tracking: Android service filters noisy points and stores compact event/trip records, reducing JS wakeups.');
  doc.push('- Bottleneck candidates are visible in the calculation index: repeated `sort`, `map`, `filter`, route-window scans, and report aggregation loops.');
  doc.push('');
  doc.push('---');

  doc.push('## Testing Coverage Map');
  doc.push('');
  doc.push(testCoverage());
  doc.push('');
  doc.push('Coverage gaps inferred from source shape: no browser e2e suite for the full route workflow, no real-device Android instrumentation assertions beyond generated examples, and no live external API contract tests for Overpass/Open-Meteo/OSRM.');
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
  doc.push('- Android sync: `npm run android:sync` builds web assets and runs Capacitor sync.');
  doc.push('- Android debug build: run `android/gradlew.bat assembleDebug` from the repository root or Android directory as configured.');
  doc.push('- CI/CD: `.github/workflows/security-ci.yml` installs dependencies, audits packages, blocks forbidden source imports, runs repository hygiene checks, tests, builds, and scans the production bundle for localhost API fallback.');
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
    '- Trip scoring for safety, smoothness, eco driving, phone-use distraction, speed compliance, road-type segments, reaction proxy, cornering, braking efficiency, overtake quality, tailgating, fatigue, drowsy risk, slippery-condition proxy, and route risk.',
    '- Map playback with route simplification, stop handling, privacy-masked coordinate handling, HTML-escaped Leaflet popups, speed-limit coloring, fatigue overlays, event markers, and repeated-route comparison support.',
    '- Vehicle profiles with fuel/electric economy, odometer estimates, maintenance reminders, renewal tracking, localized per-car cost, CO2, and engine-health summaries, default vehicle handling, and vehicle comparison.',
    '- Reports with CSV export, monthly PDF export, UBI score-card PDF export, rolling baseline comparison, carbon impact, configurable-currency fuel cost, and CO2 savings.',
    '- Full backup export/import for trips, GPS route points, events, vehicles, settings, privacy-zone metadata, saved filters, and reviewed event feedback.',
    '- Diagnostics capture unhandled app errors, handled critical operation failures, and isolated React section crashes with sanitized messages and stack previews.',
    '',
    '## Recent Update Coverage',
    '',
    'The markdown is regenerated from the current source tree and reflects the latest vehicle-health, tracking, scoring, privacy, storage, and documentation behavior.',
    '',
    '- Documentation was converted into a source-generated technical reference with module inventory, imports/exports, function catalogue, calculation snippets, constants, storage, routes, error handling, tests, dependencies, and deployment notes.',
    '- Calculation-heavy UI is isolated with `SectionErrorBoundary`: TripMap, TripPlayback, the Trip Detail score summary, the Trip Detail page shell, and the Dashboard readiness/risk panel now show a friendly reloadable fallback and log the caught error instead of blanking the whole app.',
    '- Critical post-trip and persistence operations now log handled failures through `logError`: completed-trip notifications, phone-use pattern alerts, style-shift alerts, achievement notification sync, daily fatigue warnings, vehicle odometer sync, and driver-signature saves all write diagnostic events instead of being silently swallowed.',
    '- Vehicle odometer sync still retries on the next vehicle/trip refresh, and repeated failures in a session show a non-blocking toast so stale odometer estimates are visible without blocking the Vehicles page.',
    '- Numeric clamping is centralized in `src/lib/mathUtils.js`; score, route-risk, fatigue, weather, report, playback, calibration, and import sanitization paths now share the same NaN-safe boundary behavior.',
    '- Scoring was stabilized around explicit defaults: noisy-signal filtering, rate-normalized scoring, traffic-stop grace periods, privacy-masked coordinate exclusion, stable phone-use merges, finite anomaly/sensor scores, and reviewed-event rescoring.',
    '- Trip-stat hot paths now stay linear over route points: sunset night driving windows are cached once per trip date, speed-zone windows use sliding summaries, drowsy detection uses a moving window, and fatigue progression uses direct segment scoring instead of recursively rescoring three sub-trips.',
    '- Eco driving scoring now exposes cruise-band, moving-speed floor, cruise-score multiplier, idle-penalty multiplier, and idle-penalty cap settings, and returns `idle_penalty_points` for diagnostics and tests.',
    '- Phone-use Safety impact messaging now uses the exported `PHONE_USE_SAFETY_WEIGHT` scorer constant, so Trip Detail explanations stay aligned with the actual Safety score blend.',
    '- Predictive route risk now sorts completed trips newest-first inside the estimator before applying the recent-trip window, so dashboard and map pre-trip risk stay based on fresh history even when callers pass unsorted trip arrays.',
    '- Vehicle engine-health summaries now average only finite stored engine stress scores. Trips without a usable score are excluded, and vehicles with no scored samples show `N/A` instead of a misleading maximum-stress fallback.',
    '- Currency and economics baselines are configurable in Settings, including cost symbol, average vehicle CO2 per 100 km, EV kWh per 100 km, grid CO2 intensity, and tree-year equivalents. Vehicle fuel type is used for trip CO2 and savings estimates, and vehicle fuel/energy price validation now allows values up to 20 per litre or kWh for high-price markets.',
    '- Backup import is hardened: files larger than 50 MB are rejected from the Settings file picker before the JSON body is read, malformed or non-backup JSON gets clear errors, trips/settings are sanitized, unknown fields are stripped, prototype-pollution keys are ignored, route/event arrays are capped, unsafe thresholds are clamped, imported OSRM endpoints are stripped, and imported background auto tracking requires in-app consent.',
    '- Local trip storage uses IndexedDB when available, with a migration runner and localStorage fallback. Trip schema versioning triggers rescoring for completed trips when scoring, phone-use, map, or privacy behavior changes.',
    '- API behavior is local-first by default. Trips and vehicles use local repositories when `VITE_API_URL` is absent or the app is running natively; configured backends fail clearly instead of silently falling back to localhost.',
    '- Auth tokens are session-scoped. Legacy `localStorage` tokens are migrated into `sessionStorage` and removed, and logout clears both token names from browser storage.',
    '- Open road context is explicit and privacy-aware. OpenStreetMap speed limits and Open-Meteo weather are manual by default unless automatic context fetch is enabled. OSRM route snapping is opt-in, disabled without a configured endpoint, and the public demo requires confirmation because sampled GPS points leave the device.',
    '- Settings now explains tracking, Android permissions, privacy, notifications, speed warnings, currency/economics, advanced models, and data controls with searchable sections and safer validation.',
    '- Android tracking updates include immediate native notification state, quick settings tile sync, clearer off/paused handling, deduplicated trip/safety notifications, battery optimization guidance, phone usage access support, and native diagnostics surfaced in the app.',
    '- Privacy-zone and map fixes keep private locations masked, allow radius editing, hide private events, exclude masked null coordinates from distance/playback math, HTML-escape user/external values in Leaflet popups, and preserve original GPS geometry when route snapping or old map-matching data would collapse playback.',
    '- Test coverage now includes backend fallback, auth migration, backup import security, settings import security, IndexedDB migrations, UBI mileage windows, notifications, currency formatting, vehicle fuel-price validation, scoring consistency, privacy zones, OSRM opt-in behavior, route risk, tracking diagnostics, section error boundaries, and release-blocker regressions.',
    '- Repository hygiene now blocks machine-local Android SDK files from the tracked tree: `android/local.properties` remains ignored, is excluded from generated technical-reference scans, and is checked in CI with `npm run check:repo-hygiene`.',
    '',
    '## Documentation',
    '',
    'The production technical reference is [TECHNICAL_REFERENCE.md](TECHNICAL_REFERENCE.md). It is generated from the repository by `scripts/generate-technical-reference.mjs` and includes:',
    '',
    '- source/module inventory, import/export map, and function/method catalogue',
    '- actual calculation snippets for scoring, trip physics, playback, route risk, predictions, reports, imports/exports, and Android native tracking',
    '- grouped calculation index with file/line references',
    '- hard-coded values and a constants-registry draft',
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
    '- Native stack: Capacitor 8 Android shell plus custom Java services/plugins for activity recognition, background tracking, phone usage evidence, native downloads, notifications, quick settings tile, and SharedPreferences storage',
    '- Primary storage: IndexedDB, localStorage, sessionStorage, Capacitor Preferences, Android SharedPreferences, and native download files',
    '- Optional backend: set `VITE_API_URL`; when it is absent, trips and vehicles use local repositories',
    '- Optional external services: OpenStreetMap Overpass for speed limits, Open-Meteo for weather context, and user-configured OSRM for route snapping',
    '',
    '## Privacy And Security Defaults',
    '',
    '- Trips, vehicles, settings, diagnostics, and reports stay local by default.',
    '- No ads, analytics, or automatic trip upload are implemented in this repository.',
    '- OSRM route snapping is disabled until the user enables it and provides or confirms an endpoint.',
    '- Automatic road/weather context fetch is off by default; manual Get Road Data prompts before sending route context to external services.',
    '- Privacy zones mask route points and events around private places; backups do not restore private coordinates for privacy zones.',
    '- Imported backups and settings are treated as untrusted input and sanitized before merge.',
    '- Leaflet popup values from trips, routes, events, danger zones, privacy zones, and parked locations are escaped before rendering as HTML.',
    '',
    '## Local Setup',
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
