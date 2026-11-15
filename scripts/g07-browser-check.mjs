/**
 * G-07 browser check: traveler switch → radius chips → distance/ETA on the cards, and the
 * map picker on the new-listing form. Runs the production build through `vite preview`.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:5173';
const BANEH = { latitude: 35.9983, longitude: 45.8851 };
const shots = '/home/user/shots';
const log = (...parts) => console.log('•', ...parts);

const browser = await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 420, height: 900 },
  locale: 'fa-IR',
  timezoneId: 'Asia/Tehran',
  geolocation: BANEH,
  permissions: ['geolocation'],
});
const page = await context.newPage();
page.on('console', (message) => {
  if (message.type() === 'error') console.log('  console error:', message.text());
});

const login = async () => {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.getByLabel(/شماره/).first().fill('09187888993');
  await page.getByRole('button').filter({ hasText: /کد|ورود|دریافت/ }).first().click();
  await page.waitForTimeout(600);
  const boxes = page.locator('input[inputmode="numeric"]');
  const count = await boxes.count();
  if (count > 1) {
    for (let index = 0; index < count; index += 1) await boxes.nth(index).fill('12345'[index]);
  } else {
    await boxes.first().fill('12345');
  }
  await page.waitForTimeout(400);
  const verify = page.getByRole('button').filter({ hasText: /تأیید|ورود|تایید/ }).last();
  if (await verify.count()) await verify.click();
  await page.waitForTimeout(1200);
};

await login();
log('logged in, url =', page.url());

// ---------------------------------------------------------------- market + traveler mode
await page.goto(`${BASE}/market`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);

const traveler = page.getByRole('switch', { name: 'محل جست‌وجو' });
await traveler.click();
await page.waitForTimeout(1200);
const checked = await traveler.getAttribute('aria-checked');
log('traveler switch aria-checked =', checked);

const radiusChips = page.getByRole('button').filter({ hasText: /کیلومتر/ });
log('radius chips =', await radiusChips.count());
await radiusChips.first().click();
await page.waitForTimeout(1200);
log('url after radius click =', page.url());

const cards = page.locator('button.card');
log('cards =', await cards.count());
const firstCardText = (await cards.first().innerText()).replace(/\n/g, ' | ');
log('first card =', firstCardText);
log('card shows distance =', /کیلومتر/.test(firstCardText));
log('card shows eta =', /دقیقه/.test(firstCardText));
await page.screenshot({ path: `${shots}/g07-market-traveler.png`, fullPage: false });

// ---------------------------------------------------------------- map picker on the form
await page.goto(`${BASE}/create`, { waitUntil: 'networkidle' });
await page.waitForTimeout(800);
const map = page.getByRole('application');
log('map picker present =', (await map.count()) > 0);
const box = await map.boundingBox();
if (box) {
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.4);
  await page.waitForTimeout(400);
  log('coordinates shown after tap =', /[۰-۹]/.test(await map.locator('..').innerText()));
}
await page.screenshot({ path: `${shots}/g07-map-picker.png`, fullPage: false });

// the picked point must survive into the payload
const payload = [];
page.on('request', (request) => {
  if (request.method() === 'POST' && request.url().endsWith('/v1/orders')) {
    payload.push(request.postData());
  }
});
await page.getByLabel('حجم (لیتر)').fill('20');
await page.getByLabel(/قیمت هر لیتر/).fill('2800');
await page.getByRole('button', { name: /ثبت|درخواست|آگهی/ }).last().click();
await page.waitForTimeout(1800);
log('POST /v1/orders body =', payload[0] ?? '(none)');
log('url after submit =', page.url());
await page.screenshot({ path: `${shots}/g07-after-submit.png`, fullPage: false });

await browser.close();
