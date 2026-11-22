require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ready } = require('./database');
const { listCoupons, normalizeCode } = require('./coupons');

function hashCode(code) {
  return crypto.createHash('sha256').update(normalizeCode(code)).digest('hex');
}

async function main() {
  await ready;
  const coupons = await listCoupons();
  const unused = coupons.filter((c) => c.remaining > 0);
  const catalog = {
    version: 1,
    generatedAt: new Date().toISOString(),
    codes: unused.map((c) => ({
      h: hashCode(c.code),
      m: c.durationMonths,
    })),
  };
  const outPath = path.join(__dirname, '..', 'coupons-catalog.json');
  fs.writeFileSync(outPath, JSON.stringify(catalog));
  console.log(`Wrote ${catalog.codes.length} hashed unused coupons to ${outPath}`);
  process.exit(0);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
