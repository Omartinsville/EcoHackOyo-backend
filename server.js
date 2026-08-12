// EcoHackOyo API — minimal, production-lean Express server in front of Postgres.
// Handles the 3 registration forms: hackathon, summit, sponsor.
require('dotenv').config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");
const app = express();

// ---------------------------------------------------------------------------
// DB POOL
// Keep this small. Serverless/managed Postgres providers (Neon, Supabase,
// RDS Proxy) already pool connections upstream — a huge local pool just
// exhausts the DB's own connection limit under load. 5–10 is plenty for an
// event-registration API; this isn't a high-throughput service.
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX || 8),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env.PGSSL === "true" ? true : { rejectUnauthorized: false }
});

// ---------------------------------------------------------------------------
// MIDDLEWARE
// ---------------------------------------------------------------------------
app.use(helmet());
app.use(express.json({ limit: "20kb" })); // registration payloads are tiny
app.use(
  cors({
    origin: (process.env.ALLOWED_ORIGIN || "").split(",").filter(Boolean),
    methods: ["POST"]
  })
);

// Generic rate limit: protects the DB from bot floods hitting a public form.
// 500 hackathon slots means legitimate traffic is naturally low-volume.
const formLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 8, // 8 submissions per IP per 15 minutes is generous for a real user
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many submissions from this device. Please try again later." }
});
app.use("/api/register", formLimiter);

// ---------------------------------------------------------------------------
// VALIDATION HELPERS
// ---------------------------------------------------------------------------
const isEmail = v => typeof v === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
const isPhone = v => typeof v === "string" && v.replace(/\D/g, "").length >= 7;
const nonEmpty = v => typeof v === "string" && v.trim().length > 0;
const clamp = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : v);

function badRequest(res, errors) {
  return res.status(400).json({ error: "Validation failed", details: errors });
}

// Honeypot check shared by all three forms: a hidden field named "company_website"
// (NOT the visible sponsor "website" field) that real users never fill in.
// Add <input type="text" name="company_website" class="hidden" tabindex="-1"
// autocomplete="off"> to each form on the frontend to use this.
function isBot(body) {
  return Boolean(body.company_website);
}

// ---------------------------------------------------------------------------
// POST /api/register/hackathon
// ---------------------------------------------------------------------------
const HACKATHON_ROLES = new Set([
  "student", "young_entrepreneur", "tech_digital_innovator",
  "developer_designer", "researcher", "creative_problem_solver", "other"
]);
const CHALLENGE_AREAS = new Set([
  "youth_employment", "entrepreneurship_msmes", "agriculture_agribusiness",
  "digital_economy", "education_skills_development", "financial_inclusion",
  "sustainability", "local_economic_development", "creative_economy",
  "technology_innovation"
]);

app.post("/api/register/hackathon", async (req, res) => {
  const b = req.body || {};
  if (isBot(b)) return res.status(200).json({ ok: true }); // silently accept, don't insert

  const errors = [];
  if (!nonEmpty(b.full_name)) errors.push("full_name is required");
  if (!isEmail(b.email)) errors.push("valid email is required");
  if (!isPhone(b.phone)) errors.push("valid phone is required");
  const age = Number(b.age);
  if (!Number.isInteger(age) || age < 15 || age > 99) errors.push("age must be between 15 and 99");
  if (!nonEmpty(b.location)) errors.push("location is required");
  if (!HACKATHON_ROLES.has(b.role)) errors.push("valid role is required");
  if (!CHALLENGE_AREAS.has(b.challenge_area)) errors.push("valid challenge_area is required");
  if (b.consent !== true) errors.push("consent must be accepted");
  if (errors.length) return badRequest(res, errors);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Atomically reserve a slot. See schema.sql for why this must be a
    // single UPDATE ... WHERE ... RETURNING rather than count-then-insert.
    const capacity = await client.query(
      `UPDATE hackathon_capacity
         SET slots_taken = slots_taken + 1
         WHERE slots_taken < total_slots
         RETURNING slots_taken, total_slots`
    );
    if (capacity.rowCount === 0) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "The hackathon is full. You've been noted for the waitlist." });
    }

    const insert = await client.query(
      `INSERT INTO hackathon_registrations
         (full_name, email, phone, age, location, role, challenge_area,
          team_status, team_name, idea_summary, referral_source, consent,
          source_ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (email) DO UPDATE SET
         full_name = EXCLUDED.full_name,
         phone = EXCLUDED.phone,
         age = EXCLUDED.age,
         location = EXCLUDED.location,
         role = EXCLUDED.role,
         challenge_area = EXCLUDED.challenge_area,
         team_status = EXCLUDED.team_status,
         team_name = EXCLUDED.team_name,
         idea_summary = EXCLUDED.idea_summary,
         updated_at = now()
       RETURNING id`,
      [
        clamp(b.full_name, 120), b.email.toLowerCase(), clamp(b.phone, 20), age,
        clamp(b.location, 120), b.role, b.challenge_area,
        b.team_status === "has_team" ? "has_team" : "solo",
        clamp(b.team_name, 80) || null, clamp(b.idea_summary, 1000) || null,
        clamp(b.referral_source, 120) || null, true,
        req.ip, req.get("user-agent") || null
      ]
    );

    await client.query("COMMIT");
    return res.status(201).json({ ok: true, id: insert.rows[0].id });
  } catch (err) {
    await client.query("ROLLBACK");
    if (err.code === "23505") {
      // Shouldn't hit this given ON CONFLICT above, but kept as a safety net
      return res.status(200).json({ ok: true, note: "Registration already existed and was updated." });
    }
    console.error("hackathon registration error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// POST /api/register/summit
// ---------------------------------------------------------------------------
const SUMMIT_CATEGORIES = new Set([
  "student_youth", "entrepreneur_business_owner", "innovator_creative",
  "community_builder", "policy_maker_government", "investor_sponsor_rep", "other"
]);

app.post("/api/register/summit", async (req, res) => {
  const b = req.body || {};
  if (isBot(b)) return res.status(200).json({ ok: true });

  const errors = [];
  if (!nonEmpty(b.full_name)) errors.push("full_name is required");
  if (!isEmail(b.email)) errors.push("valid email is required");
  if (!isPhone(b.phone)) errors.push("valid phone is required");
  if (!SUMMIT_CATEGORIES.has(b.category)) errors.push("valid category is required");
  if (b.consent !== true) errors.push("consent must be accepted");
  if (errors.length) return badRequest(res, errors);

  try {
    const insert = await pool.query(
      `INSERT INTO summit_registrations
         (full_name, email, phone, category, organization, also_contestant,
          expectations, consent, source_ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (email) DO UPDATE SET
         full_name = EXCLUDED.full_name,
         phone = EXCLUDED.phone,
         category = EXCLUDED.category,
         organization = EXCLUDED.organization,
         also_contestant = EXCLUDED.also_contestant,
         expectations = EXCLUDED.expectations,
         updated_at = now()
       RETURNING id`,
      [
        clamp(b.full_name, 120), b.email.toLowerCase(), clamp(b.phone, 20), b.category,
        clamp(b.organization, 120) || null,
        ["yes", "interested"].includes(b.also_contestant) ? b.also_contestant : "no",
        clamp(b.expectations, 800) || null, true,
        req.ip, req.get("user-agent") || null
      ]
    );
    return res.status(201).json({ ok: true, id: insert.rows[0].id });
  } catch (err) {
    console.error("summit registration error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// POST /api/register/sponsor
// ---------------------------------------------------------------------------
const SPONSOR_TIERS = new Set(["exhibition_in_kind", "gold", "platinum", "not_sure"]);

app.post("/api/register/sponsor", async (req, res) => {
  const b = req.body || {};
  if (isBot(b)) return res.status(200).json({ ok: true });

  const errors = [];
  if (!nonEmpty(b.organization_name)) errors.push("organization_name is required");
  if (!nonEmpty(b.contact_name)) errors.push("contact_name is required");
  if (!nonEmpty(b.contact_role)) errors.push("contact_role is required");
  if (!isEmail(b.email)) errors.push("valid email is required");
  if (!isPhone(b.phone)) errors.push("valid phone is required");
  if (!SPONSOR_TIERS.has(b.tier)) errors.push("valid tier is required");
  if (b.consent !== true) errors.push("consent must be accepted");
  if (errors.length) return badRequest(res, errors);

  try {
    const insert = await pool.query(
      `INSERT INTO sponsor_registrations
         (organization_name, contact_name, contact_role, email, phone, website,
          tier, message, consent, source_ip, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (organization_name, email) DO UPDATE SET
         contact_name = EXCLUDED.contact_name,
         contact_role = EXCLUDED.contact_role,
         phone = EXCLUDED.phone,
         website = EXCLUDED.website,
         tier = EXCLUDED.tier,
         message = EXCLUDED.message,
         updated_at = now()
       RETURNING id`,
      [
        clamp(b.organization_name, 150), clamp(b.contact_name, 120), clamp(b.contact_role, 80),
        b.email.toLowerCase(), clamp(b.phone, 20), clamp(b.website, 200) || null,
        b.tier, clamp(b.message, 1000) || null, true,
        req.ip, req.get("user-agent") || null
      ]
    );
    return res.status(201).json({ ok: true, id: insert.rows[0].id });
  } catch (err) {
    console.error("sponsor registration error:", err);
    return res.status(500).json({ error: "Something went wrong. Please try again." });
  }
});

// ---------------------------------------------------------------------------
// Health check + capacity endpoint (useful for the "X of 500 slots left" banner)
// ---------------------------------------------------------------------------
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true });
  } catch {
    res.status(500).json({ ok: false });
  }
});

app.get("/api/capacity/hackathon", async (_req, res) => {
  try {
    const { rows } = await pool.query("SELECT * FROM v_capacity_status");
    res.json(rows[0]);
  } catch (err) {
    console.error("capacity check error:", err);
    res.status(500).json({ error: "Could not load capacity." });
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`EcoHackOyo API listening on :${port}`));
