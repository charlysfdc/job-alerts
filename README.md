# AiA Job Alerts

Daily job leads for the people Charly helps find work. Each person signs in with Google at
**https://jobs.afrikanerinamerika.com** and sees only their own leads; Charly signs in as admin and sees everyone.

Plan: [AiA Job Alerts - Plan](https://claude.ai/artifact/AN8wK3TUKUhzbAypkn21Pi). Concept and ground rules:
"AiA Job Alerts - Concept and Process.md" in the AiAJobAlerts Drive folder.

| Folder | What |
| --- | --- |
| `web/` | Phone web app (React + Vite PWA), deployed to GitHub Pages by `.github/workflows/deploy.yml` |
| `supabase/migrations/` | Database tables and access rules, run in order in the Supabase SQL editor |
| `supabase/seed.private.sql` | The real people and admins. **Never committed** (`*.private.*` is gitignored): this repo is public |

## Phase 0 setup (Charly)

These steps need passwords or secret keys, so Charly does them. Do them in this order.

### 1. Supabase project
1. https://supabase.com/dashboard → **New project**. Name `job-alerts`, region **East US (North Virginia)**,
   a strong database password (save it in your password manager; nothing in the app needs it).
2. **SQL Editor** → New query → paste all of `supabase/migrations/0001_init.sql` → **Run**.
3. New query → paste all of `supabase/seed.private.sql` (on the Mac in `~/Projects/GIT/job-alerts/supabase/`) → **Run**.
4. **Project Settings → API keys**: note the **Project URL** and the **publishable** key (starts `sb_publishable_`).
   Never the secret key.

### 2. Tell the app where its database is
GitHub → charlysfdc/job-alerts → **Settings → Secrets and variables → Actions → Variables** tab → **New repository variable**:
- `SUPABASE_URL` = the Project URL
- `SUPABASE_PUBLISHABLE_KEY` = the publishable key

Then **Actions → Deploy to GitHub Pages → Run workflow** (or ask Claude to re-run it).

### 3. Google sign-in
1. https://console.cloud.google.com → project picker → **New project** `AiA Job Alerts`.
2. **Google Auth Platform → Branding**: app name `AiA Job Alerts`, support email afrikanerinamerika@gmail.com,
   developer contact the same. Authorized domain: `supabase.co`.
3. **Audience**: External → **Publish app** (In production). The app only asks for name and email, so Google
   needs no review.
4. **Clients → Create client** → Web application, name `job-alerts web`:
   - Authorized JavaScript origins: `https://jobs.afrikanerinamerika.com`
   - Authorized redirect URIs: `https://<project-ref>.supabase.co/auth/v1/callback`
     (the Project URL from step 1 plus `/auth/v1/callback`)
   - Copy the **Client ID** and **Client secret**.
5. Supabase → **Authentication → Sign In / Providers → Google**: turn on, paste Client ID and secret, **Save**.
6. Supabase → **Authentication → URL Configuration**:
   - Site URL: `https://jobs.afrikanerinamerika.com`
   - Redirect URLs: add `https://jobs.afrikanerinamerika.com/**`

### 4. Check (phase 0 is done when both pass)
- Open https://jobs.afrikanerinamerika.com, sign in with afrikanerinamerika@gmail.com → the **People** page lists
  everyone from the seed file (any unconfirmed email is marked "Email to confirm").
- Sign out, sign in with any other Google account → "not on the AiA Job Alerts list".

## Phase 1: profiles
`supabase/migrations/0002_profiles.sql` adds profiles, job families, applications and the TO CONFIRM list (admin-only).
`supabase/profiles.private.sql` (gitignored) imported the three Master Job Profile Docs on 27 Oct 2026. From then on the
app is the source of truth: edit profiles on each person's page, not in the old Docs.

## Adding a person
Admin page → **Add a person**: name, the Gmail address they sign in with, home base, Drive folder link. They get an
empty profile and three starter TO CONFIRM questions (work authorisation, pay floor, commute and remote).

## The job seeker's view
Job seekers never read the tables. Their app (home, questions, profile in plain words, applications) comes from one
database function, `person_view` / `my_view`, that leaves out the coach's notes; they act through `answer_question`,
`send_request` and `add_my_application`. Coaches open **See their view** on a profile to preview it.

Built for a later self sign-up with no coach:
- `people.coach_email` empty = no coach. Answers to field-linked questions then save straight into the profile.
- `question_templates` give every new person their starter questions (a database trigger, not the page).
- Self sign-up mainly means changing `handle_new_user` to create a `people` row instead of refusing unknown accounts.

## Uploading resumes and documents
People (and admins, for them) upload a PDF, Word or text file. It goes to the private Storage bucket `documents`
(`<person id>/…`), is recorded with `register_document`, and the edge function `process-document` has Claude
(`claude-opus-5-5`) compare it with the profile. Claude's findings become `suggestions` (new fact, updated fact,
headline, new job family) and, where the document and the profile disagree, TO CONFIRM questions. Nothing reaches the
profile until a suggestion is accepted with `decide_suggestion`: by an admin, or by the person when they have no coach.

The function needs the secret `ANTHROPIC_API_KEY` (Supabase > Edge Functions > Secrets). It deploys from
`.github/workflows/deploy-functions.yml` once the repository secret `SUPABASE_ACCESS_TOKEN` is set; until then, paste
`supabase/functions/process-document/index.ts` into the dashboard editor (JWT verification off: the function checks
sign-in itself).
