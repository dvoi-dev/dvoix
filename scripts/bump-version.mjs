// Sets the app version everywhere at once: package.json (and the lockfile),
// the Cargo workspace and the Tauri config. After bumping, commit and push a
// `v<version>` tag; the release workflow builds the signed bundles from it.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error("Usage: npm run bump <version>   (e.g. npm run bump 0.3.0)");
  process.exit(1);
}

function editJson(file, change) {
  const path = join(root, file);
  const data = JSON.parse(readFileSync(path, "utf8"));
  change(data);
  writeFileSync(path, JSON.stringify(data, null, 2) + "\n");
}

editJson("package.json", (pkg) => (pkg.version = version));
editJson("package-lock.json", (lock) => {
  lock.version = version;
  if (lock.packages?.[""]) lock.packages[""].version = version;
});
editJson("src-tauri/tauri.conf.json", (conf) => (conf.version = version));

const cargoPath = join(root, "Cargo.toml");
const cargo = readFileSync(cargoPath, "utf8");
const updated = cargo.replace(/(\[workspace\.package\][\s\S]*?\nversion = ")[^"]+(")/, `$1${version}$2`);
if (updated === cargo) {
  console.error("Could not find the version in the [workspace.package] section of Cargo.toml");
  process.exit(1);
}
writeFileSync(cargoPath, updated);

console.log(`dvoix is now ${version}. Commit, then: git tag v${version} && git push origin v${version}`);
