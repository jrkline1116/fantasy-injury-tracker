# Fantasy Injury Tracker

Push alerts when your fantasy players, or the players they depend on, are ruled out or cleared to play.

- **Linked players:** a WR or TE is linked to his QB; a RB is linked to his handcuff. "Burrow is Out. Affects Tee Higgins. Consider benching him."
- **Works with any league app (ESPN, Yahoo, Sleeper):** each team is a lineup grid. Pick a slot (QB, RB, WR, TE, FLEX, S-FLEX, D/ST, K, IDP, BENCH), type a name, and the status fills in automatically. 15 rows to start, plus "Add another player" for bigger rosters.
- **Alerts:** ruled out, cleared, handcuff upgrade/downgrade, pre-game check at T-5 to T-120, Thursday bye-week warning, quiet hours.
- **If/then rules:** "If McConkey is ruled Active, start him over Mike Evans." One alert tells you exactly what to swap.
- **Notification control** at every level: global, team, player, and link.

It's a PWA on GitHub Pages with a Supabase backend. Updating the app is `git push`; no Android Studio, no cable.

```
index.html  app.css  app.js      the app (GitHub Pages)
config.js                        your Supabase URL/key and VAPID public key
sw.js  manifest.json  icons/     installable app + push notifications
supabase/migrations/001_init.sql database tables and security rules
supabase/cron.sql                runs the backend every minute
supabase/functions/tick/         scheduled job: sync players, schedule, statuses; send alerts
supabase/functions/api/          app actions: add players with auto-links, test tools
supabase/functions/_shared/      alert engine, push sending, auto-links
```

---

## Setup (about 30 minutes, one time)

You'll need: a GitHub account, [Node.js](https://nodejs.org) (for the `npx` commands), and a free [Supabase](https://supabase.com) account.

### 1. Put the code on GitHub and turn on Pages

1. Create a new public repo named `fantasy-injury-tracker` at <https://github.com/new>.
2. Upload every file and folder from this zip (drag them into "uploading an existing file"), or push with git.
3. Repo **Settings → Pages → Build and deployment → Source: Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
4. After a minute your app lives at `https://jrkline1116.github.io/fantasy-injury-tracker/`. It will say "Almost there" until step 7.

### 2. Create the Supabase project and database

1. At <https://supabase.com/dashboard> click **New project**. Name it `fantasy-injury-tracker`, pick a region near you (West US), save the database password somewhere.
2. When it's ready, open **SQL Editor → New query**, paste all of `supabase/migrations/001_init.sql`, and click **Run**. You should see "Success. No rows returned." Then do the same with `supabase/migrations/002_plans.sql` (free vs Pro) `supabase/migrations/003_rules.sql` (if/then rules), and `supabase/migrations/004_lineup.sql` (lineup grid). Run them in number order.
3. **Authentication → URL Configuration**:
   - Site URL: `https://jrkline1116.github.io/fantasy-injury-tracker/`
   - Redirect URLs: add the same URL.
4. **Project Settings → API** (or **API Keys**): copy the **Project URL** and the **anon / publishable** key. You'll paste them in step 7. Also note the **project ref** (the `abcd1234` part of the URL).

### 3. Make push notification keys (VAPID)

In a terminal:

```
npx web-push generate-vapid-keys
```

Save both the **Public Key** and **Private Key**.

### 4. Make a cron secret

Any long random string. This command prints one:

```
node -e "console.log(crypto.randomUUID())"
```

### 5. Deploy the backend functions

In a terminal, from the repo folder:

```
npx supabase login
npx supabase link --project-ref YOUR-PROJECT-REF
npx supabase secrets set VAPID_PUBLIC_KEY=YOUR-PUBLIC-KEY VAPID_PRIVATE_KEY=YOUR-PRIVATE-KEY VAPID_SUBJECT=mailto:your@email.com CRON_SECRET=YOUR-CRON-SECRET
npx supabase functions deploy api
npx supabase functions deploy tick --no-verify-jwt
```

(`link` asks for the database password from step 2.)

### 6. Start the every-minute schedule

Open `supabase/cron.sql`, replace `YOUR-PROJECT-REF` and the cron secret placeholder, then paste the whole file into **SQL Editor** and **Run**.

Within a couple of minutes the first run loads about 2,000 players and this week's schedule. Check **Table Editor → nfl_players** (should have rows) and **job_state** (should show `players`, `schedule`, `injuries`). The very first injury pull seeds statuses quietly without sending alerts.

### 7. Point the app at your backend

Edit `config.js` on GitHub (pencil icon) with your Project URL, anon/publishable key, and VAPID **public** key. Commit. These are safe to publish; the database's security rules keep each person's data private.

### 8. Install it on your phone

1. Open the Pages URL in **Chrome** on your phone. Enter your email and tap the sign-in link from the email (it opens in Chrome, signed in).
2. Chrome menu **⋮ → Add to home screen → Install**.
3. Open it from the home screen, tap **Turn on** for notifications, then **Alerts → Send test notification**.
4. Add a team (the last tab, "+ Team"), then fill in the grid: slot on the left, player name in the middle, status on the right. QB and handcuff links are added automatically; tap a player's name to change them.
5. Try **Alerts → Simulate** to see a real push for a fake status change.

---

## Updating the app

**App changes** (`index.html`, `app.js`, `app.css`): edit, then bump `VERSION` in `sw.js` and `APP_VERSION` in `app.js` to the same number, and push. Your phone shows **"A new version is ready"** next time you open it; tap **Update now**.

**Backend changes** (`supabase/functions/...`): `npx supabase functions deploy api` or `... deploy tick --no-verify-jwt`. Takes effect immediately.

**Database changes:** add a new file like `supabase/migrations/002_something.sql` and run it in the SQL Editor.

## How alerts read

Every alert uses the same shape: the title is the player whose status changed, and each line says what it means for your lineup.

| Situation | Alert |
|---|---|
| Linked QB ruled out | **Smith ACTIVE → OUT** · → Bowers DOWNGRADE · consider benching |
| Your starter goes Out → Questionable | **Bowers OUT → QUESTIONABLE** · In your lineup · trending up, still questionable |
| Your starter is cleared | **Bowers QUESTIONABLE → ACTIVE** · In your lineup · cleared to play |
| RB1 out, handcuff on your bench | **Hubbard ACTIVE → OUT** · → Dowdle UPGRADE · start him |
| RB1 cleared, handcuff in your lineup | **Hubbard QUESTIONABLE → ACTIVE** · → Dowdle DOWNGRADE · consider benching |
| Your if/then rule triggers | **McConkey QUESTIONABLE → ACTIVE** · RULE → start McConkey over Evans |

Titles always show the move (from → to). Lines use **UPGRADE** or **DOWNGRADE** when a player crosses in or out of playing, and **WATCH** for a trend that isn't settled yet (Out → Questionable, Active → Questionable).

The default alert setting, **Out or cleared**, fires when a player is ruled out (Out, IR, suspended), comes back off it (including Out → Questionable), or is fully cleared. It skips new Questionable and Doubtful tags on healthy players. **Everything** includes those tags too.

**If/then rules** are set per team (Add rule, or from a player's screen). They fire once, always come through even in quiet hours, and clear themselves on Tuesday. The pre-game check also lists rules still waiting on a Questionable player. The app can't change your ESPN lineup for you; the alert tells you exactly what to swap.

## League sync (ESPN + Sleeper)

Tap **+ Team** to link a league instead of typing a roster. One person links the league; everyone else in it opens that person's **invite link** (Team settings → Share invite link), signs in, and claims their team.

- **Sleeper:** enter a username, pick leagues.
- **ESPN:** paste the league URL. Private leagues also need the `espn_s2` and `SWID` cookies from a computer (the app shows how). They're encrypted with `LEAGUE_SECRET_KEY` and never readable from the browser.
- Synced every 3 hours, every 30 minutes around games, plus **Sync now**. Lineup slots, bench, and IR come from the league; links, rules, and alert settings still work.
- If ESPN cookies expire, the linker gets a "Reconnect" notification and the league pauses until they update them.
- **Stop syncing** turns a team back into a manual team.

Setup: run `007_league_sync.sql`, add an Edge Function secret named `LEAGUE_SECRET_KEY` (any long random string; never change it later or saved cookies can't be read), and redeploy both functions.

## Free and Pro

**Right now plans are off: everyone gets unlimited teams.** The plumbing is in place for later.

To turn on the free limit (1 team free, Pro unlimited):
1. In the SQL Editor run: `create or replace function public.free_team_limit() returns int language sql immutable as $$ select 1 $$;`
2. In `app.js` set `PLANS_ENABLED = true`, bump the version, and push.

The database enforces the limit, so it can't be bypassed from the browser. Payments aren't wired up yet; with plans on, the app says "Pro is coming soon." To make an account Pro by hand (for yourself or a tester), run in the SQL Editor:

```sql
insert into public.accounts (user_id, plan, source)
select id, 'pro', 'manual' from auth.users where email = 'you@example.com'
on conflict (user_id) do update set plan = 'pro', pro_until = null, updated_at = now();
```

Later, a Stripe webhook will write to the same `accounts` table.

## Where the data comes from

| Data | Source | How often |
|---|---|---|
| Players, teams, depth charts, ESPN ids | Sleeper public API | Once a day |
| Game schedule | ESPN public scoreboard | Every 3 hours |
| Injury statuses | ESPN public injuries feed | Every 2 min within 3 hours of a game, every 15 min otherwise |

Both are free and unofficial, so either could change without notice. If a feed breaks, the `tick` log (below) will show errors and no bad data gets written: a feed that returns too few entries or clears 150+ players at once is skipped.

Game-day inactives show up once ESPN marks those players Out, usually within minutes of the official list about 90 minutes before kickoff.

## Troubleshooting

- **Backend logs:** Supabase → **Edge Functions → tick → Logs**. Each run returns what it did (`players`, `schedule`, `injuries`, `pregame`...).
- **Is the schedule running?** SQL Editor: `select * from cron.job_run_details order by start_time desc limit 10;`
- **No players in search:** the first `tick` hasn't run. Check step 6 and the logs.
- **Test notification says "No devices":** turn notifications on from the app on that device. If Chrome blocked them, long-press the app icon → App info → Notifications.
- **Push errors in logs:** re-check the VAPID keys in step 5 match `config.js` exactly. If you ever change VAPID keys, turn notifications off and on again on each device.
- **Sign-in email doesn't arrive:** Supabase's built-in email is limited to a few per hour. Wait, or add your own SMTP under Authentication → Emails.
- **Pause everything:** SQL Editor: `select cron.unschedule('fit-tick');`

## Costs

Free. The Supabase free tier covers this comfortably (one run per minute is about 43,000 function calls a month; the free tier includes 500,000). Free Supabase projects can be paused after a stretch of inactivity. Opening the app regularly helps; if it ever pauses, restore it from the Supabase dashboard in one click.
