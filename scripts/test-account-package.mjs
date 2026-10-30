// Install the tarball in a clean host: source aliases cannot hide missing exports.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
const host = mkdtempSync(join(tmpdir(), 'forms-account-host-'));
const run = (cmd, args, cwd = host) => execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
try {
  const packed = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', host], process.cwd()));
  writeFileSync(join(host, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', join(host, packed[0].filename), `agentic-identity@${process.env.ACCOUNT_IDENTITY_VERSION ?? JSON.parse(readFileSync('node_modules/agentic-identity/package.json', 'utf8')).version}`]);
  copyFileSync('scripts/account-host.mts', join(host, 'host.mts'));
  run(process.execPath, [resolve('node_modules/typescript/bin/tsc'), '--noEmit', '--strict', '--skipLibCheck', '--module', 'NodeNext', '--target', 'ES2022', 'host.mts']);
  process.stdout.write(run(process.execPath, ['--experimental-strip-types', 'host.mts']));
} finally {
  rmSync(host, { recursive: true, force: true });
}
