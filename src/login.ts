import { initPlaywright, closePlaywright, activePage } from './services/playwright.ts';
import { saveCookies } from './services/auth.ts';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  const positionalEmail = process.argv.find((a, i) => i > 1 && !a.startsWith('--') && a.includes('@'));
  const flagEmail = process.argv.find(a => a.startsWith('--email='))?.split('=')[1];
  const email = positionalEmail || flagEmail;

  if (!email) {
    console.error('Usage: npm run login user@example.com');
    console.error('       npm run login -- --email=user@example.com');
    process.exit(1);
  }

  console.log(`[Login] Logging in as ${email}`);
  await initPlaywright(false);
  if (!activePage) {
    console.error('Failed to get active page');
    process.exit(1);
  }

  await activePage.goto('https://chat.qwen.ai/auth', { waitUntil: 'domcontentloaded' });
  console.log('Browser opened. Please login to chat.qwen.ai.');
  console.log('Once you see the chat interface, press ENTER here to save the session.');

  await new Promise<void>(resolve => {
    process.stdin.once('data', () => resolve());
  });

  console.log('[Login] Extracting session data...');
  const cookies = await activePage.context().cookies();
  const tokenCookie = cookies.find(c => c.name === 'token');
  const refreshCookie = cookies.find(c => c.name === 'refresh_token');

  if (!tokenCookie?.value) {
    console.error('No token cookie found. Login may have failed.');
    console.log('Cookies found:', cookies.map(c => c.name).join(', '));
    await closePlaywright();
    process.exit(1);
  }

  await saveCookies(email, tokenCookie.value, refreshCookie?.value || null);
  console.log(`[Login] Session saved for ${email}. You can now use this account.`);
  console.log('To add another account, run again: npm run login other@example.com');
  await closePlaywright();
  process.exit(0);
}

main();
