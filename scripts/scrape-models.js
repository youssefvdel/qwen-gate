import { chromium } from 'playwright';
import path from 'path';

const PROFILE = path.resolve('qwen_profile');

async function main() {
  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false, args: ['--disable-blink-features=AutomationControlled'],
  });
  const page = await context.newPage();
  await context.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));
  
  await page.goto('https://chat.qwen.ai/settings/model', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  const shells = await page.$$('.model-item-shell');
  const models = [];

  for (const shell of shells) {
    const name = await shell.$eval('button', el => el.textContent.trim());
    
    // Click to expand
    const btn = await shell.$('button');
    await btn.click();
    await page.waitForTimeout(400);

    // Extract parameters
    const features = await shell.$$eval('.model-item-parameter-container .qwen-chat-comp-settings-models-content-feature', items =>
      items.map(el => {
        const label = el.querySelector('.qwen-chat-comp-settings-models-content-feature-label')?.textContent?.trim() || '';
        const value = el.querySelector('.qwen-chat-comp-settings-models-content-feature-value')?.textContent?.trim() || '';
        return { label, value };
      })
    );

    const maxContext = features.find(f => f.label.includes('context'))?.value || '';
    const maxOutput = features.find(f => f.label.includes('generation'))?.value || features.find(f => f.label.includes('summary'))?.value || '';
    const modality = features.find(f => f.label.includes('Modality'))?.value || 'text';

    models.push({
      id: name.toLowerCase().replace(/[\s.-]+/g, '-').replace(/-$/, ''),
      name,
      max_context: maxContext,
      max_output: maxOutput,
      modality: modality.split(',').map(s => s.trim()),
    });

    // Collapse back
    await btn.click();
    await page.waitForTimeout(200);
  }

  console.log(JSON.stringify(models, null, 2));
  await context.close();
}

main().catch(console.error);
