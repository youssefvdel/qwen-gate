/*
 * DeepSeek PoW Worker — loads SHA3 WASM module and exposes wasm_solve via postMessage.
 *
 * The DeepSeek WASM module requires a Web Worker context (indirect function table
 * is initialized during instantiation). This worker mirrors how the DeepSeek
 * web app loads the WASM — in a dedicated Worker thread.
 *
 * Protocol:
 *   postMessage({ challenge, salt, expireAt, difficulty }) → { answer }
 *   postMessage({ error: message })
 */

const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

let wasmExports: any = null;

async function initWasm(): Promise<any> {
  if (wasmExports) return wasmExports;

  const response = await fetch(WASM_URL);
  const bytes = await response.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(bytes, {});

  wasmExports = instance.exports;
  return wasmExports;
}

self.onmessage = async (event: MessageEvent) => {
  const { challenge, salt, expireAt, difficulty } = event.data;

  if (!challenge || !salt || !expireAt || difficulty === undefined) {
    self.postMessage({ error: 'Missing required fields: challenge, salt, expireAt, difficulty' });
    return;
  }

  try {
    const ex = await initWasm();
    const memory = ex.memory as WebAssembly.Memory;
    const solveFn = ex.wasm_solve as Function;
    const addToStack = ex.__wbindgen_add_to_stack_pointer as Function;

    // Grow memory to ensure space
    memory.grow(10);

    const enc = new TextEncoder();
    const prefix = salt + '_' + expireAt + '_';
    const retptr = addToStack(-16);

    // Write data at fixed offsets well past stack allocations
    const cBytes = enc.encode(challenge);
    const pBytes = enc.encode(prefix);
    const dataOff = 131072; // 128KB offset
    const prefOff = dataOff + cBytes.length + 32;

    new Uint8Array(memory.buffer, dataOff, cBytes.length).set(cBytes);
    new Uint8Array(memory.buffer, prefOff, pBytes.length).set(pBytes);

    solveFn(retptr, dataOff, cBytes.length, prefOff, pBytes.length, difficulty);

    const view = new DataView(memory.buffer);
    const flag = view.getInt32(retptr, true);
    const answer = view.getFloat64(retptr + 8, true);
    addToStack(16);

    if (flag === 0) {
      self.postMessage({ error: 'No solution found' });
    } else {
      self.postMessage({ answer });
    }
  } catch (err: any) {
    self.postMessage({ error: err.message || 'WASM solve failed' });
  }
};
