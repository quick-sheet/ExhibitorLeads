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
6. Open the app, tap the sliders icon (Settings), paste the web app address and the token, and tap **Connect**.

The token stops strangers using the web app address. Keep it private. The repo never contains it.

## Install

- **Android (Chrome):** open the live address and tap **Install** on the banner. If there is no banner, use Chrome menu, **Install app**.
- **iPhone (Safari):** open the live address, tap **Share**, then **Add to Home Screen**. Open it from the home-screen icon from then on, because Safari and the installed app keep separate settings.

## Use

1. Tap the search icon at the top. The top bar stays in place as you scroll, and tapping anywhere outside the search panel closes it. Type a sector, or tap the arrow to choose from the list of 31. A number beside a sector is how many exhibitions you have already added to it.
2. Use the searches on the sector screen to find shows. Open a show's exhibitor list.
3. Share that page to Exhibitor Leads from Chrome's Share menu (Android, once installed), or copy its address and tap **Add exhibition**.
4. The list is read and each exhibitor is checked. You can leave the app: the checks carry on every 10 minutes.
5. Open any exhibitor for the detail. Confirm likely company matches, edit details, or download the CSV.

If a show's site does not allow automated reading, or the list cannot be read, use **Paste the list**.

## What the statuses mean

- **Can email:** confirmed as a limited company or LLP on Companies House. Corporate subscribers can be emailed without prior consent under PECR. You still need to say who you are, keep it relevant to the business and offer a way to opt out.
- **Consent needed:** no limited company confirmed. Could be a sole trader or a partnership, which need consent first.
- **To check:** a similar company name exists, but it is not confirmed, or the company is not active. Confirm it in the exhibitor's detail.

The company number is looked for in this order: on the exhibitor's own pages (home page, footer, terms and privacy pages), checked against Companies House and against the company name shown beside it; then the same page of the company register by name. A number found on the site is only accepted when it exists on Companies House and, if several numbers appear, the registered name also appears on the page. Irish and charity numbers are ignored.

This is a guide, not legal advice.

## Update

1. **Add file, Upload files**, choose the changed files (same names replace the old ones), then **Commit changes**.
2. Wait about a minute.
3. Fully close the app and reopen it. If it still looks the same, close and reopen once more.

If a release changes how companies are matched, it either checks the unconfirmed results again by itself the first time the sheet is used (confirmed ones are never touched), or leaves that to you. Release 6 leaves it to you, so you can try it on one exhibition first:

1. Deploy the new `Code.gs`, then update the app files.
2. Open one exhibition, choose the menu (three dots), then **Check the N “to check” again**.
3. When it finishes, open **Settings**. **How companies were matched** shows which rule confirmed each business, and **Checking the “to check” ones again** shows the counts before and now. Open a few businesses to read their evidence.
4. If you are happy, Settings has **Check them all again** for every exhibition. **Include consent needed** goes further and is rarely worth it.

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
- Sites that build their pages with JavaScript give little to read. The detail says so. For these the usual terms and privacy addresses are tried as well, which costs a few extra requests for exhibitors with no company number on their home page.
- A company counts as confirmed only on strong evidence from its own website: a company number the register holds under a fitting name (for example “Registered Company: 08756928”, never a VAT number), a legal name such as “We are Ickle Bubba Ltd” that the register holds exactly, or the registered postcode written on its pages beside a similar name. A similar name alone stays “to check”, and says when the website names a different company. A wrongly confirmed company costs more than one extra tap, so doubtful ones are left for you.
- To save time, one website's home page, mail records and company search go out together, and its terms and privacy pages are read two at a time. This uses a few more web requests but waits for them together. Settings has a **Speed** section with the average time per business, where it goes, and the slowest sites.
- Sole traders are not on the Companies House register, so they cannot be confirmed and stay as consent needed.
- Eight colour themes are in Settings: four dark (Harbour, Graphite, Forest, Aubergine) and four light (Porcelain, Stone, Sage, Sky). Harbour is the default. Every theme keeps its text at a readable contrast.
- The **plus**, **pencil** and **download** icons beside a sector's name add an exhibition, rename the sector (changing all its exhibitions at once) and download its CSV. Choose a name that already exists to join two sectors together.
- **Your leads** on the home, sector and exhibition screens lists one fact per line, including how many appear to use Google Workspace.
- Three colours mean the same thing everywhere (the stand plan, the lines under it, the filter pills and the dots beside each exhibitor): green is *can email* (a confirmed limited company), amber is *to check* and rose is *consent needed*. An outlined square is not checked yet. The colours are tuned for each theme and kept apart in lightness as well as hue, so they still tell apart for colour-blind viewers.
- On an exhibition screen, the **download** icon beside the name saves the whole list as a CSV. To save only what a filter or search is showing, use the menu (the three dots).
- The mail check looks at public MX records. "Probably Google" means Google sits behind a mail filter.
- Apps Script cuts any run off at 6 minutes, so the work is done in short bursts: about 20 seconds at a time while the app is open, and up to 3 minutes every 10 minutes in the background. An exhibitor whose site is very slow has its extra pages skipped (the detail says so, and **Check again** retries), and one that is cut off twice is skipped.
- Settings shows a **Last 24 hours** line: web requests used of 100,000 and background minutes of 360 (the Google Workspace limits). The main screen shows a warning only above 70%. It counts this app's own use, so Google's figure for your whole account may be higher. Google's limits run on a rolling 24 hours from first use, not from midnight.
- Daily limits are per Google account, across all your scripts. A free account allows about 20,000 web requests and 90 minutes of background time a day. Google Workspace allows 100,000 requests and 6 hours. Each exhibitor uses roughly five to ten requests, so a few hundred exhibitors a day is comfortable on either.
- Some exhibitors share a website (a distributor with several brands). They share one set of results.
- Spreadsheets drop the leading zero of a company number such as 07654321. The CSV also has a Companies House page link for each company.
- On some Android phones every launch of the installed app plays a sound and shows a Chrome notification saying "Tap to copy the URL for this app". That is Chrome's **Full screen site controls** notification category. Long-press the notification and turn that category off.
