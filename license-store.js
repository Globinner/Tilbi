const Store = require('electron-store');

const LICENSE_KEYS = [
  'authToken',
  'userEmail',
  'userId',
  'localCoupon',
  'redeemedCouponHashes',
  'subscriptionStatus',
  'lastValidationTime',
  'trialStartedAt',
  'deviceId',
];

const licenseStore = new Store({ name: 'tilbi-license' });

function migrateFromClipboardStore() {
  try {
    const clipboardStore = new Store({ name: 'clipboard-history' });
    LICENSE_KEYS.forEach((key) => {
      if (licenseStore.has(key)) return;
      if (!clipboardStore.has(key)) return;
      licenseStore.set(key, clipboardStore.get(key));
    });
  } catch (_) {}
}

module.exports = {
  licenseStore,
  LICENSE_KEYS,
  migrateFromClipboardStore,
};
