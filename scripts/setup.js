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

function portRedirect() {
  const PORT = process.env.PORT || '26405';
  const portNum = parseInt(PORT, 10);
  if (portNum > 65535) {
    console.log(`  ⚠ Port ${PORT} exceeds 65535, skipping redirect`);
    return;
  }
  const plat = platform();
  try {
    if (plat === 'linux') {
      // Check if redirect already exists
      const check = execSync(`iptables -t nat -C PREROUTING -p tcp --dport 80 -j REDIRECT --to-port ${portNum} 2>/dev/null; echo $?`, { stdio: 'pipe', timeout: 5000 }).toString().trim();
      if (check.endsWith('0')) {
        console.log(`  ✅ Port 80 → ${portNum} redirect already active`);
      } else {
        execSync(`iptables -t nat -A PREROUTING -p tcp --dport 80 -j REDIRECT --to-port ${portNum}`, { stdio: 'pipe', timeout: 5000 });
        execSync(`iptables -t nat -A OUTPUT -p tcp -d 127.0.0.1 --dport 80 -j REDIRECT --to-port ${portNum}`, { stdio: 'pipe', timeout: 5000 });
        console.log(`  ✅ Port 80 → ${portNum} redirect active`);
        // Try to persist
        try {
          execSync('which netfilter-persistent >/dev/null 2>&1 && netfilter-persistent save', { stdio: 'pipe', timeout: 5000 });
        } catch {}
      }
    } else if (plat === 'darwin') {
      // macOS: use pfctl
      const anchorFile = '/etc/pf.anchors/qwen-gate';
      const rule = `rdr pass on lo0 inet proto tcp from any to 127.0.0.1 port 80 -> 127.0.0.1 port ${portNum}`;
      try {
        writeFileSync(anchorFile, rule + '\n');
        execSync(`pfctl -Ef /etc/pf.conf 2>/dev/null; echo \"rdr-anchor \\\"qwen-gate\\\"\" >> /tmp/qwen-pf.conf; pfctl -a qwen-gate -f ${anchorFile} 2>/dev/null`, { stdio: 'pipe', timeout: 5000 });
        console.log(`  ✅ Port 80 → ${portNum} redirect active (macOS pfctl)`);
      } catch (e) {
        console.log(`  ⚠ Could not set up pf redirect: ${e.message}`);
      }
    } else if (plat === 'win32') {
      // Windows: use netsh
      try {
        execSync(`netsh interface portproxy add v4tov4 listenport=80 listenaddress=127.0.0.1 connectport=${portNum} connectaddress=127.0.0.1`, { stdio: 'pipe', timeout: 5000 });
        console.log(`  ✅ Port 80 → ${portNum} redirect active (Windows netsh)`);
      } catch (e) {
        console.log(`  ⚠ Could not set up portproxy: ${e.message}. Run as Administrator.`);
      }
    }
  } catch (e) {
    console.log(`  ⚠ Port redirect skipped: ${e.message}. Run as root/admin or set up manually.`);
  }
}

function opencodeConfig() {
  try {
    const PORT = process.env.PORT || '26405';
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
  portRedirect();
  opencodeConfig();
  console.log('\nSetup complete.\n');
}

main();
