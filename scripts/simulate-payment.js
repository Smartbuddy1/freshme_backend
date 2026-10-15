import crypto from 'node:crypto';
import { readConfig } from '../src/config.js';
const config = readConfig();
const [orderId, target = `http://localhost:${config.PORT}`] = process.argv.slice(2);
const url = new URL(target);
if (!['localhost','127.0.0.1','[::1]'].includes(new URL(config.DATABASE_URL).hostname) || config.NODE_ENV === 'production' || !config.RAZORPAY_KEY_ID.startsWith('rzp_test_') || !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) throw new Error('Simulation is restricted to a local development server and Razorpay TEST keys.');
if (!/^[a-f\d]{24}$/i.test(orderId || '')) throw new Error('Usage: npm run simulate-payment -- <local-order-id> [http://localhost:3000]');
// Read gateway linkage from the development database; never expose a simulation API.
const { connectDatabase, disconnectDatabase } = await import('../src/database.js');
const { Order } = await import('../src/models.js');
try {
  await connectDatabase(config);
  const order = await Order.findById(orderId);
  if (!order?.razorpayOrderId) throw new Error('Create a checkout through the customer menu first.');
  const payment = { id: `pay_sim_${order._id}`, order_id: order.razorpayOrderId, amount: order.total * 100, currency: 'INR', method: 'card', status: 'captured' };
  const body = JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: payment } } });
  const response = await fetch(`${url.origin}/api/webhooks/razorpay`, { method:'POST', headers:{'Content-Type':'application/json','x-razorpay-signature':crypto.createHmac('sha256',config.RAZORPAY_WEBHOOK_SECRET).update(body).digest('hex')}, body, signal:AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Simulation failed: HTTP ${response.status}`);
  console.log(`Signed test webhook accepted. Token: ${url.origin}/order/${order._id}`);
  console.log('This is a local synthetic payment, not a payment recorded in Razorpay. Use a separate development database.');
} finally { await disconnectDatabase(); }
