# Learning Tree Portal — Architecture Orientation

A contractor portal for a bilingual special-education evaluation business. School districts
send referrals; 1099 contractors ("evaluators") log in to see assigned cases, testing
materials, and due dates, upload completed reports, and get paid. Admins (office staff)
manage referrals, assignments, QA review, invoicing, and payroll.

> **Reviewer note:** the code in this repo is only the **frontend**. Most business logic —
> security rules, triggers, and server functions — lives in **Supabase**, not here. Plan to
> review both. Access to the Supabase project is required for a meaningful review.

---

## System map (3 places)

| Concern | Where it lives |
|---|---|
| Frontend (React SPA) | **This GitHub repo** → built & hosted on **Vercel** |
| Database, Auth, Storage, Row-Level Security, triggers, server functions | **Supabase** (project ref `wuxttyvxrpmwavfmfzsh`) |
| Transactional email (invites, reminders, notifications) | **Resend** (verified sending domain `learningtreenj.org`) |
| DNS / custom domain `portal.learningtreenj.org` | Squarespace DNS → Vercel; Google Workspace for mailboxes |
| AI referral parsing | **Anthropic API** (key stored as a Supabase Edge Function secret) |

Live URL: **https://portal.learningtreenj.org**

---

## Tech stack

- **Frontend:** Vite + React 18 (JSX, no TypeScript). No component framework; hand-rolled
  components + a single `styles.css`. Data layer is `@supabase/supabase-js` directly from the
  browser (no separate API server).
- **Backend:** Supabase — Postgres + GoTrue auth + Storage + Edge Functions (Deno/TypeScript)
  + `pg_cron`.
- **Client-side document parsing:** `fflate` (DOCX) and `pdfjs-dist` (PDF) extract text /
  checkbox states before sending to the AI parser; scanned/image PDFs are sent to Claude for OCR.
- **Excel export:** SheetJS (`xlsx`), client-side.

---

## Repo layout (`/src`)

| File | Responsibility |
|---|---|
| `App.jsx` | Auth gate + set-password screen (handles `type=invite`/`recovery` links). Chooses Admin vs Contractor portal by `admin_users` membership. |
| `AdminPortal.jsx` | The entire admin app (dashboard, New Referral intake, Cases + Case Detail, Contractors, QA review, Invoices, Payroll, Due-date monitor, Email log). Large single file. |
| `ContractorPortal.jsx` | Contractor app (their assignments, accept/decline, status updates, multi-file report upload, earnings, profile + change password). |
| `Login.jsx` | Email/password login, forgot-password, magic-link. |
| `ui.jsx` | Shared presentational components (`Shell`, `Badge`, `StatCard`, `Meta`). |
| `supabase.js` | Supabase client + helpers (`fetchAll` handles the 1000-row query cap, `statusClass`, date/rate utils). |
| `extractDocumentText.js` | Client-side DOCX/PDF text + form-checkbox extraction. |
| `invoice.js` | District invoice `.doc` generator (letterhead). |
| `smartAssign.js` | Contractor recommendation scoring (field + language + county adjacency). |
| `exportExcel.js` | Cases/assignments → `.xlsx`. |

Environment variables (Vite, client-side): `VITE_SUPABASE_URL`, `VITE_SUPABASE_KEY`
(the **publishable** anon key — safe for the browser; RLS is the real access control).

---

## Data model (Supabase, `public` schema)

Table names are **capitalized and quoted** (a legacy from the original import) — e.g.
`"Cases"`, `"Contractors"`, `"Assignments"`, `"Invoices"`. Watch for this in SQL.

- **`"Cases"`** — one row per referral. `case_number` (YY-NNNN) auto-set by a `BEFORE INSERT`
  trigger (`generate_case_number`). `evaluation_type` is a free-text comma list of *requested*
  eval types (distinct from actual assignments). `Status` is a display/workflow field.
- **`"Contractors"`** — evaluators. PK is **`identifier`** (not `id`). `user_id` links to the
  auth user once they log in.
- **`"Assignments"`** — one row per (case, eval type, contractor). Carries `status`
  (Assigned → … → Submitted), `acceptance_status` (pending/accepted/declined), `report_files`
  (jsonb array of uploaded reports), `report_url` (latest, back-compat).
- **`"Invoices"`, `qa_reviews`, `contractor_earnings`, `payment_batches`, `email_log`** — QA,
  billing, payroll, and an email audit log.

### Row-Level Security (review this closely)
- Helper functions `is_admin()` and `my_contractor_id()` (SECURITY DEFINER) drive policies.
- **Admins** (`admin_users` table) get full access; **contractors** see only their own rows.
- `guard_assignment_update` trigger is a **blocklist** — contractors may only change
  `testing_date`/`status`/`notes`/`report_url`/`report_files`; admins bypass it.
- Storage buckets are **private**: `reports` (contractor path-scoped) and `referrals`
  (contractor read only for cases they're assigned to). Files are served via short-lived
  signed URLs.

### Notable triggers
- `generate_case_number` — auto case numbers on insert.
- `link_contractor_on_signup` — links a new auth user to its `"Contractors"` row by email
  (single-row, to survive duplicate emails).
- `case_status_on_submit` — sets `"Cases".Status = 'Report Submitted'` when an assignment
  is submitted.

---

## Auth & onboarding

- Email/password via GoTrue. `App.jsx` routes to Admin vs Contractor by `admin_users`.
- **Onboarding model:** admin clicks *Invite* → an Edge Function generates a **temporary
  password**, creates/updates the auth user (`email_confirm: true`), and **emails the
  credentials** (no one-time link). This replaced Supabase's magic/verify links because
  **AOL/Yahoo/Outlook security scanners pre-fetch links and consume the single-use token**
  before the human clicks (a real, diagnosed production issue). Contractors change their
  password in-app (Profile → Change Password). Admins can also set a password directly.

---

## Edge Functions (Supabase, Deno)

All are admin-gated (verify the caller against `admin_users`) except where noted. They send
mail through the **Resend API** (not GoTrue SMTP), from `notifications@learningtreenj.org`.

- `invite-contractor` — temp-password onboarding (above).
- `set-contractor-password` — admin sets a specific password.
- `parse-referral` — Claude (Opus) extracts structured fields from a referral doc; accepts
  extracted text or a raw PDF (for OCR of scans).
- `notify-assignment` — emails a contractor when assigned a case.
- `notify-report-submitted` — emails the office when a report is uploaded.
- `send-reminders` — 7/3-day due-date reminders; runs on a `pg_cron` schedule; has an
  `EMAIL_OVERRIDE_TO` test-redirect safety.

---

## Hosting & deploy pipeline

- **Vercel** project `beval-portal`, custom domain `portal.learningtreenj.org`.
- **CI:** push to `main` → GitHub Action (`.github/workflows/deploy.yml`) runs
  `vercel deploy --prod` (Vercel builds **remotely**, which injects the `VITE_` env vars).
  > Do **not** switch this to `--prebuilt`: a CI-local build omits the client env vars and
  > ships a blank page. This is documented in the workflow file.

---

## Suggested review focus

1. **RLS policies & the `guard_assignment_update` blocklist** — is least-privilege actually
   enforced? Can a contractor read another contractor's cases, reports, or referral files?
2. **Edge Function authorization** — every function should verify admin (or ownership) from
   the JWT before acting with the service role.
3. **Storage signed-URL usage** — buckets are private; confirm nothing leaks via predictable
   paths.
4. **The direct-to-DB frontend pattern** — all authorization rests on RLS since the browser
   talks to Postgres directly; verify there's no table/column a contractor can mutate that
   they shouldn't.
5. **Email deliverability** — domain is new; SPF/DKIM/DMARC pass but reputation is warming up.

---

*This is an orientation, not exhaustive documentation. Ask the office for Supabase + Vercel
access to review the backend and deploy config directly.*
