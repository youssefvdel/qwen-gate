/**
 * Discovery script: Navigate to chat.qwen.ai/settings/personalization
 * using the existing authenticated browser profile, intercept all API calls,
 * and extract the exact payload keys for personalization toggles.
 */
import { chromium } from 'playwright';
import path from 'path';
import fs from 'fs';

const profilePath = path.resolve('qwen_profile');

async function main() {
  console.log('[Discover] Launching browser with existing profile...');
  
  const context = await chromium.launchPersistentContext(profilePath, {
    headless: true,
    channel: undefined,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
    ignoreDefaultArgs: ['--enable-automation'],
    args: ['--disable-blink-features=AutomationControlled'],
  });

  const page = await context.newPage();
  
  // Capture ALL network requests to settings endpoints
  const settingsRequests: Array<{ url: string; method: string; body: string; timestamp: string }> = [];
  const settingsResponses: Array<{ url: string; status: number; body: string; timestamp: string }> = [];
  
  // Intercept settings/update requests
  page.on('request', (request) => {
    const url = request.url();
    if (url.includes('settings') || url.includes('personalization') || url.includes('user')) {
      const entry = {
        url,
        method: request.method(),
        body: request.postData() || '',
        timestamp: new Date().toISOString(),
      };
      settingsRequests.push(entry);
      console.log(`[REQ] ${request.method()} ${url}`);
      if (request.postData()) {
        console.log(`  Body: ${request.postData()}`);
      }
    }
  });

  page.on('response', async (response) => {
    const url = response.url();
    if (url.includes('settings') || url.includes('personalization') || url.includes('user')) {
      try {
        const body = await response.text();
        settingsResponses.push({
          url,
          status: response.status(),
          body: body.substring(0, 5000),
          timestamp: new Date().toISOString(),
        });
        console.log(`[RES] ${response.status()} ${url}`);
        console.log(`  Body preview: ${body.substring(0, 500)}`);
      } catch {}
    }
  });

  // Navigate to personalization settings
  console.log('[Discover] Navigating to settings/personalization...');
  await page.goto('https://chat.qwen.ai/settings/personalization', { 
    waitUntil: 'networkidle',
    timeout: 60000 
  });

  // Wait for page to fully load
  await page.waitForTimeout(5000);

  console.log('[Discover] Page loaded. URL:', page.url());

  // Check if we're on a login page
  const isLogin = page.url().includes('login');
  if (isLogin) {
    console.error('[Discover] ERROR: Redirected to login page. Session expired.');
    await context.close();
    process.exit(1);
  }

  // Extract page content and structure
  console.log('[Discover] Extracting page structure...');
  const pageData = await page.evaluate(() => {
    // Get all toggle/switch elements
    const toggles: Array<{
      label: string;
      checked: boolean | null;
      ariaChecked: string | null;
      role: string | null;
      id: string;
      name: string;
      dataAttrs: Record<string, string>;
    }> = [];

    // Find all elements that look like toggles/switches
    const allInputs = document.querySelectorAll('input[type="checkbox"], [role="switch"], [role="checkbox"], button[class*="toggle"], button[class*="switch"], [class*="toggle"], [class*="switch"]');
    
    allInputs.forEach((el) => {
      const htmlEl = el as HTMLElement;
      const inputEl = el as HTMLInputElement;
      const label = htmlEl.getAttribute('aria-label') 
        || htmlEl.closest('label')?.textContent?.trim()
        || htmlEl.parentElement?.textContent?.trim().substring(0, 100)
        || '';
      
      const dataAttrs: Record<string, string> = {};
      for (const attr of htmlEl.attributes) {
        if (attr.name.startsWith('data-')) {
          dataAttrs[attr.name] = attr.value;
        }
      }

      toggles.push({
        label: label || '',
        checked: inputEl.checked ?? null,
        ariaChecked: htmlEl.getAttribute('aria-checked'),
        role: htmlEl.getAttribute('role'),
        id: htmlEl.id || '',
        name: inputEl.name || '',
        dataAttrs,
      });
    });

    // Get all text content to identify toggle labels
    const allText: string[] = [];
    document.querySelectorAll('h1, h2, h3, h4, h5, h6, p, span, label, div').forEach(el => {
      const text = el.textContent?.trim();
      if (text && text.length < 200 && text.length > 2) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          allText.push(text);
        }
      }
    });

    // Try to find React fiber/state
    let reactState: any = null;
    try {
      const rootEl = document.getElementById('root') || document.getElementById('__next') || document.querySelector('[data-reactroot]');
      if (rootEl) {
        const fiberKey = Object.keys(rootEl).find(k => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
        if (fiberKey) {
          reactState = 'React fiber found (key: ' + fiberKey + ')';
        }
      }
    } catch {}

    // Get all script tags with inline data
    const scriptData: string[] = [];
    document.querySelectorAll('script:not([src])').forEach(script => {
      const text = script.textContent || '';
      if (text.includes('settings') || text.includes('personalization') || text.includes('memory') || text.includes('history')) {
        scriptData.push(text.substring(0, 2000));
      }
    });

    return { toggles, allText: [...new Set(allText)].slice(0, 200), reactState, scriptData };
  });

  console.log('\n========== TOGGLES FOUND ==========');
  console.log(JSON.stringify(pageData.toggles, null, 2));
  
  console.log('\n========== PAGE TEXT (filtered) ==========');
  const relevantText = pageData.allText.filter(t => 
    t.toLowerCase().includes('memory') || 
    t.toLowerCase().includes('memories') || 
    t.toLowerCase().includes('history') || 
    t.toLowerCase().includes('advanced') ||
    t.toLowerCase().includes('reference') ||
    t.toLowerCase().includes('personalization') ||
    t.toLowerCase().includes('save') ||
    t.toLowerCase().includes('chat')
  );
  console.log(JSON.stringify(relevantText, null, 2));

  console.log('\n========== REACT STATE ==========');
  console.log(pageData.reactState);

  console.log('\n========== SCRIPT DATA ==========');
  console.log(JSON.stringify(pageData.scriptData, null, 2));

  // Now try to find and interact with the memory/history toggles to capture the API call
  console.log('\n========== ATTEMPTING TOGGLE INTERACTION ==========');
  
  // Try clicking toggles that match our target labels
  const targetLabels = ['memory', 'memories', 'history', 'advanced'];
  
  for (const targetLabel of targetLabels) {
    try {
      // Find elements containing the target text
      const elements = await page.$$eval('*', (els, label) => {
        return els
          .filter(el => {
            const text = el.textContent?.toLowerCase() || '';
            return text.includes(label) && el.getBoundingClientRect().height > 0;
          })
          .map(el => ({
            tag: el.tagName,
            text: el.textContent?.trim().substring(0, 100),
            className: el.className?.toString().substring(0, 100),
            id: el.id,
            rect: el.getBoundingClientRect(),
          }));
      }, targetLabel);
      
      if (elements.length > 0) {
        console.log(`\nElements matching "${targetLabel}":`);
        elements.slice(0, 5).forEach(el => {
          console.log(`  <${el.tag}> "${el.text}" class="${el.className}" id="${el.id}"`);
        });
      }
    } catch (err: any) {
      console.log(`Error searching for "${targetLabel}": ${err.message}`);
    }
  }

  // Try to extract settings via API directly
  console.log('\n========== FETCHING CURRENT SETTINGS ==========');
  const currentSettings = await page.evaluate(async () => {
    try {
      const res = await fetch('/api/v2/users/user/settings', {
        headers: { 'accept': 'application/json' }
      });
      if (res.ok) {
        return await res.json();
      }
      return { error: `Status ${res.status}`, text: await res.text() };
    } catch (err: any) {
      return { error: err.message };
    }
  });
  console.log(JSON.stringify(currentSettings, null, 2));

  // Also try the user profile endpoint
  const userProfile = await page.evaluate(async () => {
    try {
      const res = await fetch('/api/v2/users/user', {
        headers: { 'accept': 'application/json' }
      });
      if (res.ok) {
        return await res.json();
      }
      return { error: `Status ${res.status}` };
    } catch (err: any) {
      return { error: err.message };
    }
  });
  console.log('\n========== USER PROFILE ==========');
  console.log(JSON.stringify(userProfile, null, 2));

  // Save all captured data
  const output = {
    settingsRequests,
    settingsResponses,
    pageData,
    currentSettings,
    userProfile,
    timestamp: new Date().toISOString(),
  };

  const outputPath = path.resolve('scripts/discovery-output.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(`\n[Discover] Full output saved to: ${outputPath}`);

  await context.close();
  console.log('[Discover] Done.');
}

main().catch(err => {
  console.error('[Discover] Fatal error:', err);
  process.exit(1);
});
