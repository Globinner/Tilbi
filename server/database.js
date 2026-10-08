const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'tilbi.db');

const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let resolveReady;
const ready = new Promise((resolve) => {
  resolveReady = resolve;
});

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
    resolveReady();
  } else {
    console.log('✅ Connected to SQLite database');
    initializeTables();
  }
});

function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function runMigration(sql) {
  return new Promise((resolve) => {
    db.run(sql, (err) => {
      if (err && !/duplicate column name/i.test(err.message)) {
        console.warn('Migration note:', err.message);
      }
      resolve();
    });
  });
}

async function migrateSubscriptionsPlanTypes() {
  const row = await getAsync(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='subscriptions'`
  );
  const sql = (row && row.sql) || '';
  if (!sql || sql.includes('coupon_3m')) return;

  await runAsync(`
    CREATE TABLE IF NOT EXISTS subscriptions_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      payment_provider TEXT DEFAULT 'stripe',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      paypal_subscription_id TEXT UNIQUE,
      plan_type TEXT NOT NULL CHECK(plan_type IN ('monthly', 'yearly', 'coupon_3m', 'coupon_6m', 'coupon_1y')),
      status TEXT NOT NULL CHECK(status IN ('active', 'canceled', 'past_due', 'trialing')),
      current_period_start DATETIME,
      current_period_end DATETIME,
      cancel_at_period_end BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
  await runAsync(`
    INSERT INTO subscriptions_new (
      id, user_id, payment_provider, stripe_customer_id, stripe_subscription_id,
      paypal_subscription_id, plan_type, status, current_period_start, current_period_end,
      cancel_at_period_end, created_at, updated_at
    )
    SELECT
      id, user_id, COALESCE(payment_provider, 'stripe'), stripe_customer_id, stripe_subscription_id,
      paypal_subscription_id, plan_type, status, current_period_start, current_period_end,
      cancel_at_period_end, created_at, updated_at
    FROM subscriptions
  `);
  await runAsync(`DROP TABLE subscriptions`);
  await runAsync(`ALTER TABLE subscriptions_new RENAME TO subscriptions`);
}

async function migrateSchema() {
  await runMigration(`ALTER TABLE subscriptions ADD COLUMN payment_provider TEXT DEFAULT 'stripe'`);
  await runMigration(`ALTER TABLE subscriptions ADD COLUMN paypal_subscription_id TEXT`);
  await runMigration(`ALTER TABLE payments ADD COLUMN payment_provider TEXT DEFAULT 'stripe'`);
  await runMigration(`ALTER TABLE payments ADD COLUMN external_payment_id TEXT`);
  await migrateSubscriptionsPlanTypes();

  await runAsync(`
    CREATE TABLE IF NOT EXISTS coupons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      duration_months INTEGER NOT NULL CHECK(duration_months IN (3, 6, 12)),
      max_redemptions INTEGER NOT NULL DEFAULT 1,
      redemption_count INTEGER NOT NULL DEFAULT 0,
      expires_at DATETIME,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  await runAsync(`
    CREATE TABLE IF NOT EXISTS coupon_redemptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      coupon_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      subscription_id INTEGER,
      redeemed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(coupon_id, user_id)
    )
  `);
}

function initializeTables() {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      payment_provider TEXT DEFAULT 'stripe',
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      paypal_subscription_id TEXT UNIQUE,
      plan_type TEXT NOT NULL CHECK(plan_type IN ('monthly', 'yearly', 'coupon_3m', 'coupon_6m', 'coupon_1y')),
      status TEXT NOT NULL CHECK(status IN ('active', 'canceled', 'past_due', 'trialing')),
      current_period_start DATETIME,
      current_period_end DATETIME,
      cancel_at_period_end BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS licenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      device_id TEXT NOT NULL,
      device_name TEXT,
      last_validation DATETIME DEFAULT CURRENT_TIMESTAMP,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(user_id, device_id)
    )
  `);

  db.run(
    `
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      payment_provider TEXT DEFAULT 'stripe',
      stripe_payment_intent_id TEXT UNIQUE,
      external_payment_id TEXT,
      amount INTEGER NOT NULL,
      currency TEXT DEFAULT 'usd',
      status TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `,
    (err) => {
      if (err) {
        console.error('❌ Payments table error:', err.message);
      }
      migrateSchema()
        .then(() => {
          console.log('✅ Database tables initialized');
          resolveReady();
        })
        .catch((migrateErr) => {
          console.error('❌ Database migration error:', migrateErr.message);
          resolveReady();
        });
    }
  );
}

const dbHelpers = {
  createUser: (email, passwordHash) => {
    return new Promise((resolve, reject) => {
      db.run(
        'INSERT INTO users (email, password_hash) VALUES (?, ?)',
        [email, passwordHash],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID, email });
        }
      );
    });
  },

  getUserByEmail: (email) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE email = ?', [email], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },

  getUserById: (id) => {
    return new Promise((resolve, reject) => {
      db.get('SELECT * FROM users WHERE id = ?', [id], (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },

  createSubscription: (userId, subscriptionData) => {
    const provider = subscriptionData.paymentProvider || 'stripe';
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO subscriptions
         (user_id, payment_provider, stripe_customer_id, stripe_subscription_id,
          paypal_subscription_id, plan_type, status,
          current_period_start, current_period_end, cancel_at_period_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          provider,
          subscriptionData.stripeCustomerId || null,
          subscriptionData.stripeSubscriptionId || null,
          subscriptionData.paypalSubscriptionId || null,
          subscriptionData.planType,
          subscriptionData.status,
          subscriptionData.currentPeriodStart,
          subscriptionData.currentPeriodEnd,
          subscriptionData.cancelAtPeriodEnd ? 1 : 0,
        ],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        }
      );
    });
  },

  updateSubscription: (stripeSubscriptionId, subscriptionData) => {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE subscriptions
         SET status = ?, current_period_start = ?, current_period_end = ?,
             cancel_at_period_end = ?, updated_at = CURRENT_TIMESTAMP
         WHERE stripe_subscription_id = ?`,
        [
          subscriptionData.status,
          subscriptionData.currentPeriodStart,
          subscriptionData.currentPeriodEnd,
          subscriptionData.cancelAtPeriodEnd ? 1 : 0,
          stripeSubscriptionId,
        ],
        function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes });
        }
      );
    });
  },

  updatePayPalSubscription: (paypalSubscriptionId, subscriptionData) => {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE subscriptions
         SET status = ?, current_period_start = ?, current_period_end = ?,
             cancel_at_period_end = ?, updated_at = CURRENT_TIMESTAMP
         WHERE paypal_subscription_id = ?`,
        [
          subscriptionData.status,
          subscriptionData.currentPeriodStart,
          subscriptionData.currentPeriodEnd,
          subscriptionData.cancelAtPeriodEnd ? 1 : 0,
          paypalSubscriptionId,
        ],
        function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes });
        }
      );
    });
  },

  getSubscriptionByPayPalId: (paypalSubscriptionId) => {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM subscriptions WHERE paypal_subscription_id = ?',
        [paypalSubscriptionId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  },

  getActiveSubscription: (userId) => {
    return new Promise((resolve, reject) => {
      db.get(
        `SELECT * FROM subscriptions
         WHERE user_id = ? AND status IN ('active', 'trialing')
         ORDER BY created_at DESC LIMIT 1`,
        [userId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  },

  registerDevice: (userId, deviceId, deviceName) => {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT OR REPLACE INTO licenses (user_id, device_id, device_name, last_validation)
         VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        [userId, deviceId, deviceName],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        }
      );
    });
  },

  updateLicenseValidation: (userId, deviceId) => {
    return new Promise((resolve, reject) => {
      db.run(
        'UPDATE licenses SET last_validation = CURRENT_TIMESTAMP WHERE user_id = ? AND device_id = ?',
        [userId, deviceId],
        function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes });
        }
      );
    });
  },

  getDeviceLicense: (userId, deviceId) => {
    return new Promise((resolve, reject) => {
      db.get(
        'SELECT * FROM licenses WHERE user_id = ? AND device_id = ?',
        [userId, deviceId],
        (err, row) => {
          if (err) reject(err);
          else resolve(row);
        }
      );
    });
  },

  recordPayment: (userId, paymentData) => {
    const provider = paymentData.paymentProvider || 'stripe';
    const externalId =
      paymentData.externalPaymentId ||
      paymentData.stripePaymentIntentId ||
      paymentData.paypalPaymentId;

    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO payments
         (user_id, payment_provider, stripe_payment_intent_id, external_payment_id, amount, currency, status)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          provider,
          provider === 'stripe' ? externalId : null,
          externalId,
          paymentData.amount,
          paymentData.currency || 'usd',
          paymentData.status,
        ],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        }
      );
    });
  },

  updateSubscriptionById: (subscriptionId, subscriptionData) => {
    return new Promise((resolve, reject) => {
      db.run(
        `UPDATE subscriptions
         SET status = ?, plan_type = ?, current_period_start = ?, current_period_end = ?,
             cancel_at_period_end = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          subscriptionData.status,
          subscriptionData.planType,
          subscriptionData.currentPeriodStart,
          subscriptionData.currentPeriodEnd,
          subscriptionData.cancelAtPeriodEnd ? 1 : 0,
          subscriptionId,
        ],
        function (err) {
          if (err) reject(err);
          else resolve({ changes: this.changes });
        }
      );
    });
  },

  getCouponByCode: (code) => {
    return getAsync('SELECT * FROM coupons WHERE code = ?', [code]);
  },

  listCoupons: () => {
    return allAsync(
      `SELECT id, code, duration_months, max_redemptions, redemption_count, expires_at, notes, created_at
       FROM coupons
       ORDER BY created_at DESC`
    );
  },

  createCoupon: ({ code, durationMonths, maxRedemptions = 1, expiresAt = null, notes = null }) => {
    return runAsync(
      `INSERT INTO coupons (code, duration_months, max_redemptions, expires_at, notes)
       VALUES (?, ?, ?, ?, ?)`,
      [code, durationMonths, maxRedemptions, expiresAt, notes]
    );
  },

  incrementCouponRedemption: (couponId) => {
    return runAsync(
      `UPDATE coupons
       SET redemption_count = redemption_count + 1
       WHERE id = ?
         AND redemption_count < max_redemptions
         AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)`,
      [couponId]
    );
  },

  recordCouponRedemption: ({ couponId, userId, subscriptionId }) => {
    return runAsync(
      `INSERT INTO coupon_redemptions (coupon_id, user_id, subscription_id)
       VALUES (?, ?, ?)`,
      [couponId, userId, subscriptionId]
    );
  },

  getCouponRedemption: (couponId, userId) => {
    return getAsync(
      'SELECT * FROM coupon_redemptions WHERE coupon_id = ? AND user_id = ?',
      [couponId, userId]
    );
  },
};

module.exports = { db, dbHelpers, ready };
