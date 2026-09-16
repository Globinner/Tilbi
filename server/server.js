require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { authenticateToken, registerUser, loginUser } = require('./auth');
const { dbHelpers } = require('./database');
const stripeHelpers = require('./stripe');
const paypalHelpers = require('./paypal');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { body, validationResult } = require('express-validator');

const app = express();
const PORT = process.env.PORT || 3001;
const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

function subscriptionResponse(subscription) {
  return {
    id: subscription.id,
    provider: subscription.payment_provider || 'stripe',
    planType: subscription.plan_type,
    status: subscription.status,
    currentPeriodStart: subscription.current_period_start,
    currentPeriodEnd: subscription.current_period_end,
    cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
    stripeSubscriptionId: subscription.stripe_subscription_id || null,
    paypalSubscriptionId: subscription.paypal_subscription_id || null,
  };
}

// Stripe webhooks need raw body — register before JSON parser
app.post(
  '/api/webhooks/stripe',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } catch (err) {
      console.error('Webhook signature verification failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    try {
      await stripeHelpers.handleWebhookEvent(event);
      res.json({ received: true });
    } catch (error) {
      console.error('Webhook handler error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    payments: {
      stripe: !!process.env.STRIPE_SECRET_KEY,
      paypal: !!(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET),
    },
    timestamp: new Date().toISOString(),
  });
});

// PayPal return pages (after user approves subscription)
app.get('/paypal/success', (req, res) => {
  res.send(
    '<html><body style="font-family:sans-serif;text-align:center;padding:40px;">' +
      '<h1>Payment approved</h1><p>You can close this window and return to Tilbi.</p>' +
      '</body></html>'
  );
});

app.get('/paypal/cancel', (req, res) => {
  res.send(
    '<html><body style="font-family:sans-serif;text-align:center;padding:40px;">' +
      '<h1>Payment canceled</h1><p>No charge was made. Return to Tilbi to try again.</p>' +
      '</body></html>'
  );
});

// ============================================================================
// AUTHENTICATION ROUTES
// ============================================================================

app.post(
  '/api/auth/register',
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 8 }),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password } = req.body;
      const result = await registerUser(email, password);
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  }
);

app.post(
  '/api/auth/login',
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { email, password } = req.body;
      const result = await loginUser(email, password);
      res.json({ success: true, ...result });
    } catch (error) {
      res.status(401).json({ error: error.message });
    }
  }
);

app.get('/api/auth/me', authenticateToken, async (req, res) => {
  try {
    const user = await dbHelpers.getUserById(req.userId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user: { id: user.id, email: user.email } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/plans', (req, res) => {
  res.json({
    plans: {
      monthly: { id: 'monthly', label: 'Monthly', amount: 5, currency: 'usd', interval: 'month' },
      yearly: { id: 'yearly', label: 'Yearly', amount: 29, currency: 'usd', interval: 'year' },
    },
  });
});

// ============================================================================
// SUBSCRIPTION ROUTES
// ============================================================================

app.get('/api/subscription', authenticateToken, async (req, res) => {
  try {
    const subscription = await dbHelpers.getActiveSubscription(req.userId);
    if (!subscription) {
      return res.json({ subscription: null });
    }

    if ((subscription.payment_provider || 'stripe') === 'stripe' && subscription.stripe_subscription_id) {
      await stripeHelpers.getSubscription(subscription.stripe_subscription_id);
    }

    res.json({ subscription: subscriptionResponse(subscription) });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create subscription checkout — provider: 'stripe' | 'paypal'
app.post('/api/subscription/create', authenticateToken, async (req, res) => {
  try {
    const { planType, provider = 'stripe' } = req.body;

    if (!planType || !['monthly', 'yearly'].includes(planType)) {
      return res.status(400).json({ error: 'Invalid plan type' });
    }

    if (!['stripe', 'paypal'].includes(provider)) {
      return res.status(400).json({ error: 'Invalid payment provider. Use stripe or paypal.' });
    }

    if (provider === 'paypal') {
      const result = await paypalHelpers.createCheckoutSubscription(
        req.userId,
        planType,
        `${APP_BASE_URL}/paypal/success?plan=${planType}`,
        `${APP_BASE_URL}/paypal/cancel`
      );

      return res.json({
        provider: 'paypal',
        checkoutUrl: result.approveUrl,
        subscriptionId: result.subscriptionId,
      });
    }

    const user = await dbHelpers.getUserById(req.userId);

    let customerId;
    const existingSubscription = await dbHelpers.getActiveSubscription(req.userId);
    if (existingSubscription?.stripe_customer_id) {
      customerId = existingSubscription.stripe_customer_id;
    } else {
      const customer = await stripeHelpers.createCustomer(user.email, req.userId);
      customerId = customer.id;
    }

    const session = await stripeHelpers.createCheckoutSession(
      customerId,
      planType,
      `${APP_BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
      `${APP_BASE_URL}/cancel`
    );

    res.json({
      provider: 'stripe',
      checkoutUrl: session.url,
      sessionId: session.id,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/subscription/cancel', authenticateToken, async (req, res) => {
  try {
    const { cancelImmediately } = req.body;
    const subscription = await dbHelpers.getActiveSubscription(req.userId);

    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    if ((subscription.payment_provider || 'stripe') === 'paypal') {
      await paypalHelpers.cancelSubscription(subscription.paypal_subscription_id);
    } else {
      await stripeHelpers.cancelSubscription(
        subscription.stripe_subscription_id,
        cancelImmediately === true
      );
    }

    res.json({ success: true, message: 'Subscription canceled' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/subscription/resume', authenticateToken, async (req, res) => {
  try {
    const subscription = await dbHelpers.getActiveSubscription(req.userId);

    if (!subscription) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    if ((subscription.payment_provider || 'stripe') === 'paypal') {
      await paypalHelpers.activateSubscription(subscription.paypal_subscription_id);
    } else {
      await stripeHelpers.resumeSubscription(subscription.stripe_subscription_id);
    }

    res.json({ success: true, message: 'Subscription resumed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/subscription/billing-portal', authenticateToken, async (req, res) => {
  try {
    const subscription = await dbHelpers.getActiveSubscription(req.userId);

    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    if ((subscription.payment_provider || 'stripe') === 'paypal') {
      return res.json({
        url: 'https://www.paypal.com/myaccount/autopay/',
        provider: 'paypal',
        message: 'Manage your PayPal subscription in your PayPal account.',
      });
    }

    const session = await stripeHelpers.createBillingPortalSession(
      subscription.stripe_customer_id,
      `${APP_BASE_URL}/billing`
    );

    res.json({ url: session.url, provider: 'stripe' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Confirm PayPal subscription after user returns from PayPal (optional sync)
app.post('/api/subscription/paypal/confirm', authenticateToken, async (req, res) => {
  try {
    const { subscriptionId } = req.body;
    if (!subscriptionId) {
      return res.status(400).json({ error: 'subscriptionId required' });
    }

    const paypalSubscription = await paypalHelpers.getSubscription(subscriptionId);
    if (String(paypalSubscription.custom_id) !== String(req.userId)) {
      return res.status(403).json({ error: 'Subscription does not belong to this user' });
    }

    await paypalHelpers.syncSubscriptionRecord(paypalSubscription, req.userId);
    const local = await dbHelpers.getSubscriptionByPayPalId(subscriptionId);

    res.json({
      success: true,
      subscription: local ? subscriptionResponse(local) : null,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// LICENSE VALIDATION ROUTES
// ============================================================================

app.post('/api/license/validate', authenticateToken, async (req, res) => {
  try {
    const { deviceId, deviceName } = req.body;

    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID required' });
    }

    const subscription = await dbHelpers.getActiveSubscription(req.userId);

    if (!subscription || subscription.status !== 'active') {
      return res.json({
        valid: false,
        reason: 'No active subscription',
        subscription: subscription
          ? {
              status: subscription.status,
              expiresAt: subscription.current_period_end,
              provider: subscription.payment_provider || 'stripe',
            }
          : null,
      });
    }

    const serverNow = new Date();
    const periodEnd = new Date(subscription.current_period_end);
    if (periodEnd < serverNow) {
      return res.json({
        valid: false,
        reason: 'Subscription expired',
        expiresAt: subscription.current_period_end,
        serverTime: serverNow.toISOString(),
      });
    }

    await dbHelpers.registerDevice(req.userId, deviceId, deviceName || 'Unknown Device');
    await dbHelpers.updateLicenseValidation(req.userId, deviceId);

    res.json({
      valid: true,
      subscription: {
        planType: subscription.plan_type,
        expiresAt: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
        provider: subscription.payment_provider || 'stripe',
      },
      serverTime: serverNow.toISOString(),
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// PAYPAL WEBHOOK
// ============================================================================

app.post('/api/webhooks/paypal', async (req, res) => {
  try {
    await paypalHelpers.verifyWebhook(req);
    await paypalHelpers.handleWebhookEvent(req.body);
    res.json({ received: true });
  } catch (error) {
    console.error('PayPal webhook error:', error.message);
    res.status(400).json({ error: error.message });
  }
});

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`🚀 Tilbi Subscription Server running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`💳 Stripe: ${process.env.STRIPE_SECRET_KEY ? 'configured' : 'not configured'}`);
  console.log(
    `💳 PayPal: ${process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET ? process.env.PAYPAL_MODE || 'sandbox' : 'not configured'}`
  );
});
