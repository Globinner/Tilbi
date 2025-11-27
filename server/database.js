const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'tilbi.db');

// Ensure data directory exists
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

// Initialize database
const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error('❌ Database connection error:', err.message);
  } else {
    console.log('✅ Connected to SQLite database');
    initializeTables();
  }
});

// Initialize database tables
function initializeTables() {
  // Users table
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Subscriptions table
  db.run(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      stripe_customer_id TEXT,
      stripe_subscription_id TEXT UNIQUE,
      plan_type TEXT NOT NULL CHECK(plan_type IN ('monthly', 'yearly')),
      status TEXT NOT NULL CHECK(status IN ('active', 'canceled', 'past_due', 'trialing')),
      current_period_start DATETIME,
      current_period_end DATETIME,
      cancel_at_period_end BOOLEAN DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  // Licenses table (for tracking active installations)
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

  // Payment history table
  db.run(`
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      stripe_payment_intent_id TEXT UNIQUE,
      amount INTEGER NOT NULL,
      currency TEXT DEFAULT 'usd',
      status TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);

  console.log('✅ Database tables initialized');
}

// Database helper functions
const dbHelpers = {
  // User operations
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

  // Subscription operations
  createSubscription: (userId, subscriptionData) => {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO subscriptions 
         (user_id, stripe_customer_id, stripe_subscription_id, plan_type, status, 
          current_period_start, current_period_end, cancel_at_period_end)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          userId,
          subscriptionData.stripeCustomerId,
          subscriptionData.stripeSubscriptionId,
          subscriptionData.planType,
          subscriptionData.status,
          subscriptionData.currentPeriodStart,
          subscriptionData.currentPeriodEnd,
          subscriptionData.cancelAtPeriodEnd || 0
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
          subscriptionData.cancelAtPeriodEnd || 0,
          stripeSubscriptionId
        ],
        function(err) {
          if (err) reject(err);
          else resolve({ changes: this.changes });
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

  // License operations
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

  // Payment operations
  recordPayment: (userId, paymentData) => {
    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO payments (user_id, stripe_payment_intent_id, amount, currency, status)
         VALUES (?, ?, ?, ?, ?)`,
        [
          userId,
          paymentData.stripePaymentIntentId,
          paymentData.amount,
          paymentData.currency || 'usd',
          paymentData.status
        ],
        function(err) {
          if (err) reject(err);
          else resolve({ id: this.lastID });
        }
      );
    });
  }
};

module.exports = { db, dbHelpers };

