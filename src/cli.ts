#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isBun } from './utils/env.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, 'index.tsx');

const out = (s: string) => process.stdout.write(s + '\n');
function err(msg: string) {
  console.error(`[qg] ${msg}`);
}
const DEFAULT_PORT = '26405';

function showHelp() {
  out('');
  out('Qwen Gate — OpenAI-compatible gateway for Qwen AI');
  out('');
  out('USAGE');
  out('  qg [command] [options]');
  out('');
  out('COMMANDS');
  out('  start          Start the API server (default)');
  out('  update         Pull latest code and reinstall dependencies');
  out('  restart        Restart the running server');
  out('  status         Check if the server is running');
  out('  help           Show this help message');
  out('');
  out('OPTIONS');
  out('  --port <n>     Override port (default: from config or 26405)');
  out('  --browser <e>  Browser engine: chromium, firefox, chrome, edge');
  out('  --host <addr>  Bind address (default: from config or localhost)');
  out('');
  out('EXAMPLES');
  out('  qg                    Start the server');
  out('  qg update             Update to latest version');
  out('  qg start --port 8080  Start on port 8080');
  out('  qg restart            Restart the server');
  out('  qg status             Check server status');
  out('  qg help               Show this message');
  out('');
  out('ACCOUNT MANAGEMENT');
  out('  Use the web dashboard at http://localhost:26405/dashboard/accounts');
  out('  to add, remove, and manage your Qwen accounts.');
  out('');
}

function findEntry(): string {
  return SERVER_ENTRY;
}

async function startServer(args: string[]) {
  const portIdx = args.indexOf('--port');
  const browserIdx = args.indexOf('--browser');
  const hostIdx = args.indexOf('--host');

  const extraArgs: string[] = [];
  if (portIdx !== -1 && args[portIdx + 1]) extraArgs.push('--port', args[portIdx + 1]);
  if (browserIdx !== -1 && args[browserIdx + 1]) extraArgs.push('--browser', args[browserIdx + 1]);
  if (hostIdx !== -1 && args[hostIdx + 1]) extraArgs.push('--host', args[hostIdx + 1]);

  const entry = findEntry();
  // Run the server under Node, not Bun. cloakbrowser drives Chrome over a CDP
  // pipe that hangs under Bun on Windows (browser-profile launch never resolves
  // -> 30s timeout -> fetch-login with no baxia/WAF cookie harvest -> captchas).
  // Node drives the pipe correctly and harvests the WAF cookies. `tsx` lets Node
  // execute the .tsx entry directly.
  const runner = 'node';
  const runnerArgs = ['--import', 'tsx', entry, ...extraArgs];

  out(`Starting server (node ${entry})...`);
  if (extraArgs.length) out(`Extra args: ${extraArgs.join(' ')}`);

  const server = spawn(runner, runnerArgs, {
    stdio: 'inherit',
    shell: true,
  });

  server.on('error', (e) => {
    err(`Failed to start: ${e.message}`);
    process.exit(1);
  });
  server.on('exit', (code) => process.exit(code ?? 0));
}

async function doUpdate() {
  const repoDir = resolve(__dirname, '..');
  const isWin = process.platform === 'win32';

  out('Pulling latest code...');
  const pull = spawn('git', ['pull', '--ff-only'], { cwd: repoDir, stdio: 'inherit', shell: true });
  const pullCode = await new Promise<number | null>((r) => {
    pull.on('close', r);
  });
  if (pullCode !== 0) {
    err('git pull failed');
    process.exit(1);
  }

  out(isBun ? 'Reinstalling dependencies (bun)...' : 'Reinstalling dependencies (npm)...');

  if (isBun) {
    const bunInstall = spawn('bun', ['install'], { cwd: repoDir, stdio: 'inherit', shell: true });
    const bunCode = await new Promise<number | null>((r) => {
      bunInstall.on('close', r);
    });
    if (bunCode === 0) {
      out('Update complete. Restart the server with: qg restart');
      return;
    }
    err('bun install failed — falling back to npm...');
  }

  const npmCmd = isWin ? 'npm.cmd' : 'npm';
  const install = spawn(npmCmd, ['install'], { cwd: repoDir, stdio: 'inherit', shell: true });
  const installCode = await new Promise<number | null>((r) => {
    install.on('close', r);
  });
  if (installCode !== 0) {
    err('npm install failed');
    process.exit(1);
  }

  out('Update complete. Restart the server with: qg restart');
}

async function checkStatus() {
  const port = process.env.PORT || DEFAULT_PORT;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/v1/models`, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      out(`Server is running on port ${port}`);
      return;
    }
  } catch {
    // Server not running
  }
  err('Server is not running');
  process.exit(1);
}

function getPidFilePath(): string {
  return resolve(__dirname, '..', '.qwen', 'gate.pid');
}

async function restartServer() {
  const pidFile = getPidFilePath();

  out('Stopping server...');
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf-8').trim(), 10);
      if (!isNaN(pid)) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* process already dead */
        }
        // Wait for process to exit
        for (let i = 0; i < 30; i++) {
          try {
            process.kill(pid, 0);
            await new Promise((r) => setTimeout(r, 200));
          } catch {
            break;
          }
        }
      }
      try {
        unlinkSync(pidFile);
      } catch {
        /* best effort */
      }
    } catch {
      /* pid file read error */
    }
  }

  await new Promise((r) => setTimeout(r, 1000));
  out('Starting server...');
  await startServer([]);
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.find((a) => !a.startsWith('--')) || 'start';

  if (command === 'help' || args.includes('--help') || args.includes('-h')) {
    showHelp();
    process.exit(0);
  }

  switch (command) {
    case 'update':
      await doUpdate();
      break;
    case 'restart':
      await restartServer();
      break;
    case 'status':
      await checkStatus();
      break;
    case 'start':
    case 'run':
    case 'server':
      await startServer(args);
      break;
    default:
      out(`Starting server... (unknown command '${command}' — defaulting to start)`);
      await startServer(args);
      break;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url).endsWith('cli.ts')) {
  main().catch((e) => {
    err(`Fatal: ${e.message}`);
    process.exit(1);
  });
}

export { restartServer, startServer };
