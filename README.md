# EcoHackOyo — Postgres backend

Replaces the Formspree placeholders in the frontend with your own database.
Two pieces: `schema.sql` (the database) and `server.js` (a small API the
frontend forms talk to).

## 1. Stand up Postgres

Any managed Postgres works. For an event site at this scale, pick whichever
is easiest to operate — you do not need anything exotic:

- **Neon** (neon.tech) — serverless Postgres, generous free tier, built-in
  connection pooling (important, see Performance below). Recommended default.
- **Supabase** — also free-tier friendly, comes with a built-in admin table
  editor if you want to eyeball registrations without writing SQL.
- **Railway / Render** — simplest if you're already deploying the API there
  too, so DB and API sit in the same project.

Steps (same for any provider):
1. Create the Postgres instance.
2. Copy its connection string.
3. Run the schema:
   ```
   psql "postgres://..." -f schema.sql
   ```
   (or paste `schema.sql` into the provider's SQL editor / query console).
4. Confirm: `SELECT * FROM v_capacity_status;` should show `total_slots: 500,
   slots_taken: 0, slots_remaining: 500`.

## 2. Deploy the API

```
cd backend
npm install
cp .env.example .env   # fill in DATABASE_URL and ALLOWED_ORIGIN
npm start
```

Deploy target: Render, Railway, or Fly.io all work well for a small
always-on Node service (Vercel/Netlify functions also work, but see the
pooling note below if you go serverless). Set the same environment
variables from `.env.example` in whichever platform's dashboard.

## 3. Point the frontend at the API instead of Formspree

In each registration page (`register-hackathon.html`, `register-summit.html`,
`register-sponsor.html`), the `<form>` currently has:

```html
<form id="reg-form" data-ecohackoyo-form action="https://formspree.io/f/REPLACE_..." method="POST">
```

Change `action` to your API endpoint, e.g.:

```html
<form id="reg-form" data-ecohackoyo-form action="https://api.ecohackoyo.org/api/register/hackathon" method="POST">
```

`js/forms.js` currently POSTs `FormData` with an `Accept: application/json`
header — that works against Formspree, but this API expects **JSON**, not
multipart form data. Update the fetch call in `js/forms.js`:

```js
// was:
const response = await fetch(action, {
  method: "POST",
  body: new FormData(form),
  headers: { Accept: "application/json" }
});

// change to:
const payload = Object.fromEntries(new FormData(form).entries());
payload.consent = form.querySelector('[name="consent"]')?.checked === true;
const response = await fetch(action, {
  method: "POST",
  body: JSON.stringify(payload),
  headers: { "Content-Type": "application/json", Accept: "application/json" }
});
```

Also add a honeypot field to each form (real users never see or fill it —
bots usually do), since the API already checks for it:

```html
<input type="text" name="company_website" autocomplete="off" tabindex="-1"
       style="position:absolute; left:-9999px;" aria-hidden="true">
```

## Performance & capacity — the parts that actually matter at this scale

Being direct about scale first: 500 hackathon slots, a few thousand summit
attendees at most, a few dozen sponsor leads. That's a few thousand rows,
total. Postgres does not care — a $0–15/month instance handles this without
tuning. The real risks aren't query speed, they're these:

**1. Overselling the 500 hackathon slots.**
A naive "count rows, then insert if under 500" has a race condition: two
people submitting in the same second can both pass the check before either
insert lands, and you end up with 501+. `schema.sql`'s `hackathon_capacity`
table fixes this with a single atomic `UPDATE ... WHERE slots_taken <
total_slots RETURNING ...` — Postgres row-locks that update, so concurrent
submissions queue up and are serialized. `server.js` wraps the capacity
check and the insert in one transaction, so a slot is only "spent" if the
registration actually succeeds.

**2. Connection exhaustion, not query speed.**
If you deploy the API as serverless functions (Vercel/Netlify functions,
AWS Lambda), each invocation can open its own DB connection, and Postgres
has a hard connection ceiling (often ~100 on small instances). A traffic
spike — say, the moment you post the registration link on Instagram — can
exhaust that ceiling in seconds even though the actual query load is
trivial. Two ways to avoid this:
- Deploy `server.js` as a normal always-on process (Render/Railway/Fly),
  where one small connection pool (`PG_POOL_MAX=8` in `.env`) is reused
  across all requests — this is what's set up here by default.
- If you do go serverless, use your provider's *pooled* connection string
  (Neon and Supabase both expose one, usually on a different port/host than
  the direct connection) instead of connecting straight to Postgres.

**3. Duplicate/spam submissions.**
`UNIQUE(email)` on each table plus `ON CONFLICT ... DO UPDATE` in
`server.js` means a resubmission (someone double-clicking Submit, or
re-registering to fix a typo) updates their existing row instead of
creating junk duplicates — so your attendee counts stay accurate without
manual cleanup. The rate limiter (8 submissions per IP per 15 minutes) and
honeypot field handle bot floods, which is the actual DoS risk for a public
form, not query load.

**4. Indexes are there for the admin dashboard, not the write path.**
Each table only has indexes on the columns you'll actually filter/sort by
when reviewing registrations (`status`, `category`/`challenge_area`/`tier`,
`created_at`). Every index adds a small write cost, so this list is
intentionally short — there's no benefit to indexing everything on tables
this size, it would just slow down inserts for no read-speed gain anyone
would notice.

**5. Backups.**
This is the one thing worth paying attention to regardless of scale: it's
irreplaceable registration data for a live event. Neon, Supabase, and RDS
all do automated daily backups on their free/starter tiers — just confirm
it's turned on, and consider a quick manual `pg_dump` the week of the event
as an extra safety net.

## Handy queries once data is flowing

```sql
-- How full is the hackathon?
SELECT * FROM v_capacity_status;

-- Registrations by challenge area (for balancing mentor assignments)
SELECT * FROM v_hackathon_summary ORDER BY total DESC;

-- Everyone still pending review, oldest first
SELECT full_name, email, challenge_area, created_at
FROM hackathon_registrations
WHERE status = 'pending'
ORDER BY created_at;

-- Sponsor pipeline by tier
SELECT tier, status, count(*) FROM sponsor_registrations GROUP BY tier, status;
```
