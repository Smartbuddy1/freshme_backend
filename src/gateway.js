import Razorpay from 'razorpay';
import crypto from 'node:crypto';

export function createDemoGateway(config, logger) {
  const remoteOrders = new Map();
  const remotePayments = new Map();

  return {
    isDemo: true,
    orders: {
      create: async ({ amount, currency = 'INR', receipt }) => {
        const id = `order_demo_${receipt || crypto.randomUUID().slice(0, 14)}`;
        const order = { id, amount, currency, receipt, status: 'created', created_at: Math.floor(Date.now() / 1000) };
        remoteOrders.set(id, order);
        logger?.info?.({ orderId: id, amount, receipt }, 'Demo gateway: order created');
        return order;
      },
      all: async ({ receipt } = {}) => {
        const items = Array.from(remoteOrders.values()).filter(o => !receipt || o.receipt === receipt);
        return { items };
      },
      fetch: async id => {
        const order = remoteOrders.get(id);
        if (!order) throw new Error(`Demo order not found: ${id}`);
        return order;
      }
    },
    payments: {
      fetch: async id => {
        let payment = remotePayments.get(id);
        if (!payment) {
          const matchingOrder = Array.from(remoteOrders.values()).find(o => id.includes(o.receipt)) || Array.from(remoteOrders.values())[0];
          payment = {
            id,
            order_id: matchingOrder ? matchingOrder.id : `order_${id.slice(4)}`,
            amount: matchingOrder ? matchingOrder.amount : 0,
            currency: 'INR',
            status: 'captured',
            method: 'upi'
          };
        }
        return payment;
      },
      registerPayment: payment => {
        remotePayments.set(payment.id, payment);
      }
    }
  };
}

export function createGateway(config, logger) {
  if (config.NODE_ENV !== 'production' && config.DEMO_PAYMENT) {
    if (!['localhost','127.0.0.1','[::1]'].includes(new URL(config.DATABASE_URL).hostname)) throw new Error('Demo payments require a local development database');
    logger?.warn?.('Razorpay test/demo mode active: using local demo payment gateway');
    return createDemoGateway(config, logger);
  }

  const gateway = new Razorpay({ key_id: config.RAZORPAY_KEY_ID, key_secret: config.RAZORPAY_KEY_SECRET });
  gateway.api.rq.defaults.timeout = 15000;
  gateway.isDemo = false;
  return gateway;
}
