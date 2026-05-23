import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const replaceInFile = (file, transforms) => {
  const path = resolve(file);
  if (!existsSync(path)) return;

  const source = readFileSync(path, 'utf8');
  const patched = transforms.reduce((current, [pattern, replacement]) => current.replace(pattern, replacement), source);

  if (patched !== source) {
    writeFileSync(path, patched);
    console.log(`Patched Android Gradle compatibility in ${file}`);
  }
};

const containsLocalLibrary = (directories) => directories.some((directory) => {
  const path = resolve(directory);
  if (!existsSync(path)) return false;
  return readdirSync(path, { recursive: true }).some((entry) => /\.(?:aar|jar)$/i.test(String(entry)));
});

const modernAndroidDslTransforms = [
  [/getDefaultProguardFile\('proguard-android\.txt'\)/g, "getDefaultProguardFile('proguard-android-optimize.txt')"],
  [/(rootProject\.ext\.)compileSdk =/g, '$1compileSdkVersion'],
  [/(rootProject\.ext\.)minSdk =/g, '$1minSdkVersion'],
  [/(rootProject\.ext\.)targetSdk =/g, '$1targetSdkVersion'],
  [/^(\s*)coreLibraryDesugaringEnabled true\s*$/gm, '$1coreLibraryDesugaringEnabled = true'],
  [/^(\s*)namespace "([^"]+)"\s*$/gm, '$1namespace = "$2"'],
  [/^(\s*)compileSdkVersion (.+)$/gm, '$1compileSdk = $2'],
  [/^(\s*)minSdkVersion (.+)$/gm, '$1minSdk = $2'],
  [/^(\s*)targetSdkVersion (.+)$/gm, '$1targetSdk = $2'],
  [/^(\s*)versionCode (\d+)\s*$/gm, '$1versionCode = $2'],
  [/^(\s*)versionName "([^"]+)"\s*$/gm, '$1versionName = "$2"'],
  [/^(\s*)minifyEnabled false\s*$/gm, '$1minifyEnabled = false'],
  [/^(\s*)abortOnError false\s*$/gm, '$1abortOnError = false'],
  [/^(\s*)baseline file\((.+)\)\s*$/gm, '$1baseline = file($2)'],
  [/^(\s*)lintOptions\s*\{\s*$/gm, '$1lint {'],
];

const patchedGradleFiles = [
  'android/app/build.gradle',
  'android/capacitor-cordova-android-plugins/build.gradle',
  'node_modules/@capacitor/android/capacitor/build.gradle',
  'node_modules/@capacitor/app/android/build.gradle',
  'node_modules/@capacitor/filesystem/android/build.gradle',
  'node_modules/@capacitor/geolocation/android/build.gradle',
  'node_modules/@capacitor/local-notifications/android/build.gradle',
  'node_modules/@capacitor/preferences/android/build.gradle',
  'node_modules/@capacitor/splash-screen/android/build.gradle',
  'node_modules/@capacitor-community/background-geolocation/android/build.gradle',
];

patchedGradleFiles.forEach((file) => replaceInFile(file, modernAndroidDslTransforms));

[
  'node_modules/@capacitor/filesystem/android/build.gradle',
  'node_modules/@capacitor/geolocation/android/build.gradle',
].forEach((file) => replaceInFile(file, [
  [/\napply plugin: 'kotlin-android'/g, ''],
]));

if (!containsLocalLibrary([
  'android/app/libs',
  'android/capacitor-cordova-android-plugins/src/main/libs',
  'android/capacitor-cordova-android-plugins/libs',
])) {
  replaceInFile('android/app/build.gradle', [
    [/\nrepositories \{\s+flatDir\{\s+dirs '\.\.\/capacitor-cordova-android-plugins\/src\/main\/libs', 'libs'\s+\}\s+\}\n/m, '\n'],
  ]);
  replaceInFile('android/capacitor-cordova-android-plugins/build.gradle', [
    [/\n    flatDir\{\s+dirs 'src\/main\/libs', 'libs'\s+\}/m, ''],
  ]);
}
