require('dotenv').config();
const { ready } = require('./database');
const { generateCoupons, listCoupons } = require('./coupons');

async function main() {
  const months = Number(process.argv[2]);
  const count = Number(process.argv[3] || 1);

  if (process.argv[2] === 'list') {
    await ready;
    const coupons = await listCoupons();
    if (!coupons.length) {
      console.log('No coupons yet. Generate with: node generate-coupons.js 3 5');
      process.exit(0);
    }
    console.log('code\tmonths\tused\tremaining');
    coupons.forEach((c) => {
      console.log(`${c.code}\t${c.durationMonths}\t${c.redemptionCount}/${c.maxRedemptions}\t${c.remaining}`);
    });
    process.exit(0);
  }

  if (![3, 6, 12].includes(months) || !Number.isFinite(count) || count < 1) {
    console.error('Usage:');
    console.error('  node generate-coupons.js <3|6|12> [count]');
    console.error('  node generate-coupons.js list');
    console.error('');
    console.error('Examples:');
    console.error('  node generate-coupons.js 3 10    # ten 3-month codes');
    console.error('  node generate-coupons.js 6 5     # five 6-month codes');
    console.error('  node generate-coupons.js 12 5    # five 1-year codes');
    process.exit(1);
  }

  await ready;
  const created = await generateCoupons(months, count);
  console.log(`Created ${created.length} coupon(s) for ${created[0].label}:`);
  created.forEach((c) => console.log(c.code));
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
