import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const files = [
  'android/app/build.gradle',
  'node_modules/@capacitor-community/background-geolocation/android/build.gradle',
];

for (const file of files) {
  const path = resolve(file);
  if (!existsSync(path)) continue;

  const source = readFileSync(path, 'utf8');
  const patched = source.replace(
    /getDefaultProguardFile\('proguard-android\.txt'\)/g,
    "getDefaultProguardFile('proguard-android-optimize.txt')"
  );

  if (patched !== source) {
    writeFileSync(path, patched);
    console.log(`Patched deprecated ProGuard default in ${file}`);
  }
}
