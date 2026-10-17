# Exhibitor Leads

Find who exhibits at UK shows and who you can email.

A personal prospecting tool that installs on your phone. Type a sector, find the shows, load each exhibitor list, and it works out for every exhibitor the website, phone, email, contact name, whether it is a limited company (so you can email it without asking first), and whether its email runs on Google Workspace. Download a CSV per exhibition or per sector.

Live at `https://quick-sheet.github.io/ExhibitorLeads/`. The page holds no data. Everything is kept in a Google Sheet in your own account, behind a small Apps Script.

## Host

1. Deploy the Apps Script (see below) and keep the web app address and token.
2. Create the repo `quick-sheet/ExhibitorLeads` (public), upload every file in this folder, and turn on GitHub Pages from the `main` branch, root folder.

## Set up the Apps Script (once, on a computer)

1. Go to script.google.com, choose **New project** and name it Exhibitor Leads.
2. Paste `apps-script/Code.gs` over the default file. In **Project Settings** tick **Show "appsscript.json" manifest file in editor**, then paste `apps-script/appsscript.json` into it.
3. Get a free Companies House key: register at developer.company-information.service.gov.uk, create an application, then add a **REST** key. In Apps Script open **Project Settings, Script Properties**, add `CH_KEY` and paste the key as its value.
4. Choose `setup` in the toolbar, press **Run** and approve access. Open **Execution log**: it shows your access token and the Sheet address. Copy the token.
5. **Deploy, New deployment, Web app**. Set **Execute as** Me and **Who has access** Anyone, then **Deploy** and copy the **Web app URL**.
6. Open the app, tap the sliders icon, paste the web app address and the token, and tap **Connect**.

The token stops strangers using the web app address. Keep it private. The repo never contains it.

## Install

- **Android (Chrome):** open the live address and tap **Install** on the banner. If there is no banner, use Chrome menu, **Install app**.
- **iPhone (Safari):** open the live address, tap **Share**, then **Add to Home Screen**. Open it from the home-screen icon from then on, because Safari and the installed app keep separate settings.

## Use

1. Type a sector on the first screen, or tap a suggestion.
2. Use the searches on the sector screen to find shows. Open a show's exhibitor list.
3. Share that page to Exhibitor Leads from Chrome's Share menu (Android, once installed), or copy its address and tap **Add exhibition**.
4. The list is read and each exhibitor is checked. You can leave the app: the checks carry on every 10 minutes.
5. Open any exhibitor for the detail. Confirm likely company matches, edit details, or download the CSV.

If a show's site does not allow automated reading, or the list cannot be read, use **Paste the list**.

## What the statuses mean

- **Can email:** confirmed as a limited company or LLP on Companies House. Corporate subscribers can be emailed without prior consent under PECR. You still need to say who you are, keep it relevant to the business and offer a way to opt out.
- **Consent needed:** no limited company confirmed. Could be a sole trader or a partnership, which need consent first.
- **To check:** a similar company name exists, but it is not confirmed, or the company is not active. Confirm it in the exhibitor's detail.

This is a guide, not legal advice.

## Update

1. **Add file, Upload files**, choose the changed files (same names replace the old ones), then **Commit changes**.
2. Wait about a minute.
3. Fully close the app and reopen it. If it still looks the same, close and reopen once more.

Each release bumps two markers together: `core.js?v=N` in `index.html` and the cache name `exhibitorleads-vN` in `sw.js`. If `Code.gs` changed, also go to **Deploy, Manage deployments**, tap the pencil, set Version to **New version** and **Deploy**. That keeps the same address.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The whole interface |
| `core.js` | Plain logic: dates, statuses, filters, CSV, the stand plan |
| `sw.js` | Offline support and instant updates |
| `manifest.webmanifest` | Install to the home screen and receive shared pages |
| `icon.svg`, `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` | Icons |
| `apps-script/Code.gs`, `apps-script/appsscript.json` | The thin server: Sheet storage, Companies House, mail-record check, directory reading |

## Good to know

- Pages are read politely: the app obeys each site's `robots.txt`, and anything it asks bots not to read is skipped.
- Contact names and emails come from company websites, so they are patchy. Emails are never guessed. A Companies House director is shown, labelled, only when a company is confirmed.
- Sites that build their pages with JavaScript give little to read. The detail says so.
- The mail check looks at public MX records. "Probably Google" means Google sits behind a mail filter.
- A free Google account can make about 20,000 web requests a day from Apps Script. Each exhibitor uses roughly five to eight, so a few hundred exhibitors a day is comfortable.
- Some exhibitors share a website (a distributor with several brands). They share one set of results.
- Spreadsheets drop the leading zero of a company number such as 07654321. The CSV also has a Companies House page link for each company.
- On some Android phones every launch of the installed app plays a sound and shows a Chrome notification saying "Tap to copy the URL for this app". That is Chrome's **Full screen site controls** notification category. Long-press the notification and turn that category off.
