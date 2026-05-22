import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

function loadEnv() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const envPath = join(__dirname, '..', '.env');
  if (existsSync(envPath)) {
    const content = readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const match = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/);
      if (match) process.env[match[1]] = process.env[match[1]] || match[2];
    }
  }
}

function hostsEntry() {
  const HOSTNAME = 'qwen-gate';
  try {
    const plat = platform();
    const hostsPath = plat === 'win32'
      ? 'C:\\Windows\\System32\\drivers\\etc\\hosts'
      : '/etc/hosts';
    if (existsSync(hostsPath)) {
      const hosts = readFileSync(hostsPath, 'utf-8');
      if (!hosts.includes(HOSTNAME)) {
        writeFileSync(hostsPath, hosts + `\n127.0.0.1 ${HOSTNAME}\n`);
        console.log(`  ✅ Added ${HOSTNAME} to hosts`);
      } else {
        console.log(`  ✅ ${HOSTNAME} already in hosts`);
      }
    }
  } catch {}
}

function opencodeConfig() {
  try {
    const PORT = process.env.PORT || '3000';
    const BASE_URL = PORT === '80' ? 'http://qwen-gate' : `http://qwen-gate:${PORT}`;
    const modelDefs = [
      { id: 'qwen3.7-max', name: 'Qwen3.7 Max', ctx: 1000000, out: 81920 },
      { id: 'qwen3.7-max-no-thinking', name: 'Qwen3.7 Max (No Thinking)', ctx: 1000000, out: 81920 },
      { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', ctx: 1000000, out: 65536 },
      { id: 'qwen3.6-plus-no-thinking', name: 'Qwen3.6 Plus (No Thinking)', ctx: 1000000, out: 65536 },
    ];
    const models = {};
    modelDefs.forEach(m => { models[m.id] = { name: m.name, limit: { context: m.ctx, output: m.out } }; });

    const opencodeDir = join(homedir(), '.opencode');
    if (existsSync(opencodeDir)) {
      try { execSync(`npm install --prefix "${opencodeDir}" @ai-sdk/openai-compatible`, { stdio: 'pipe', timeout: 30000 }); } catch {}
    }

    const configPaths = [
      join(homedir(), '.config', 'opencode', 'opencode.json'),
      join(homedir(), '.config', 'opencode.json'),
    ];
    for (const configPath of configPaths) {
      if (!existsSync(configPath)) continue;
      try {
        let config = JSON.parse(readFileSync(configPath, 'utf-8'));
        if (!config.provider) config.provider = {};
        if (!config.provider['qwen-gate']) {
          config.provider['qwen-gate'] = { name: 'Qwen Gate', type: 'openai', apiBase: `${BASE_URL}/v1`, models };
          config.default_provider = config.default_provider || 'qwen-gate';
          writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
          console.log(`  ✅ Added qwen-gate to OpenCode`);
        }
        if (config.default_provider !== 'qwen-gate') {
          config.default_provider = 'qwen-gate';
          writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
          console.log(`  ✅ Set qwen-gate as default`);
        }
      } catch {}
    }

    const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
    if (existsSync(authPath)) {
      try {
        const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
        if (!auth['qwen-gate']) {
          auth['qwen-gate'] = { type: 'api', key: 'none' };
          delete auth['qwenproxy'];
          writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n');
          console.log('  ✅ Added credential to OpenCode');
        }
      } catch {}
    }
  } catch {}
}

function main() {
  loadEnv();
  console.log('\nSetting up Qwen Gate...\n');
  hostsEntry();
  opencodeConfig();
  console.log('\nSetup complete.\n');
}

main();
