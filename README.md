# Finma — Financial Personal Management

React (Vite) + Tailwind CSS frontend with a Supabase backend (Auth + Postgres),
supporting Lao / Thai / English localization, LAK / THB / USD currencies, and
installable as a PWA on Android, iOS, and desktop.

**Access model:** the app opens straight to the **Fixed Deposit** calculator —
no login wall. Fixed Deposit and Compound Interest are free-trial tools,
usable by anyone. Every other function (the ledger, Net Profit Margin, NPV,
Opportunity Cost, and saving your profile) is visible but shown dimmed with
a "sign in to unlock" prompt until you sign in with Google, via the button
in the top-right corner. There's also a separate **Admin** area (hidden from
everyone except the configured admin email) for app maintenance — see
section 10.

## 1. Setup

```bash
npm install
cp .env.example .env.local   # fill in your Supabase project keys
npm run dev
```

### Supabase project setup
1. Create a project at https://supabase.com/dashboard
2. Enable **Authentication → Providers → Google** (you'll need a Google
   OAuth client ID/secret from the
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials) —
   Supabase's provider settings page shows you the exact redirect URL to
   register there).
3. Push the schema + Row Level Security policies:
   ```bash
   npm install -g supabase
   supabase login
   supabase link --project-ref <your-project-ref>   # find this in Project Settings > General
   npm run db:push
   ```
4. In **Database → Replication**, confirm `ledger_entries`, `monthly_cycles`,
   and `app_config` are enabled for Realtime (the migration does this via
   `alter publication supabase_realtime add table ...`, but it's worth
   double-checking in the dashboard if live sync doesn't seem to be working).
5. Copy your Project URL and anon/public key (**Project Settings → API**)
   into `.env.local` (see `.env.example`).

### GitHub Actions secrets (for automated deploys)

This repo ships two workflows under `.github/workflows/`:

- **`deploy.yml`** — builds the app and publishes it to GitHub Pages on
  every push to `main`. Needs these repo secrets (**Settings → Secrets and
  variables → Actions → Repository secrets**), matching `.env.example`:
  - **`VITE_SUPABASE_URL`** — your project's URL, e.g. `https://xxxxx.supabase.co`
    (Project Settings → API → Project URL).
  - **`VITE_SUPABASE_ANON_KEY`** — the `anon` `public` key from the same
    page. This is safe to ship in a client bundle — Row Level Security
    policies, not secrecy of this key, are what actually protect your data.
- **`deploy-supabase.yml`** — pushes `supabase/migrations/*.sql` (schema +
  Row Level Security policies + Realtime publication) to your live database
  whenever they change on `main` (or on demand via **Actions → Deploy
  Supabase Migrations → Run workflow**). This is what actually fixes a
  **"Missing or insufficient permissions"** error in the app — a migration
  file sitting in the repo does nothing until it's pushed. Needs three more
  secrets:
  - **`SUPABASE_ACCESS_TOKEN`** — a personal access token from
    **[Supabase Dashboard → Account → Access Tokens](https://supabase.com/dashboard/account/tokens)**.
  - **`SUPABASE_PROJECT_REF`** — your project's reference ID (Project
    Settings → General → Reference ID — the short string like `abcdefghijklmnop`,
    *not* the project name).
  - **`SUPABASE_DB_PASSWORD`** — your database password, set when you
    created the project (reset it under Project Settings → Database if
    you don't have it — this is separate from your Supabase account
    password).

  Once all three secrets exist, either push a change under
  `supabase/migrations/` or trigger the workflow manually — after it
  finishes (check the **Actions** tab for a green check), the "Missing or
  insufficient permissions" banner in the app should be gone.

## 2. Architecture

```
src/
  config/         admin.js — admin email allowlist (client-side UX check)
  context/        Auth, Language, Currency — global React context providers
  hooks/          useLedger.js (Supabase ledger + roll-over), useAppConfig.js
                  (maintenance mode)
  i18n/           en.json, lo.json, th.json, i18n.js — translations + t()
  utils/
    financeFormulas.js  Pure calculation engines (unit-testable, no React)
    currency.js         Currency metadata, formatting, conversion
    exportData.js       CSV / Excel export (xlsx, lazy-loaded)
    dateUtils.js        Month-key helpers for the roll-over engine
  components/
    Ledger/      Dashboard (reports/charts/export), Financial (income/expense
                 entry — TransactionForm, TransactionList)
    Calculators/ FixedDeposit, CompoundInterest (free), NetProfitMargin, NPV,
                 OpportunityCost (all three require sign-in)
    Knowledge/   Knowledge — free explainer for every calculator's formula
    Settings/    AccountSettings
    Admin/       AdminPanel (maintenance mode toggle, user count)
    common/      Sidebar, Topbar, AuthGate, ConfigError, ErrorBoundary,
                 MaintenanceScreen, Card
```

### Design tokens ("Finma Ledger")
- Colors: Ink `#16233D`, Indigo `#2F4C7A`, Gold `#C9A227`, Paper `#F7F4EC`,
  Bamboo `#4E7D5D` (income), Lotus `#B85C55` (expense).
- Type: Sora (display/headings) + Inter (body) + Noto Sans Lao / Noto Sans
  Thai (script fallback).
- Signature motif: the "stitch divider" — a dashed rule referencing the
  woven borders of Lao silk textiles — used instead of plain `<hr>`s.

### Layout
- **Sidebar** (`components/common/Sidebar.jsx`) — persistent on desktop, a
  slide-over drawer on mobile. Grouped as: Dashboard, Financial, a
  **Calculators** section (Fixed Deposit, Compound Interest, Net Profit
  Margin, NPV, Opportunity Cost), then Knowledge, then Settings/Admin — plus
  a profile card (avatar, name, sign out) at the bottom.
- **Topbar** (`components/common/Topbar.jsx`) — mobile menu toggle, current
  page title, a language switcher (works signed out too), and the
  **Sign in with Google** button / account menu, top right.
- **AuthGate** (`components/common/AuthGate.jsx`) — wraps a page's gated
  content in dimmed, non-interactive styling plus a sign-in overlay when
  signed out. **Important:** use exactly one `<AuthGate>` per page, wrapping
  everything that needs to be locked together — two separate `<AuthGate>`
  instances on the same page each render their own overlay, producing two
  stacked popups (this was a real bug on the Settings page, fixed by merging
  its two gates into one).

## 3. Supabase data model & how the ledger saves data

Once signed in, `useLedger.js` reads and writes Postgres directly (no
localStorage) via an initial fetch plus Realtime `postgres_changes`
subscriptions — edits sync instantly across tabs/devices signed into the
same account.

```
profiles(id, name, email, photo_url,        # one row per user, PK = auth.users.id
         primary_currency, language, created_at)
ledger_entries(id, user_id, date, type,      # one row per income/expense transaction
                category, description, amount, currency, cycle_key)
monthly_cycles(user_id, cycle_key,           # PK (user_id, cycle_key)
                opening_balance, closed, closing_balance)
app_config(key, maintenance_mode,            # single row, key = 'global'
           updated_at, updated_by)
```

Full DDL + Row Level Security policies live in
`supabase/migrations/0001_init.sql`.

**How it's wired (for reference if you extend it):**
- `src/supabase.js` initializes the Supabase client from your `.env.local` /
  build-time secrets, and exports `isSupabaseConfigured` so the app can show
  a clear error instead of crashing if a key is missing.
- `src/context/AuthContext.jsx` listens for sign-in state via
  `supabase.auth.onAuthStateChange`, and creates the `profiles` row on first
  sign-in via `insert`.
- `src/hooks/useLedger.js`:
  - Fetches `ledger_entries` for the signed-in user once, then patches that
    list in place from a `postgres_changes` Realtime channel — this is the
    "live sync" part.
  - `addTransaction` → `.insert(...)`, `deleteTransaction` → `.delete(...)`.
  - Runs the **monthly roll-over** on mount: reads the
    `monthly_cycles` row for the current month key; if it doesn't exist yet,
    it closes any still-open prior cycle(s) — `closing_balance = opening_balance
    + Σ(income) − Σ(expenses)`, converted to your primary currency — writes
    that with `closed: true`, then creates the new month's row with
    `opening_balance` carried forward, and surfaces a one-time notice banner.
  - When signed **out**, the hook returns an empty transaction list (no
    Supabase calls happen at all until you sign in).
- `supabase/migrations/0001_init.sql` (already included) enables Row Level
  Security on every table with `auth.uid() = user_id` policies, so users can
  only ever touch their own data — enforced by Postgres itself, not the
  client. It's deployed automatically by
  `.github/workflows/deploy-supabase.yml` on every push to `main` (see
  section 1's "GitHub Actions secrets"), or manually with the
  [Supabase CLI](https://supabase.com/docs/guides/cli):
  ```bash
  npm install -g supabase
  supabase login
  supabase link --project-ref <your-project-ref>
  npm run db:push
  ```

**To add a new piece of saved data** (e.g. budgets, recurring bills): add a
new table to `supabase/migrations/`, give it an RLS policy following the
`auth.uid() = user_id` pattern above, add it to the `supabase_realtime`
publication if you want live sync, and write a small hook mirroring
`useLedger.js`'s fetch + `postgres_changes` + `insert`/`delete` pattern.

## 4. Calculation engines (`src/utils/financeFormulas.js`)

| Function | Formula |
|---|---|
| `calculateFixedDeposit` | `I = P × (r/100) × (t/12)`; `Maturity = P + I` |
| `calculateCompoundInterest` | `FV = P(1+r/n)^(nt) + PMT × [((1+r/n)^(nt) − 1) / (r/n)]` |
| `calculateNetProfitMargin` | `Margin % = (NetProfit / GrossRevenue) × 100` |
| `calculateNPV` | `NPV = Σ CFₜ/(1+r)ᵗ − InitialInvestment` |
| `calculateOpportunityCost` | Compares compound future value of a chosen vs. foregone option; `OpportunityCost = FV(foregone) − FV(chosen)` |

All five are pure functions (no React, no side effects), and have been
verified against hand-calculated cases, including edge cases (zero revenue,
zero discount rate, identical options → zero opportunity cost). Run the
checks yourself:

```js
import { calculateFixedDeposit } from "./src/utils/financeFormulas";
calculateFixedDeposit({ principal: 1000, annualRatePct: 5, termMonths: 12 });
// => { interestEarned: 50, maturityValue: 1050 }
```

## 5. Multi-currency

`src/utils/currency.js` holds indicative LAK/THB/USD rates against USD.
Replace `FALLBACK_RATES_TO_USD` with a live FX API call (cached, e.g.
refreshed every few hours) via `setRates()` for production use.

## 6. Export

`src/utils/exportData.js` wraps the `xlsx` package to export any flat array
of objects to CSV or `.xlsx`. The library is **dynamically imported** only
when someone clicks an export button, keeping it out of the initial page
load entirely.

## 7. PWA & Android support

Finma ships as an installable Progressive Web App:
- `public/manifest.webmanifest` — app name, icons, theme color, standalone display mode
- `public/icons/` — 192px/512px icons plus a maskable variant for Android's adaptive icon shape
- `public/sw.js` — a runtime-caching service worker (network-first for navigation, stale-while-revalidate for assets), registered in `src/main.jsx`. **This must live under `public/`, not the repo root** — `vite build` only copies `publicDir` into `dist/`, so a root-level `sw.js` would silently never ship (this repo used to have both; the root copy was dead code that made a service-worker fix look like it did nothing).

On Android Chrome, visiting the deployed site shows an "Install app" / "Add
to Home screen" prompt automatically once the manifest + service worker are
served over HTTPS (GitHub Pages and any other static host both qualify). On
iOS Safari, use Share → "Add to Home Screen".

## 8. Performance: fixing "slow to show" / white screen

Three changes address this together:

1. **Instant loading shell.** `index.html` has a small inline `<style>` +
   `#shell` spinner that paints immediately, before any JS downloads —
   so there's never a truly blank screen, even on a slow connection.
2. **Code-splitting.** `App.jsx` lazy-loads every page (`React.lazy` +
   `Suspense`) and `exportData.js` dynamically imports `xlsx` — so the
   first paint only needs the Dashboard's code, not all six calculators
   plus the export library. `vite.config.js` also splits `vendor-react`,
   `vendor-supabase`, and `vendor-xlsx` into separate cacheable chunks.
3. **Non-blocking fonts.** Google Fonts are loaded via the
   `media="print" onload="this.media='all'"` trick, so the browser doesn't
   delay first paint waiting on them.

## 9. Troubleshooting: white screen or stuck spinner after deploying

Three causes to check if it still happens:

1. **Absolute asset paths under a subfolder.** GitHub Pages serves project
   sites from `https://<user>.github.io/<repo>/`, but an absolute base
   (`/assets/...`) 404s outside the domain root. Fixed via `base: "./"` in
   `vite.config.js` — works regardless of subfolder.
2. **A missing/misspelled Supabase secret.** If `VITE_SUPABASE_URL` or
   `VITE_SUPABASE_ANON_KEY` isn't set at build time, `createClient()` would
   throw before React renders. `src/supabase.js` guards against this so
   nothing crashes. Rather than blocking the whole app, `App.jsx` renders
   normally and shows a small dismissible `ConfigBanner` listing exactly
   which key is missing — the free tools (Fixed Deposit, Compound Interest,
   Knowledge) and every page's read-only preview work fine without
   Supabase, since only signing in and saving data actually need it. The
   Sign In button (`Topbar.jsx`) is disabled with an explanatory tooltip,
   and `AuthGate.jsx` shows "sign-in isn't available yet" instead of a
   Google button that would silently do nothing. Any other runtime error is
   caught by `ErrorBoundary.jsx` and shown on-screen with its stack trace
   (also logged to the console).
3. **Stuck on the loading spinner forever (not a blank screen, but the
   branded "Fin" mark spinning indefinitely).** This means `src/main.jsx`
   never executed at all — usually because the page is serving **raw,
   unbuilt source files** (e.g. the repository was pushed directly to the
   Pages branch without running `npm run build` first, or GitHub Pages
   "Source" is still set to "Deploy from a branch" instead of "GitHub
   Actions"). Browsers can't execute `.jsx` syntax directly, so the module
   script fails silently. `index.html` now includes a watchdog: if React
   hasn't mounted within 8 seconds, it replaces the spinner with a
   diagnostic message telling you to check the console. To actually fix
   it: confirm **Settings → Pages → Source = GitHub Actions**, and confirm
   the latest run under the **Actions** tab succeeded (green check) — if
   you're deploying manually instead, only ever push the *contents of
   `dist/`* (after `npm run build`), never the raw project folder.

   **If you'd rather not use the GitHub Actions workflow at all** (e.g. you
   don't have permission to change repo Settings, or Actions/Pages
   permissions are misconfigured in your org), there's a simpler
   branch-folder alternative that sidesteps it entirely:
   ```bash
   cp .env.example .env.local   # fill in your real Supabase keys
   npm run build:docs           # builds straight into ./docs (git-tracked)
   git add docs && git commit -m "Build for Pages" && git push
   ```
   Then in **Settings → Pages → Build and deployment → Source**, choose
   **"Deploy from a branch"**, set **Branch: `main`**, **Folder: `/docs`**,
   and save. GitHub now serves the actual built app straight out of
   `docs/` — no Actions workflow, no secrets to configure in GitHub, no
   subtlety about Pages "Source" settings beyond that one dropdown. Just
   remember to re-run `npm run build:docs` and push again every time you
   change the source, since nothing rebuilds it automatically this way.

## 10. Admin & maintenance mode

`berndvh015@gmail.com` is the configured admin account (edit `src/config/admin.js`
to add more, in both places noted below). Signing in with that Google account
reveals a **🛠️ Admin** item in the sidebar, leading to a panel that can:
- See the total number of registered users (a `count`-only query on `profiles`)
- Toggle **maintenance mode** — when on, every other visitor sees a full-screen
  "Finma is under maintenance" notice instead of the app; the admin still has
  full access, so they can turn it back off

**This is enforced in two places, and both must be updated together:**
1. `src/config/admin.js` — `ADMIN_EMAILS` — controls what the *UI* shows (the
   Admin nav item, panel access).
2. `supabase/migrations/0001_init.sql` — the `profiles_select_admin` and
   `app_config_write_admin` RLS policies check `auth.jwt() ->> 'email'`
   (Google's verified email claim) — this is what actually *enforces* it
   server-side. The client-side check alone would be trivial to bypass; the
   Postgres RLS policy is the real gate.

Maintenance mode is stored in `app_config` (row `key = 'global'`),
readable by anyone (so the check works before sign-in) but writable only by
the admin. Migrations redeploy automatically on push (see section 1), or manually:
```bash
npm run db:push
```

**Note:** the signed-out state of the ledger shows a genuinely empty list
(no seeded/fake transactions) — `useLedger.js`'s signed-out branch sets
`transactions: []`. `AuthGate` is what communicates "you'd see your data
here once signed in," not placeholder content.

## 11. Free trial vs. full access

| Page | Access |
|---|---|
| Fixed Deposit | Free — no sign-in |
| Compound Interest | Free — no sign-in |
| Net Profit Margin | Requires sign-in |
| NPV | Requires sign-in |
| Opportunity Cost | Requires sign-in |
| Knowledge (guidance) | Free — no sign-in |
| Dashboard (reports/charts) | Requires sign-in (needed to read Supabase data anyway) |
| Financial (income/expense entry) | Requires sign-in |
| Settings (profile, currency, language) | Requires sign-in — use the Topbar's language switcher instead if you just want to preview the UI in another language without signing in |

This is controlled per-page by wrapping the page's content in a **single**
`<AuthGate>` (never more than one per page — see the note in section 2).
`variant="feature"` (used on the three locked calculators) shows "sign up to
unlock this tool" wording; the default `variant="data"` (used on Financial,
Dashboard, Settings) shows "sign in to save your data" instead. To make
another calculator free, remove its `<AuthGate>` wrapper; to gate a new
page, wrap all of its gated content in one. The Sidebar's `NAV_ITEMS` array
also has a `free: true/false` flag purely for the "Free" / 🔒 badges shown
next to each item.

## Next steps for production

- Add a scheduled [Supabase Edge Function](https://supabase.com/docs/guides/functions/schedule-functions)
  (cron-triggered) to run the roll-over server-side at midnight on the 1st,
  so it doesn't depend on the app being opened that day.
- Add automated tests for `financeFormulas.js` (Vitest) and policy tests for
  `supabase/migrations/0001_init.sql` (`supabase test db`, using pgTAP).
- Consider Supabase's offline-first patterns (e.g. a local cache layer) if
  you want the ledger to keep working fully offline, not just cached page
  assets.
