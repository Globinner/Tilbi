/**
 * Tilbi Subscription Management
 * Handles license validation, authentication, and subscription status
 */
const https = require('https');
const http = require('http');
const { app } = require('electron');
const Store = require('electron-store');
const os = require('os');

const store = new Store({ name: 'clipboard-history' });

// Configuration
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3001';
const DEVICE_ID = getDeviceId();

// Get unique device ID
function getDeviceId() {
  let deviceId = store.get('deviceId');
  if (!deviceId) {
    // Generate device ID based on machine info
    const machineId = os.hostname() + os.platform() + os.arch();
    deviceId = require('crypto').createHash('sha256').update(machineId).digest('hex').substring(0, 32);
    store.set('deviceId', deviceId);
  }
  return deviceId;
}

// Get device name
function getDeviceName() {
  return os.hostname() || 'Unknown Device';
}

// Make API request
async function apiRequest(endpoint, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(endpoint, API_BASE_URL);
    const protocol = url.protocol === 'https:' ? https : http;
    
    const req = protocol.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: options.method || 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': options.token ? `Bearer ${options.token}` : undefined,
        ...options.headers
      }
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(json.error || `HTTP ${res.statusCode}`));
          }
        } catch (error) {
          reject(new Error(`Invalid JSON response: ${data}`));
        }
      });
    });

    req.on('error', reject);
    
    if (options.body) {
      req.write(JSON.stringify(options.body));
    }
    
    req.end();
  });
}

// Authentication
async function login(email, password) {
  try {
    const response = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: { email, password }
    });
    
    if (response.success && response.token) {
      store.set('authToken', response.token);
      store.set('userEmail', email);
      store.set('userId', response.user.id);
      return { success: true, user: response.user, token: response.token };
    }
    
    throw new Error('Invalid response from server');
  } catch (error) {
    return { success: false, error: error.message };
  }
}

async function register(email, password) {
  try {
    const response = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: { email, password }
    });
    
    if (response.success && response.token) {
      store.set('authToken', response.token);
      store.set('userEmail', email);
      store.set('userId', response.user.id);
      return { success: true, user: response.user, token: response.token };
    }
    
    throw new Error('Invalid response from server');
  } catch (error) {
    return { success: false, error: error.message };
  }
}

function logout() {
  store.delete('authToken');
  store.delete('userEmail');
  store.delete('userId');
  store.delete('subscriptionStatus');
}

function isAuthenticated() {
  return !!store.get('authToken');
}

function getAuthToken() {
  return store.get('authToken');
}

// License validation
async function validateLicense() {
  const token = getAuthToken();
  if (!token) {
    return { valid: false, reason: 'Not authenticated' };
  }

  try {
    const response = await apiRequest('/api/license/validate', {
      method: 'POST',
      token,
      body: {
        deviceId: DEVICE_ID,
        deviceName: getDeviceName()
      }
    });

    if (response.valid) {
      // Store validation result with server timestamp
      store.set('subscriptionStatus', {
        valid: true,
        planType: response.subscription.planType,
        expiresAt: response.subscription.expiresAt,
        cancelAtPeriodEnd: response.subscription.cancelAtPeriodEnd,
        lastValidatedAt: response.serverTime || new Date().toISOString(), // Server's time, not local!
        lastValidatedOnline: true
      });
      
      // Store last successful validation timestamp
      store.set('lastValidationTime', Date.now());
    } else {
      store.set('subscriptionStatus', {
        valid: false,
        reason: response.reason,
        expiresAt: response.expiresAt,
        lastValidatedAt: response.serverTime || new Date().toISOString(),
        lastValidatedOnline: true
      });
    }

    return response;
  } catch (error) {
    console.error('License validation error:', error);
    
    // Offline grace period - but with security checks
    const lastStatus = store.get('subscriptionStatus');
    const lastValidationTime = store.get('lastValidationTime');
    
    if (lastStatus && lastStatus.valid && lastValidationTime) {
      // Check if last validation was recent (within 7 days)
      const daysSinceValidation = (Date.now() - lastValidationTime) / (1000 * 60 * 60 * 24);
      
      if (daysSinceValidation > 7) {
        // Too long offline - require online validation
        return { 
          valid: false, 
          reason: 'Online validation required. Please connect to internet.',
          requiresOnline: true
        };
      }
      
      // Check expiry using server-provided expiry date (not local clock!)
      const expiresAt = new Date(lastStatus.expiresAt);
      const now = new Date();
      
      // Use server time if available, otherwise estimate based on last validation
      if (lastStatus.lastValidatedAt) {
        const serverTimeWhenValidated = new Date(lastStatus.lastValidatedAt);
        const timeSinceValidation = now.getTime() - lastValidationTime;
        const estimatedServerTime = new Date(serverTimeWhenValidated.getTime() + timeSinceValidation);
        
        if (expiresAt > estimatedServerTime) {
          return { 
            valid: true, 
            offline: true, 
            subscription: lastStatus,
            warning: 'Offline mode - will require online validation soon'
          };
        }
      } else {
        // Fallback: use local time but warn
        if (expiresAt > now) {
          return { 
            valid: true, 
            offline: true, 
            subscription: lastStatus,
            warning: 'Offline mode - please connect to internet to verify subscription'
          };
        }
      }
    }
    
    return { valid: false, reason: 'Validation failed: ' + error.message, requiresOnline: true };
  }
}

// Get subscription status
async function getSubscriptionStatus() {
  const token = getAuthToken();
  if (!token) {
    return { subscription: null };
  }

  try {
    const response = await apiRequest('/api/subscription', {
      method: 'GET',
      token
    });
    
    if (response.subscription) {
      store.set('subscriptionStatus', {
        valid: response.subscription.status === 'active',
        planType: response.subscription.planType,
        expiresAt: response.subscription.currentPeriodEnd,
        cancelAtPeriodEnd: response.subscription.cancelAtPeriodEnd
      });
    }
    
    return response;
  } catch (error) {
    console.error('Get subscription error:', error);
    return { subscription: null, error: error.message };
  }
}

// Create subscription checkout
async function createSubscription(planType) {
  const token = getAuthToken();
  if (!token) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    const response = await apiRequest('/api/subscription/create', {
      method: 'POST',
      token,
      body: { planType }
    });
    
    return { success: true, checkoutUrl: response.checkoutUrl };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Cancel subscription
async function cancelSubscription(cancelImmediately = false) {
  const token = getAuthToken();
  if (!token) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    const response = await apiRequest('/api/subscription/cancel', {
      method: 'POST',
      token,
      body: { cancelImmediately }
    });
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Resume subscription
async function resumeSubscription() {
  const token = getAuthToken();
  if (!token) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    const response = await apiRequest('/api/subscription/resume', {
      method: 'POST',
      token
    });
    
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

// Get billing portal URL
async function getBillingPortalUrl() {
  const token = getAuthToken();
  if (!token) {
    return { success: false, error: 'Not authenticated' };
  }

  try {
    const response = await apiRequest('/api/subscription/billing-portal', {
      method: 'POST',
      token
    });
    
    return { success: true, url: response.url };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

module.exports = {
  login,
  register,
  logout,
  isAuthenticated,
  getAuthToken,
  validateLicense,
  getSubscriptionStatus,
  createSubscription,
  cancelSubscription,
  resumeSubscription,
  getBillingPortalUrl,
  getDeviceId: () => DEVICE_ID,
  getDeviceName
};

