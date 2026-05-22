import { execSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { homedir, platform } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Load .env if it exists
const __dirname = dirname(fileURLToPath(import.meta.url));
const envPath = join(__dirname, '..', '.env');
if (existsSync(envPath)) {
  const envContent = readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const match = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/);
    if (match) process.env[match[1]] = process.env[match[1]] || match[2];
  }
}

const HOSTNAME = 'qwen-gate';
const PORT = process.env.PORT || '3000';
const BASE_URL = PORT === '80' ? `http://${HOSTNAME}` : `http://${HOSTNAME}:${PORT}`;

async function main() {
  console.log(`\nSetting up Qwen Gate...\n`);

  // 1. Register hostname
  try {
    const plat = platform();
    if (plat === 'linux' || plat === 'darwin') {
      const hostsPath = '/etc/hosts';
      const hosts = readFileSync(hostsPath, 'utf-8');
      if (!hosts.includes(HOSTNAME)) {
        execSync(`echo "127.0.0.1 ${HOSTNAME}" >> ${hostsPath}`, { sudo: true });
        console.log(`  ✅ Added ${HOSTNAME} to /etc/hosts`);
      } else {
        console.log(`  ✅ ${HOSTNAME} already in /etc/hosts`);
      }
    } else if (plat === 'win32') {
      const hostsPath = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
      const hosts = readFileSync(hostsPath, 'utf-8');
      if (!hosts.includes(HOSTNAME)) {
        writeFileSync(hostsPath, hosts + `\n127.0.0.1 ${HOSTNAME}\n`);
        console.log(`  ✅ Added ${HOSTNAME} to hosts file`);
      } else {
        console.log(`  ✅ ${HOSTNAME} already in hosts`);
      }
    }
  } catch (err) {
    console.log(`  ⚠️  Could not add hostname (run with sudo/admin): ${err.message}`);
  }

  try {
    const opencodeDir = join(homedir(), '.opencode');
    if (existsSync(opencodeDir)) {
      execSync(`npm install --prefix ${opencodeDir} @ai-sdk/openai-compatible`, { stdio: 'pipe' });
      console.log('  ✅ Installed @ai-sdk/openai-compatible for OpenCode');
    }
  } catch (err) {
    console.log(`  ⚠️  Could not install @ai-sdk/openai-compatible: ${err.message}`);
  }

  // 3. Register with OpenCode
  const opencodeConfigPath = join(homedir(), '.config', 'opencode', 'opencode.json');
  const opencodeAltPath = join(homedir(), '.config', 'opencode.json');

  for (const configPath of [opencodeConfigPath, opencodeAltPath]) {
    if (!existsSync(configPath)) continue;

    try {
      let config = JSON.parse(readFileSync(configPath, 'utf-8'));

      if (!config.provider) config.provider = {};

      if (!config.provider['qwen-gate']) {
        const modelDefs = [
          { id: 'qwen3.7-max', name: 'Qwen3.7 Max', ctx: 1000000, out: 81920 },
          { id: 'qwen3.7-max-no-thinking', name: 'Qwen3.7 Max (No Thinking)', ctx: 1000000, out: 81920 },
          { id: 'qwen3.6-plus', name: 'Qwen3.6 Plus', ctx: 1000000, out: 65536 },
          { id: 'qwen3.6-plus-no-thinking', name: 'Qwen3.6 Plus (No Thinking)', ctx: 1000000, out: 65536 },
        ];
        const models: Record<string, any> = {};
        modelDefs.forEach(m => { models[m.id] = { name: m.name, limit: { context: m.ctx, output: m.out } }; });
        config.provider['qwen-gate'] = {
          name: 'Qwen Gate',
          type: 'openai',
          apiBase: `${BASE_URL}/v1`,
          models,
        };
        config.default_provider = config.default_provider || 'qwen-gate';
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
        console.log(`  ✅ Added qwen-gate provider to OpenCode`);
      } else {
        console.log(`  ✅ qwen-gate already in OpenCode config`);
      }

      if (config.default_provider !== 'qwen-gate') {
        config.default_provider = 'qwen-gate';
        writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
        console.log(`  ✅ Set qwen-gate as default OpenCode provider`);
      }
    } catch (err) {
      console.log(`  ⚠️  Could not update OpenCode config: ${err.message}`);
    }
  }

  // 4. Add credential to OpenCode auth
  const authPath = join(homedir(), '.local', 'share', 'opencode', 'auth.json');
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
      auth['qwen-gate'] = auth['qwen-gate'] || { type: 'api', key: 'none' };
      delete auth['qwenproxy'];
      writeFileSync(authPath, JSON.stringify(auth, null, 2) + '\n');
      console.log('  ✅ Added qwen-gate credential to OpenCode');
    } catch (err) {
      console.log(`  ⚠️  Could not update OpenCode auth: ${err.message}`);
    }
  }

  console.log(`\n📋 Next steps:`);
  console.log(`   Run \`npm start\` to start the proxy`);
  console.log(`   Your API is at ${BASE_URL}/v1\n`);
}

main().catch(console.error);
