const { dbHelpers } = require('./database');

const PAYPAL_API =
  process.env.PAYPAL_MODE === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com';

const PLANS = {
  monthly: {
    planId: process.env.PAYPAL_MONTHLY_PLAN_ID || '',
    amount: 5.00,
    currency: 'USD',
    interval: 'month',
  },
  yearly: {
    planId: process.env.PAYPAL_YEARLY_PLAN_ID || '',
    amount: 29.00,
    currency: 'USD',
    interval: 'year',
  },
};

let cachedToken = null;
let tokenExpiresAt = 0;

async function getAccessToken() {
  if (cachedToken && Date.now() < tokenExpiresAt - 60000) {
    return cachedToken;
  }

  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('PayPal credentials not configured (PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET)');
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const response = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error_description || data.message || 'PayPal auth failed');
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  return cachedToken;
}

async function paypalRequest(path, options = {}) {
  const token = await getAccessToken();
  const response = await fetch(`${PAYPAL_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });

  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = { raw: text };
    }
  }

  if (!response.ok) {
    const message =
      data.message ||
      data.error_description ||
      (Array.isArray(data.details) && data.details[0]?.description) ||
      `PayPal API error (${response.status})`;
    throw new Error(message);
  }

  return data;
}

function mapPayPalStatus(status) {
  switch ((status || '').toUpperCase()) {
    case 'ACTIVE':
      return 'active';
    case 'APPROVAL_PENDING':
    case 'APPROVED':
      return 'trialing';
    case 'SUSPENDED':
      return 'past_due';
    case 'CANCELLED':
    case 'EXPIRED':
      return 'canceled';
    default:
      return 'canceled';
  }
}

function planTypeFromPlanId(planId) {
  if (planId && planId === PLANS.yearly.planId) return 'yearly';
  return 'monthly';
}

function subscriptionPeriod(subscription, planType) {
  const start = subscription.start_time || subscription.create_time || new Date().toISOString();
  const nextBilling = subscription.billing_info?.next_billing_time;
  if (nextBilling) {
    return {
      currentPeriodStart: new Date(start).toISOString(),
      currentPeriodEnd: new Date(nextBilling).toISOString(),
    };
  }

  const startDate = new Date(start);
  const endDate = new Date(startDate);
  if (planType === 'yearly') {
    endDate.setFullYear(endDate.getFullYear() + 1);
  } else {
    endDate.setMonth(endDate.getMonth() + 1);
  }

  return {
    currentPeriodStart: startDate.toISOString(),
    currentPeriodEnd: endDate.toISOString(),
  };
}

async function createCheckoutSubscription(userId, planType, successUrl, cancelUrl) {
  const plan = PLANS[planType];
  if (!plan?.planId) {
    throw new Error(
      `PayPal plan not configured for "${planType}". Set PAYPAL_${planType.toUpperCase()}_PLAN_ID in server/.env`
    );
  }

  const subscription = await paypalRequest('/v1/billing/subscriptions', {
    method: 'POST',
    body: JSON.stringify({
      plan_id: plan.planId,
      custom_id: String(userId),
      application_context: {
        brand_name: 'Tilbi',
        locale: 'en-US',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        payment_method: {
          payer_selected: 'PAYPAL',
          payee_preferred: 'IMMEDIATE_PAYMENT_REQUIRED',
        },
        return_url: successUrl,
        cancel_url: cancelUrl,
      },
    }),
  });

  const approveLink = (subscription.links || []).find((link) => link.rel === 'approve');
  if (!approveLink?.href) {
    throw new Error('PayPal did not return an approval URL');
  }

  return {
    subscriptionId: subscription.id,
    approveUrl: approveLink.href,
    status: subscription.status,
  };
}

async function getSubscription(subscriptionId) {
  return paypalRequest(`/v1/billing/subscriptions/${subscriptionId}`, { method: 'GET' });
}

async function cancelSubscription(subscriptionId, reason = 'User requested cancellation') {
  return paypalRequest(`/v1/billing/subscriptions/${subscriptionId}/cancel`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

async function activateSubscription(subscriptionId, reason = 'User resumed subscription') {
  return paypalRequest(`/v1/billing/subscriptions/${subscriptionId}/activate`, {
    method: 'POST',
    body: JSON.stringify({ reason }),
  });
}

async function syncSubscriptionRecord(subscription, userIdOverride) {
  const userId = userIdOverride || parseInt(subscription.custom_id, 10);
  if (!userId) {
    console.error('PayPal subscription missing custom_id (userId):', subscription.id);
    return;
  }

  const planId = subscription.plan_id;
  const planType = planTypeFromPlanId(planId);
  const status = mapPayPalStatus(subscription.status);
  const { currentPeriodStart, currentPeriodEnd } = subscriptionPeriod(subscription, planType);

  const subscriptionData = {
    paymentProvider: 'paypal',
    paypalSubscriptionId: subscription.id,
    planType,
    status,
    currentPeriodStart,
    currentPeriodEnd,
    cancelAtPeriodEnd: subscription.status === 'CANCELLED',
  };

  const existing = await dbHelpers.getSubscriptionByPayPalId(subscription.id);
  if (existing) {
    await dbHelpers.updatePayPalSubscription(subscription.id, subscriptionData);
  } else {
    await dbHelpers.createSubscription(userId, subscriptionData);
  }
}

async function verifyWebhook(req) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) {
    throw new Error('PAYPAL_WEBHOOK_ID not configured');
  }

  const transmissionId = req.headers['paypal-transmission-id'];
  const transmissionTime = req.headers['paypal-transmission-time'];
  const certUrl = req.headers['paypal-cert-url'];
  const authAlgo = req.headers['paypal-auth-algo'];
  const transmissionSig = req.headers['paypal-transmission-sig'];

  const result = await paypalRequest('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    body: JSON.stringify({
      auth_algo: authAlgo,
      cert_url: certUrl,
      transmission_id: transmissionId,
      transmission_sig: transmissionSig,
      transmission_time: transmissionTime,
      webhook_id: webhookId,
      webhook_event: req.body,
    }),
  });

  if (result.verification_status !== 'SUCCESS') {
    throw new Error('PayPal webhook signature verification failed');
  }

  return true;
}

async function handleWebhookEvent(event) {
  const eventType = event.event_type;
  const resource = event.resource || {};

  switch (eventType) {
    case 'BILLING.SUBSCRIPTION.ACTIVATED':
    case 'BILLING.SUBSCRIPTION.UPDATED':
    case 'BILLING.SUBSCRIPTION.RE-ACTIVATED':
      await syncSubscriptionRecord(resource);
      break;
    case 'BILLING.SUBSCRIPTION.CANCELLED':
    case 'BILLING.SUBSCRIPTION.EXPIRED':
    case 'BILLING.SUBSCRIPTION.SUSPENDED':
      await syncSubscriptionRecord(resource);
      break;
    case 'PAYMENT.SALE.COMPLETED': {
      const userId = parseInt(resource.custom, 10) || parseInt(resource.custom_id, 10);
      if (userId && resource.id) {
        await dbHelpers.recordPayment(userId, {
          paymentProvider: 'paypal',
          externalPaymentId: resource.id,
          amount: Math.round(parseFloat(resource.amount?.total || '0') * 100),
          currency: (resource.amount?.currency || 'USD').toLowerCase(),
          status: resource.state === 'completed' ? 'succeeded' : resource.state,
        });
      }
      break;
    }
    default:
      break;
  }
}

module.exports = {
  PLANS,
  createCheckoutSubscription,
  getSubscription,
  cancelSubscription,
  activateSubscription,
  syncSubscriptionRecord,
  verifyWebhook,
  handleWebhookEvent,
};
