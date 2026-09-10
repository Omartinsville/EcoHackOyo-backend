// EcoHackOyo API — minimal, production-lean Express server in front of Postgres.
// Handles the 3 registration forms: hackathon, summit, sponsor.

const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { Pool } = require("pg");

const app = express();
app.set('trust proxy', 1);

// ---------------------------------------------------------------------------
// DB POOL
// Keep this small. Serverless/managed Postgres providers (Neon, Supabase,
// RDS Proxy) already pool connections upstream — a huge local pool just
// exhausts the DB's own connection limit under load. 5–10 is plenty for an
// event-registration API; this isn't a high-throughput service.
// ---------------------------------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: true,
  },
  max: Number(process.env.PG_POOL_MAX || 8),
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
 });

// ---------------------------------------------------------------------------
// MIDDLEWARE
// ---------------------------------------------------------------------------
app.use(helmet());
app.use(express.json({ limit: "20kb" })); // registration payloads are tiny
app.use(
  cors({
    origin: ["https://ecohackoyo.netlify.app", "http://localhost:3000"],
    methods: ["GET","POST","OPTIONS"],
    allowedHeaders:["Content-type"]
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
    const email = b.email.toLowerCase();

    // An edit/resubmit (same email) must NOT consume another slot or get a
    // new participant number — only genuinely new emails touch capacity.
    const existing = await client.query(
      `SELECT id FROM hackathon_registrations WHERE email = $1`,
      [email]
    );

    let row;
    if (existing.rowCount > 0) {
      const updated = await client.query(
        `UPDATE hackathon_registrations SET
           full_name = $1, phone = $2, age = $3, location = $4, role = $5,
           challenge_area = $6, team_status = $7, team_name = $8,
           idea_summary = $9, referral_source = $10, updated_at = now()
         WHERE email = $11
         RETURNING id, participant_no, participant_code`,
        [
          clamp(b.full_name, 120), clamp(b.phone, 20), age, clamp(b.location, 120),
          b.role, b.challenge_area, b.team_status === "has_team" ? "has_team" : "solo",
          clamp(b.team_name, 80) || null, clamp(b.idea_summary, 1000) || null,
          clamp(b.referral_source, 120) || null, email
        ]
      );
      row = updated.rows[0];
    } else {
      // Atomically reserve a slot. See schema.sql for why this must be a
      // single UPDATE ... WHERE ... RETURNING rather than count-then-insert.
      // The returned slots_taken doubles as this person's participant_no.
      const capacity = await client.query(
        `UPDATE hackathon_capacity
           SET slots_taken = slots_taken + 1
           WHERE slots_taken < total_slots
           RETURNING slots_taken`
      );
      if (capacity.rowCount === 0) {
        await client.query("ROLLBACK");
        return res.status(409).json({ error: "The hackathon is full. You've been noted for the waitlist." });
      }
      const participantNo = capacity.rows[0].slots_taken;

      const inserted = await client.query(
        `INSERT INTO hackathon_registrations
           (full_name, email, phone, age, location, role, challenge_area,
            team_status, team_name, idea_summary, referral_source, consent,
            participant_no, source_ip, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         RETURNING id, participant_no, participant_code`,
        [
          clamp(b.full_name, 120), email, clamp(b.phone, 20), age,
          clamp(b.location, 120), b.role, b.challenge_area,
          b.team_status === "has_team" ? "has_team" : "solo",
          clamp(b.team_name, 80) || null, clamp(b.idea_summary, 1000) || null,
          clamp(b.referral_source, 120) || null, true,
          participantNo, req.ip, req.get("user-agent") || null
        ]
      );
      row = inserted.rows[0];
    }

    await client.query("COMMIT");
    return res.status(201).json({
      ok: true,
      id: row.id,
      participant_no: row.participant_no,
      participant_code: row.participant_code,
      whatsapp_link: process.env.WHATSAPP_HACKATHON_LINK || null
    });
  } catch (err) {
    await client.query("ROLLBACK"); // undoes the capacity increment too, if one happened
    if (err.code === "23505") {
      // Two submissions for the same brand-new email landed at once — one
      // won, this one lost the race. Nothing was left inconsistent because
      // the ROLLBACK above reverted its capacity increment.
      return res.status(200).json({ ok: true, note: "You're already registered — no changes needed." });
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
    return res.status(201).json({
      ok: true,
      id: insert.rows[0].id,
      whatsapp_link: process.env.WHATSAPP_SUMMIT_LINK || null
    });
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
