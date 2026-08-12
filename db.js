// db.js
const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: parseInt(process.env.PG_POOL_MAX || '8', 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: { rejectUnauthorized: false } // most managed providers (Neon/Supabase/Railway) require SSL
});

pool.on('error', (err) => {
  console.error('Unexpected idle client error', err);
});

module.exports = pool;