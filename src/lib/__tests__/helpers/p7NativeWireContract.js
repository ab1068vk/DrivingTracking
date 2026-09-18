/**
 * The **real** native wire contract, read out of the Java sources.
 *
 * P7-IMPL-F05. A hand-written bridge double is only as good as the author's
 * memory of the Java, and the delivered one was wrong in five places at once:
 * it answered `tripCount` where the repository emits `liveCount`, accepted
 * `limit` where the repository reads `maxBuckets`, returned `items` where the
 * plugin returns `recent`, and handed the reducers projection fields the real
 * page path never copied. Every one of those passed a green parity suite,
 * because the double and the facade agreed with each other and neither agreed
 * with Android.
 *
 * So the contract is not written here — it is **extracted** from
 * `DriveSenseArchivePlugin.java` and `DriveSenseTripArchiveRepository.java`.
 * For each bridged method it reports:
 *
 *   - `args`: the request keys the Java actually reads;
 *   - `results`: the response keys the Java actually emits.
 *
 * A double built on this cannot silently drift, and a facade that sends an
 * argument nobody reads or reads a key nobody emits fails a test rather than a
 * device. This is a **static** contract check plus a contract-checked
 * behavioural double: it does not execute Dalvik, and it is not claimed to.
 * The seam it cannot cross is documented in `p7NativeWireContract.test.js`.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SRC_ROOT } from './p7ReleaseAudit.js';

const ANDROID_ROOT = path.resolve(
  SRC_ROOT, '..', 'android', 'app', 'src', 'main', 'java', 'com', 'drivesense', 'app'
);

const readJava = (name) => readFileSync(path.join(ANDROID_ROOT, name), 'utf8');

/** The `{...}` body that starts at the first `{` at or after `from`. */
const bodyFrom = (text, from) => {
  const open = text.indexOf('{', from);
  if (open < 0) return '';
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    if (text[index] === '{') depth += 1;
    else if (text[index] === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return text.slice(open + 1);
};

/** The body of `@PluginMethod public void NAME(PluginCall call)`. */
const pluginMethodBody = (source, name) => {
  const at = source.indexOf(`public void ${name}(PluginCall call)`);
  if (at < 0) throw new Error(`Plugin method ${name} not found`);
  return bodyFrom(source, at);
};

/** The body of a package-private `JSONObject NAME(...)` on the repository. */
const repositoryMethodBody = (source, name) => {
  const match = new RegExp(`JSONObject ${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`Repository method ${name} not found`);
  return bodyFrom(source, match.index);
};

const matchAll = (text, pattern) => {
  const found = new Set();
  let match = pattern.exec(text);
  while (match) {
    found.add(match[1]);
    match = pattern.exec(text);
  }
  pattern.lastIndex = 0;
  return found;
};

/** Request keys a Java body reads, through either the call or a JSONObject. */
const argsRead = (body) => new Set([
  ...matchAll(body, /call\.get(?:String|Int|Long|Boolean|Array|Object|Float|Double)\s*\(\s*"([^"]+)"/g),
  ...matchAll(body, /longArg\s*\(\s*call\s*,\s*"([^"]+)"/g),
  ...matchAll(body, /request\.(?:opt|get)(?:String|Int|Long|Boolean|Double|JSONArray|JSONObject)?\s*\(\s*"([^"]+)"/g),
  ...matchAll(body, /request\.(?:has|isNull)\s*\(\s*"([^"]+)"/g),
]);

/** Response keys a Java body emits. */
const resultsWritten = (body) => matchAll(
  body, /\b(?:out|o|response|result|next|request)\.put\s*\(\s*"([^"]+)"/g
);

/**
 * The bridged methods this facade uses, and where each one's contract lives.
 *
 * `repository` is the repository method the plugin delegates to, when it passes
 * `call.getData()` straight through — then the arguments the plugin never names
 * are the ones the repository reads.
 */
const BRIDGED = Object.freeze({
  // Health is assembled in its own class, so that is where its keys live.
  getHealth: { repository: null, delegates: [], externals: ['DriveSenseArchiveHealth.java'] },
  queryHistoryPage: { repository: 'queryHistoryPage', delegates: [] },
  // `aggregates` builds its whole response in one shared helper, so the result
  // keys are that helper's, not the query method's.
  getTripAggregates: { repository: 'aggregates', delegates: ['aggregateObject'] },
  getTripChartBuckets: { repository: 'chartBuckets', delegates: [] },
  queryAdjacentTrip: { repository: null, delegates: [] },
  getTripTagContext: { repository: null, delegates: [] },
  getTripOverviewTrack: { repository: null, delegates: [] },
});

/** The body of a `private`/`static` helper returning a JSONObject. */
const helperBody = (source, name) => {
  const match = new RegExp(`JSONObject ${name}\\s*\\(`).exec(source);
  if (!match) throw new Error(`Helper ${name} not found`);
  return bodyFrom(source, match.index);
};

/**
 * The extracted contract for one bridged method.
 *
 * @param {string} method the `@PluginMethod` name
 * @returns {{args: Set<string>, results: Set<string>}}
 */
export function nativeMethodContract(method) {
  const entry = BRIDGED[method];
  if (!entry) throw new Error(`${method} is not a bridged P7 method`);
  const plugin = readJava('DriveSenseArchivePlugin.java');
  const repository = readJava('DriveSenseTripArchiveRepository.java');
  const pluginBody = pluginMethodBody(plugin, method);
  const repositoryBody = entry.repository ? repositoryMethodBody(repository, entry.repository) : '';
  const delegated = (entry.delegates ?? []).map((name) => helperBody(repository, name));
  const external = (entry.externals ?? []).map((file) => readJava(file));
  return {
    args: new Set([...argsRead(pluginBody), ...argsRead(repositoryBody)]),
    results: new Set([
      ...resultsWritten(pluginBody),
      ...resultsWritten(repositoryBody),
      ...delegated.flatMap((body) => [...resultsWritten(body)]),
      ...external.flatMap((body) => [
        ...matchAll(body, /\b(?:result|catalog|value|integrity|speed)\.put\s*\(\s*"([^"]+)"/g),
      ]),
      // Every plugin response is stamped by `execute(...)` before it resolves.
      'responseBytes', 'maxBytes',
    ]),
  };
}

/**
 * The keys one **row** of a native page carries.
 *
 * Two sources and no others: the plaintext columns `metadataFromCursor` copies
 * out of the page `SELECT`, and the display-metadata fields the page path
 * allowlists. Anything a double adds beyond these is a field Android does not
 * send, which is precisely how the reducers' missing inputs stayed hidden.
 */
export function nativePageRowKeys() {
  const repository = readJava('DriveSenseTripArchiveRepository.java');
  const cursorBody = helperBody(repository, 'metadataFromCursor');
  return new Set([
    ...matchAll(cursorBody, /o\.put\s*\(\s*"([^"]+)"/g),
    ...nativePageProjectionFields(),
  ]);
}

/** Every bridged method name this contract covers. */
export const BRIDGED_METHODS = Object.freeze(Object.keys(BRIDGED));

/**
 * The page-row projection field list the Java page path actually copies.
 *
 * Read out of `PAGE_PROJECTION_FIELDS` so the JavaScript owner of that set and
 * the Java mirror of it cannot drift apart unnoticed.
 */
export function nativePageProjectionFields() {
  const repository = readJava('DriveSenseTripArchiveRepository.java');
  const match = /static final String\[\] PAGE_PROJECTION_FIELDS=\{([^}]*)\};/.exec(repository);
  if (!match) throw new Error('PAGE_PROJECTION_FIELDS not found in the repository');
  return match[1].split(',').map((entry) => entry.trim().replace(/^"|"$/g, '')).filter(Boolean);
}

/** The plaintext columns the page `SELECT` returns, before enrichment. */
export function nativePageSelectColumns() {
  const repository = readJava('DriveSenseTripArchiveRepository.java');
  const body = repositoryMethodBody(repository, 'queryHistoryPage');
  const match = /SELECT ([a-z_,]+) FROM trip_current/.exec(body);
  if (!match) throw new Error('The page SELECT was not found');
  return match[1].split(',').map((column) => column.trim());
}

/**
 * Wrap a bridge double so it can only speak the extracted contract.
 *
 * Sending an argument the Java never reads, or answering with a key the Java
 * never emits, throws here — which is the whole point: the double is no longer
 * free to agree with the facade about something Android does not do.
 *
 * @param {Record<string, Function>} methods the double, keyed by plugin method
 * @param {{allowArgs?: Record<string, string[]>}} [options]
 */
export function contractChecked(methods, options = {}) {
  const wrapped = {};
  for (const [method, implementation] of Object.entries(methods)) {
    const contract = nativeMethodContract(method);
    const extraArgs = new Set(options.allowArgs?.[method] ?? []);
    wrapped[method] = async (request = {}) => {
      for (const key of Object.keys(request ?? {})) {
        if (!contract.args.has(key) && !extraArgs.has(key)) {
          throw new Error(`${method} was sent "${key}", which the Java never reads`);
        }
      }
      const answer = await implementation(request);
      if (answer && typeof answer === 'object' && !Array.isArray(answer)) {
        for (const key of Object.keys(answer)) {
          if (!contract.results.has(key)) {
            throw new Error(`${method} answered "${key}", which the Java never emits`);
          }
        }
      }
      return answer;
    };
  }
  return wrapped;
}
