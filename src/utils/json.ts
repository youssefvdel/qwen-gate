/*
 * File: json.ts
 * Project: qwenproxy
 * Robust JSON parsing utilities
 */

/**
 * Remove trailing commas before } or ] in JSON strings.
 * LLMs often produce: {"items": ["a", "b",]} or {"a": 1,}
 * This is string-aware — it won't modify commas inside quoted values.
 */
function removeTrailingCommas(json: string): string {
  let result = '';
  let inString = false;
  let escaped = false;

  for (let i = 0; i < json.length; i++) {
    const char = json[i];

    if (escaped) {
      result += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      result += char;
      escaped = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      result += char;
      continue;
    }

    if (!inString && char === ',') {
      // Look ahead past whitespace to see if next non-whitespace is } or ]
      let j = i + 1;
      while (j < json.length && /\s/.test(json[j])) j++;
      if (j < json.length && (json[j] === '}' || json[j] === ']')) {
        // Skip this trailing comma
        continue;
      }
    }

    result += char;
  }

  return result;
}

export function robustParseJSON(str: string): any {
  const trimmed = str.trim();

  try {
    return JSON.parse(trimmed);
  } catch {}

  // Strip markdown code fences in all variants
  let sanitized = trimmed;
  const fenceMatch = sanitized.match(/\x60\x60\x60(?:json|JSON)?\s*\n?([\s\S]*?)\n?\s*\x60\x60\x60/);
  if (fenceMatch) {
    sanitized = fenceMatch[1].trim();
  } else {
    sanitized = sanitized.replace(/^\x60\x60\x60(?:json|JSON)?\s*/i, '').replace(/\x60\x60\x60\s*$/, '').trim();
  }

  const firstBrace = sanitized.indexOf('{');
  if (firstBrace === -1) return null;

  const jsonPart = sanitized.substring(firstBrace);

  try {
    return JSON.parse(jsonPart);
  } catch {}


  // 0. Fix unquoted property names (e.g., arguments instead of "arguments")
  // We apply this to jsonPart and use the result for subsequent fixes
  let currentJson = jsonPart.replace(/([{,]\s*)([a-zA-Z_][a-zA-Z0-9_]*)(\s*:)/g, '$1"$2"$3');

  // 0b. Fix trailing commas inside arrays/objects (e.g., [a, b,] -> [a, b])
  currentJson = removeTrailingCommas(currentJson);

  // 0. Fix common LLM hallucinations
  // Fix double key names like {"name": "name": "tool"} -> {"name": "tool"}
  currentJson = currentJson.replace(/([{,]\s*)"([a-zA-Z0-9_]+)"\s*:\s*"\2"\s*:/g, '$1"$2":');
  // Fix unquoted double key names like {name: name: "tool"} -> {name: "tool"}
  currentJson = currentJson.replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:\s*\2\s*:/g, '$1$2:');

  try {
    return JSON.parse(currentJson);
  } catch (e) {
    // Still fails, continue to more complex fixes
  }

  // 1. Clean trailing noise from the end of the string
  let cleaned = currentJson.trim();
  while (cleaned.length > 0 && !/[}\]"0-9a-z]/i.test(cleaned[cleaned.length - 1])) {
    cleaned = cleaned.slice(0, -1).trim();
  }

  // 2. Pre-process to escape control characters in strings and count braces
  let fixedJson = '';
  let openBraces = 0;
  let openBrackets = 0;
  let inString = false;
  let escaped = false;
  let lastBalancedIndex = -1;

  for (let i = 0; i < cleaned.length; i++) {
    const char = cleaned[i];
    
    if (escaped) {
      const validEscapes = ['n', 'r', 't', 'u', '"', '\\', '/'];
      if (validEscapes.includes(char)) {
        if (char === 'u') {
          const next4 = cleaned.substring(i + 1, i + 5);
          const isHex = /^[0-9a-fA-F]{4}$/.test(next4);
          if (isHex) {
            fixedJson += '\\' + char;
          } else {
            fixedJson += '\\\\' + char;
          }
        } else if (['n', 'r', 't'].includes(char)) {
          const nextChar = cleaned[i + 1] || '';
          const isWinPath = /[a-zA-Z]:\\/i.test(cleaned.substring(0, i)) || /[a-zA-Z]:\//i.test(cleaned.substring(0, i));
          if (isWinPath && /^[a-zA-Z0-9]/.test(nextChar)) {
            fixedJson += '\\\\' + char;
          } else {
            fixedJson += '\\' + char;
          }
        } else {
          fixedJson += '\\' + char;
        }
      } else {
        fixedJson += '\\\\' + char;
      }
      escaped = false;
      continue;
    }
    
    if (char === '\\') {
      escaped = true;
      continue;
    }
    
    if (char === '"') {
      inString = !inString;
      fixedJson += char;
      continue;
    }
    
    if (inString) {
      // Escape literal control characters that are invalid in JSON strings
      if (char === '\n') fixedJson += '\\n';
      else if (char === '\r') fixedJson += '\\r';
      else if (char === '\t') fixedJson += '\\t';
      else if (char.charCodeAt(0) < 32) {
        fixedJson += '\\u' + char.charCodeAt(0).toString(16).padStart(4, '0');
      }
      else fixedJson += char;
    } else {
      fixedJson += char;
      if (char === '{') openBraces++;
      if (char === '}') openBraces--;
      if (char === '[') openBrackets++;
      if (char === ']') openBrackets--;
      
      if (openBraces === 0 && openBrackets === 0 && i > 0) {
        lastBalancedIndex = fixedJson.length - 1;
      }
    }
  }

  let tempJson = fixedJson;

  // If we found a point where it was balanced and there is trailing noise or it didn't stay balanced
  if (lastBalancedIndex !== -1 && (openBraces !== 0 || openBrackets !== 0 || fixedJson.length > lastBalancedIndex + 1)) {
    tempJson = fixedJson.substring(0, lastBalancedIndex + 1);
  } else if (openBraces > 0 || openBrackets > 0) {
    // If it never balanced, attempt to close everything that is open
    if (openBrackets > 0) tempJson += ']'.repeat(openBrackets);
    if (openBraces > 0) tempJson += '}'.repeat(openBraces);
  }

  try {
    return JSON.parse(tempJson);
  } catch (e) {
    // Still fails, try one more aggressive approach: remove trailing comma before closing
    let aggressive = fixedJson.trim();
    if (aggressive.endsWith(',')) aggressive = aggressive.slice(0, -1);
    
    // Recount for the aggressive version
    let ob = 0, bk = 0, is = false, esc = false;
    let aggFixed = '';
    for (let i = 0; i < aggressive.length; i++) {
      const char = aggressive[i];
      if (esc) {
        const validEscapes = ['n', 'r', 't', 'u', '"', '\\', '/'];
        if (validEscapes.includes(char)) {
          if (char === 'u') {
            const next4 = aggressive.substring(i + 1, i + 5);
            const isHex = /^[0-9a-fA-F]{4}$/.test(next4);
            if (isHex) {
              aggFixed += '\\' + char;
            } else {
              aggFixed += '\\\\' + char;
            }
          } else if (['n', 'r', 't'].includes(char)) {
            const isWinPath = /[a-zA-Z]:\\/i.test(aggressive) || /[a-zA-Z]:\//i.test(aggressive);
            const nextChar = aggressive[i + 1] || '';
            if (isWinPath && /^[a-zA-Z0-9]/.test(nextChar)) {
              aggFixed += '\\\\' + char;
            } else {
              aggFixed += '\\' + char;
            }
          } else {
            aggFixed += '\\' + char;
          }
        } else {
          aggFixed += '\\\\' + char;
        }
        esc = false;
        continue;
      }
      if (char === '\\') { esc = true; continue; }
      if (char === '"') { is = !is; aggFixed += char; continue; }
      
      if (is) {
        if (char === '\n') aggFixed += '\\n';
        else if (char === '\r') aggFixed += '\\r';
        else if (char === '\t') aggFixed += '\\t';
        else aggFixed += char;
      } else {
        aggFixed += char;
        if (char === '{') ob++;
        if (char === '}') ob--;
        if (char === '[') bk++;
        if (char === ']') bk--;
      }
    }
    
    if (bk > 0) aggFixed += ']'.repeat(bk);
    if (ob > 0) aggFixed += '}'.repeat(ob);
    
    try {
      return JSON.parse(aggFixed);
    } catch (e2) {
      throw e; // Throw original error if all fixes fail
    }
  }
}
