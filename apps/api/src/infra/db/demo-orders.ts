import type { OrderSide, Tier } from '@benzin/shared';
import type { Clock } from '../../domain/entities.js';
import type { Repositories } from '../../ports.js';
import { BANEH_ZONE } from './seed.js';

/**
 * Demo listings for the local/desktop build only (in-memory data is wiped on restart).
 *
 * The marketplace is empty on a fresh launch, so the home screen's price block and the
 * green/red split would have nothing to show. These rows exist purely so the owner can see
 * the province → county cascade, the seller-declared pump fee and the per-place statistics
 * working. `SEED_DEMO_ORDERS=0` turns them off.
 */
interface DemoOrder {
  side: OrderSide;
  tier: Tier;
  litres: number;
  rateToman: number;
  province: string;
  county: string;
  stationName: string;
  note: string;
}

export const DEMO_ORDERS: readonly DemoOrder[] = [
  // کردستان / بانه
  {
    side: 'SELL',
    tier: 'T3000',
    litres: 60,
    rateToman: 450,
    province: 'کردستان',
    county: 'بانه',
    stationName: 'جایگاه شهید کاظمی',
    note: 'سهمیهٔ ماهانه، کارت سوخت تحویل همان‌جا',
  },
  {
    side: 'SELL',
    tier: 'T1500',
    litres: 40,
    rateToman: 300,
    province: 'کردستان',
    county: 'بانه',
    stationName: 'جایگاه مرکزی',
    note: 'فقط عصرها',
  },
  {
    side: 'SELL',
    tier: 'T10000',
    litres: 25,
    rateToman: 900,
    province: 'کردستان',
    county: 'بانه',
    stationName: 'جایگاه آزاد بانه',
    note: '',
  },
  {
    side: 'BUY',
    tier: 'T1500',
    litres: 80,
    rateToman: 350,
    province: 'کردستان',
    county: 'بانه',
    stationName: 'جایگاه شهید کاظمی',
    note: 'برای سفر هفتهٔ آینده',
  },
  {
    side: 'BUY',
    tier: 'T3000',
    litres: 50,
    rateToman: 400,
    province: 'کردستان',
    county: 'بانه',
    stationName: '',
    note: '',
  },
  // تهران / تهران
  {
    side: 'SELL',
    tier: 'T3000',
    litres: 120,
    rateToman: 700,
    province: 'تهران',
    county: 'تهران',
    stationName: 'جایگاه بزرگراه بعثت',
    note: 'تحویل در محل',
  },
  {
    side: 'SELL',
    tier: 'T1500',
    litres: 90,
    rateToman: 500,
    province: 'تهران',
    county: 'تهران',
    stationName: 'جایگاه شهرک غرب',
    note: '',
  },
  {
    side: 'BUY',
    tier: 'T1500',
    litres: 150,
    rateToman: 600,
    province: 'تهران',
    county: 'تهران',
    stationName: '',
    note: 'هر چه بیشتر بهتر',
  },
  {
    side: 'BUY',
    tier: 'T3000',
    litres: 60,
    rateToman: 650,
    province: 'تهران',
    county: 'تهران',
    stationName: '',
    note: '',
  },
  // اصفهان / اصفهان
  {
    side: 'SELL',
    tier: 'T3000',
    litres: 70,
    rateToman: 600,
    province: 'اصفهان',
    county: 'اصفهان',
    stationName: 'جایگاه چهارباغ',
    note: '',
  },
  {
    side: 'BUY',
    tier: 'T1500',
    litres: 45,
    rateToman: 520,
    province: 'اصفهان',
    county: 'اصفهان',
    stationName: '',
    note: '',
  },
  // خراسان رضوی / مشهد
  {
    side: 'SELL',
    tier: 'T10000',
    litres: 100,
    rateToman: 1200,
    province: 'خراسان رضوی',
    county: 'مشهد',
    stationName: 'جایگاه وکیل‌آباد',
    note: 'پمپ آزاد',
  },
];

/**
 * Creates the demo listings for the two known accounts — enough rows that every province and
 * both sides have something to show, few enough that the list still reads like a small town.
 */
export async function applyDemoOrders(repos: Repositories, clock: Clock): Promise<void> {
  const existing = await repos.orders.listAll({
    status: null,
    zoneId: null,
    side: null,
    text: null,
    limit: 1,
    offset: 0,
  });
  if (existing.total > 0) return;

  const owners = await Promise.all([
    repos.users.findByPhone('09187888993'),
    repos.users.findByPhone('09373210545'),
  ]);
  const ownerIds = owners
    .filter((user): user is NonNullable<typeof user> => user !== null)
    .map((user) => user.id);
  if (ownerIds.length === 0) return;

  const now = clock.now();
  for (const [index, demo] of DEMO_ORDERS.entries()) {
    const ownerId = ownerIds[index % ownerIds.length]!;
    await repos.orders.create({
      ownerId,
      side: demo.side,
      tier: demo.tier,
      litres: demo.litres,
      rateToman: demo.rateToman,
      zoneId: BANEH_ZONE.id,
      province: demo.province,
      county: demo.county,
      stationName: demo.stationName || null,
      note: demo.note || null,
      lat: null,
      lng: null,
      deliveryMethod: 'FUEL_CARD',
      expiresAt: new Date(now.getTime() + 36 * 3_600_000),
    });
  }
}
