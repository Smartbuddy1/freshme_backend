import { connectDatabase, database, disconnectDatabase } from '../src/database.js';

async function main() {
  await connectDatabase({
    DATABASE_URL: 'postgresql://postgres.vmdsskmfdcuwwjxdncqb:Smart_Buddy%40786@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres'
  });

  const res = await database().query(`
    UPDATE fresh_me.settings 
    SET "agentKeyHash" = '9161b7f7197532da7b094cd69c7436057cc559ddf2feee3a07e8fb6033a189a2',
        "updatedAt" = now()
    WHERE _id = 'shop'
    RETURNING _id, "shopName", "agentKeyHash", "keyVersion"
  `);
  console.log('UPDATED SETTINGS:\n', res.rows);

  await disconnectDatabase();
}

main().catch(console.error);
