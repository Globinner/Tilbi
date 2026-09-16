const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { dbHelpers } = require('./database');

// Subscription plan prices (in cents)
const PLANS = {
  monthly: {
    priceId: process.env.STRIPE_MONTHLY_PRICE_ID || 'price_monthly_placeholder',
    amount: 500, // $5.00
    currency: 'usd',
    interval: 'month'
  },
  yearly: {
    priceId: process.env.STRIPE_YEARLY_PRICE_ID || 'price_yearly_placeholder',
    amount: 2900, // $29.00
    currency: 'usd',
    interval: 'year'
  }
};

// Create Stripe customer
async function createCustomer(email, userId) {
  try {
    const customer = await stripe.customers.create({
      email,
      metadata: {
        userId: userId.toString()
      }
    });
    return customer;
  } catch (error) {
    throw new Error(`Failed to create Stripe customer: ${error.message}`);
  }
}

// Create subscription
async function createSubscription(customerId, planType) {
  try {
    const plan = PLANS[planType];
    if (!plan) {
      throw new Error('Invalid plan type');
    }

    const subscription = await stripe.subscriptions.create({
      customer: customerId,
      items: [{
        price: plan.priceId
      }],
      payment_behavior: 'default_incomplete',
      payment_settings: { save_default_payment_method: 'on_subscription' },
      expand: ['latest_invoice.payment_intent']
    });

    return subscription;
  } catch (error) {
    throw new Error(`Failed to create subscription: ${error.message}`);
  }
}

// Get subscription
async function getSubscription(subscriptionId) {
  try {
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);
    return subscription;
  } catch (error) {
    throw new Error(`Failed to get subscription: ${error.message}`);
  }
}

// Cancel subscription
async function cancelSubscription(subscriptionId, cancelImmediately = false) {
  try {
    if (cancelImmediately) {
      const subscription = await stripe.subscriptions.cancel(subscriptionId);
      return subscription;
    } else {
      // Cancel at period end
      const subscription = await stripe.subscriptions.update(subscriptionId, {
        cancel_at_period_end: true
      });
      return subscription;
    }
  } catch (error) {
    throw new Error(`Failed to cancel subscription: ${error.message}`);
  }
}

// Resume subscription
async function resumeSubscription(subscriptionId) {
  try {
    const subscription = await stripe.subscriptions.update(subscriptionId, {
      cancel_at_period_end: false
    });
    return subscription;
  } catch (error) {
    throw new Error(`Failed to resume subscription: ${error.message}`);
  }
}

// Create checkout session
async function createCheckoutSession(customerId, planType, successUrl, cancelUrl) {
  try {
    const plan = PLANS[planType];
    if (!plan) {
      throw new Error('Invalid plan type');
    }

    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      payment_method_types: ['card'],
      line_items: [{
        price: plan.priceId,
        quantity: 1
      }],
      mode: 'subscription',
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        planType: planType
      }
    });

    return session;
  } catch (error) {
    throw new Error(`Failed to create checkout session: ${error.message}`);
  }
}

// Create billing portal session
async function createBillingPortalSession(customerId, returnUrl) {
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl
    });
    return session;
  } catch (error) {
    throw new Error(`Failed to create billing portal session: ${error.message}`);
  }
}

// Handle webhook event
async function handleWebhookEvent(event) {
  try {
    switch (event.type) {
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
        await handleSubscriptionUpdate(event.data.object);
        break;
      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object);
        break;
      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object);
        break;
      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object);
        break;
    }
  } catch (error) {
    console.error('Webhook handler error:', error);
    throw error;
  }
}

// Handle subscription update
async function handleSubscriptionUpdate(subscription) {
  let userId = parseInt(subscription.metadata?.userId);
  if (!userId) {
    // Try to get from customer metadata
    const customer = await stripe.customers.retrieve(subscription.customer);
    userId = parseInt(customer.metadata?.userId);
  }

  if (!userId) {
    console.error('No userId found in subscription metadata');
    return;
  }

  const planType = subscription.items.data[0]?.price?.recurring?.interval === 'month' ? 'monthly' : 'yearly';
  
  const subscriptionData = {
    paymentProvider: 'stripe',
    stripeCustomerId: subscription.customer,
    stripeSubscriptionId: subscription.id,
    planType,
    status: subscription.status,
    currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
    currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    cancelAtPeriodEnd: subscription.cancel_at_period_end
  };

  // Check if subscription exists
  const existing = await dbHelpers.getActiveSubscription(userId);
  if (existing) {
    await dbHelpers.updateSubscription(subscription.id, subscriptionData);
  } else {
    await dbHelpers.createSubscription(userId, subscriptionData);
  }
}

// Handle subscription deleted
async function handleSubscriptionDeleted(subscription) {
  await dbHelpers.updateSubscription(subscription.id, {
    status: 'canceled',
    currentPeriodStart: new Date(subscription.current_period_start * 1000).toISOString(),
    currentPeriodEnd: new Date(subscription.current_period_end * 1000).toISOString(),
    cancelAtPeriodEnd: false
  });
}

// Handle payment succeeded
async function handlePaymentSucceeded(invoice) {
  const customerId = invoice.customer;
  const customer = await stripe.customers.retrieve(customerId);
  const userId = parseInt(customer.metadata?.userId);

  if (userId) {
    await dbHelpers.recordPayment(userId, {
      stripePaymentIntentId: invoice.payment_intent,
      amount: invoice.amount_paid,
      currency: invoice.currency,
      status: 'succeeded'
    });
  }
}

// Handle payment failed
async function handlePaymentFailed(invoice) {
  // Update subscription status to past_due
  if (invoice.subscription) {
    await handleSubscriptionUpdate({
      ...invoice.subscription,
      status: 'past_due'
    });
  }
}

module.exports = {
  PLANS,
  createCustomer,
  createSubscription,
  getSubscription,
  cancelSubscription,
  resumeSubscription,
  createCheckoutSession,
  createBillingPortalSession,
  handleWebhookEvent
};

