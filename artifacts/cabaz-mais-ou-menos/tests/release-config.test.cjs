const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const projectRoot = path.resolve(__dirname, "..");
const expo = JSON.parse(
  fs.readFileSync(path.join(projectRoot, "app.json"), "utf8"),
).expo;

const appIdentifierPattern =
  /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9][A-Za-z0-9_]*)+$/;

function assertPngIs1024(pathFromProjectRoot) {
  const image = fs.readFileSync(path.join(projectRoot, pathFromProjectRoot));
  assert.equal(image.toString("hex", 0, 8), "89504e470d0a1a0a");
  assert.equal(image.readUInt32BE(16), 1024);
  assert.equal(image.readUInt32BE(20), 1024);
}

test("native release identity and build counters are explicit", () => {
  assert.match(expo.ios.bundleIdentifier, appIdentifierPattern);
  assert.match(expo.android.package, appIdentifierPattern);
  assert.notEqual(expo.ios.bundleIdentifier, "com.placeholder.appid");
  assert.notEqual(expo.android.package, "com.placeholder.appid");
  assert.equal(expo.ios.bundleIdentifier, expo.android.package);
  assert.match(expo.version, /^\d+\.\d+\.\d+$/);
  assert.match(expo.ios.buildNumber, /^\d+$/);
  assert.ok(Number(expo.ios.buildNumber) > 0);
  assert.ok(Number.isInteger(expo.android.versionCode));
  assert.ok(expo.android.versionCode > 0);
  assert.equal(expo.orientation, "portrait");
  assert.equal(expo.scheme, "cabaz-mais-ou-menos");
});

test("release icon and splash configuration use existing square assets", () => {
  assert.equal(expo.splash, undefined);
  assertPngIs1024(expo.icon.replace(/^\.\//, ""));

  const splashPlugin = expo.plugins.find(
    (plugin) => Array.isArray(plugin) && plugin[0] === "expo-splash-screen",
  );
  assert.ok(splashPlugin, "expo-splash-screen config plugin is required");
  assert.equal(splashPlugin[1].image, "./assets/images/icon.png");
  assert.equal(splashPlugin[1].imageWidth, 200);
  assert.equal(splashPlugin[1].resizeMode, "contain");
  assert.equal(splashPlugin[1].backgroundColor, "#1F4D3A");
  assertPngIs1024(splashPlugin[1].image.replace(/^\.\//, ""));

  assertPngIs1024(
    expo.android.adaptiveIcon.foregroundImage.replace(/^\.\//, ""),
  );
});

test("Android excludes unused legacy external-storage permissions", () => {
  assert.deepEqual(expo.android.blockedPermissions, [
    "android.permission.READ_EXTERNAL_STORAGE",
    "android.permission.WRITE_EXTERNAL_STORAGE",
  ]);
});
