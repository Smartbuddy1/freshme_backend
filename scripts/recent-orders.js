import { readDatabaseConfig } from '../src/config.js';
import { connectDatabase, disconnectDatabase, database } from '../src/database.js';

try {
  await connectDatabase(readDatabaseConfig());
  const { rows } = await database().query(`
    SELECT _id, status, "orderCode", "tokenNo", total, "razorpayOrderId", "razorpayPaymentId", "creationError", "createdAt", "paidAt"
    FROM fresh_me.orders
    ORDER BY "createdAt" DESC
    LIMIT 10
  `);
  console.log(JSON.stringify(rows, null, 2));
} catch (err) {
  console.error('Error:', err);
} finally {
  await disconnectDatabase();
}
