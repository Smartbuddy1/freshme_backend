import { connectDatabase, database, disconnectDatabase } from '../src/database.js';

async function main() {
  await connectDatabase({
    DATABASE_URL: 'postgresql://postgres.vmdsskmfdcuwwjxdncqb:Smart_Buddy%40786@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres'
  });

  const orders = await database().query('SELECT * FROM fresh_me.orders ORDER BY "createdAt" DESC LIMIT 5');
  console.log('ORDERS:\n', JSON.stringify(orders.rows, null, 2));

  const jobs = await database().query('SELECT * FROM fresh_me.print_jobs ORDER BY "createdAt" DESC LIMIT 5');
  console.log('PRINT JOBS:\n', JSON.stringify(jobs.rows, null, 2));

  await disconnectDatabase();
}

main().catch(console.error);
