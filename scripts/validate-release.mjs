import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const read = name => readFileSync(new URL(name, root), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
const versions = JSON.parse(read('versions.json'));

assert.equal(manifest.id, 'simple-memo');
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
assert.equal(pkg.version, manifest.version);
assert.equal(versions[manifest.version], manifest.minAppVersion);
assert.equal(pkg.license, 'MIT');
assert.equal(manifest.isDesktopOnly, false);
assert.ok(manifest.author && manifest.author !== 'Personal tools');
assert.ok(manifest.description.length <= 250 && manifest.description.endsWith('.'));
if (process.env.GITHUB_REF_TYPE === 'tag') {
  assert.equal(process.env.GITHUB_REF_NAME, manifest.version, 'Release tag must match manifest.version');
}
for (const name of ['main.js', 'manifest.json', 'styles.css', 'README.md', 'README.zh-CN.md', 'LICENSE']) {
  assert.ok(statSync(fileURLToPath(new URL(name, root))).size > 0, `${name} is missing or empty`);
}
console.log(`Release files validated: ${manifest.id} ${manifest.version}`);
