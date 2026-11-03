# Ryley's Dungeon

A Dungeon Crawler Carl inspired personal dashboard that runs as a static web app. It shows your Google Calendar (the Schedule), your Todoist work tasks (the Quest Log), a daily AI briefing with commentary (the Announcer), live weather with moon and sun data (the Surface Report), upcoming birthdays and events (Celebrations), bookmarks (Stairwells), and XP, streaks, and achievement pop-ups for cleared quests (Achievements).

Everything runs in your browser. There is no server. API keys stay on each device, and your progress syncs between devices through a private file in your own Google Drive.

## Hosting on GitHub Pages

1. In this repository on GitHub, open **Settings**, then **Pages**.
2. Under **Build and deployment**, set **Source** to **Deploy from a branch**.
3. Choose the `master` branch and the `/ (root)` folder, then click **Save**.
4. After a minute, the site is live at `https://ryleyp.github.io/dashboard/`.

## First-Time Setup

Open the site, then click the key button in the header to open the **Crawler Menu**. You will set up three things.

### 1. Todoist (the Quest Log)

1. In Todoist, open **Settings**, then **Integrations**, then the **Developer** tab.
2. Copy your **API token** and paste it into the Crawler Menu.
3. Pick the project you want to show. Work Tasks is selected by default if it exists.
4. Click **Save Settings**.

Completing a quest in the dashboard completes it in Todoist. Confirmed completions in the selected project earn XP whether you finish them here or directly in Todoist. Province Bosses (priority 1) are worth 50 XP, Borough Bosses 30, Neighborhood Bosses 20, and Mobs 10.

XP tracking begins when you first open this version of the dashboard. Existing XP is preserved; earlier Todoist history is not backfilled because older dashboard completions have no task IDs for reliable duplicate detection. History is checked on launch, every five minutes while open, when returning to the tab, and with **Refresh quests**. Completion timestamps determine the activity day and streak, and recurring completions get separate credit. Deleted or moved tasks do not earn XP merely by disappearing from the list.

Dashboard completions use the same confirmed history as external completions. If Todoist delays or rejects a history request, the quest can still close successfully and XP stays pending until a successful refresh. History is paginated and long absences are split into 30-day requests. A durable completion ledger prevents duplicate XP on refresh or reload and is merged when loading progress from Drive. Google Drive remains a best-effort sync; keep the dashboard current on each device.

### 2. Google Calendar (the Schedule, Celebrations, and cross-device sync)

This takes about ten minutes the first time, and you only do it once.

1. Go to [console.cloud.google.com](https://console.cloud.google.com/) and create a new project. Any name works, for example "Atlas".
2. Open **APIs & Services**, then **Library**. Enable the **Google Calendar API** and the **Google Drive API**.
3. Open **APIs & Services**, then **OAuth consent screen**. Choose **External**, give the app a name, enter your email for the support and developer contact fields, and save.
4. Still on the consent screen, open **Audience** (or **Test users**) and add your own Gmail address as a test user. The app stays in testing mode, which is fine for personal use.
5. Open **Credentials**, click **Create credentials**, then **OAuth client ID**. Choose **Web application**.
6. Under **Authorized JavaScript origins**, add `https://ryleyp.github.io`. If you also want to run it locally, add `http://localhost:8080` as well.
7. Click **Create** and copy the **Client ID**. It ends in `.apps.googleusercontent.com`.
8. Paste the Client ID into the Crawler Menu and click **Connect Google**. Sign in and allow access. Google will warn that the app is unverified because it is your own test app. Click **Continue**.

The app asks for read-only calendar access and access to its own hidden app folder in Drive, where it keeps a single file with your XP, bookmarks, and calendar choices so every device shows the same progress.

### 3. The Announcer (optional)

Without a key, the Announcer uses a short list of canned lines. For a live briefing written from your actual day:

1. Create an API key at [console.anthropic.com](https://console.anthropic.com/).
2. Paste it into the Crawler Menu. The model defaults to `claude-opus-5-5`.

The key is stored only in this browser and is sent directly from your browser to Anthropic. Do not use this on a shared or public computer.

### Weather

In the Crawler Menu, type your city and click **Find**. Weather comes from Open-Meteo and needs no key.

## Appearance and settings export

In the **Crawler Menu**, choose **Dungeon** (dark), **Surface** (light), or **Follow device**. The default **Compact command center** uses a denser desktop grid; **Comfortable** keeps the roomier layout. Both the Schedule and Quest Log have small, independently scrollable content boxes: 220 pixels high on desktop and 200 pixels on mobile. They support keyboard scrolling, and expanded quest details stay inside the box. Mobile retains a single column. Appearance is saved per browser when you click **Save Settings**.

**Export settings JSON** downloads the current menu values, appearance, resolved weather location, bookmarks, and calendar choices in a versioned JSON file. API keys are excluded by default. The optional **Include Todoist and Anthropic API keys** checkbox includes those secrets in plain text; keep that file private. Google access tokens and XP history are never exported. This is an export for inspection or backup, with no import flow yet. To change the exported location, use **Find** to resolve the city first.

## Putting It on Your Phone

- **iPhone (Safari):** open the site, tap the Share button, then **Add to Home Screen**.
- **Android (Chrome):** open the site, tap the menu, then **Install app** or **Add to Home screen**.

The app opens full screen with its own icon and keeps working offline for the parts that do not need live data.

## Running It Locally

Any static file server works. For example:

```
python3 -m http.server 8080
```

Then open `http://localhost:8080/`. Remember to add that origin to your Google OAuth client if you want calendars to load locally.

## Files

- `index.html` is the page.
- `atlas.css` is the styling: a dark dungeon theme by default, with a lighter surface theme when your device prefers light mode.
- `atlas.js` holds UI logic and API calls.
- `dashboard-data.js` handles settings exports, completion-history pagination, and XP ledger accounting.
- `manifest.webmanifest` and `sw.js` make it installable as a home-screen app.
- `icons/` holds the app icons.

## Validation

No build step or package installation is required. With Node.js 22 or later:

```sh
node --check atlas.js
node --check dashboard-data.js
node --check sw.js
node --test tests/*.test.js
```

The tests cover external completion credit, duplicate history, recurring tasks, priority mapping, legacy migration, device-ledger merges, pagination, failed requests, and secret exclusion. Pull requests run these checks in GitHub Actions. Browser checks should exercise both themes, desktop/mobile widths, settings downloads, and scrolling/expanding long quest lists. Completion-history behavior follows the [Todoist API documentation](https://developer.todoist.com/api/v1/#tag/Tasks/operation/get_completed_tasks_by_completion_date_api_v1_tasks_completed_by_completion_date_get).
