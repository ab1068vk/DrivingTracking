import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const OUTPUT_RELATIVE = 'docs/ANDROID_SECURITY_REFERENCE.md';
const OUTPUT_PATH = path.join(ROOT, OUTPUT_RELATIVE);
const CHECK = process.argv.includes('--check');

function read(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

function readJson(relativePath) {
  return JSON.parse(read(relativePath));
}

function match(source, pattern, label) {
  const result = source.match(pattern);
  if (!result) throw new Error(`Could not read ${label}.`);
  return result[1];
}

function constNumber(source, name, label = name) {
  return match(source, new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*([0-9_]+)`), label).replaceAll('_', '');
}

function constBoolean(source, name, label = name) {
  return match(source, new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=\\s*(true|false)`), label);
}

function objectString(source, key, label = key) {
  return match(source, new RegExp(`${key}:\\s*['"]([^'"]+)['"]`), label);
}

function markdownTable(rows) {
  return rows.map((row) => `| ${row.map((cell) => String(cell ?? '').replace(/\|/g, '\\|')).join(' | ')} |`).join('\n');
}

function codeBlock(language, code) {
  return `\`\`\`${language}\n${code.trim()}\n\`\`\``;
}

function sourceLink(relativePath) {
  return `\`${relativePath}\``;
}

function lineExcerpt(relativePath, startPattern, {
  endPattern = null,
  includeEnd = true,
  maxLines = 80,
  before = 0,
  after = 0,
} = {}) {
  const lines = read(relativePath).split('\n');
  const startIndex = lines.findIndex((line) => startPattern.test(line));
  if (startIndex === -1) throw new Error(`Could not find ${startPattern} in ${relativePath}.`);
  let first = Math.max(0, startIndex - before);
  let last = Math.min(lines.length - 1, startIndex + maxLines - 1);
  if (endPattern) {
    const endIndex = lines.findIndex((line, index) => index >= startIndex && endPattern.test(line));
    if (endIndex !== -1) {
      last = includeEnd ? endIndex : Math.max(startIndex, endIndex - 1);
    }
  }
  last = Math.min(lines.length - 1, last + after);
  first = Math.min(first, last);
  return lines.slice(first, last + 1).join('\n');
}

function compactSnippet(relativePath, pattern, contextLines = 4) {
  const lines = read(relativePath).split('\n');
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) throw new Error(`Could not find ${pattern} in ${relativePath}.`);
  const first = Math.max(0, index - contextLines);
  const last = Math.min(lines.length - 1, index + contextLines);
  return lines.slice(first, last + 1).join('\n');
}

function indexFromLine(source, lineIndex) {
  let index = 0;
  for (let i = 0; i < lineIndex; i += 1) index += source.indexOf('\n', index) - index + 1;
  return index;
}

function braceBlock(relativePath, startPattern, { maxChars = 24000 } = {}) {
  const source = read(relativePath);
  const lines = source.split('\n');
  const lineIndex = lines.findIndex((line) => startPattern.test(line));
  if (lineIndex === -1) throw new Error(`Could not find ${startPattern} in ${relativePath}.`);
  const startIndex = indexFromLine(source, lineIndex);
  const firstLineEnd = source.indexOf('\n', startIndex);
  const lineEnd = firstLineEnd === -1 ? source.length : firstLineEnd;
  let openIndex = -1;
  for (let index = startIndex; index < lineEnd; index += 1) {
    if (source[index] === '{') openIndex = index;
  }
  if (openIndex === -1) openIndex = source.indexOf('{', startIndex);
  if (openIndex === -1 || openIndex - startIndex > maxChars) {
    throw new Error(`Could not find opening brace for ${startPattern} in ${relativePath}.`);
  }

  let depth = 0;
  let quote = '';
  let lineComment = false;
  let blockComment = false;
  for (let index = openIndex; index < Math.min(source.length, openIndex + maxChars); index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (char === '\\') {
        index += 1;
        continue;
      }
      if (char === quote) quote = '';
      continue;
    }

    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        const endLineIndex = source.indexOf('\n', index);
        const endIndex = endLineIndex === -1 ? index + 1 : endLineIndex;
        return source.slice(startIndex, endIndex).trimEnd();
      }
    }
  }
  throw new Error(`Could not find closing brace for ${startPattern} in ${relativePath}.`);
}

function settingsDefault(settingsSource, key) {
  const defaults = match(settingsSource, /export const DEFAULT_SETTINGS = \{([\s\S]*?)\n\};/, 'DEFAULT_SETTINGS');
  const value = match(defaults, new RegExp(`${key}:\\s*([^,\\n]+)`), `DEFAULT_SETTINGS.${key}`);
  return value.trim();
}

function gradleDependency(gradleSource, artifact) {
  return match(
    gradleSource,
    new RegExp(`implementation\\s+["']([^"']*${artifact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"']*)["']`),
    `Gradle dependency ${artifact}`
  );
}

function manifestApplicationAttrs(manifestSource) {
  const tag = match(manifestSource, /<application\s+([\s\S]*?)>/, 'manifest application tag');
  return [...tag.matchAll(/android:([a-zA-Z0-9_]+)="([^"]+)"/g)]
    .map(([, attr, value]) => [attr, `\`${value}\``]);
}

function manifestPermissions(manifestSource) {
  return [...manifestSource.matchAll(/<uses-permission[\s\S]*?android:name="([^"]+)"([\s\S]*?)\/>/g)]
    .map(([, name, rest]) => [
      `\`${name}\``,
      rest.includes('maxSdkVersion')
        ? `maxSdk ${match(rest, /android:maxSdkVersion="([^"]+)"/, `${name} maxSdkVersion`)}`
        : rest.includes('ProtectedPermissions')
          ? 'protected permission'
          : rest.includes('neverForLocation')
            ? 'neverForLocation'
            : 'normal declaration',
    ]);
}

function manifestComponents(manifestSource) {
  return [...manifestSource.matchAll(/<(activity|service|receiver|provider)\s+([\s\S]*?)>/g)]
    .map(([, kind, attrs]) => {
      const name = attrs.match(/android:name="([^"]+)"/)?.[1] || '(unnamed)';
      const exported = attrs.match(/android:exported="([^"]+)"/)?.[1] || '(not explicit)';
      const permission = attrs.match(/android:permission="([^"]+)"/)?.[1] || '';
      return [`\`${kind}\``, `\`${name}\``, `\`${exported}\``, permission ? `\`${permission}\`` : ''];
    });
}

function networkPinRows(networkSource) {
  const uncommented = networkSource.replace(/<!--[\s\S]*?-->/g, '');
  return [...uncommented.matchAll(/<domain-config[\s\S]*?<domain includeSubdomains="([^"]+)">([^<]+)<\/domain>[\s\S]*?<pin-set expiration="([^"]+)">([\s\S]*?)<\/pin-set>/g)]
    .map(([, includeSubdomains, domain, expiration, pins]) => [
      `\`${domain}\``,
      `\`${includeSubdomains}\``,
      `\`${expiration}\``,
      `${[...pins.matchAll(/<pin digest="SHA-256">/g)].length} SHA-256 SPKI pins`,
    ]);
}

function cspFromVite() {
  return braceBlock('scripts/content-security-policy.mjs', /export function buildContentSecurityPolicy/);
}

const packageJson = readJson('package.json');
const capacitorConfig = read('capacitor.config.ts');
const manifestSource = read('android/app/src/main/AndroidManifest.xml');
const gradleSource = read('android/app/build.gradle');
const constantsSource = read('src/lib/appConstants.js');
const settingsSource = read('src/lib/trackingStore.js');
const backupSource = read('src/lib/dataBackup.js');
const backupEncryptionSource = read('src/lib/backupEncryption.js');
const networkSource = read('android/app/src/main/res/xml/network_security_config.xml');

const appId = objectString(capacitorConfig, 'appId', 'Capacitor appId');
const appName = objectString(capacitorConfig, 'appName', 'Capacitor appName');
const versionCode = match(gradleSource, /versionCode\s*=\s*([0-9]+)/, 'Android versionCode');
const minSdk = match(read('android/variables.gradle'), /minSdkVersion\s*=\s*([0-9]+)/, 'minSdkVersion');
const targetSdk = match(read('android/variables.gradle'), /targetSdkVersion\s*=\s*([0-9]+)/, 'targetSdkVersion');
const compileSdk = match(read('android/variables.gradle'), /compileSdkVersion\s*=\s*([0-9]+)/, 'compileSdkVersion');
const biometricDefault = settingsDefault(settingsSource, 'biometric_lock_enabled');
const lockTimeoutDefault = settingsDefault(settingsSource, 'lock_timeout_minutes');
const lockTimeoutMin = constNumber(constantsSource, 'BIOMETRIC_LOCK_TIMEOUT_MIN_MINUTES');
const lockTimeoutMax = constNumber(constantsSource, 'BIOMETRIC_LOCK_TIMEOUT_MAX_MINUTES');
const authTimeoutMs = constNumber(constantsSource, 'BIOMETRIC_AUTH_TIMEOUT_MS');
const backupVersion = constNumber(backupSource, 'BACKUP_VERSION');
const backupEncryptionVersion = constNumber(backupEncryptionSource, 'BACKUP_ENC_VERSION');
const backupPasswordMin = constNumber(backupEncryptionSource, 'BACKUP_PASSWORD_MIN_LENGTH');
const backupPasswordMax = constNumber(backupEncryptionSource, 'BACKUP_PASSWORD_MAX_LENGTH');
const backupPbkdf2Iterations = constNumber(backupEncryptionSource, 'BACKUP_PBKDF2_ITERATIONS');
const biometricDefaultEnabled = constBoolean(constantsSource, 'BIOMETRIC_LOCK_DEFAULT_ENABLED');
const hasBiometricPermission = /android\.permission\.(USE_BIOMETRIC|USE_FINGERPRINT)/.test(manifestSource);

const content = `# Road Sage Android Security Reference

This file is generated by \`scripts/generate-android-security-docs.mjs\`. Do not edit it by hand.

Use this as an AI handoff when a bug might be caused by Android security, settings persistence, fingerprint/app-lock behavior, encrypted storage, network hardening, backup/import rules, permissions, or runtime integrity.

## Update Contract

| Command | Purpose |
| --- | --- |
| \`npm run docs:android-security\` | Regenerates this file from current source code. |
| \`npm run docs:android-security:check\` | Fails when this file is stale. |
| \`npm run build\` | Refreshes this file through \`prebuild\`. |
| \`npm run test\` | Checks this file through \`pretest\`. |

Any future Android/security code change should be reflected here by rerunning the generator. If the check fails, regenerate the doc and review the diff before giving this file to another AI.

## Current Identity

| Field | Current value | Source |
| --- | --- | --- |
| App name | \`${appName}\` | \`capacitor.config.ts\` |
| Package | \`${packageJson.name}\` | \`package.json\` |
| App version | \`${packageJson.version}\` | \`package.json\` |
| Capacitor app id | \`${appId}\` | \`capacitor.config.ts\` |
| Android application id | \`com.roadsage.app\` | \`android/app/build.gradle\` |
| Android versionCode | \`${versionCode}\` | \`android/app/build.gradle\` |
| Android SDKs | min \`${minSdk}\`, target \`${targetSdk}\`, compile \`${compileSdk}\` | \`android/variables.gradle\` |

## Security Surfaces

| Surface | What to check first |
| --- | --- |
| App lock / fingerprint | Device credential availability, \`BiometricGatePlugin\`, \`BiometricRouteGuard\`, \`biometric_lock_enabled\`, \`lock_timeout_minutes\`. |
| Settings persistence | \`localSettings.setAsync\`, native settings sync, encrypted preferences, hydration candidate choice, settings revision metadata. |
| Encrypted storage | Android Keystore aliases, \`EncryptedSharedPreferences\`, synchronous \`commit()\`, recovery/wipe behavior. |
| Network behavior | Local-only mode, endpoint trust, network security config, CSP, certificate pins, cleartext blocking. |
| Backup/import | Encrypted \`.rsbackup\`, import sanitizers, stripped consent/trust fields, disabled Android Auto Backup. |
| Native tracking | Runtime integrity suspension, permissions, native setting consumers, foreground service declarations. |
| WebView safety | \`FLAG_SECURE\`, file/content access disabled, geolocation disabled, mixed content blocked, security headers. |

## Android Manifest

Application security attributes:

| Attribute | Value |
| --- | --- |
${markdownTable(manifestApplicationAttrs(manifestSource))}

Exported components and permission gates:

| Kind | Name | Exported | Permission |
| --- | --- | --- | --- |
${markdownTable(manifestComponents(manifestSource))}

Declared Android permissions:

| Permission | Note |
| --- | --- |
${markdownTable(manifestPermissions(manifestSource))}

Fingerprint permission declaration: \`${hasBiometricPermission ? 'present' : 'not present'}\`.

That is expected for the current implementation because Road Sage uses Android's device-credential confirmation intent and only uses AndroidX Biometric APIs for availability checks.

${codeBlock('xml', lineExcerpt('android/app/src/main/AndroidManifest.xml', /<application/, {
  endPattern: /android:theme="@style\/AppTheme">/,
  maxLines: 16,
}))}

## Native Plugin Allowlist And Screen Capture

Road Sage registers only the expected app-owned Capacitor plugins. If a security bug appears after plugin refactoring, verify this list before debugging React state.

${codeBlock('java', lineExcerpt('android/app/src/main/java/com/roadsage/app/MainActivity.java', /ROAD_SAGE_PLUGIN_ALLOWLIST/, {
  endPattern: /\);/,
  maxLines: 16,
}))}

\`FLAG_SECURE\` is set before \`super.onCreate(...)\`, so Android recent-app previews and ordinary screenshots should not expose Road Sage screens.

${codeBlock('java', compactSnippet('android/app/src/main/java/com/roadsage/app/MainActivity.java', /WindowManager\.LayoutParams\.FLAG_SECURE/, 4))}

## WebView Hardening And CSP

Capacitor WebView hardening disables file/content URI access, WebView geolocation, saved form/password data, persistent cache use, mixed content, and third-party cookies.

${codeBlock('java', braceBlock('android/app/src/main/java/com/roadsage/app/MainActivity.java', /private void hardenWebView/))}

Security headers are injected into local WebView responses:

${codeBlock('java', braceBlock('android/app/src/main/java/com/roadsage/app/MainActivity.java', /private Map<String, String> securityHeaders/))}

MainActivity CSP:

${codeBlock('java', braceBlock('android/app/src/main/java/com/roadsage/app/MainActivity.java', /private String buildCsp/))}

Vite HTML/dev-server CSP source:

${codeBlock('js', cspFromVite())}

## Deep Link Guard

Road Sage accepts only explicit safe app paths and small allowlisted query values. Unsafe launch intents are stripped or rejected before Capacitor sees them.

${codeBlock('java', lineExcerpt('android/app/src/main/java/com/roadsage/app/MainActivity.java', /SAFE_QUERY_KEYS/, {
  endPattern: /ALLOWED_DEEP_LINK_PATHS/,
  includeEnd: false,
  maxLines: 8,
}))}

${codeBlock('java', lineExcerpt('android/app/src/main/java/com/roadsage/app/MainActivity.java', /ALLOWED_DEEP_LINK_PATHS/, {
  endPattern: /\)\);/,
  maxLines: 18,
}))}

${codeBlock('java', braceBlock('android/app/src/main/java/com/roadsage/app/MainActivity.java', /private static boolean isAllowedAppPath/))}

## Network Security

Base cleartext setting: \`${match(networkSource, /<base-config cleartextTrafficPermitted="([^"]+)"/, 'base cleartextTrafficPermitted')}\`.

Pinned built-in domains:

| Domain | Include subdomains | Pin expiry | Pins |
| --- | --- | --- | --- |
${markdownTable(networkPinRows(networkSource))}

Important behavior:

- Ordinary settings saves are local and do not depend on network security.
- HTTP endpoints are blocked by Android network security and/or app trust checks.
- A network-related setting can save correctly but appear ineffective when local-only mode, CSP, endpoint verification, certificate pinning, or Android cleartext rules block the request.
- Optional backend and user-configured OSRM hosts need trusted HTTPS origins and should add pins before release.

## Android Backup Rules

Android Auto Backup is disabled in the manifest and sensitive stores are also excluded from older backup and newer data-extraction paths.

${codeBlock('xml', read('android/app/src/main/res/xml/backup_rules.xml'))}

${codeBlock('xml', read('android/app/src/main/res/xml/data_extraction_rules.xml'))}

Expected behavior: settings and trips should survive relaunch and force-stop, but are not expected to survive uninstall/reinstall or Android cloud/device-transfer restore. Portable state uses Road Sage backup/import.

## Secure Native Storage

Gradle security dependencies:

| Dependency | Current declaration |
| --- | --- |
| AndroidX Biometric | \`${gradleDependency(gradleSource, 'androidx.biometric:biometric')}\` |
| AndroidX Security Crypto | \`${gradleDependency(gradleSource, 'androidx.security:security-crypto')}\` |
| Play Integrity | \`${gradleDependency(gradleSource, 'com.google.android.play:integrity')}\` |

Encrypted SharedPreferences use AndroidX Security with an Android Keystore-backed master key. StrongBox is attempted when available and falls back when unavailable.

${codeBlock('java', braceBlock('android/app/src/main/java/com/roadsage/app/EncryptedPreferenceStore.java', /static SharedPreferences open/))}

${codeBlock('java', `${braceBlock('android/app/src/main/java/com/roadsage/app/EncryptedPreferenceStore.java', /private static MasterKey buildHardwareMasterKey/)}\n\n${braceBlock('android/app/src/main/java/com/roadsage/app/EncryptedPreferenceStore.java', /private static MasterKey buildMasterKey/)}`)}

Native settings are stored in encrypted preferences under \`road_sage_native_settings_v2\`, key \`road_sage_settings\`.

${codeBlock('java', lineExcerpt('android/app/src/main/java/com/roadsage/app/NativeSettingsStore.java', /static String getSettingsJson/, {
  endPattern: /private static SharedPreferences prefs/,
  includeEnd: false,
  maxLines: 56,
}))}

The encrypted Capacitor mirror uses synchronous \`commit()\` and rejects failed writes:

${codeBlock('java', braceBlock('android/app/src/main/java/com/roadsage/app/EncryptedCapacitorPlugin.java', /public void set/))}

Sensitive JS trip fields use a separate Android Keystore AES-GCM key alias.

${codeBlock('java', lineExcerpt('android/app/src/main/java/com/roadsage/app/SecureKeyPlugin.java', /private static final String KEY_ALIAS/, {
  endPattern: /private static void generateKey/,
  includeEnd: false,
  maxLines: 90,
}))}

## Settings Persistence Contract

Default app-lock values:

| Setting | Current source value |
| --- | --- |
| \`biometric_lock_enabled\` | \`${biometricDefault}\` |
| \`lock_timeout_minutes\` | \`${lockTimeoutDefault}\` |
| \`BIOMETRIC_LOCK_DEFAULT_ENABLED\` | \`${biometricDefaultEnabled}\` |
| Timeout range | \`${lockTimeoutMin}..${lockTimeoutMax}\` minutes |
| Native auth timeout | \`${Number(authTimeoutMs).toLocaleString('en-US')} ms\` |

The durable Android save path is:

\`\`\`text
Settings UI
  -> updateCfg(patch)
  -> validateSettingsPatch(patch)
  -> localSettings.setAsync(...)
  -> setJson(...) encrypted Capacitor/browser mirror
  -> syncSettingsForNativeAsync(...)
  -> DriveSenseActivityRecognition.saveSettings(...)
  -> NativeSettingsStore.saveSettingsJson(...)
  -> EncryptedSharedPreferences.commit()
\`\`\`

Revision stamping:

${codeBlock('js', braceBlock('src/lib/trackingStore.js', /const stampSettingsSnapshot/))}

Hydration candidate choice:

${codeBlock('js', braceBlock('src/lib/trackingStore.js', /export function chooseSettingsHydrationCandidate/))}

Native settings sync:

${codeBlock('js', braceBlock('src/lib/trackingStore.js', /async function syncSettingsForNativeAsync/))}

Async durable save:

${codeBlock('js', braceBlock('src/lib/trackingStore.js', /async setAsync\(data\)/))}

Patch validation:

${codeBlock('js', braceBlock('src/lib/trackingStore.js', /export function validateSettingsPatch/))}

## Local-Only And External Services

Local-only mode forces every optional external service off. If a bug looks like networking does not work, check this before checking Android network security.

${codeBlock('js', `${braceBlock('src/lib/privacyControls.js', /export const externalServiceAllowed/)}\n\n${lineExcerpt('src/lib/privacyControls.js', /export const enforceLocalOnlyPatch/, {
  endPattern: /^\);/,
  maxLines: 28,
})}`)}

## Backup And Import Security

Current backup contract:

| Field | Current value |
| --- | --- |
| Backup schema | \`v${backupVersion}\` |
| Encrypted backup wrapper | \`v${backupEncryptionVersion}\` |
| Password length | \`${backupPasswordMin}-${backupPasswordMax}\` characters |
| PBKDF2 iterations | \`${Number(backupPbkdf2Iterations).toLocaleString('en-US')}\` |

Backup encryption code:

${codeBlock('js', braceBlock('src/lib/backupEncryption.js', /export async function encryptBackup/))}

Backup import treats files as untrusted input, limits size, strips BOMs, decrypts encrypted backups, verifies sealed legacy backups when present, migrates schemas, sanitizes trips/vehicles/settings, and only then writes to repositories.

${codeBlock('js', lineExcerpt('src/lib/dataBackup.js', /export async function importDriveSenseBackup/, {
  endPattern: /await reportImportProgress\(onProgress, \{ stage: 'validating' \}\);/,
  maxLines: 72,
  after: 2,
}))}

Settings import sanitizer:

${codeBlock('js', braceBlock('src/lib/trackingStore.js', /export function sanitizeImportedSettings/))}

## Fingerprint And App Lock

Road Sage does not store fingerprints. It asks Android to confirm the device credential. Depending on OS setup, that credential may be fingerprint, face, PIN, pattern, or password.

Settings enable flow:

${codeBlock('jsx', braceBlock('src/settings/sections/PrivacySettings.jsx', /const updateBiometricLockEnabled/))}

JavaScript Capacitor wrapper:

${codeBlock('js', read('src/lib/nativeBiometricGate.js'))}

In-memory lock state and timeout math:

${codeBlock('js', read('src/lib/biometricLock.js'))}

Native Android credential gate:

${codeBlock('java', read('android/app/src/main/java/com/roadsage/app/BiometricGatePlugin.java'))}

Protected route guard:

${codeBlock('jsx', braceBlock('src/App.jsx', /function BiometricRouteGuard/))}

Important app-lock behavior:

- App lock is off by default.
- Enabling App lock on Android requires a secure device credential and a successful Android credential prompt.
- Protected route content is covered by an opaque Road Sage lock screen while locked.
- Cancelling route unlock leaves the Road Sage lock overlay with an Unlock button.
- Auth timeout currently returns to the locked overlay and allows retry.
- If the native credential bridge reports unavailable during route unlock, the in-memory lock is disabled for that session, but the saved setting is not automatically changed.
- Backgrounding or visibility loss calls \`lockWhenBiometricEnabled()\`, so an enabled App lock should lock immediately regardless of the inactivity timeout.

## Runtime Integrity And Play Integrity

Runtime integrity can suspend native tracking while settings still persist correctly. Treat this as a security override, not a settings-save failure.

${codeBlock('java', read('android/app/src/main/java/com/roadsage/app/RuntimeIntegrityCheck.java'))}

MainActivity applies the local runtime check on launch:

${codeBlock('java', braceBlock('android/app/src/main/java/com/roadsage/app/MainActivity.java', /private void suspendTrackingOnCompromisedRuntime/))}

Play Integrity bridge:

${codeBlock('java', read('android/app/src/main/java/com/roadsage/app/PlayIntegrityPlugin.java'))}

## Debug Checklist

Use this sequence when another part of the app has a bug that might be security-related:

1. Decide whether the symptom is persistence failure, security override, or behavior wiring failure.
2. If a setting is involved, confirm \`validateSettingsPatch(...)\` accepts the patch.
3. Confirm \`localSettings.setAsync(...)\` returns and \`_settings_revision\` advances.
4. On Android, check native settings save and \`NativeSettingsStore.saveSettingsJson(...)\` commit behavior.
5. Force-stop and relaunch. If the value survives, persistence worked.
6. Check security overrides: App lock, permissions, local-only mode, endpoint trust, CSP, network security config, runtime integrity, backup import sanitizer, and Android credential availability.
7. If the value survived and security allows it, inspect the behavior consumer for wrong keys or missing native reads.

Useful logcat:

\`\`\`powershell
adb logcat -c
adb shell am force-stop com.roadsage.app
adb shell monkey -p com.roadsage.app 1
adb logcat -d -v time RoadSage:V RoadSageSettings:V EncryptedPreferenceStore:V AndroidRuntime:E chromium:E *:S
\`\`\`

Look for:

\`\`\`text
saveSettings called
NativeSettingsStore.commit() result=true
settings native save confirmed
settings_hydrate_from_native
native_settings_sync_async
Encrypted preferences are unavailable
Native settings plugin unavailable
Runtime integrity warning
biometric_gate_authenticate
\`\`\`

## AI Reviewer Prompt

\`\`\`text
Review Road Sage Android security behavior using docs/ANDROID_SECURITY_REFERENCE.md as the source map. Check whether the bug is caused by settings persistence, App lock/fingerprint credential flow, native encrypted storage, Android permissions, local-only mode, endpoint trust, network security config, CSP, backup/import sanitization, runtime integrity, or a behavior consumer not reading the saved setting. Return findings first with file paths and line references, and distinguish persistence failures from intentional security overrides.
\`\`\`
`;

const normalized = `${content.trim()}\n`;

if (CHECK) {
  const current = fs.existsSync(OUTPUT_PATH) ? fs.readFileSync(OUTPUT_PATH, 'utf8').replace(/\r\n/g, '\n') : '';
  if (current !== normalized) {
    console.error(`${OUTPUT_RELATIVE} is stale. Run npm run docs:android-security.`);
    process.exit(1);
  }
  console.log(`${OUTPUT_RELATIVE} is current.`);
} else {
  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, normalized, 'utf8');
  console.log(`Wrote ${OUTPUT_RELATIVE}`);
}
