require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { authenticateToken, registerUser, loginUser } = require('./auth');
const { dbHelpers } = require('./database');
const stripeHelpers = require('./stripe');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { body, validationResult } = require('express-validator');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ============================================================================
// AUTHENTICATION ROUTES
// ============================================================================

// Register
app.post('/api/auth/register',
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

// Login
app.post('/api/auth/login',
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

// Get current user
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

// ============================================================================
// SUBSCRIPTION ROUTES
// ============================================================================

// Get subscription status
app.get('/api/subscription', authenticateToken, async (req, res) => {
  try {
    const subscription = await dbHelpers.getActiveSubscription(req.userId);
    if (!subscription) {
      return res.json({ subscription: null });
    }

    // Get latest info from Stripe
    const stripeSubscription = await stripeHelpers.getSubscription(subscription.stripe_subscription_id);
    
    res.json({
      subscription: {
        id: subscription.id,
        planType: subscription.plan_type,
        status: subscription.status,
        currentPeriodStart: subscription.current_period_start,
        currentPeriodEnd: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end === 1,
        stripeSubscriptionId: subscription.stripe_subscription_id
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create subscription (start checkout)
app.post('/api/subscription/create', authenticateToken, async (req, res) => {
  try {
    const { planType } = req.body; // 'monthly' or 'yearly'
    
    if (!planType || !['monthly', 'yearly'].includes(planType)) {
      return res.status(400).json({ error: 'Invalid plan type' });
    }

    // Get user
    const user = await dbHelpers.getUserById(req.userId);
    
    // Create or get Stripe customer
    let customerId;
    const existingSubscription = await dbHelpers.getActiveSubscription(req.userId);
    if (existingSubscription) {
      customerId = existingSubscription.stripe_customer_id;
    } else {
      const customer = await stripeHelpers.createCustomer(user.email, req.userId);
      customerId = customer.id;
    }

    // Create checkout session
    const session = await stripeHelpers.createCheckoutSession(
      customerId,
      planType,
      `http://localhost:${PORT}/success?session_id={CHECKOUT_SESSION_ID}`,
      `http://localhost:${PORT}/cancel`
    );

    res.json({ checkoutUrl: session.url, sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Cancel subscription
app.post('/api/subscription/cancel', authenticateToken, async (req, res) => {
  try {
    const { cancelImmediately } = req.body;
    const subscription = await dbHelpers.getActiveSubscription(req.userId);
    
    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    await stripeHelpers.cancelSubscription(
      subscription.stripe_subscription_id,
      cancelImmediately === true
    );

    res.json({ success: true, message: 'Subscription canceled' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Resume subscription
app.post('/api/subscription/resume', authenticateToken, async (req, res) => {
  try {
    const subscription = await dbHelpers.getActiveSubscription(req.userId);
    
    if (!subscription) {
      return res.status(404).json({ error: 'No subscription found' });
    }

    await stripeHelpers.resumeSubscription(subscription.stripe_subscription_id);
    res.json({ success: true, message: 'Subscription resumed' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get billing portal URL
app.post('/api/subscription/billing-portal', authenticateToken, async (req, res) => {
  try {
    const subscription = await dbHelpers.getActiveSubscription(req.userId);
    
    if (!subscription) {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    const session = await stripeHelpers.createBillingPortalSession(
      subscription.stripe_customer_id,
      `http://localhost:${PORT}/billing`
    );

    res.json({ url: session.url });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// LICENSE VALIDATION ROUTES
// ============================================================================

// Validate license
app.post('/api/license/validate', authenticateToken, async (req, res) => {
  try {
    const { deviceId, deviceName } = req.body;
    
    if (!deviceId) {
      return res.status(400).json({ error: 'Device ID required' });
    }

    // Check subscription status
    const subscription = await dbHelpers.getActiveSubscription(req.userId);
    
    if (!subscription || subscription.status !== 'active') {
      return res.json({
        valid: false,
        reason: 'No active subscription',
        subscription: subscription ? {
          status: subscription.status,
          expiresAt: subscription.current_period_end
        } : null
      });
    }

    // Check if subscription is expired (using SERVER time, not client time!)
    const serverNow = new Date();
    const periodEnd = new Date(subscription.current_period_end);
    if (periodEnd < serverNow) {
      return res.json({
        valid: false,
        reason: 'Subscription expired',
        expiresAt: subscription.current_period_end,
        serverTime: serverNow.toISOString() // Include server time to prevent clock manipulation
      });
    }

    // Register/update device
    await dbHelpers.registerDevice(req.userId, deviceId, deviceName || 'Unknown Device');
    await dbHelpers.updateLicenseValidation(req.userId, deviceId);

    res.json({
      valid: true,
      subscription: {
        planType: subscription.plan_type,
        expiresAt: subscription.current_period_end,
        cancelAtPeriodEnd: subscription.cancel_at_period_end === 1
      },
      serverTime: serverNow.toISOString() // Always include server time in response
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// STRIPE WEBHOOK
// ============================================================================

app.post('/api/webhooks/stripe', 
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

// ============================================================================
// START SERVER
// ============================================================================

app.listen(PORT, () => {
  console.log(`🚀 Tilbi Subscription Server running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV || 'development'}`);
});

