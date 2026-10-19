# Exhibitor Leads

Find who exhibits at UK shows and who you can email.

A personal prospecting tool that installs on your phone. Type a sector, find the shows, load each exhibitor list, and it works out for every exhibitor the website, phone, email, contact name, whether it is a limited company (so you can email it without asking first), whether its email runs on Google Workspace or Microsoft 365 (the two easy ways to sign in to an AppSheet app), and what other services it has set up for its domain. Download a CSV per exhibition or per sector.

Live at `https://quick-sheet.github.io/ExhibitorLeads/`. The page holds no data. Everything is kept in a Google Sheet in your own account, behind a small Apps Script.

## Host

1. Deploy the Apps Script (see below) and keep the web app address and token.
2. Create the repo `quick-sheet/ExhibitorLeads` (public) and upload every file in this folder.
3. Publish it with GitHub Pages. This repo uses a small workflow, `.github/workflows/pages.yml` ("Deploy to Pages"), with **Settings, Pages, Source** set to **GitHub Actions**. It runs on every commit to `main` and can also be started by hand from the **Actions** tab (**Run workflow**). It is pinned to `ubuntu-24.04`, because GitHub's plain branch build sat in a queue for hours. Do not delete it. A new repo can instead choose **Deploy from a branch, main, root folder** if that builds promptly.

## Set up the Apps Script (once, on a computer)

1. Go to script.google.com, choose **New project** and name it Exhibitor Leads.
2. Paste `apps-script/Code.gs` over the default file. In **Project Settings** tick **Show "appsscript.json" manifest file in editor**, then paste `apps-script/appsscript.json` into it.
3. Get a free Companies House key: register at developer.company-information.service.gov.uk, create an application, then add a **REST** key. In Apps Script open **Project Settings, Script Properties**, add `CH_KEY` and paste the key as its value.
4. Choose `setup` in the toolbar, press **Run** and approve access. Open **Execution log**: it shows your access token and the Sheet address. Copy the token.
5. Choose `authorise` in the toolbar, press **Run** and approve. This lets the script send you notification emails (see Release 10 below). It does nothing else and sends nothing.
6. **Deploy, New deployment, Web app**. Set **Execute as** Me and **Who has access** Anyone, then **Deploy** and copy the **Web app URL**.
7. Open the app, tap the sliders icon (Settings), paste the web app address and the token, and tap **Connect**.

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

The company number is looked for in this order: on the exhibitor's own pages (home page, footer, terms, privacy and contact pages, and Shopify's business details page), checked against Companies House and against the company name shown beside it; then the same page of the company register by name. A number found on the site is only accepted when it exists on Companies House and, if several numbers appear, the registered name also appears on the page. Irish and charity numbers are ignored.

A lead also counts as confirmed when its own pages name the company behind it (“We are X Ltd”, “a trading name of Y Ltd”, “© 2026 Y Ltd”) and Companies House has exactly that name, or when a company with a matching name is backed by a second piece of evidence: its registered postcode on the site, one of its directors named on the site, as the contact or in an email address, or a director's postcode on the site. A matching name on its own is never enough.

This is a guide, not legal advice.

## Update

1. **Add file, Upload files**, choose the changed files (same names replace the old ones), then **Commit changes**.
2. Open the **Actions** tab and wait for **Deploy to Pages** to show a green tick (usually under a minute). Opening `sw.js` on the live address should show the new `exhibitorleads-vN` name.
3. Fully close the app and reopen it. If it still looks the same, close and reopen once more.

**Release 13 (Apps Script release 13).** Microsoft 365 gets its own count line and filter, each lead shows which other services its business uses, and the company check confirms more companies by itself.

1. Paste the new `Code.gs` over the old one and save. You do not need to run `authorise` or `setup` again.
2. **Deploy, Manage deployments**, the pencil, **New version**, **Deploy**.
3. Upload `index.html`, `core.js`, `sw.js` and `README.md` and commit. Wait for the green tick in **Actions**, then fully close and reopen the app. Settings should say **Apps Script release: 13, up to date**.

The first time it runs, the new Apps Script adds a column called `alsoUses` to the end of the **Exhibitors** tab of your sheet. Leave it where it is.

What release 13 changes:

- **Microsoft 365** sits next to Google Workspace: a line under **Your leads** (“2 appear to use Microsoft 365”), a **Microsoft 365** filter, and a “Microsoft 365” label on each lead. In each status, Google Workspace leads come first, then Microsoft 365, then the rest. Leads already checked show up straight away, because the mail host was already recorded.
- **Behind a mail filter.** A business whose email passes through a filter such as Mimecast or Proofpoint used to show only “Mail filter”. If its domain records name Microsoft (its SPF record, or Microsoft's `MS=` verification), it now shows “Probably Microsoft 365”, the same way Google behind a filter shows “Probably Google”. This needs a fresh check of the lead.
- **Apple iCloud.** A business using its own domain with iCloud Mail shows “Apple iCloud” instead of “Other”.
- **Also uses** (under **Email setup** on each lead, and a CSV column after **Mail host**): the other services a business has set up for its domain. It looks for Microsoft 365, Google Workspace, Apple, Dropbox, Salesforce and Smartsheet (the other ways to sign in to AppSheet), and HubSpot, Atlassian and Zendesk. It finds them in the domain's DNS records: a company account usually leaves a verification record behind, and services that send email for the business are named in its SPF record.
  - Finding one is a good sign that the company uses it. Not finding one means nothing, because most small firms never verify their domain. It shows that the company uses the service, not that every person has an account on their work address.
  - Box is not listed, because its records could not be confirmed.
  - Leads already checked get it the next time they are checked (**Check again** on a lead, **Check the “to check” again**, or **Check everything again** in an exhibition's menu). New checks get it straight away. It costs one more lookup per business, made at the same time as the first page, well within the daily limit.
- **More companies confirmed without you.** A “to check” lead is usually a company with the same or a similar name on Companies House and nothing else to back it. The check now looks for that second piece of evidence:
  - **A director on its website.** The company's current directors are fetched, and a director's full name on its pages (an About page, say), as its contact, or in an email address such as jane.smith@ confirms it: “Director named on its website: Jane Rivers”. A first name or a surname alone does not count.
  - **A director's postcode.** Small firms often use their accountant's address as the registered office, so that postcode is rarely on their site. A director's correspondence postcode often is the trading address, so it counts too.
  - **The company behind the brand.** “Little Sprout is a trading name of Greenfield Family Trading Ltd”, “Northwind Retail Ltd t/a Kite & Co”, “this website is operated by Y Ltd” and the copyright line “© 2026 Y Ltd” now count even when the company name is nothing like the brand, if Companies House has exactly that name. Payment providers, couriers, platforms, web designers and photographers named this way are ignored.
  - **More pages and data.** Its contact page is read as well (it often gives the address and the people behind it), Shopify shops' Contact information page is tried, and a legal name or a labelled company number in the page's structured data is used.
  - **Other names it goes by.** When its listed name finds nothing that can be confirmed, Companies House is also searched for the name its website gives itself, numbers written as words (“3 Little Birds” as “Three Little Birds”), the name without words like Shop or Boutique, and its web address split into words. A company found this way still needs its own evidence, and the lead says how it was found: “… (found by searching “Mama Bear Slings”)”.
  - These only ever confirm a company. A lead with nothing new to back it stays exactly as it was. Open any lead and tap **Why this result?** to see each step, including which directors were looked for.
- **Safeguards against confirming the wrong company.** Before this release went out, the new rules were tested against the ways they could go wrong, and these checks were added (some also tighten older rules):
  - **Franchises and branches.** If the listed name adds a place the company name does not have (“Baby Sensory Surrey” against BABY SENSORY LIMITED), or its site says it is a franchise or independently owned, a match by name, director or postcode is left as “to check”. Its note starts “May be a franchise or branch”, and Settings counts these on their own line. A company number on its own pages still stands, unless both signs are there. Two exhibitors on one website with different places in their names no longer share a result.
  - **Shared addresses.** A postcode where many companies are registered (formation agents and virtual offices, such as 160 City Road EC1V 2NX) proves nothing. The app asks Companies House how many companies are registered at a postcode before counting it.
  - **Statements about someone else.** “X is a trading name of Y Ltd” counts only when X is the exhibitor's own name, website name or web address, and never next to finance, credit or insurance wording, so a lender, courier or brand it stocks is not taken. A copyright line counts only at the foot of the page, and never for a photographer, designer, review widget or licensed character.
  - **Directors.** A director's name must appear in a sentence that says they started, own or run it (“founded by”, “I'm”, “meet”), so a customer review signed with the same name does not count. The business's own name is never read as a person (“Lily Rose Designs”), and only email addresses on its own domain count. The company's name must be at least a close match (prefix or exact).
  - **Exact means exact.** “Bear and Bow Ltd” no longer matches BEAR BOW LTD; if two records share a name the app does not guess; template text such as “Your Company Ltd” is ignored; “limited edition” is not a company; and charity, FCA and ICO numbers are never taken for company numbers.
  - **Marketplaces and social pages.** An Etsy, notonthehighstreet, Amazon, eBay, Linktree, Instagram or Facebook address is not read as the business's own website.
  - **To apply them to leads already checked**, start with one exhibition: its menu, **Check the “to check” again**. Then, if you like the result, **Settings**, **Check them all again** (or **Include consent needed** to look at those too). Settings shows the counts before and after, and **How companies were matched** shows how many were confirmed each new way.
  - Each “to check” lead may now take up to six more Companies House requests (directors of up to three companies, up to two more searches, and a postcode count). Companies House allows 600 requests every five minutes; if it asks the app to slow down, the extra steps are skipped for that lead rather than failing it.
  - Rechecking can also move a lead the other way: a lead that was confirmed only by a name on a franchise class's site, or by a virtual office postcode, becomes “to check”. That is the safer answer.

**Release 12 (Apps Script release 12).** A message every time a check finishes, whether or not you are in the app, and for any number of exhibitors.

1. Paste the new `Code.gs` over the old one and save. You do not need to run `authorise` again.
2. **Deploy, Manage deployments**, the pencil, **New version**, **Deploy**.
3. Upload `index.html`, `sw.js` and `README.md` and commit. Wait for the green tick in **Actions**, then fully close and reopen the app. Settings should say **Apps Script release: 12, up to date**.
4. Check an exhibition again (even one business). A message should reach ntfy within about a minute. If none comes, open **Settings** and read the **Last message** line under Notifications.

What release 12 changes:

- **Every finished check sends a message.** Releases 9 to 11 stayed quiet while you were in the app, and for checks of fewer than 5 exhibitors. Both rules are gone. Checking one business again now sends a message when it finishes.
- **One message per finish.** A check that takes several runs says nothing until nothing is left to check, then sends one message. If two runs finish the same check together, only one message goes. Checking the same exhibition again later is a new finish, so it sends a new message.
- **Last message** (from release 11) stays: Settings says what the last message did, or why it could not be sent.
- **Limits.** Each message is one email from your Google account, so a lot of small rechecks add up. Google allows about 100 emails a day on a free account (about 1,500 on Workspace). Past that the app shows the daily-limit reason under **Last message**, and the checks themselves carry on.

**Release 11 (Apps Script release 11).** A finished check no longer loses its message if you leave the app just before the end, and Settings shows what the last message did.

1. Paste the new `Code.gs` over the old one and save. You do not need to run `authorise` again.
2. **Deploy, Manage deployments**, the pencil, **New version**, **Deploy**.
3. Upload `index.html`, `sw.js` and `README.md` and commit. Wait for the green tick in **Actions**, then fully close and reopen the app. Settings should say **Apps Script release: 11, up to date**.

What release 11 changes:

- **A message could be lost.** The background run (every 10 minutes) counted you as “in the app” for two and a half minutes after your last tap. If it finished a check inside that time, it skipped the message and then forgot the check. Release 11 held it back for the next background run. Release 12 removes the in-app rule altogether, so nothing is held back.
- **Last message.** Under Notifications, Settings says what the last message did: “Last message: the message for Baby & Toddler Show was sent at 19:00.” or why it could not be sent. A check that finishes in the background has no screen to tell you, so this is where a failure shows. (Apps Script, **Executions**, then the run, shows the same reason in its log as a line starting `notify:`.)
- **If it says the message could not be sent because of approval,** choose `authorise`, press **Run** and approve. If checks that finish in the background still fail after that, choose `setup` and press **Run** once more: it is safe to repeat, keeps your token and sheet, and sets up the 10-minute background run again.

**Release 10 (Apps Script release 10).** Notifications now reach ntfy by email, and the pop-up messages show above open panels.

1. Paste the new `Code.gs` over the old one and save.
2. Choose `authorise` in the toolbar, press **Run** and approve the new permission, **Send email as you**. Open **Execution log**: it says how many emails the script can still send today. This is needed once, and sends nothing.
3. **Deploy, Manage deployments**, tap the pencil, set Version to **New version** and **Deploy**. The address stays the same.
4. Upload `index.html`, `sw.js` and `README.md` and commit. Nothing changes in ntfy on your phone: the notification code is the same.
5. Open **Settings** (the box says **Apps Script release: 10, up to date**), then **Notifications, Send test notification**. The result is written under the button: “Sent at 18:20…”, or the exact reason it could not send. The message reaches ntfy within about a minute.

What release 10 changes:

- **Why.** ntfy.sh turns away web requests from Google's shared servers (error 429), which is where Apps Script runs. Release 9 sent them that way and so failed. Release 10 has Apps Script send a short email to `ntfy-<your code>@ntfy.sh`, which ntfy turns into a notification (the subject becomes the title, the body the message). Same rules at the time (release 12 later removed the “only when you are away” and “5 or more” rules): one message per exhibition, the same wording.
- **The link.** The email route cannot carry a tap action, so on Android the exhibition link is written in the message itself: tap that link to open the exhibition. Tapping the notification opens ntfy. On iPhone there is no link, so open Exhibitor Leads from your Home Screen.
- **Pop-up messages** (“Test sent”, “Copied”) were drawn behind open panels such as the notification steps, so you never saw them. They now sit on top, and the test result is also written inside the panel.
- **Limits.** Google lets a free account send about 100 emails a day (about 1,500 on Workspace), far more than this needs. If an email cannot be sent, the app shows why. A failed delivery can also come back as a bounce message in your Gmail inbox. Messages sent by email can take up to a minute to arrive.


Every release: after deploying the new `Code.gs`, open **Settings**: the box under the connection form says **Apps Script release: N, up to date**. If it says older, the new version was not deployed (see the last paragraph below), and the app also shows a warning on the main screen until it is.

What release 9 added:

- **Notifications through ntfy.** When a check finishes, ntfy sends one message (release 12: every time, in the app or not, any size; release 9 only sent it for checks of 5 or more exhibitors while you were away), for example “Baby & Toddler Show: all 120 checked. 34 can email, 29 to check, 57 need consent. 9 sites wouldn’t open.” Settings has a **Notifications** section with the setup steps (Android: install ntfy, tap Connect, turn on instant delivery; iPhone: install ntfy, copy the code, subscribe by hand) and a **Send test notification** button.
  - Releases 9 to 11 only sent a message when you were away from the app and the check covered 5 or more exhibitors. Release 12 removed both rules.
  - One message per exhibition, however many runs it took.
  - The notification code is made on your phone and kept in your Apps Script's Script Properties, never in the repository. Anyone who knows the code could read the messages, which only hold the exhibition name and counts. **Turn off** forgets it.
  - On Android the message holds a link to the exhibition (from release 10; release 9 made the tap itself open the app). On iPhone there is no link, because it would open Safari, which does not have your settings. Open Exhibitor Leads from your Home Screen.

What release 8 added:

- **The same exhibitor in more than one exhibition.** If a business with the same name (ignoring Ltd, The and punctuation) is already checked under another exhibition in the same sector, the new one takes that result at once, with no web requests, and its note says which exhibition it came from. A different website means a different business, so those are checked on their own. A confirmed company is always reused. A weaker result is reused only by a business not checked yet, so **Check again** and the “to check” recheck always do their own reading.
- **A badge with a count** on any exhibitor listed in two or more exhibitions (the same website anywhere, or the same name within the sector). The detail screen lists the other exhibitions.
- **Percentages** on the lead lines (can email, quick check, consent, Google Workspace): a share of the exhibitors checked so far, which is all of them once the checks finish.
- **A copy icon** beside the company number.
- **Find on Companies House** on the detail screen: type a name or paste a number, see up to eight matches with their status and address, tap one and confirm. It is saved as confirmed by you, the same as entering a number.
- **Couldn’t read.** A filter on each exhibition for businesses whose website would not open (it turned the app away, asked bots to stay out, did not answer, or only some pages opened), and a tally in Settings under **Websites that would not open**. The app never tries to get round a site that turns it away: for those, use **Find on Companies House**.

Open any checked business and tap **Why this result?** It runs the check again without saving anything and lists every page it read, what each gave (company numbers, legal names, postcodes), which pages it could not read and why (a site that turns requests away, or a `robots.txt` that asks bots to stay out), what Companies House said, and the result. **Copy** puts that text on the clipboard so it can be pasted into a message. If the fresh result differs from the saved one, it says so, and **Check again** keeps the new one.

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
| `apps-script/Code.gs`, `apps-script/appsscript.json` | The thin server: Sheet storage, Companies House, mail-record check, directory reading, notification emails |
| `.github/workflows/pages.yml` | Publishes the site with GitHub Pages (set up once in the repo, not in this folder) |

## Good to know

- Pages are read politely: the app obeys each site's `robots.txt`, and anything it asks bots not to read is skipped.
- Contact names and emails come from company websites, so they are patchy. Emails are never guessed. A Companies House director is shown, labelled, only when a company is confirmed.
- Sites that build their pages with JavaScript give little to read. The detail says so. For these the usual terms and privacy addresses are tried as well, which costs a few extra requests for exhibitors with no company number on their home page.
- A company counts as confirmed only on strong evidence from its own website: a company number the register holds under a fitting name (for example “Registered Company: 08756928”, never a VAT number), a legal name such as “We are Ickle Bubba Ltd” that the register holds exactly, or the registered postcode written on its pages, either beside a similar name or as the registered office of another company the search returned. A similar name alone stays “to check”. When the website names a different company from the register's (for example “Zello Sleep Ltd” against ZELLO LIMITED), the lead drops from “likely” to “possible”, says so, and is not swept up by **Confirm likely matches**. A wrongly confirmed company costs more than one extra tap, so doubtful ones are left for you.
- For a lead that stays unconfirmed, the note says how many pages were read and names any it could not (for example “terms-of-service (robots.txt says no)” or “privacy-policy (403)”). Those are the pages to open yourself; if one gives the company number, use **Enter company number** on the business.
- Legal pages are found from the site's own links first. If those lead nowhere, the usual addresses for the kind of site it is (Shopify, WordPress, Wix, Squarespace) are tried, up to eight extra pages, two at a time, stopping as soon as one settles it. Very long pages (a shop home page can be most of a megabyte) are cut down to their words first, so a company line in the footer is not lost.
- To save time, one website's home page, mail records and company search go out together, and its terms and privacy pages are read two at a time. This uses a few more web requests but waits for them together. Settings has a **Speed** section with the average time per business, where it goes, and the slowest sites.
- Sole traders are not on the Companies House register, so they cannot be confirmed and stay as consent needed.
- Eight colour themes are in Settings: four dark (Harbour, Graphite, Forest, Aubergine) and four light (Porcelain, Stone, Sage, Sky). Harbour is the default. Every theme keeps its text at a readable contrast.
- The **plus**, **pencil** and **download** icons beside a sector's name add an exhibition, rename the sector (changing all its exhibitions at once) and download its CSV. Choose a name that already exists to join two sectors together.
- **Your leads** on the home, sector and exhibition screens lists one fact per line, including how many appear to use Google Workspace. Each line also gives its share of the exhibitors checked so far.
- Three colours mean the same thing everywhere (the stand plan, the lines under it, the filter pills and the dots beside each exhibitor): green is *can email* (a confirmed limited company), amber is *to check* and rose is *consent needed*. An outlined square is not checked yet. The colours are tuned for each theme and kept apart in lightness as well as hue, so they still tell apart for colour-blind viewers.
- On an exhibition screen, the **download** icon beside the name saves the whole list as a CSV. To save only what a filter or search is showing, use the menu (the three dots).
- The mail check looks at public MX records. "Probably Google" means Google sits behind a mail filter.
- Apps Script cuts any run off at 6 minutes, so the work is done in short bursts: about 20 seconds at a time while the app is open, and up to 3 minutes every 10 minutes in the background. An exhibitor whose site is very slow has its extra pages skipped (the detail says so, and **Check again** retries), and one that is cut off twice is skipped.
- Settings shows a **Last 24 hours** line: web requests used of 100,000 and background minutes of 360 (the Google Workspace limits). The main screen shows a warning only above 70%. It counts this app's own use, so Google's figure for your whole account may be higher. Google's limits run on a rolling 24 hours from first use, not from midnight.
- Daily limits are per Google account, across all your scripts. A free account allows about 20,000 web requests and 90 minutes of background time a day. Google Workspace allows 100,000 requests and 6 hours. Each exhibitor uses roughly five to ten requests, so a few hundred exhibitors a day is comfortable on either.
- Some exhibitors share a website (a distributor with several brands). They share one set of results.
- Spreadsheets drop the leading zero of a company number such as 07654321. The CSV also has a Companies House page link for each company.
- On some Android phones every launch of the installed app plays a sound and shows a Chrome notification saying "Tap to copy the URL for this app". That is Chrome's **Full screen site controls** notification category. Long-press the notification and turn that category off.
