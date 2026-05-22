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

  // 2. Register with OpenCode
  const opencodeConfigPath = join(homedir(), '.config', 'opencode', 'opencode.json');
  const opencodeAltPath = join(homedir(), '.config', 'opencode.json');

  for (const configPath of [opencodeConfigPath, opencodeAltPath]) {
    if (!existsSync(configPath)) continue;

    try {
      let config = JSON.parse(readFileSync(configPath, 'utf-8'));

      if (!config.provider) config.provider = {};

      if (!config.provider['qwen-gate']) {
        config.provider['qwen-gate'] = {
          npm: '@ai-sdk/openai-compatible',
          name: 'Qwen Gate',
          options: { baseURL: `${BASE_URL}/v1` }
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

  console.log(`\n📋 Next steps:`);
  console.log(`   Run \`npm start\` to start the proxy`);
  console.log(`   Your API is at ${BASE_URL}/v1\n`);
}

main().catch(console.error);
