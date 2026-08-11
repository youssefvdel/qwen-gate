/**
 * SSXMOD cookie generator (port of the QwenFreeApi reverse-engineered
 * generator, websdk-2.3.15d template).
 *
 * `ssxmod_itna` / `ssxmod_itna2` are a device fingerprint that Alibaba's
 * WAF accepts as proof of a real browser. This lets us use a plain fast
 * HTTP transport (native fetch + keep-alive) instead of a TLS-impersonation
 * worker for Qwen chat requests. Regenerated every 15 minutes.
 */

const CUSTOM_BASE64_CHARS = 'DGi0YA7BemWnQjCl4_bR3f8SKIF9tUz/xhr2oEOgPpac=61ZqwTudLkM5vHyNXsVJ';

const DEFAULT_TEMPLATE = {
  deviceId: '84985177a19a010dea49',
  sdkVersion: 'websdk-2.3.15d',
  initTimestamp: '1765348410850',
  field3: '91',
  field4: '1|15',
  language: 'zh-CN',
  timezoneOffset: '-480',
  colorDepth: '16705151|12791',
  screenInfo: '1470|956|283|797|158|0|1470|956|1470|798|0|0',
  field9: '5',
  platform: 'MacIntel',
  field11: '10',
  webglRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)|Google Inc. (Apple)',
  field13: '30|30',
  field14: '0',
  field15: '28',
  pluginCount: '5',
  vendor: 'Google Inc.',
  field29: '8',
  touchInfo: '-1|0|0|0|0',
  field32: '11',
  field35: '0',
  mode: 'P',
};

const HASH_FIELDS: Record<number, 'split' | 'full'> = {
  16: 'split',
  17: 'full',
  18: 'full',
  31: 'full',
  34: 'full',
  36: 'full',
};

const randomHash = (): number => Math.floor(Math.random() * 4294967296);

function generateDeviceId(): string {
  return Array.from({ length: 20 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
}

function lzwCompress(data: string, bits: number, charFunc: (index: number) => string): string {
  if (data == null) return '';
  const dict = new Map<string, number>();
  const dictToCreate = new Map<string, boolean>();
  let wc = '';
  let w = '';
  let enlargeIn = 2;
  let dictSize = 3;
  let numBits = 2;
  const result: string[] = [];
  let value = 0;
  let position = 0;

  const pushBits = (bitCount: number, fill: number): void => {
    for (let j = 0; j < bitCount; j++) {
      value = (value << 1) | (fill & 1);
      if (position === bits - 1) {
        position = 0;
        result.push(charFunc(value));
        value = 0;
      } else {
        position++;
      }
      fill >>= 1;
    }
  };

  for (let i = 0; i < data.length; i++) {
    const c = data.charAt(i);
    if (!dict.has(c)) {
      dict.set(c, dictSize++);
      dictToCreate.set(c, true);
    }
    wc = w + c;
    if (dict.has(wc)) {
      w = wc;
    } else {
      if (dictToCreate.has(w)) {
        if (w.charCodeAt(0) < 256) {
          pushBits(numBits, 0);
          pushBits(8, w.charCodeAt(0));
        } else {
          pushBits(numBits, 1);
          pushBits(16, w.charCodeAt(0));
        }
        enlargeIn--;
        if (enlargeIn === 0) {
          enlargeIn = 2 ** numBits;
          numBits++;
        }
        dictToCreate.delete(w);
      } else {
        pushBits(numBits, dict.get(w) ?? 0);
      }
      enlargeIn--;
      if (enlargeIn === 0) {
        enlargeIn = 2 ** numBits;
        numBits++;
      }
      dict.set(wc, dictSize++);
      w = String(c);
    }
  }

  if (w !== '') {
    if (dictToCreate.has(w)) {
      if (w.charCodeAt(0) < 256) {
        pushBits(numBits, 0);
        pushBits(8, w.charCodeAt(0));
      } else {
        pushBits(numBits, 1);
        pushBits(16, w.charCodeAt(0));
      }
      enlargeIn--;
      if (enlargeIn === 0) {
        enlargeIn = 2 ** numBits;
        numBits++;
      }
      dictToCreate.delete(w);
    } else {
      pushBits(numBits, dict.get(w) ?? 0);
    }
    enlargeIn--;
    if (enlargeIn === 0) {
      enlargeIn = 2 ** numBits;
      numBits++;
    }
  }

  // End of stream
  pushBits(numBits, 2);
  for (;;) {
    value = value << 1;
    if (position === bits - 1) {
      result.push(charFunc(value));
      break;
    }
    position++;
  }

  return result.join('');
}

function customEncode(data: string, urlSafe: boolean): string {
  if (data == null) return '';
  const compressed = lzwCompress(data, 6, (index) => CUSTOM_BASE64_CHARS.charAt(index));
  if (!urlSafe) {
    switch (compressed.length % 4) {
      case 1:
        return compressed + '===';
      case 2:
        return compressed + '==';
      case 3:
        return compressed + '=';
      default:
        return compressed;
    }
  }
  return compressed;
}

function generateFingerprint(): string {
  const config = { ...DEFAULT_TEMPLATE };
  const deviceId = generateDeviceId();
  const currentTimestamp = Date.now();

  const fields = [
    deviceId, // 0
    config.sdkVersion, // 1
    config.initTimestamp, // 2
    config.field3, // 3
    config.field4, // 4
    config.language, // 5
    config.timezoneOffset, // 6
    config.colorDepth, // 7
    config.screenInfo, // 8
    config.field9, // 9
    config.platform, // 10
    config.field11, // 11
    config.webglRenderer, // 12
    config.field13, // 13
    config.field14, // 14
    config.field15, // 15
    `${config.pluginCount}|${randomHash()}`, // 16
    randomHash(), // 17 canvas
    randomHash(), // 18 ua hash1
    '1', // 19
    '0', // 20
    '1', // 21
    '0', // 22
    config.mode, // 23
    '0', // 24
    '0', // 25
    '0', // 26
    '416', // 27
    config.vendor, // 28
    config.field29, // 29
    config.touchInfo, // 30
    randomHash(), // 31 ua hash2
    config.field32, // 32
    currentTimestamp, // 33
    randomHash(), // 34 url hash
    config.field35, // 35
    Math.floor(Math.random() * 91) + 10, // 36 doc hash
  ];

  return fields.join('^');
}

function processFields(fields: string[]): string[] {
  const processed = [...fields];
  const currentTimestamp = Date.now();
  for (const [index, type] of Object.entries(HASH_FIELDS)) {
    const idx = parseInt(index, 10);
    if (type === 'split') {
      const parts = String(processed[idx]).split('|');
      if (parts.length === 2) processed[idx] = `${parts[0]}|${randomHash()}`;
    } else if (type === 'full') {
      processed[idx] = idx === 36 ? String(Math.floor(Math.random() * 91) + 10) : String(randomHash());
    }
  }
  processed[33] = String(currentTimestamp);
  return processed;
}

export function generateSsxmod(): { ssxmod_itna: string; ssxmod_itna2: string; deviceId: string; timestamp: number } {
  const fp = generateFingerprint();
  const fields = fp.split('^');
  const processed = processFields(fields);

  const itnaData = processed.join('^');
  const ssxmod_itna = '1-' + customEncode(itnaData, true);

  const itna2Data = [
    processed[0],
    processed[1],
    processed[23],
    0,
    '',
    0,
    '',
    '',
    0,
    0,
    0,
    processed[32],
    processed[33],
    0,
    0,
    0,
    0,
    0,
  ].join('^');
  const ssxmod_itna2 = '1-' + customEncode(itna2Data, true);

  return { ssxmod_itna, ssxmod_itna2, deviceId: processed[0], timestamp: parseInt(processed[33], 10) };
}

// ── Cache manager: generate at first use, refresh every 15 min ──

export interface SsxmodPair {
  ssxmod_itna: string;
  ssxmod_itna2: string;
}

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;

let current: SsxmodPair | null = null;
let timer: ReturnType<typeof setInterval> | null = null;

function refresh(): void {
  try {
    const { ssxmod_itna, ssxmod_itna2 } = generateSsxmod();
    current = { ssxmod_itna, ssxmod_itna2 };
  } catch (err) {
    console.error('[ssxmod] generation failed:', err);
    current = null;
  }
}

function ensureTimer(): void {
  if (timer) return;
  refresh();
  timer = setInterval(refresh, REFRESH_INTERVAL_MS);
  if (typeof timer.unref === 'function') timer.unref();
}

/** Get the current (cached) SSXMOD cookie pair, generating lazily if needed. */
export function getSsxmodCookies(): SsxmodPair {
  ensureTimer();
  if (!current) refresh(); // surface an error once if first generation failed
  return current ?? { ssxmod_itna: '', ssxmod_itna2: '' };
}
