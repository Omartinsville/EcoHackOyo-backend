// One-time setup script: runs schema.sql against DATABASE_URL using the
// same `pg` package server.js already depends on — no psql install needed.
//
// Usage:
//   node run-schema.js

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');

  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'true' ? true : { rejectUnauthorized: false }
  });

  await client.connect();
  try {
    await client.query(sql);
    console.log('schema.sql applied successfully.');

    const { rows } = await client.query('SELECT * FROM v_capacity_status;');
    console.log('Capacity check:', rows[0]);
  } finally {
    await client.end();
  }
}

main().catch(err => {
  console.error('Failed to apply schema.sql:', err.message);
  process.exit(1);
});