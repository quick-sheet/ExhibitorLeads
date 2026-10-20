/**
 * Exhibitor Leads: Apps Script back end.
 *
 * One web app, routed by "action". Every action except "ping" needs the access token.
 * Data lives in a Google Sheet that this script creates in your Drive (tabs: Shows, Exhibitors).
 *
 * Script Properties (Project Settings):
 *   TOKEN     made for you by setup(); type it once into the app's Settings
 *   CH_KEY    your free Companies House API key (you add this)
 *   SHEET_ID  made for you, the data sheet
 *
 * Apps Script has no URL class, no DOM and no DNS, so this file brings its own small helpers.
 */

const VERSION = 1;
// Which release of this code is live. The app shows it in Settings and warns when it is older than the app expects.
const BUILD = 15;
const TZ = 'Europe/London';
const UA = 'ExhibitorLeads/1 (personal prospecting tool; Google Apps Script)';
const MAX_BODY = 600000;
const CLAIM_MS = 3 * 60 * 1000;

// Apps Script ends any run at 6 minutes. These keep every run well inside that.
const MAX_BUDGET = 180;             // seconds a run may spend starting new exhibitors (the phone asks for 20)
const TICK_BUDGET = 180;            // the same, for the 10-minute background run
const EX_MS = 35 * 1000;            // one exhibitor may spend this long reading websites; after that its remaining pages are skipped
const MAX_TRIES = 2;                // an exhibitor whose check is cut off this many times is skipped, not retried for ever
const LATE_NOTE = 'Took too long, so some pages were skipped. Use Check again to try once more';

// What your Google account allows. Google Workspace: 100000 web requests and 360 background minutes a day.
// A free Google account: 20000 and 90. Change these two numbers if your plan differs.
const PLAN = { fetches: 100000, bgMinutes: 360 };

// Raise this when the checking gets better, and every result that is not yet confirmed is looked at again once.
const PROTO = 3;

// Where terms and privacy pages usually live, tried when a site's own links do not lead to them.
const PAGE_PAIR = 2;   // pages of one website read together
const LEGAL_GUESSES = ['/privacy-policy', '/terms-and-conditions', '/terms-of-use', '/terms', '/privacy', '/legal'];
// Shop and site builders put their legal pages in the same few places, so once the home page shows which one a site uses these are worth a try.
const PLATFORM_GUESSES = {
  // contact-information is Shopify's own page for a shop's business details (company number, VAT, address); legal-notice is its imprint page
  shopify: ['/policies/terms-of-service', '/policies/contact-information', '/policies/privacy-policy', '/policies/legal-notice', '/pages/terms-and-conditions', '/pages/privacy-policy', '/pages/terms-conditions', '/pages/terms'],
  wordpress: ['/terms-and-conditions/', '/terms-conditions/', '/privacy-policy/', '/terms-of-use/', '/terms/'],
  wix: ['/terms-conditions', '/terms-and-conditions', '/privacy-policy'],
  squarespace: ['/terms-and-conditions', '/terms', '/privacy-policy'],
};
const EXTRA_PAGES = 8;   // most pages read on one website after its home page

const SHOW_COLS = ['id', 'name', 'sector', 'start', 'end', 'urls', 'status', 'statusNote', 'addedAt', 'loadedAt'];
const EX_COLS = ['id', 'showId', 'name', 'stand', 'category', 'blurb', 'website', 'domain', 'detailUrl',
  'phone', 'phoneSrc', 'email', 'emailKind', 'emailSrc', 'contact', 'contactSrc', 'chDirector',
  'companyNo', 'companyName', 'companyType', 'companyStatus', 'companyAddr',
  'legal', 'legalSrc', 'emailable', 'workspace', 'mailHost', 'state', 'note', 'addedAt', 'enrichedAt',
  'alsoUses'];   // new columns go on the end, so sheets made by an older release keep their layout (see ensureCols)
const EDITABLE = ['name', 'website', 'phone', 'email', 'contact', 'note'];

// A shop on a marketplace or a social profile is not the business's own website: its pages name the platform, not the business.
const MARKET_HOSTS = /(^|\.)(etsy\.com|notonthehighstreet\.com|folksy\.com|amazon\.[a-z.]+|ebay\.[a-z.]+|onbuy\.com|depop\.com|vinted\.[a-z.]+|faire\.com|wolfandbadger\.com|trouva\.com|linktr\.ee|linkin\.bio|beacons\.ai|bio\.link|facebook\.com|fb\.com|instagram\.com|tiktok\.com|twitter\.com|x\.com|youtube\.com|linkedin\.com|pinterest\.[a-z.]+)$/i;
const REDIRECTORS = ['share.google', 'g.co', 'goo.gl', 'bit.ly', 't.co', 'tinyurl.com', 'ow.ly', 'buff.ly', 'lnkd.in', 'is.gd'];
const SKIP_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|twitter\.com|x\.com|tiktok\.com|youtube\.com|youtu\.be|linkedin\.com|pinterest\.[a-z.]+|wa\.me|whatsapp\.com|threads\.net|snapchat\.com|vimeo\.com|google\.[a-z.]+|goo\.gl|apple\.com|gstatic\.com|googletagmanager\.com|googleapis\.com|seetickets\.com|eventbrite\.[a-z.]+|ticketmaster\.[a-z.]+|bit\.ly|wixsite\.com)$/i;
const FREEMAIL = /^(gmail\.com|googlemail\.com|hotmail\.com|hotmail\.co\.uk|outlook\.com|outlook\.co\.uk|live\.com|live\.co\.uk|msn\.com|yahoo\.com|yahoo\.co\.uk|ymail\.com|icloud\.com|me\.com|aol\.com|btinternet\.com|btopenworld\.com|sky\.com|talktalk\.net|virginmedia\.com|ntlworld\.com|blueyonder\.co\.uk|protonmail\.com|proton\.me)$/i;
const GENERIC_LOCAL = /^(info|hello|hi|contact|enquiries|enquiry|sales|office|admin|team|support|customer|customers|customerservice|shop|trade|events|wholesale|accounts|bookings|mail|post|general|marketing|orders|help|service)$/i;
const GATEWAY = /(mimecast|pphosted|proofpoint|barracuda|messagelabs|symanteccloud|mailcontrol|forcepoint|trendmicro|iphmx|sophos|mailguard|ppe-hosted|cloudfilter|mxlogic|antispamcloud|spamh|mailhop|mailanyone)/i;

/* ============================================================
 * Web app entry points
 * ============================================================ */

function doGet() { return json({ ok: true, app: 'Exhibitor Leads', v: VERSION, build: BUILD }); }

function doPost(e) {
  let b = {};
  try { b = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { b = {}; }
  return json(route(b.action, b));
}

function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function route(action, p) {
  const routes = { ping, status, list, saveShow, deleteShow, loadShow, pasteList, rows, enrich, confirmMatch, confirmLikely, editRow, recheck, recheckWeak, deleteRows, explain, searchCompanies, setNotify, testNotify };
  p = p || {};
  try {
    if (action === 'ping') return { ok: true, v: VERSION, build: BUILD };
    if (!routes[action]) return { error: 'Unknown action' };
    if (!prop('TOKEN')) return { error: 'Not set up yet. In Apps Script, choose setup and press Run.' };
    if (typeof p.token !== 'string' || !safeEq(p.token, prop('TOKEN'))) { Utilities.sleep(700); return { error: 'Unauthorised' }; }
    const out = routes[action](p);
    noteUsage(0);
    return out;
  } catch (err) {
    noteUsage(0);
    return { error: String((err && err.message) || err) };
  }
}

/** Run once from the editor. Safe to run again: it never makes duplicate triggers. */
function setup() {
  if (!prop('TOKEN')) setProp('TOKEN', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
  db();
  migrateOnce();
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'enrichTick').forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('enrichTick').timeBased().everyMinutes(10).create();
  Logger.log('Access token (type it once into the app Settings): ' + prop('TOKEN'));
  Logger.log('Companies House key: ' + (prop('CH_KEY') ? 'set' : 'NOT set. Add CH_KEY under Project Settings, Script Properties.'));
  Logger.log('Data sheet: ' + SpreadsheetApp.openById(prop('SHEET_ID')).getUrl());
}

/** Runs every 10 minutes: carries on checking exhibitors while no phone is open. */
function enrichTick() {
  const t0 = Date.now();
  try { enrichRun({ budget: TICK_BUDGET }); } catch (err) { Logger.log('enrichTick: ' + err); }
  noteUsage((Date.now() - t0) / 1000);
}

/* ============================================================
 * Usage: what this app has asked of your Google account in the last 24 hours.
 * Google counts per account and across all your scripts, and does not let a script read the real figure,
 * so this is this app's own count. Google's daily allowances reset 24 hours after first use, hence a rolling window.
 * ============================================================ */

let _fetched = 0;

function readUsage() {
  try { const u = JSON.parse(prop('USAGE') || '{}'); return u && typeof u === 'object' ? u : {}; } catch (e) { return {}; }
}

/** Adds the web requests made so far in this run, and any background seconds, to the current hour. Never throws. */
function noteUsage(bgSeconds) {
  const f = _fetched; _fetched = 0;
  if (!f && !bgSeconds) return;
  try {
    withLock(() => {
      const u = readUsage(), k = new Date().toISOString().slice(0, 13);
      const cur = u[k] || (u[k] = { f: 0, b: 0 });
      cur.f += f; cur.b += Math.round(bgSeconds || 0);
      const keep = Date.now() - 48 * 3600 * 1000;
      Object.keys(u).forEach((h) => { if (Date.parse(h + ':00:00Z') < keep) delete u[h]; });
      setProp('USAGE', JSON.stringify(u));
    });
  } catch (e) { /* counting must never break a request */ }
}

function usageInfo() {
  const u = readUsage(), from = Date.now() - 24 * 3600 * 1000;
  let f = 0, b = 0;
  Object.keys(u).forEach((h) => { if (Date.parse(h + ':00:00Z') + 3600 * 1000 > from) { f += u[h].f || 0; b += u[h].b || 0; } });
  return { fetches: f, bgMinutes: Math.round(b / 6) / 10, limits: { fetches: PLAN.fetches, bgMinutes: PLAN.bgMinutes } };
}

/**
 * Once after an upgrade, leads the better checking can do something about go back in the queue. Ones you confirmed stay.
 * Level 2: results that were not confirmed. Level 3 (release 15): companies found but closed (dissolved, in liquidation),
 * since the check now looks for the active company that took over at the same address.
 */
function migrateOnce() {
  if (+prop('PROTO') >= PROTO) return 0;
  return withLock(() => {
    const from = +prop('PROTO') || 0;
    if (from >= PROTO) return 0;
    const rows = readTab('Exhibitors', EX_COLS);
    let n = 0;
    const vals = rows.map((r) => {
      const again = (from < 2 && r.legal !== 'verified') || (from < 3 && r.legal === 'verified' && CLOSED.test(String(r.companyStatus || '')));
      if ((r.state === 'done' || r.state === 'error') && again && r.legalSrc !== 'Confirmed by you') { n++; return ['todo', '']; }
      return [r.state, r.note];
    });
    if (rows.length) db().getSheetByName('Exhibitors').getRange(2, EX_COLS.indexOf('state') + 1, rows.length, 2).setValues(vals);   // state and note sit side by side
    setProp('PROTO', String(PROTO));
    return n;
  });
}

/* ============================================================
 * Small helpers
 * ============================================================ */

function clip(s, n) { return String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').trim().slice(0, n); }
function nowIso() { return new Date().toISOString(); }
function prop(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function setProp(k, v) { PropertiesService.getScriptProperties().setProperty(k, v); }
function newId() { return Utilities.getUuid().replace(/-/g, '').slice(0, 10); }

function safeEq(a, b) {
  a = String(a); b = String(b);
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

function withLock(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(25000);
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ---------- URLs ---------- */

function parseUrl(u) {
  const m = /^(https?):\/\/([^\/?#:@]+)(?::(\d+))?([^?#]*)(\?[^#]*)?/i.exec(String(u || '').trim());
  if (!m) return null;
  return { scheme: m[1].toLowerCase(), host: m[2].toLowerCase(), port: m[3] || '', path: m[4] || '/', query: m[5] || '' };
}

function originOf(u) { const p = parseUrl(u); return p ? p.scheme + '://' + p.host + (p.port ? ':' + p.port : '') : ''; }

function isPublicHost(h) {
  h = String(h || '').toLowerCase();
  if (!h || h.indexOf('.') < 0 || h === 'localhost' || /\.(local|internal|localhost|lan)$/.test(h)) return false;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h) || h.indexOf(':') >= 0) return false;
  return /^[a-z0-9.-]+$/.test(h);
}

function resolveUrl(base, href) {
  href = String(href || '').trim().replace(/&amp;/gi, '&');
  if (!href || /^(#|javascript:|mailto:|tel:|data:|sms:)/i.test(href)) return '';
  if (/^https?:\/\//i.test(href)) return href;
  const b = parseUrl(base);
  if (!b) return '';
  const origin = b.scheme + '://' + b.host + (b.port ? ':' + b.port : '');
  if (href.indexOf('//') === 0) return b.scheme + ':' + href;
  const clean = href.replace(/#.*$/, '');
  if (!clean) return '';
  if (clean.charAt(0) === '?') return origin + b.path + clean;
  const qi = clean.indexOf('?');
  const rel = qi >= 0 ? clean.slice(0, qi) : clean;
  const q = qi >= 0 ? clean.slice(qi) : '';
  const full = rel.charAt(0) === '/' ? rel : b.path.replace(/[^\/]*$/, '') + rel;
  const out = [];
  full.split('/').forEach((s, i) => {
    if (s === '..') { if (out.length > 1) out.pop(); } else if (s !== '.' || i === 0) out.push(s);
  });
  let path = out.join('/');
  if (path.charAt(0) !== '/') path = '/' + path;
  return origin + path + q;
}

/** "https://www.acme.co.uk/shop?x=1" becomes "acme.co.uk" */
function siteDomain(u) {
  let s = String(u || '').trim();
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const p = parseUrl(s);
  return p ? p.host.replace(/^www\./, '') : '';
}

/** Keep only the web address of the home page, which is what we keep and read. */
function cleanWebsite(u) {
  let s = String(u || '').trim().replace(/[\s,;]+$/, '');
  if (!s) return '';
  if (!/^https?:\/\//i.test(s)) {
    if (!/^(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(\/|$)/i.test(s)) return '';
    s = 'https://' + s;
  }
  const p = parseUrl(s);
  if (!p || !isPublicHost(p.host)) return '';
  return p.scheme + '://' + p.host + (p.port ? ':' + p.port : '');
}

function isSkipHost(host) { return SKIP_HOSTS.test(String(host || '')); }
function sameSite(a, b) { return String(a).replace(/^www\./, '') === String(b).replace(/^www\./, ''); }
function emailDomain(e) { const i = String(e || '').lastIndexOf('@'); return i < 0 ? '' : e.slice(i + 1).toLowerCase(); }

/* ---------- HTML ---------- */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”', ndash: '–', mdash: '—', hellip: '…', pound: '£', eacute: 'é', egrave: 'è', ocirc: 'ô', uuml: 'ü', ouml: 'ö', auml: 'ä', copy: '©', reg: '®', trade: '™' };

function decodeEntities(s) {
  return String(s == null ? '' : s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => safeChar(+d))
    .replace(/&([a-z]+);/gi, (m, n) => (ENTITIES[n.toLowerCase()] != null ? ENTITIES[n.toLowerCase()] : m));
}
function safeChar(n) { try { return n > 0 && n < 0x10ffff ? String.fromCodePoint(n) : ' '; } catch (e) { return ' '; } }

function stripTags(s) {
  return decodeEntities(String(s || '')
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attr(attrs, name) {
  const m = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i').exec(attrs || '');
  return m ? decodeEntities(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]) : '';
}

function anchors(html) {
  const out = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    out.push({ index: m.index, end: re.lastIndex, href: attr(m[1], 'href'), title: attr(m[1], 'title'), text: stripTags(m[2]), inner: m[2] });
  }
  return out;
}

function headings(html) {
  const out = [];
  const re = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let m;
  while ((m = re.exec(html))) out.push({ index: m.index, end: re.lastIndex, level: +m[1], text: stripTags(m[2]) });
  return out;
}

/* ---------- Names ---------- */

function normKey(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[’']/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(ltd|limited|plc|llp|the|uk|company|co|and)\b/g, ' ')
    .replace(/\s+/g, ' ').trim();
}

/** 1 = same name once Ltd, The and punctuation are ignored. Lower scores are looser matches. */
function nameScore(a, b) {
  const ka = normKey(a), kb = normKey(b);
  if (!ka || !kb) return 0;
  if (ka === kb) return 1;
  const sa = ka.replace(/ /g, ''), sb = kb.replace(/ /g, '');
  if (sa === sb) return 1;
  if (Math.min(sa.length, sb.length) >= 5 && (sa.indexOf(sb) === 0 || sb.indexOf(sa) === 0)) return 0.75;
  const ta = ka.split(' '), tb = kb.split(' ');
  const common = ta.filter((t) => tb.indexOf(t) >= 0).length;
  const j = common / (ta.length + tb.length - common);
  return j >= 0.5 ? 0.5 + j / 4 : j / 2;
}

function titleCaseOfficer(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  let first, last;
  if (s.indexOf(',') >= 0) { last = s.split(',')[0].trim(); first = (s.split(',').slice(1).join(' ').trim().split(/\s+/)[0]) || ''; }
  else { const t = s.split(/\s+/); first = t[0]; last = t.slice(1).join(' '); }
  const cap = (w) => w.toLowerCase().replace(/(^|[\s'’\-])([a-z])/g, (m, p, c) => p + c.toUpperCase()).replace(/^Mc([a-z])/, (m, c) => 'Mc' + c.toUpperCase());
  return (cap(first) + ' ' + cap(last)).trim();
}

/* ============================================================
 * Reading pages: emails, phones, company numbers, links
 * ============================================================ */

function extractEmails(html) {
  const found = [];
  const seen = {};
  const add = (e, mailto) => {
    e = String(e || '').toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
    if (!/^[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}$/.test(e) || e.length > 80) return;
    if (/\.(png|jpe?g|gif|svg|webp|css|js|ico|woff2?)$/.test(e) || /@\d+x/.test(e)) return;
    if (/(example\.|sentry|wixpress|domain\.com|email\.com|yourname|yourdomain|name@|user@|test@|@sentry|u003e)/.test(e)) return;
    if (seen[e]) { if (mailto) seen[e].mailto = true; return; }
    seen[e] = { email: e, mailto: !!mailto };
    found.push(seen[e]);
  };
  const re1 = /mailto:([^"'?\s>]+)/gi;
  let m;
  while ((m = re1.exec(html))) { let v = m[1]; try { v = decodeURIComponent(v); } catch (e) { /* keep raw */ } add(v, true); }
  const ld = [];
  const reLd = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  while ((m = reLd.exec(html))) ld.push(m[1]);
  const body = decodeEntities(html.replace(/<script\b[\s\S]*?<\/script>/gi, ' ').replace(/<style\b[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]*>/g, ' ')) + ' ' + ld.join(' ');
  const re2 = /[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}/gi;
  while ((m = re2.exec(body))) add(m[0], false);
  return found;
}

/** Best address to use: on the business's own domain first, then ones from a mailto link, then general addresses. */
function pickEmail(list, domain) {
  let best = null, bestScore = -Infinity;
  list.forEach((c, i) => {
    const d = emailDomain(c.email), local = c.email.split('@')[0];
    let s = 0;
    if (domain && (d === domain || d.slice(-(domain.length + 1)) === '.' + domain || domain.slice(-(d.length + 1)) === '.' + d)) s += 10;
    if (c.mailto) s += 2;
    if (GENERIC_LOCAL.test(local)) s += 1;
    if (FREEMAIL.test(d)) s -= 1;
    s -= i * 0.01;
    if (s > bestScore) { best = c; bestScore = s; }
  });
  if (!best) return null;
  const d = emailDomain(best.email), local = best.email.split('@')[0];
  return { email: best.email, kind: FREEMAIL.test(d) ? 'freemail' : GENERIC_LOCAL.test(local) ? 'generic' : 'named' };
}

function normalisePhone(raw) {
  let d = String(raw || '').replace(/\(0\)/g, '').replace(/[^\d+]/g, '');
  if (d.indexOf('+44') === 0) d = '0' + d.slice(3);
  else if (d.indexOf('0044') === 0) d = '0' + d.slice(4);
  else if (d.indexOf('+') >= 0) return '';
  d = d.replace(/\D/g, '');
  return /^0(?:7[1-57-9]\d{8}|[123]\d{9,10}|8\d{9,10})$/.test(d) ? d : '';
}

function formatPhone(d) {
  if (!d) return '';
  if (/^02/.test(d) && d.length === 11) return d.slice(0, 3) + ' ' + d.slice(3, 7) + ' ' + d.slice(7);
  if (/^07/.test(d)) return d.slice(0, 5) + ' ' + d.slice(5);
  if (/^0[38]/.test(d)) return d.slice(0, 4) + ' ' + d.slice(4, 7) + ' ' + d.slice(7);
  if (/^011\d|^01\d1/.test(d)) return d.slice(0, 4) + ' ' + d.slice(4, 7) + ' ' + d.slice(7);
  return d.slice(0, 5) + ' ' + d.slice(5);
}

function extractPhones(html) {
  const out = [];
  const add = (raw) => { const d = normalisePhone(raw); if (d) { const f = formatPhone(d); if (out.indexOf(f) < 0) out.push(f); } };
  let m;
  const reTel = /href\s*=\s*["']tel:([^"']+)["']/gi;
  while ((m = reTel.exec(html))) { let v = m[1]; try { v = decodeURIComponent(v); } catch (e) { /* keep raw */ } add(v); }
  const text = stripTags(html);
  const re = /(?:\+44[\s.\-]?\(?0?\)?|\(?\b0)\d[\d\s().\-]{7,12}\d/g;
  while ((m = re.exec(text))) add(m[0]);
  return out;
}

/**
 * Every UK company number written near words like "Registered in England" or "Company number", in page order.
 * A six digit number (an Irish company, say) is never taken, because padding it could land on an unrelated UK company.
 */
function extractCompanyNumbers(text) {
  const t = String(text || '');
  const num = '(?<![0-9A-Za-z])((?:SC|NI|OC|SO|NC|LP|SL|FC|SE|SA|NF|NL|GE|IP|SP|RC)\\d{6}|\\d{8}|\\d{7})(?!\\d)';
  const res = [
    // "Company number 12345678", "Co. No. 12345678", "Registered number: 12345678", "Reg. No 12345678"
    new RegExp('(?:company|co\\.?|registered|registration|reg\\.?)\\s*(?:registration\\s*)?(?:number|no\\.?|num\\.?|#)\\s*(?:is|:|-|\u2013|\u2014)?\\s*' + num, 'gi'),
    // "Registered Company: 12345678", "Company Reg: 12345678", "Company registration: 12345678"
    new RegExp('(?:registered\\s+company|company\\s+(?:reg(?:istered|istration)?\\.?|registered\\s+in\\s+(?:england|wales|scotland))|reg(?:istered)?\\.?\\s+company)\\s*(?:number|no\\.?|num\\.?|#)?\\s*(?:is|:|-|\u2013|\u2014)\\s*' + num, 'gi'),
    new RegExp('registered\\s+in\\s+(?:england(?:\\s*(?:and|&)\\s*wales)?|scotland|wales|northern\\s+ireland)[^0-9A-Za-z]{0,6}(?:company\\s*)?(?:(?:number|no\\.?|num\\.?|#)[^0-9A-Za-z]{0,6})?' + num, 'gi'),
  ];
  const hits = [];
  res.forEach((re) => {
    let m;
    while ((m = re.exec(t))) {
      if (/\bvat\b/i.test(t.slice(Math.max(0, m.index - 14), m.index + 4))) continue;   // a VAT number is not a company number
      if (/(charit|\bfca\b|financial conduct|firm reference|\bfrn\b|\bico\b|data protection)/i.test(t.slice(Math.max(0, m.index - 30), m.index + 4).split(/[.;]\s/).pop())) continue;   // nor a charity, FCA or ICO number in the same sentence
      let n = m[1].toUpperCase();
      if (/^\d{7}$/.test(n)) n = '0' + n;
      hits.push({ i: m.index, n });
    }
  });
  hits.sort((a, b) => a.i - b.i);
  const out = [];
  hits.forEach((h) => { if (out.indexOf(h.n) < 0 && out.length < 4) out.push(h.n); });
  return out;
}

function extractCompanyNumber(text) { return extractCompanyNumbers(text)[0] || ''; }

/**
 * A page that says "We are Ickle Bubba Ltd" or "(c) 2026 Window to the Womb (Franchise) Limited" names the company
 * behind the site. This looks for the exhibitor's own name followed within a few words by Ltd, Limited, LLP or PLC,
 * and returns what was written, so it can be looked up on the register. Anchoring on the exhibitor's name keeps out
 * the other companies a policy mentions (payment providers, platforms, advisers).
 */
const NAME_JOINERS = /^(and|of|the|to|for|in|on|at|by|co|&|&amp;)$/i;
// A company name ends Ltd, LTD, Limited, LIMITED, LLP, PLC or plc: "limited edition prints" is not a company.
const CO_SUFFIX = /^(Ltd|LTD|Limited|LIMITED|LLP|PLC|Plc|plc)[.,;:)\]'"\u2019\u201d]*$/;
// Template text left in place ("[Company Name] Ltd", "Your Company Ltd"): never a real company.
const PLACEHOLDER_NAME = /\b(company name|your company|yourcompany|business name|insert|example|lorem)\b/i;
const NOT_AFTER_SUFFIX = /^(edition|editions|offer|offers|stock|time|run|range|release|releases|availability|quantity|quantities|number|numbers|space|spaces|places)\b/i;
function legalNameStatements(text, exName) {
  const keys = normKey(exName).split(' ').filter(Boolean);
  if (!keys.length) return [];
  const anchor = keys.slice(0, keys[0].length < 3 && keys.length > 1 ? 2 : 1);
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const bare = (w) => w.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const isSuffix = (w, next) => CO_SUFFIX.test(w) && !NOT_AFTER_SUFFIX.test(next || '');
  const out = [], seen = {};
  for (let i = 0; i + anchor.length <= words.length && out.length < 3; i++) {
    if (!anchor.every((k, j) => bare(words[i + j]) === k)) continue;
    const from = i + anchor.length;
    for (let j = from; j < Math.min(words.length, from + 6); j++) {
      const w = words[j];
      if (isSuffix(w, words[j + 1])) {
        const name = words.slice(i, j + 1).join(' ').replace(/[.,;:)\]]+$/, '').replace(/^[(\["'\u2018\u201c]+/, '');
        const key = normKey(name);
        if (key && !seen[key]) { seen[key] = 1; out.push(name); }
        break;
      }
      // between the name and the suffix: capitalised words, numbers, brackets and small joining words only, and no end of sentence
      const core = w.replace(/^[(\["'\u2018\u201c]+/, '');
      if (!(/^[A-Z0-9&]/.test(core) || NAME_JOINERS.test(core))) break;
      if (/[.!?;:]$/.test(w) && !/^co\.$/i.test(w)) break;
    }
  }
  return out;
}

/** UK postcodes written in a page, tidied to "SA7 9FJ". */
function extractPostcodes(text) {
  const out = [], re = /\b([A-Z]{1,2}\d[A-Z\d]?)\s*(\d[A-Z]{2})\b/gi;
  let m;
  while ((m = re.exec(String(text || ''))) && out.length < 12) {
    const pc = (m[1] + ' ' + m[2]).toUpperCase();
    if (out.indexOf(pc) < 0) out.push(pc);
  }
  return out;
}

/** Does the page that gave a company number also name the company the register holds under it? */
function nameInText(name, text) {
  const k = normKey(name);
  if (k.length < 3) return false;
  return (' ' + normKey(text) + ' ').indexOf(' ' + k + ' ') >= 0;
}

/**
 * Looks up the numbers an exhibitor's own pages give, up to three. A company whose name appears on the same page
 * (or that matches the exhibitor's name) wins. A lone number that exists on the register is accepted. Several
 * numbers with no name to back any of them is too uncertain, so none is taken.
 */
function verifyCandidates(cands, name, say) {
  let first = null, looked = 0;
  const tell = say || (() => {});
  for (let i = 0; i < cands.length && looked < 3; i++) {
    const p = chProfile(cands[i].n);
    looked++;
    if (!p) { tell('Companies House has no company numbered ' + cands[i].n); continue; }
    const onPage = nameInText(p.name, cands[i].text), close = nameScore(name, p.name) >= 0.6;
    tell('Companies House number ' + cands[i].n + ' is ' + p.name + ' (' + (p.status || '?') + ', ' + (p.pc || 'no postcode') + '). Its name ' + (onPage ? 'is' : 'is not') + ' on the page that gave the number, and it ' + (close ? 'is' : 'is not') + ' close to the exhibitor name');
    if (onPage || close) return p;
    if (!first) first = p;
  }
  if (cands.length === 1 && first && cands[0].sd) tell('The only number, but from its structured data and under a name that does not fit, so it is not taken');
  else if (cands.length === 1 && first) tell('The only number on its pages, and it exists on the register, so it is taken');
  else if (cands.length > 1 && !first) tell('Several numbers and none of them names this business, so none is taken');
  return cands.length === 1 && !cands[0].sd ? first : null;   // a lone number from structured data needs the name to fit as well
}

function personFromNode(n) {
  if (!n || typeof n !== 'object') return '';
  const nm = typeof n.name === 'string' ? n.name.trim() : '';
  return /^[A-Za-z][A-Za-z'’.\- ]{3,58}$/.test(nm) && nm.indexOf(' ') > 0 ? nm : '';
}

/** A named person from the page's structured data, only where it says founder, owner, employee or contact. */
function extractPerson(html) {
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    let j;
    try { j = JSON.parse(m[1].trim()); } catch (e) { continue; }
    const nodes = [].concat(j && j['@graph'] ? j['@graph'] : j);
    for (const n of nodes) {
      if (!n || typeof n !== 'object') continue;
      if (/Person/i.test([].concat(n['@type'] || []).join(','))) { const p = personFromNode(n); if (p) return p; }
      for (const k of ['founder', 'founders', 'owner', 'employee', 'employees', 'member', 'contactPoint']) {
        for (const c of [].concat(n[k] || [])) { const p = personFromNode(c); if (p) return p; }
      }
    }
  }
  return '';
}

function findLinks(html, base) {
  const host = (parseUrl(base) || {}).host || '';
  let contact = '';
  const core = [], more = [];   // terms and privacy pages first: they are where a company number is usually written
  anchors(html).forEach((a) => {
    const u = resolveUrl(base, a.href);
    const p = u && parseUrl(u);
    if (!p || !sameSite(p.host, host)) return;
    const hay = (p.path + ' ' + a.text).toLowerCase();
    const full = p.scheme + '://' + p.host + p.path;
    if (!contact && /contact|get[- ]in[- ]touch|enquir/.test(hay) && !/\.(pdf|jpg|png)$/.test(p.path)) contact = full;
    if (/\.(pdf|jpe?g|png|gif|svg|webp)$/.test(p.path)) return;
    if (/terms|privacy|conditions|legal|imprint|company[- ]info|registered|contact-information|legal-notice/.test(hay)) { if (core.length < 6 && core.indexOf(full) < 0) core.push(full); }
    else if (/about|delivery|returns|cookie|policies/.test(hay)) { if (more.length < 4 && more.indexOf(full) < 0) more.push(full); }
  });
  return { contact, legal: core.concat(more), core: core.length };
}

/** Which site builder made a page, from tell-tale addresses in its code. Decides which legal page addresses are worth trying. */
function detectPlatform(html) {
  const h = String(html || '');
  if (/cdn\.shopify\.com|myshopify\.com|Shopify\.theme|shopify-section/i.test(h)) return 'shopify';
  if (/\/wp-content\/|\/wp-includes\/|wp-json/i.test(h)) return 'wordpress';
  if (/wixstatic\.com|parastorage\.com|X-Wix-|wix-code/i.test(h)) return 'wix';
  if (/squarespace\.com|static1\.squarespace|sqsp\.net/i.test(h)) return 'squarespace';
  return '';
}

function scanPage(html, url) {
  const text = stripTags(html);
  const sd = structuredCompany(html);
  const numbers = extractCompanyNumbers(text);
  return { emails: extractEmails(html), phones: extractPhones(html), number: numbers[0] || '', numbers, postcodes: extractPostcodes(text), text, person: extractPerson(html), links: findLinks(html, url), textLen: text.length, platform: detectPlatform(html),
    dataNames: sd.names, dataNumbers: sd.numbers.filter((n) => numbers.indexOf(n) < 0), siteName: siteNameOf(html) };
}

/* ---------- More ways to confirm the company (release 13) ---------- */

/** "12345678", "1234567" (padded) or "SC123456" from structured data, or nothing. */
function ukCompanyNo(v) {
  const s = String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();
  if (/^(SC|NI|OC|SO|NC|LP|SL)\d{6}$/.test(s) || /^\d{8}$/.test(s)) return s;
  return /^\d{7}$/.test(s) ? '0' + s : '';
}

/**
 * What the page's structured data says about the business: a legalName ending Ltd, Limited, LLP or PLC, and a company number
 * only where it is labelled as one (an identifier whose name says company or registration), never any other number.
 */
function structuredCompany(html) {
  const out = { names: [], numbers: [] };
  const visit = (n, depth) => {
    if (!n || typeof n !== 'object' || depth > 4) return;
    if (Array.isArray(n)) { n.forEach((x) => visit(x, depth + 1)); return; }
    if (n['@graph']) visit(n['@graph'], depth + 1);
    const ln = typeof n.legalName === 'string' ? n.legalName.replace(/\s+/g, ' ').trim() : '';
    if (ln && ln.length <= 120 && /\b(ltd|limited|llp|plc)\.?$/i.test(ln) && out.names.indexOf(ln) < 0) out.names.push(ln);
    [].concat(n.identifier || []).forEach((x) => {
      const label = String((x && (x.propertyID || x.name)) || '');
      if (x && typeof x === 'object' && /compan/i.test(label) && !/charit|fca|frn|financial|vat|tax|lei/i.test(label)) { const k = ukCompanyNo(x.value); if (k && out.numbers.indexOf(k) < 0) out.numbers.push(k); }
    });
    [n.companyNumber, n.companyRegistrationNumber].forEach((v) => { const k = ukCompanyNo(v); if (k && out.numbers.indexOf(k) < 0) out.numbers.push(k); });
  };
  const re = /<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(String(html || '')))) { try { visit(JSON.parse(m[1].trim()), 0); } catch (e) { /* not JSON */ } }
  return out;
}

/** The name a site gives itself: og:site_name, or the brand part of its title ("Bambino Mio" from "Reusable Nappies | Bambino Mio"). */
const GENERIC_TITLE = /^(home|home ?page|page|welcome|shop|shop all|all products|products|online shop|official site|official website|store|index|untitled|coming soon)$/i;
function siteNameOf(html) {
  const h = String(html || '');
  const og = /<meta[^>]+property\s*=\s*["']og:site_name["'][^>]*>/i.exec(h);
  const ogName = og ? attr(og[0], 'content').trim() : '';
  if (ogName && ogName.length <= 60 && !GENERIC_TITLE.test(ogName)) return ogName;
  const t = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(h);
  if (!t) return '';
  const parts = decodeEntities(t[1]).replace(/\s+/g, ' ').split(/\s+[|\u2013\u2014\-:\u00b7]\s+/).map((x) => x.trim()).filter((x) => x.length >= 3 && x.length <= 60 && !GENERIC_TITLE.test(x));
  return parts.sort((a, b) => a.length - b.length)[0] || '';
}

// Companies a site mentions for other reasons (its platform, payments, delivery, reviews): never the company behind it.
const NOT_OWNER = /\b(google|shopify|stripe|paypal|klarna|clearpay|afterpay|wix|squarespace|amazon|meta platforms|facebook|instagram|apple|microsoft|royal mail|parcelforce|dpd|evri|hermes|yodel|ups|fedex|dhl|mailchimp|klaviyo|sumup|worldpay|barclaycard|opayo|sage pay|trustpilot|feefo|yotpo|hotjar|cloudflare|godaddy|ionos|fasthosts|automattic|woocommerce|bigcommerce|etsy|ebay|tiktok|pinterest|vimeo|youtube|zendesk|hubspot|salesforce|information commissioner|dpdgroup|parcelnet|laybuy|zilch|divido|v12 retail|paypal|hokodo|snap finance|deko|payl8r)\b/i;

/** "Smith Trading Ltd" from the start of "Smith Trading Ltd. All rights reserved": capitalised words up to Ltd, Limited, LLP or PLC. */
function nameAfter(s) {
  const words = String(s || '').trim().split(/\s+/).slice(0, 9);
  if (/^by$/i.test(words[0] || '')) words.shift();
  const out = [];
  for (const w of words) {
    const core = w.replace(/^[(\["'\u2018\u201c]+/, '');
    if (!core) return '';
    if (CO_SUFFIX.test(core) && out.length) { if (NOT_AFTER_SUFFIX.test(words[out.length + 1] || '')) return ''; out.push(w); return out.join(' ').replace(/[.,;:)\]'"\u2019\u201d]+$/, '').replace(/^[(\["'\u2018\u201c]+/, ''); }
    if (!(/^[A-Z0-9&]/.test(core) || NAME_JOINERS.test(core)) || /^by$/i.test(core)) return '';
    if (/[.!?;:]$/.test(w) && !/^co\.$/i.test(w)) return '';
    out.push(w);
  }
  return '';
}

/** "Smith Trading Ltd" from the end of "... products. Smith Trading Ltd": the company name that ends a stretch of text. */
function nameBefore(s) {
  const words = String(s || '').trim().split(/\s+/);
  const last = (words.pop() || '').replace(/[.,]$/, '');
  if (!CO_SUFFIX.test(last)) return '';
  const out = [last];
  for (let i = words.length - 1; i >= 0 && out.length < 8; i--) {
    const w = words[i];
    if (/[.!?;:]$/.test(w) && !/^co\.$/i.test(w)) break;
    const core = w.replace(/^[(\["'\u2018\u201c]+/, '');
    if (!(/^[A-Z0-9&]/.test(core) || NAME_JOINERS.test(core))) break;
    out.unshift(w.replace(/^[(\["'\u2018\u201c]+/, ''));
  }
  while (out.length > 1 && NAME_JOINERS.test(out[0])) out.shift();
  return out.length > 1 ? out.join(' ') : '';
}

/** Short forms of a business's own names, for telling statements about it from statements about someone else. */
function ownKeys(exName, siteName, domain) {
  const out = [];
  [exName, siteName].forEach((n) => { const k = normKey(n).replace(/ /g, ''); if (k.length >= 4 && out.indexOf(k) < 0) out.push(k); });
  const stem = String(domain || '').split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  if (stem.length >= 4 && out.indexOf(stem) < 0) out.push(stem);
  return out;
}
/** Is this phrase one of the business's own names (or does it contain one, or start one)? */
function isOwnName(phrase, keys) {
  const c = normKey(phrase).replace(/ /g, '');
  return c.length >= 4 && keys.some((k) => c.indexOf(k) >= 0 || k.indexOf(c) === 0);
}
// Words around a statement that make it about finance, credit or insurance: those name the lender, not the business.
const FINANCE_NEAR = /(financ|credit|lender|loan|\bbank|insur|\bfca\b|financial conduct|authori[sz]ed and regulated|regulated by|interest free|\bapr\b)/i;
// A copyright holder that is plainly whoever made the pictures, the site or the character, not the business.
const MAKER_WORDS = /(photograph|photo|design|media|studio|pictures|images|newspaper|publishing|press|productions|creative|digital|\bweb\b|agency|marketing|films?\b|entertainment|licensing)/i;

/**
 * The company behind a brand, where a page says so outright about this business: "X is a trading name of Y Ltd" or
 * "a brand of", "a division of", "Y Ltd trading as X" (or t/a), "this website is operated by Y Ltd", and the copyright line
 * "© 2026 Y Ltd". X must be one of its own names (its listing, its site name or its web address), so a page that explains a
 * lender, a courier or a brand it stocks is not taken. A copyright holder counts when it shares a name with the business, or
 * when it is the last copyright line, at the foot of the page, and not a photographer, designer or character licence.
 * Returns [{ name, kind }] with kind 'brand' or 'copyright'. A match must still be exactly that name on the register.
 */
function ownerStatements(text, keys) {
  const t = String(text || ''), out = [], seen = Object.create(null);
  if (!Array.isArray(keys)) keys = ownKeys(String(keys || ''), '', '');   // a bare exhibitor name will do
  const add = (name, kind) => {
    const k = normKey(name);
    if (!name || k.replace(/ /g, '').length < 3 || seen[k] || NOT_OWNER.test(name) || PLACEHOLDER_NAME.test(name) || out.length >= 4) return;
    seen[k] = 1; out.push({ name, kind });
  };
  const near = (i, len) => t.slice(Math.max(0, i - 200), i + len + 200);
  const lastSentence = (x) => x.split(/[.!?;:|•]\s/).pop();
  const firstSentence = (x) => x.split(/[.!?;:|•]\s/)[0];
  let m;
  const of = /(?:,\s*|\s+(?:which\s+)?(?:is|are)\s+)(?:a\s+|the\s+)?(?:registered\s+)?(?:trading\s+(?:name|style)|brand|division)\s+of\s+/gi;
  while ((m = of.exec(t))) {
    const subject = lastSentence(t.slice(Math.max(0, m.index - 120), m.index));
    if (!isOwnName(subject.split(/\s+/).slice(-6).join(' '), keys) || FINANCE_NEAR.test(near(m.index, m[0].length))) continue;
    add(nameAfter(t.slice(m.index + m[0].length, m.index + m[0].length + 200)), 'brand');
  }
  const by = /\b(?:is|are)\s+(?:(?:wholly\s+)?owned\s+and\s+operated|operated|owned|run|managed)\s+by\s+/gi;
  while ((m = by.exec(t))) {
    const subject = lastSentence(t.slice(Math.max(0, m.index - 120), m.index));
    const aboutSite = /\b(?:this|our|the)\s+(?:web\s*site|site|online\s+(?:shop|store)|shop|store)\s*$/i.test(subject) || /^\s*we\s*$/i.test(subject);
    if (!(aboutSite || isOwnName(subject.split(/\s+/).slice(-6).join(' '), keys)) || FINANCE_NEAR.test(near(m.index, m[0].length))) continue;
    const name = nameAfter(t.slice(m.index + m[0].length, m.index + m[0].length + 200));
    if (name && !MAKER_WORDS.test(name)) add(name, 'brand');
  }
  const ta = /,?\s+(?:trading\s+as|t\/a)\s+/gi;
  while ((m = ta.exec(t))) {
    const brand = firstSentence(t.slice(m.index + m[0].length, m.index + m[0].length + 80)).split(/[.,;!?(]/)[0];
    if (!isOwnName(brand.split(/\s+/).slice(0, 6).join(' '), keys) || FINANCE_NEAR.test(near(m.index, m[0].length))) continue;
    add(nameBefore(t.slice(Math.max(0, m.index - 160), m.index)), 'brand');
  }
  const marks = [];
  const cr = /©|\(c\)|\bcopyright\b/gi;
  while ((m = cr.exec(t))) {
    const rest = t.slice(m.index + m[0].length, m.index + m[0].length + 200);
    const lead = /^\s*(?:(?:©|\(c\)|copyright)\s*)*((?:19|20)\d\d(?:\s*[-–]\s*(?:(?:19|20)\d\d|present))?)?[\s,.:]*/i.exec(rest);
    let from = lead ? lead[0].length : 0;
    // "copyright of Lee Sinclair Furniture Ltd (2024)", "copyright belongs to", "is held by", "owned by": the owner follows
    const whose = /^(?:(?:is\s+)?(?:the\s+)?(?:property\s+of|of|by|belongs?\s+to|(?:is\s+)?(?:held|owned)\s+by)\s+)/i.exec(rest.slice(from));
    if (whose) from += whose[0].length;
    // the © sign, or a year after "(c)" or "Copyright", so a "(c)" in a numbered list is not taken. The word "copyright" without a
    // year counts when a company name ending Ltd, Limited, LLP or PLC follows it in the same sentence ("copyright of Smith Trading
    // Ltd", "Copyright Smith Trading Ltd"), not when its sentence ends there ("protected by copyright. Smith Ltd …")
    const signed = m[0] === '©' || (lead && lead[1]) || /^\s*(?:©|\(c\))/i.test(rest);
    if (!signed && !(/^copyright$/i.test(m[0]) && !/^\s*[.!?;]/.test(rest))) continue;
    const name = nameAfter(rest.slice(from));
    if (!name) continue;
    if (marks.length && marks[marks.length - 1].name === name) continue;   // "Copyright © 2026 Y Ltd" is one line, not two
    marks.push({ name, at: m.index, signed: !!signed });
  }
  const signedMarks = marks.filter((x) => x.signed);
  marks.forEach((x) => {
    const before = t.slice(Math.max(0, x.at - 80), x.at);
    // "Website design © 2025 Pixel Studio Ltd", "Thomas & Friends™ © 2026 …", a photographer: whoever made the site, the pictures or the character
    const credited = t.slice(Math.max(0, x.at - 200), x.at).toLowerCase();
    const madeIt = /(design|develop|built|website|site\s+by|hosting|seo|theme|template|photo|picture|image|illustrat|artwork|logo|music|font|character|powered\s+by|review)/.exec(credited);
    // "Logo design: Fox & Owl Ltd. © 2026 Fox & Owl Ltd": the holder was just credited for making something
    const maker = (madeIt && credited.indexOf(x.name.toLowerCase(), madeIt.index) >= 0) || MAKER_WORDS.test(x.name) || /[™®]/.test(before) ||
      /(design|develop|built|website|site\s+by|hosting|seo|theme|template|photo|picture|image|illustrat|artwork|logo|music|font|character|powered\s+by|review)(?:(?!\.\s)[^|]){0,40}$/i.test(before);
    if (isOwnName(x.name, keys)) { add(x.name, 'copyright'); return; }
    // words of four letters or more it shares with the business's own names ("Sinclair", "Furniture")
    const shared = normKey(x.name).split(' ').filter((w, i, a) => w.length >= 4 && a.indexOf(w) === i && keys.some((k) => k.indexOf(w) >= 0)).length;
    // "copyright of X Ltd" in words is how sites credit suppliers, pattern makers and licensors too ("the copyright of Liberty Fabric
    // Ltd", "copyright of Candle Shack Ltd"): it counts only when it shares two words with the business, and never as the last line
    if (!x.signed) { if (shared >= 2 && !maker) add(x.name, 'copyright'); return; }
    if (shared >= 1 && !maker) { add(x.name, 'copyright'); return; }
    // the last © line at the foot of the page, when it is not a maker's credit
    if (x !== signedMarks[signedMarks.length - 1] || x.at < t.length - 800 || maker) return;
    add(x.name, 'copyright');
  });
  return out;
}

// Words a stated company name can start with that are not part of it ("Venicci UK & Ireland MAGICBABY LTD" read as one).
const LEAD_JUNK = /^(uk|gb|ireland|england|scotland|wales|europe|international|and|of|the|by|tel|phone|call|us|on|at)$/i;
const GENERIC_CO = /^(group|holdings|trading|services|international|retail|products|enterprises|ventures|solutions|global|europe|uk|ireland|england|company|limited|brand|brands|london)$/;
/**
 * The company part of a stated name that the page ran together with the brand or a phone number before it:
 * "Venicci UK & Ireland MAGICBABY LTD" gives "MAGICBABY LTD", "3872 MAGICBABY LTD" gives "MAGICBABY LTD".
 * Only when something like that was trimmed, and what is left is a name of its own; otherwise ''.
 */
function coreName(stated, exName) {
  const words = String(stated || '').trim().split(/\s+/);
  const suffix = words.pop();
  if (!words.length || !CO_SUFFIX.test(suffix)) return '';
  const exWords = normKey(exName).split(' ').filter(Boolean);
  let i = 0, trimmed = false;
  while (i < words.length) {
    const w = words[i], k = normKey(w);
    if (!/[A-Za-z]/.test(w) || /^[+(]?\d/.test(w)) { i++; trimmed = true; continue; }   // a number or phone number
    if (k && k.split(' ').every((x) => exWords.indexOf(x) >= 0)) { i++; trimmed = true; continue; }   // the brand's own name
    if (!k || LEAD_JUNK.test(k)) { i++; continue; }   // UK, &, Ireland and the like between them
    break;
  }
  const rest = words.slice(i);
  if (!trimmed || !rest.length) return '';
  const keys = normKey(rest.join(' ')).split(' ').filter(Boolean);
  if (keys.some((k) => exWords.indexOf(k) >= 0) || !keys.some((k) => k.length >= 4 && !GENERIC_CO.test(k))) return '';
  return rest.join(' ') + ' ' + suffix.replace(/[.,;:]+$/, '');
}

/**
 * A company named together with its address, as sites do in the footer or on the contact page:
 * "MAGICBABY LTD, Unit 7 Brookfields Way, S63 5DL Manvers Rotherham". A Ltd, Limited, LLP or PLC name followed within a
 * couple of lines by a UK postcode. Not lenders, couriers, platforms, accountants or solicitors, and not template text.
 */
function addressedNames(text, exName) {
  const t = String(text || ''), out = [], seen = Object.create(null);
  const re = /(?:^|\s)(Ltd|LTD|Limited|LIMITED|LLP|PLC|Plc)\b[.,]?/g;
  let m;
  while ((m = re.exec(t)) && out.length < 3) {
    const end = m.index + m[0].length;
    const after = t.slice(end, end + 140);
    if (NOT_AFTER_SUFFIX.test(after.trim()) || !extractPostcodes(after).length) continue;
    const raw = nameBefore(t.slice(Math.max(0, end - 160), end));
    const name = (raw && coreName(raw, exName)) || raw;
    const around = t.slice(Math.max(0, m.index - 200), end + 200);
    if (!name || NOT_OWNER.test(name) || PLACEHOLDER_NAME.test(name) || MAKER_WORDS.test(name) || FINANCE_NEAR.test(around)) continue;
    if (/(accountan|chartered|solicitor|\blaw\b|legal|\btax\b)/i.test(name) || /(c\/o|care of)\s*$/i.test(t.slice(Math.max(0, end - name.length - 30), end - name.length))) continue;
    const k = normKey(name);
    if (!k || seen[k]) continue;
    seen[k] = 1; out.push(name);
  }
  return out;
}

/** Lower case letters and single spaces, accents and apostrophes dropped: for comparing people's names. */
function personKey(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[\u2019']/g, '').replace(/[^a-z]+/g, ' ').trim();
}

const OFFICER_TITLES = /^(mr|mrs|ms|miss|mx|dr|sir|dame|lord|lady|prof|rev|hon)$/;
/** A director from the register ("MACDONALD-JONES, Alan James, Dr") as the forms a website would write them. */
function officerShape(x) {
  const raw = String((x && x.name) || '').trim();
  let last, fores;
  if (raw.indexOf(',') >= 0) { last = raw.split(',')[0]; fores = raw.split(',').slice(1).join(' '); }
  else { const t = raw.split(/\s+/); last = t.pop() || ''; fores = t.join(' '); }
  const L = personKey(last), F = personKey(fores).split(' ').filter((w) => w.length >= 2 && !OFFICER_TITLES.test(w));
  if (L.length < 2 || !F.length) return null;
  return { name: titleCaseOfficer(raw), first: F[0], forenames: F, last: L, pc: extractPostcodes(String(((x.address || {}).postal_code) || ''))[0] || '' };
}

// Words that put a person in charge of the business, wanted in the same sentence as a director's name: "started by", "founder", "I'm".
const ROLE_NEAR = /\b(founder|founders|cofounder|co founder|founded|started|created|set up|launched|run by|owned by|owner|owners|director|managing director|md|ceo|proprietor|im|i am|my name|meet|behind|made by|handmade by|hand made by|made with love by|maker|designer)\b/;

/** The text of its pages as sentences in personKey form, with the business's own names blanked out (so "Lily Rose Designs" is not a Lily Rose). */
function sentencesFor(texts, ownNames) {
  const blanks = ownNames.map((n) => personKey(strictKey(n))).filter((n) => n.indexOf(' ') > 0);
  const out = [];
  texts.join(' . ').split(/[.!?\n|•“”"]+/).forEach((x) => {
    let k = ' ' + personKey(x) + ' ';
    if (k.length < 6 || out.length > 4000) return;
    blanks.forEach((b) => { k = k.split(' ' + b + ' ').join(' | '); });
    out.push(k);
  });
  return out;
}

/**
 * Evidence that this company is the business behind the site, from its current directors: one named on its pages in a sentence
 * that says they started, own or run it (not a customer review), its named contact, or an email address on its own domain
 * (jane.smith@), else a director's correspondence postcode written on its pages. Null when none.
 * ev: { sentences: from sentencesFor, people: [personKey], locals: ['janesmith'], pcs: ['AB1 2CD'] }
 */
function directorEvidence(officers, ev, coName) {
  const co = personKey(strictKey(coName));
  for (const o of officers) {
    const forms = [o.first + ' ' + o.last];
    if (o.forenames.length > 1) forms.push(o.forenames.join(' ') + ' ' + o.last);
    for (const sen of (ev.sentences || [])) {
      const x = co.indexOf(' ') > 0 ? sen.split(' ' + co + ' ').join(' | ') : sen;
      if (forms.some((f) => x.indexOf(' ' + f + ' ') >= 0) && ROLE_NEAR.test(x)) return { kind: 'director', how: 'Director named on its website: ' + o.name };
    }
    if ((ev.people || []).some((p) => forms.indexOf(p) >= 0)) return { kind: 'director', how: 'Director is its named contact: ' + o.name };
    const tight = [o.first + o.last, o.last + o.first].map((x) => x.replace(/ /g, ''));
    if ((ev.locals || []).some((l) => tight.indexOf(l) >= 0)) return { kind: 'director', how: 'Director named in its email address: ' + o.name };
  }
  for (const o of officers) if (o.pc && (ev.pcs || []).indexOf(o.pc) >= 0) return { kind: 'dirpost', pc: o.pc, how: 'Director’s postcode on its website matches: ' + o.pc };
  return null;
}

// Formation agents and virtual offices where thousands of companies are registered: a postcode there proves nothing.
const SHARED_POSTCODES = ['EC1V 2NX', 'N1 7GU', 'WC2H 9JQ', 'WC1N 3AX', 'EC2A 4NE', 'W1W 7LT', 'W1W 5PF', 'HR5 3DJ', 'WC1X 0ND', 'EC4M 7JN'];
const SHARED_OVER = 50;   // companies registered at one postcode before it counts as a shared address
/** Is this a postcode where many companies are registered? Asks Companies House once per postcode per run; the list above if it cannot answer. */
function postcodeShared(pc, ctx) {
  if (!pc || SHARED_POSTCODES.indexOf(pc) >= 0) return true;
  const cache = ctx ? (ctx.pcCount = ctx.pcCount || Object.create(null)) : Object.create(null);
  if (!(pc in cache)) {
    let n = -1;
    try { const r = chGet('/advanced-search/companies?size=1&location=' + encodeURIComponent(pc)); if (r.code === 200 && r.json) n = +r.json.hits || 0; } catch (e) { n = -1; }
    cache[pc] = n;
  }
  return cache[pc] > SHARED_OVER;
}

// Company statuses that mean it no longer trades, or is being wound up. A company "in a voluntary arrangement" still trades.
const CLOSED = /^(dissolved|liquidation|converted-closed|removed|closed|insolvency-proceedings|receivership|administration)$/;
const CLOSED_WORDS = { dissolved: 'dissolved', liquidation: 'in liquidation', 'converted-closed': 'closed', removed: 'removed from the register', closed: 'closed', 'insolvency-proceedings': 'in insolvency proceedings', receivership: 'in receivership', administration: 'in administration' };
const closedWord = (status) => CLOSED_WORDS[status] || String(status || 'not active');

/**
 * Owners often close a company and carry on through a new one at the same address: GRIFFIN AND SINCLAIR LTD (dissolved) and
 * LEE SINCLAIR FURNITURE LIMITED (active) are both registered at DN22 0NA. When the company a check lands on has closed, this asks
 * Companies House for the active companies registered at its postcode and keeps those whose names share a word with the business
 * (not "group", "holdings", "trading" and the like). Not at a shared address, and only when one company shares more words than the
 * rest. Returns that company, or null.
 */
function activeSuccessor(old, exName, ctx, say) {
  if (!old || !old.pc || !CLOSED.test(String(old.status || ''))) return null;
  if (postcodeShared(old.pc, ctx)) { say(old.pc + ', where ' + old.name + ' was registered, is a shared address where many companies are registered, so no other company there was looked for'); return null; }
  // the register could not say how many companies are there: that could be a virtual office, so nothing is looked for
  if (((ctx && ctx.pcCount) || {})[old.pc] < 0) { say('Companies House could not say how many companies are registered at ' + old.pc + ', so no other company there was looked for'); return null; }
  let r;
  try { r = chGet('/advanced-search/companies?size=50&company_status=active&location=' + encodeURIComponent(old.pc)); } catch (e) { r = { code: 0 }; }
  if (r.code !== 200 || !r.json) { say('Companies House did not answer the search for active companies at ' + old.pc); return null; }
  if ((+r.json.hits || 0) >= SHARED_OVER) { say(old.pc + ' has ' + r.json.hits + ' active companies, so none of them proves anything'); return null; }
  // words of the name it is listed under that the closed company's name has too (not a place, "group", "holdings" and the like)
  const telling = (w) => w.length >= 3 && !GENERIC_CO.test(w) && !LEAD_JUNK.test(w) && !PLACES[w];
  const oldWords = normKey(old.name).split(' ').filter((w, i, a) => telling(w) && a.indexOf(w) === i);
  const words = Object.create(null);
  normKey(exName).split(' ').forEach((w) => { if (telling(w) && oldWords.indexOf(w) >= 0) words[w] = 1; });
  // a shared word of four letters or more ("Sinclair"), or two short ones ("Oak & Ash"), and at least half the closed company's
  // telling words: GRIFFIN AND SINCLAIR to LEE SINCLAIR FURNITURE yes, JANE SMITH CERAMICS to JOHN SMITH BUILDERS no
  const fits = (r.json.items || []).map(chShape).filter((c) => c.no && c.no !== old.no && c.status === 'active' && c.pc === old.pc)
    .map((c) => { const sh = normKey(c.name).split(' ').filter((w, i, a) => words[w] && a.indexOf(w) === i); return { c, n: sh.length, ok: (sh.some((w) => w.length >= 4) || sh.length >= 2) && sh.length * 2 >= oldWords.length }; })
    .filter((x) => x.ok).sort((a, b) => b.n - a.n);
  if (!fits.length) { say('No active company registered at ' + old.pc + ' shares a word with its name'); return null; }
  if (fits.length > 1 && fits[1].n === fits[0].n) { say('Active companies at ' + old.pc + ' that share a word with its name: ' + fits.slice(0, 3).map((x) => x.c.name).join(', ') + '. More than one fits, so none is picked'); return null; }
  say('Active company registered at ' + old.pc + ', where ' + old.name + ' (' + closedWord(old.status) + ') is registered: ' + fits[0].c.name + ' (' + fits[0].c.no + ')');
  return fits[0].c;
}

// Places a franchise class or a branch adds to its name ("Baby Sensory Kent"). When the company name lacks the place, the company
// is likely the franchisor or head office, not the business at the stand.
const PLACES = Object.create(null);
('london manchester birmingham leeds liverpool bristol sheffield newcastle nottingham leicester brighton hove oxford cambridge bath york glasgow edinburgh ' +
  'cardiff belfast aberdeen dundee swansea newport plymouth exeter norwich reading southampton portsmouth bournemouth coventry derby hull bradford ' +
  'wolverhampton sunderland preston blackpool chester lincoln worcester gloucester cheltenham salisbury winchester canterbury guildford watford luton ' +
  'peterborough northampton ipswich colchester chelmsford southend basildon maidstone crawley swindon milton keynes surrey kent essex sussex hampshire hants ' +
  'berkshire berks hertfordshire herts buckinghamshire bucks oxfordshire oxon bedfordshire beds cambridgeshire cambs norfolk suffolk lincolnshire lincs ' +
  'nottinghamshire notts derbyshire leicestershire northamptonshire warwickshire worcestershire gloucestershire glos herefordshire shropshire ' +
  'staffordshire staffs cheshire lancashire lancs yorkshire cumbria northumberland durham devon cornwall dorset somerset wiltshire wilts merseyside ' +
  'midlands cotswolds wales scotland ireland kensington chelsea fulham clapham wimbledon richmond islington hackney camden greenwich ealing ' +
  'chiswick putney battersea twickenham kingston croydon bromley harrow barnet enfield north south east west central').split(' ').forEach((w) => { PLACES[w] = 1; });
function placesIn(name) { return normKey(name).split(' ').filter((w) => PLACES[w]); }
/** Places in the exhibitor's listed name that the company's name does not have. */
function extraPlaces(exName, coName) { const co = placesIn(coName); return placesIn(exName).filter((w) => co.indexOf(w) < 0); }
// A site that says it is one local business in a franchise or under licence.
const FRANCHISEE = /\b(franchisee|franchisees|franchise owner|independently owned|is a franchise of|a franchise of|licensee of|under licen[cs]e from|area (?:owner|franchise|licen[cs]e))\b/i;

/** The name as Companies House compares names: case, punctuation, "&"/"and", a leading "The" and the Ltd, Limited, PLC or LLP ending ignored, nothing else. */
function strictKey(name) {
  return String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[’']/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/^the /, '').replace(/( (ltd|limited|plc|llp|cyf|cyfyngedig))+$/, '').replace(/ company$/, ' co').trim();
}
/** The one company the search returned under exactly this name, or null (also when two have it, or the name is template text). */
function exactCompany(hit, stated) {
  if (!hit || PLACEHOLDER_NAME.test(stated)) return null;
  const k = strictKey(stated);
  const same = (hit.all || []).filter((x) => strictKey(x.c.name) === k);
  return same.length === 1 ? same[0].c : null;
}

// Words around a brand that say nothing about the company, dropped for a second search.
const FILLER_WORDS = /\b(shop|store|stores|boutique|official|online|brand|brands|collection|collections|studio|uk|gb|london|by|est)\b/g;
const NUM_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];

/** The domain as words found in the given text ("snugglebabyco" with "Snuggle Baby Co" on the page becomes "snuggle baby co"), or ''. */
function segmentDomain(stem, text) {
  stem = String(stem || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (stem.length < 6 || stem.length > 40) return '';
  const vocab = Object.create(null);
  String(text || '').toLowerCase().split(/[^a-z0-9]+/).forEach((w) => { if (w.length >= 2 || /^\d$/.test(w)) vocab[w] = 1; });
  const best = [[]];   // best[i]: fewest words that make up stem[0..i)
  for (let i = 1; i <= stem.length; i++) {
    for (let j = Math.max(0, i - 20); j < i; j++) {
      if (!best[j] || !vocab[stem.slice(j, i)]) continue;
      const cand = best[j].concat(stem.slice(j, i));
      if (!best[i] || cand.length < best[i].length) best[i] = cand;
    }
  }
  const w = best[stem.length];
  return w && w.length >= 2 ? w.join(' ') : '';
}

/**
 * Other names worth a Companies House search when the exhibitor's own name gives nothing that can be confirmed:
 * the name its site gives itself, numbers as words ("2 Little Legs" as "Two Little Legs"), the name without words such as
 * Shop or UK, and its web address split into words. Any company these find still needs its own evidence before it counts.
 */
function searchVariants(exName, siteName, domain, pageText) {
  const out = [], seen = Object.create(null);
  const stem = String(domain || '').split('.')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
  seen[normKey(exName).split(' ').filter((w) => w.length >= 2).join('')] = 1;
  const add = (q) => {
    q = String(q || '').replace(/\s+/g, ' ').trim();
    const words = normKey(q).split(' ').filter((w) => w.length >= 2);
    const k = words.join('');
    if (words.length < 2 || k.length < 5 || seen[k]) return;   // a single word ("Gifts", "Baby") matches far too many companies
    seen[k] = 1; out.push(q);
  };
  const exWords = normKey(exName).replace(FILLER_WORDS, ' ').split(' ').filter((w) => w.length >= 4);
  const site = normKey(siteName);
  if (site && (exWords.some((w) => (' ' + site + ' ').indexOf(' ' + w + ' ') >= 0) || (stem && stem.indexOf(site.replace(/ /g, '')) >= 0))) add(siteName);
  const words = String(exName || '').split(/\s+/);
  if (words.some((w) => /^(10|[1-9])$/.test(w))) add(words.map((w) => (/^(10|[1-9])$/.test(w) ? NUM_WORDS[+w] : w)).join(' '));
  else if (words.some((w) => NUM_WORDS.indexOf(w.toLowerCase()) > 0)) add(words.map((w) => { const i = NUM_WORDS.indexOf(w.toLowerCase()); return i > 0 ? String(i) : w; }).join(' '));
  add(normKey(exName).replace(FILLER_WORDS, ' ').replace(/\s+/g, ' ').trim());
  add(segmentDomain(stem, [exName, siteName, pageText].join(' ')));
  return out;
}

/* ============================================================
 * Reading exhibitor directories
 * ============================================================ */

const WEBSITE_TEXT = /(visit\s*(?:the\s*)?(?:our\s*)?(?:web)?site|view\s*(?:web)?site|website|^www\.|^https?:\/\/)/i;

function looksLikeWebsiteLink(a) {
  const t = (a.text || '') + ' ' + (a.title || '');
  return WEBSITE_TEXT.test(t.trim()) || /^(https?:\/\/)?(www\.)?[a-z0-9-]+(\.[a-z0-9-]+)+\/?$/i.test((a.text || '').trim());
}

function externalAnchors(html, base) {
  const host = (parseUrl(base) || {}).host || '';
  const out = [];
  anchors(html).forEach((a) => {
    const u = resolveUrl(base, a.href);
    const p = u && parseUrl(u);
    if (!p || sameSite(p.host, host) || isSkipHost(p.host) || !isPublicHost(p.host)) return;
    a.url = u;
    out.push(a);
  });
  return out;
}

/** Cards: a heading per exhibitor, with a stand number and/or a website link underneath. */
function parseCards(html, base) {
  const heads = headings(html).filter((h) => h.text && !/^stand\b/i.test(h.text));
  if (heads.length < 3) return [];
  const all = headings(html);
  const cardEnd = (h, level) => { const nxt = all.find((x) => x.index > h.index && x.level <= level && !/^stand\b/i.test(x.text)); return nxt ? nxt.index : html.length; };
  const scored = {};
  heads.forEach((h) => {
    const body = html.slice(h.end, cardEnd(h, h.level));
    const has = /stand\s*:?\s*[A-Za-z]?\d/i.test(stripTags(body).slice(0, 200)) || externalAnchors(body, base).some(looksLikeWebsiteLink);
    const s = scored[h.level] || (scored[h.level] = { n: 0, yes: 0 });
    s.n++; if (has) s.yes++;
  });
  let level = 0, bestYes = 2;
  Object.keys(scored).forEach((l) => { if (scored[l].yes > bestYes && scored[l].yes / scored[l].n >= 0.5) { bestYes = scored[l].yes; level = +l; } });
  if (!level) return [];
  const entries = [];
  heads.filter((h) => h.level === level).forEach((h) => {
    const body = html.slice(h.end, cardEnd(h, level));
    const txt = stripTags(body);
    const site = externalAnchors(body, base).filter(looksLikeWebsiteLink)[0] || null;
    const stand = /stand\s*:?\s*([A-Za-z]?\d[\w\-]*(?:\s*(?:,|&|and)\s*[A-Za-z]?\d[\w\-]*)*)/i.exec(txt);
    if (!site && !stand) return;
    const cats = [];
    const reCat = /<(?:li|span|a|div|p)\b[^>]*class\s*=\s*["'][^"']*(?:categor|tag|label)[^"']*["'][^>]*>([\s\S]*?)<\/(?:li|span|a|div|p)>/gi;
    let c;
    while ((c = reCat.exec(body))) { const t = stripTags(c[1]); if (t && t.length < 40 && cats.indexOf(t) < 0) cats.push(t); }
    const para = /<p\b[^>]*>([\s\S]*?)<\/p>/i.exec(body);
    const phones = extractPhones(body);
    entries.push({
      name: h.text, stand: stand ? stand[1].trim() : '', category: cats.join(', '),
      blurb: para ? stripTags(para[1]).slice(0, 300) : '', website: site ? site.url : '', phone: phones[0] || '',
    });
  });
  return entries;
}

/** Logo grid: each exhibitor links to its own page under the list's address. */
function parseDetailGrid(html, base) {
  const b = parseUrl(base);
  if (!b) return [];
  const listPath = b.path.replace(/\/?$/, '/');
  const seen = {};
  const entries = [];
  anchors(html).forEach((a) => {
    const u = resolveUrl(base, a.href);
    const p = u && parseUrl(u);
    if (!p || !sameSite(p.host, b.host) || p.path.indexOf(listPath) !== 0 || p.path.length <= listPath.length + 1) return;
    const key = p.path;
    if (seen[key]) return;
    let name = (a.title || '').replace(/^more information on\s+/i, '').trim();
    if (!name) { const alt = /<img\b[^>]*\balt\s*=\s*"([^"]*)"/i.exec(a.inner) || /<img\b[^>]*\balt\s*=\s*'([^']*)'/i.exec(a.inner); name = alt ? decodeEntities(alt[1]).trim() : ''; }
    if (!name) name = a.text;
    if (!name || name.length > 120 || /^(next|previous|back|more|view all)\b/i.test(name)) return;
    seen[key] = 1;
    entries.push({ name, stand: '', category: '', blurb: '', website: '', phone: '', detailUrl: p.scheme + '://' + p.host + p.path });
  });
  return entries;
}

/** Plain lists of links to other sites: <li><a href="https://business.co.uk">Business</a></li> */
function parseLinkList(html, base) {
  const entries = [];
  const seen = {};
  const re = /<li\b[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = re.exec(html))) {
    const ext = externalAnchors(m[1], base);
    if (ext.length !== 1) continue;
    const a = ext[0];
    const rest = stripTags(m[1]);
    let name = /^(visit|website|click|here|www\.|https?:)/i.test(a.text) ? rest.replace(a.text, '').replace(/^[\s\-–:,]+|[\s\-–:,]+$/g, '') : a.text;
    if (!name || name.length > 120 || name.length < 2) name = a.text;
    const site = cleanWebsite(a.url);
    if (!site || !name || seen[site]) continue;
    seen[site] = 1;
    entries.push({ name, stand: '', category: '', blurb: '', website: site, phone: '' });
  }
  return entries;
}

function parseDirectory(html, base) {
  html = String(html || '');
  let e = parseCards(html, base);
  if (e.length >= 3) return { entries: e, how: 'cards' };
  e = parseDetailGrid(html, base);
  if (e.length >= 8) return { entries: e, how: 'grid' };
  e = parseLinkList(html, base);
  if (e.length >= 8) return { entries: e, how: 'links' };
  return { entries: [], how: 'none' };
}

/** An exhibitor's own page on the show site: pick its website and a phone number. */
function parseDetail(html, base) {
  const ext = externalAnchors(html, base);
  const pick = ext.filter(looksLikeWebsiteLink)[0] || ext[0];
  return { website: pick ? cleanWebsite(pick.url) : '', phone: extractPhones(html)[0] || '' };
}

/** Pasted list: one business per line, optional website and email. Also accepts a CSV with a header row. */
function parsePasted(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 1500);
  if (!lines.length) return [];
  const split = (l) => (l.indexOf('\t') >= 0 ? l.split('\t') : l.indexOf('|') >= 0 ? l.split('|') : l.match(/("([^"]|"")*"|[^,]+)(?=,|$)/g) || [l]).map((x) => x.replace(/^"|"$/g, '').replace(/""/g, '"').trim());
  let cols = null, start = 0;
  const h = split(lines[0]).map((x) => x.toLowerCase());
  if (h.length > 1 && h.some((x) => /^(name|business|company|exhibitor)/.test(x)) && h.some((x) => /(web|url|email|phone)/.test(x))) {
    cols = { name: h.findIndex((x) => /^(name|business|company|exhibitor)/.test(x)), website: h.findIndex((x) => /(web|url)/.test(x)), email: h.findIndex((x) => /email/.test(x)), phone: h.findIndex((x) => /(phone|tel)/.test(x)), contact: h.findIndex((x) => /contact/.test(x)) };
    start = 1;
  }
  const out = [];
  lines.slice(start).forEach((line) => {
    const t = split(line);
    const e = { name: '', stand: '', category: '', blurb: '', website: '', phone: '', email: '', contact: '' };
    if (cols) {
      const g = (i) => (i >= 0 && t[i] ? t[i] : '');
      e.name = g(cols.name); e.website = cleanWebsite(g(cols.website)); e.email = /@/.test(g(cols.email)) ? g(cols.email).toLowerCase() : ''; e.phone = formatPhone(normalisePhone(g(cols.phone))); e.contact = g(cols.contact);
    } else {
      const rest = [];
      t.forEach((x) => {
        const bit = x.replace(/^[\-–:]\s*/, '');
        if (/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(bit)) e.email = bit.toLowerCase();
        else if (cleanWebsite(bit) && !/\s/.test(bit)) e.website = cleanWebsite(bit);
        else if (normalisePhone(bit)) e.phone = formatPhone(normalisePhone(bit));
        else rest.push(bit);
      });
      e.name = rest[0] || '';
      if (!e.name && e.website) e.name = siteDomain(e.website);
      // "Name - www.site.co.uk" on one line with no comma
      if (!e.website && rest.length === 1) {
        const m = /^(.*?)\s+[-–]\s+((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+\S*)$/i.exec(rest[0]);
        if (m && cleanWebsite(m[2])) { e.name = m[1].trim(); e.website = cleanWebsite(m[2]); }
      }
    }
    if (e.name && e.name.length <= 160) out.push(e);
  });
  return out;
}

/* ============================================================
 * robots.txt
 * ============================================================ */

function parseRobots(text) {
  const groups = [];
  let cur = null, lastAgent = false;
  String(text || '').split(/\r?\n/).forEach((line) => {
    line = line.replace(/#.*$/, '').trim();
    const i = line.indexOf(':');
    if (!line || i < 0) return;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k === 'user-agent') {
      if (!cur || !lastAgent) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastAgent = true;
    } else {
      lastAgent = false;
      if ((k === 'allow' || k === 'disallow') && cur && (v !== '' || k === 'allow')) cur.rules.push({ allow: k === 'allow', path: v });
    }
  });
  return groups.slice(0, 40).map((g) => ({ agents: g.agents.slice(0, 10), rules: g.rules.slice(0, 200) }));
}

function robotsAllows(groups, path) {
  if (!groups || groups === 'all') return true;
  if (groups === 'none' || groups === 'down') return false;
  const mine = groups.filter((g) => g.agents.some((a) => a === 'exhibitorleads' || a === 'google-apps-script'));
  const use = mine.length ? mine : groups.filter((g) => g.agents.indexOf('*') >= 0);
  let best = null;
  use.forEach((g) => g.rules.forEach((r) => {
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (!re.test(path)) return;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }));
  return best ? best.allow : true;
}

/* ============================================================
 * Fetching
 * ============================================================ */

function lowerKeys(h) { const o = {}; Object.keys(h || {}).forEach((k) => { o[k.toLowerCase()] = h[k]; }); return o; }

/* ---------- Timing: where the time goes in a check (shown in Settings) ---------- */

let _cat = 'web';                     // which part of a check the requests belong to
let _T = {};                          // milliseconds per part, for the exhibitor being checked
let _slow = { ms: 0, host: '' };      // the slowest single wait

function hostOf(u) { return (parseUrl(u) || {}).host || ''; }
function tick(ms, host, n) {
  _T[_cat] = (_T[_cat] || 0) + ms;
  _T.req = (_T.req || 0) + (n || 1);
  if (ms > _slow.ms) _slow = { ms, host: host || '' };
}

/* ---------- Web requests ---------- */

function reqOptions(opts) {
  const o = { method: 'get', muteHttpExceptions: true, followRedirects: false };
  Object.keys(opts || {}).forEach((k) => { o[k] = opts[k]; });
  o.headers = Object.assign({ 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-GB,en;q=0.8' }, (opts && opts.headers) || {});
  return o;
}

/**
 * A very long page (a shop or page-builder home page can carry most of a megabyte of scripts and styles) is cut down
 * to its words first, so the footer, where the company details usually are, is not the part that gets lost.
 * If it is still too long, the start and the end are kept.
 */
function shrinkBody(b) {
  if (b.length <= MAX_BODY) return b;
  b = b.replace(/<(script|style|noscript|svg)\b(?![^>]*ld\+json)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<!--[\s\S]*?-->/g, ' ');
  if (b.length <= MAX_BODY) return b;
  const head = Math.floor(MAX_BODY * 0.55);
  return b.slice(0, head) + ' ' + b.slice(b.length - (MAX_BODY - head));
}

function parseResp(r) {
  let body = '', size = 0;
  try { body = String(r.getContentText() || ''); size = body.length; body = shrinkBody(body); } catch (e) { body = ''; }
  return { code: r.getResponseCode(), headers: lowerKeys(r.getAllHeaders ? r.getAllHeaders() : r.getHeaders()), body, size };
}

function http(url, opts) {
  const o = reqOptions(opts);
  _fetched++;
  const t0 = Date.now();
  try {
    return parseResp(UrlFetchApp.fetch(url, o));
  } catch (err) {
    return { code: 0, headers: {}, body: '', error: String((err && err.message) || err) };
  } finally {
    tick(Date.now() - t0, hostOf(url), 1);
  }
}

/**
 * Several requests at once. They take as long as the slowest rather than the sum. If one of them fails outright
 * (a site that does not exist can fail the whole batch) they are sent one at a time instead, so nothing is lost.
 */
function httpMany(reqs, host) {
  if (!reqs.length) return [];
  if (reqs.length === 1) return [http(reqs[0].url, reqs[0].opts)];
  const built = reqs.map((q) => Object.assign({ url: q.url }, reqOptions(q.opts)));
  _fetched += built.length;
  const t0 = Date.now();
  try {
    const rs = UrlFetchApp.fetchAll(built).map(parseResp);
    tick(Date.now() - t0, host, built.length);
    return rs;
  } catch (err) {
    tick(Date.now() - t0, host, built.length);
    return reqs.map((q) => http(q.url, q.opts));
  }
}

function isRedirector(host) { return REDIRECTORS.some((r) => host === r || host.slice(-(r.length + 1)) === '.' + r); }

function robotsCached(host, ctx) {
  if (ctx.robots[host] !== undefined) return ctx.robots[host];
  const hit = CacheService.getScriptCache().get('rb:' + host);
  if (hit) { try { const g = JSON.parse(hit); ctx.robots[host] = g; return g; } catch (e) { /* refetch */ } }
  return undefined;
}

function robotsStore(host, r, ctx) {
  let groups = 'all';
  if (r.code === 200) groups = parseRobots(r.body);
  else if (r.code >= 400 && r.code < 500) groups = 'all';
  else if (r.code >= 300 && r.code < 400) groups = 'all';
  else groups = 'down';   // unreachable or server error: treated as "do not read", as the standard says
  ctx.robots[host] = groups;
  ctx.robotsSaid = ctx.robotsSaid || {};
  ctx.robotsSaid[host] = r.code ? 'answered ' + r.code : (r.error ? clip(r.error, 60) : 'did not answer');
  try { const j = JSON.stringify(groups); if (j.length < 90000) CacheService.getScriptCache().put('rb:' + host, j, groups === 'down' ? 600 : 6 * 3600); } catch (e) { /* cache is optional */ }
  return groups;
}

function robotsFor(host, scheme, ctx) {
  const c = robotsCached(host, ctx);
  if (c !== undefined) return c;
  return robotsStore(host, http(scheme + '://' + host + '/robots.txt'), ctx);
}

/** Fetches the robots.txt of every site in the list that is not known yet, all at once, with any extra requests. */
function prefetchRobots(urls, ctx, extras) {
  const need = [], seen = {};
  urls.forEach((u) => {
    const p = parseUrl(u);
    if (!p || !isPublicHost(p.host) || isRedirector(p.host) || seen[p.host]) return;
    seen[p.host] = 1;
    if (robotsCached(p.host, ctx) === undefined) need.push({ host: p.host, url: p.scheme + '://' + p.host + '/robots.txt' });
  });
  const reqs = need.map((n) => ({ url: n.url })).concat((extras || []).map((e) => ({ url: e.url, opts: e.opts })));
  if (!reqs.length) return [];
  const rs = httpMany(reqs, hostOf(urls[0]));
  need.forEach((n, i) => robotsStore(n.host, rs[i], ctx));
  return rs.slice(need.length);
}

/** Whether a page may be requested now. Returns { res } when the answer is already known, { ok: true } to go ahead. */
function gatePage(cur, ctx) {
  if (ctx && ctx.until && Date.now() > ctx.until) return { res: { blocked: false, late: true, code: 0, body: '', url: cur, error: 'Ran out of time' } };
  const p = parseUrl(cur);
  if (!p || !isPublicHost(p.host)) return { res: { blocked: false, code: 0, body: '', url: cur, error: 'Not a public web address' } };
  if (!isRedirector(p.host)) {
    const rb = robotsFor(p.host, p.scheme, ctx);
    if (!robotsAllows(rb, p.path + p.query)) return { res: { blocked: true, down: rb === 'down', code: 0, body: '', url: cur } };
  }
  return { ok: true };
}

/**
 * Fetch pages politely: follows redirects, and checks robots.txt before reading any page that isn't just a link
 * shortener. Several pages are fetched at once, and `side` holds other requests to send in the same first round.
 * Returns one { blocked, code, body, url } per page, in order; the answers to `side` are on the result as `.side`.
 */
function fetchPages(urls, ctx, maxHops, side) {
  const hops = maxHops || 4, out = new Array(urls.length), cur = urls.slice();
  let todo = [], sideOut = [];
  urls.forEach((u, i) => { const hit = ctx && ctx.pages && ctx.pages[u + '|' + hops]; if (hit) out[i] = hit; else todo.push(i); });
  for (let round = 0; round <= hops && (todo.length || (round === 0 && side && side.length)); round++) {
    const extra = prefetchRobots(todo.map((i) => cur[i]), ctx, round === 0 ? side : null);
    if (round === 0) sideOut = extra;
    const reqs = [], idx = [];
    todo.forEach((i) => {
      const g = gatePage(cur[i], ctx);
      if (g.res) out[i] = g.res; else { reqs.push({ url: cur[i] }); idx.push(i); }
    });
    const rs = httpMany(reqs, hostOf(cur[idx[0]] || ''));
    const next = [];
    rs.forEach((r, k) => {
      const i = idx[k];
      if (r.code >= 300 && r.code < 400 && r.headers.location) {
        const nu = resolveUrl(cur[i], r.headers.location);
        if (nu) { cur[i] = nu; next.push(i); } else out[i] = { blocked: false, code: 0, body: '', url: cur[i], error: 'Too many redirects' };
        return;
      }
      const type = String(r.headers['content-type'] || '');
      if (type && !/html|xml|text/i.test(type)) out[i] = { blocked: false, code: r.code, body: '', url: cur[i], error: 'Not a web page' };
      else out[i] = { blocked: false, code: r.code, body: r.body, url: cur[i], error: r.error, size: r.size };
    });
    todo = next;
  }
  todo.forEach((i) => { out[i] = { blocked: false, code: 0, body: '', url: cur[i], error: 'Too many redirects' }; });
  urls.forEach((u, i) => { if (ctx && ctx.pages && out[i] && !out[i].late) ctx.pages[u + '|' + hops] = out[i]; });   // a page skipped for lack of time is not remembered as "unreadable"
  out.side = sideOut;
  return out;
}

function fetchPage(url, ctx, maxHops) { return fetchPages([url], ctx, maxHops)[0]; }

/** Why a page gave nothing, in plain words. Empty when it was read. */
function pageWhy(pg, ctx) {
  if (pg.late) return 'ran out of time';
  if (pg.blocked) {
    const said = ((ctx && ctx.robotsSaid) || {})[hostOf(pg.url)];
    return pg.down ? 'its robots.txt could not be fetched' + (said ? ' (' + said + ')' : '') : 'its robots.txt asks automated tools to stay away';
  }
  if (pg.error) return clip(pg.error, 60);
  if (pg.code < 200 || pg.code >= 300) return 'the site answered ' + pg.code + (/^(403|406|429|430|503)$/.test(String(pg.code)) ? ' (it turns away automated requests)' : '');
  if (!pg.body) return 'the page was empty';
  return '';
}

/** "https://x.com/policies/terms-of-service?x=1" becomes "/policies/terms-of-service" */
function pathOf(u) { const p = parseUrl(u); return p ? (p.path || '/') : String(u || ''); }
const kb = (n) => (n >= 1000 ? Math.round(n / 1000) + ' KB' : n + ' bytes');

function newCtx() { return { robots: {}, mail: {}, donors: null, names: null, shows: null, pages: {} }; }
/** One line for the trace, from outside enrichOne's own helpers. */
function say0(ctx, line) { if (ctx.why && ctx.why.length < 70) ctx.why.push(clip(line, 400)); }

/* ---------- Mail records (DNS over HTTPS) ---------- */

let _pre = {};   // answers fetched ahead of need, alongside the first page of a check: { 'dns:MX:site.com': response, 'ch:/search/...': response }
function takePre(key) { const r = _pre[key]; if (r) delete _pre[key]; return r || null; }

function dohReq(name, type) { return { url: 'https://dns.google/resolve?name=' + encodeURIComponent(name) + '&type=' + type, opts: { headers: { Accept: 'application/dns-json' } }, key: 'dns:' + type + ':' + name }; }

function dohQuery(name, type) {
  const q = dohReq(name, type);
  const r = takePre(q.key) || http(q.url, q.opts);
  if (r.code !== 200) return null;
  try { return JSON.parse(r.body); } catch (e) { return null; }
}

/** "get.verisure.co.uk" becomes "verisure.co.uk": mail records usually sit on the main domain. */
function regDomain(host) {
  const l = String(host || '').toLowerCase().split('.');
  if (l.length <= 2) return l.join('.');
  const last2 = l.slice(-2).join('.');
  return /^(co|org|ac|gov|me|ltd|plc|net|sch|nhs)\.uk$|^(com|co|org|net)\.(au|nz|za|br|in|sg|hk)$/.test(last2) ? l.slice(-3).join('.') : last2;
}

function hostLabel(h) { const p = String(h).split('.'); return p.slice(-(/\.(co|org|ac|gov)\.uk$/.test(h) ? 3 : 2)).join('.'); }

/** Reads MX records and says who runs the mailboxes. */
function classifyMx(dns) {
  if (!dns) return { workspace: 'unknown', host: 'Could not look up mail records', gateway: false };
  if (dns.Status === 3) return { workspace: 'no', host: 'Domain not found', gateway: false };
  const mx = (dns.Answer || []).filter((a) => a.type === 15).map((a) => {
    const t = String(a.data || '').trim().split(/\s+/);
    return { pref: +t[0] || 0, host: String(t[1] || t[0] || '').toLowerCase().replace(/\.$/, '') };
  }).filter((a) => a.host).sort((a, b) => a.pref - b.pref);
  if (!mx.length) return { workspace: 'no', host: 'No email set up', gateway: false };
  const hosts = mx.map((m) => m.host);
  if (hosts.some((h) => /(^|\.)(google|googlemail)\.com$/.test(h))) return { workspace: 'yes', host: 'Google Workspace', gateway: false };
  if (hosts.some((h) => /(mail\.protection\.outlook\.com|\.outlook\.com)$/.test(h))) return { workspace: 'no', host: 'Microsoft 365', gateway: false };
  if (hosts.some((h) => /(^|\.)mail\.icloud\.com$/.test(h))) return { workspace: 'no', host: 'Apple iCloud', gateway: false };
  const gw = hosts.find((h) => GATEWAY.test(h));
  if (gw) return { workspace: 'unknown', host: 'Mail filter (' + hostLabel(gw) + ')', gateway: true };
  return { workspace: 'no', host: 'Other (' + hostLabel(hosts[0]) + ')', gateway: false };
}

/** The domain's TXT records as plain strings (long ones arrive in quoted pieces). */
function txtStrings(dns) {
  return ((dns && dns.Answer) || []).filter((a) => a.type === 16).map((a) => String(a.data || '').replace(/"\s*"/g, '').replace(/^\s*"|"\s*$/g, '').trim());
}
const spfOf = (txt) => txt.filter((t) => /^v=spf1\b/i.test(t)).join(' ');
const SPF_GOOGLE = /include:(_spf\.google\.com|google\.com|_netblocks\.google\.com)(?=\s|$)/i;
const SPF_MICROSOFT = /include:(spf\.protection\.outlook\.com|spf\.messaging\.microsoft\.com)(?=\s|$)/i;
function spfHasGoogle(txt) { return SPF_GOOGLE.test(spfOf(txt)); }
function microsoftHint(txt) { return SPF_MICROSOFT.test(spfOf(txt)) || txt.some((t) => /^MS=ms\d+/i.test(t)); }

/**
 * Other services the business has set up for its domain, read from its TXT records: a domain verification a company account leaves behind,
 * or a service allowed to send its email (SPF). Finding one is a good sign; not finding one means nothing, as most small firms never verify.
 * The first six are the other ways to sign in to AppSheet. Box could not be confirmed from its records, so it is not looked for.
 */
const ALSO_USES = [
  ['Microsoft 365', (t, spf) => SPF_MICROSOFT.test(spf) || t.some((x) => /^MS=ms\d+/i.test(x)), /^Microsoft 365/],
  ['Google Workspace', (t, spf) => SPF_GOOGLE.test(spf), /^Google/],
  ['Apple', (t) => t.some((x) => /^apple-domain-verification=/i.test(x)), /^Apple/],
  ['Dropbox', (t) => t.some((x) => /^dropbox-domain-verification=/i.test(x))],
  ['Salesforce', (t, spf) => /include:(_spf\.salesforce\.com|aspmx\.pardot\.com)(?=\s|$)/i.test(spf)],
  ['Smartsheet', (t) => t.some((x) => /^smartsheet-site-validation=/i.test(x))],
  ['HubSpot', (t, spf) => /include:[^\s]*\.hubspotemail\.net(?=\s|$)/i.test(spf)],
  ['Atlassian', (t) => t.some((x) => /^atlassian-domain-verification=/i.test(x))],
  ['Zendesk', (t, spf) => /include:mail\.zendesk\.com(?=\s|$)/i.test(spf)],
];
function alsoUsesFrom(txt, mailHost) {
  const spf = spfOf(txt);
  return ALSO_USES.filter((a) => !(a[2] && a[2].test(mailHost || '')) && a[1](txt, spf)).map((a) => a[0]).join(', ');
}

function mailCheck(domain, ctx) {
  if (!domain) return { workspace: 'unknown', host: '', also: '' };
  if (ctx.mail[domain]) return ctx.mail[domain];
  let used = domain;
  let res = classifyMx(dohQuery(used, 'MX'));
  if (/^(No email set up|Domain not found)$/.test(res.host) && regDomain(domain) !== domain) { used = regDomain(domain); res = classifyMx(dohQuery(used, 'MX')); }
  const txt = /^(Domain not found|Could not look up mail records)$/.test(res.host) ? [] : txtStrings(dohQuery(used, 'TXT'));
  if (res.gateway && spfHasGoogle(txt)) res = { workspace: 'likely', host: 'Google behind a mail filter', gateway: true };
  else if (res.gateway && microsoftHint(txt)) res = { workspace: 'no', host: 'Microsoft 365 behind a mail filter', gateway: true };
  res = Object.assign({}, res, { also: alsoUsesFrom(txt, res.host) });
  ctx.mail[domain] = res;
  return res;
}

/** Only the "Also uses" part, for a business whose email address is a personal one but which has its own website. */
function alsoUsesOnly(domain, ctx) {
  if (!domain) return '';
  ctx.txt = ctx.txt || {};
  if (!(domain in ctx.txt)) ctx.txt[domain] = alsoUsesFrom(txtStrings(dohQuery(domain, 'TXT')), '');
  return ctx.txt[domain];
}

/* ---------- Companies House ---------- */

function chReq(path) {
  return { url: 'https://api.company-information.service.gov.uk' + path, opts: { headers: { Authorization: 'Basic ' + Utilities.base64Encode(prop('CH_KEY') + ':') } }, key: 'ch:' + path };
}

function chSearchPath(name) { return '/search/companies?items_per_page=8&q=' + encodeURIComponent(name); }

function chGet(path) {
  const key = prop('CH_KEY');
  if (!key) return { code: -1 };
  const q = chReq(path);
  const go = () => http(q.url, q.opts);
  let r = takePre(q.key) || go();
  if (r.code === 429) { Utilities.sleep(2500); r = go(); }
  let j = null;
  try { j = JSON.parse(r.body); } catch (e) { /* not json */ }
  return { code: r.code, json: j };
}

function chShape(c) {
  const a = c.registered_office_address || {};
  return {
    no: c.company_number, name: c.company_name || c.title || '', status: c.company_status || '', type: c.company_type || c.type || '',
    addr: clip(c.address_snippet || [a.address_line_1, a.locality, a.postal_code].filter(Boolean).join(', '), 120),
    pc: extractPostcodes(a.postal_code || (c.address || {}).postal_code || c.address_snippet)[0] || '',
  };
}

function chProfile(number) {
  const r = chGet('/company/' + encodeURIComponent(number));
  if (r.code === 200 && r.json) return chShape(r.json);
  if (r.code === 404) return null;
  throw new Error('Companies House answered ' + r.code);
}

function chSearch(name) {
  const r = chGet(chSearchPath(name));
  if (r.code !== 200 || !r.json) throw new Error('Companies House search answered ' + r.code);
  let best = null;
  const all = [];
  (r.json.items || []).forEach((it) => {
    const s = nameScore(name, it.title);
    const live = it.company_status === 'active' ? 0.05 : 0;
    const c = chShape(it);
    all.push({ raw: s, c });
    if (!best || s + live > best.score) best = { score: s + live, raw: s, c };
  });
  if (best) best.all = all;   // everything the search returned, for the postcode check
  return best;
}

/** The current directors (or LLP members) who are people, fetched once per company per run. Null when the register did not answer. */
function chOfficers(number, ctx) {
  const cache = ctx ? (ctx.officers = ctx.officers || Object.create(null)) : Object.create(null);
  if (cache[number]) return cache[number];
  const r = chGet('/company/' + encodeURIComponent(number) + '/officers?items_per_page=35');
  if (r.code === 404) return (cache[number] = []);
  if (r.code !== 200 || !r.json) return null;
  return (cache[number] = (r.json.items || []).filter((x) => !x.resigned_on && /director|llp-member|llp-designated-member/.test(String(x.officer_role || '')) && !/\b(ltd|limited|llp|plc|services|holdings)\b/i.test(x.name || '')).map(officerShape).filter(Boolean));
}

function chDirectorName(number, ctx) { const o = (chOfficers(number, ctx) || [])[0]; return o ? o.name : ''; }

/** Who can be emailed without asking first (PECR): companies and LLPs yes; Scottish partnerships yes; English limited partnerships no. */
function emailableFor(legal, status, type, number) {
  if (legal === 'verified') {
    if (String(status) !== 'active') return 'check';
    if (type === 'limited-partnership' && !/^SL/.test(String(number))) return 'consent';
    return 'corporate';
  }
  if (legal === 'likely' || legal === 'possible') return 'check';
  return 'consent';
}

/* ============================================================
 * Enrichment: one exhibitor
 * ============================================================ */

const COPY_FROM_DONOR = ['email', 'emailKind', 'emailSrc', 'contact', 'contactSrc', 'chDirector', 'companyNo', 'companyName', 'companyType', 'companyStatus', 'companyAddr', 'legal', 'legalSrc', 'emailable', 'workspace', 'mailHost', 'alsoUses'];

/** A finished row can stand in for another exhibitor on the same website, but only when it was properly read. */
function usableDonor(r) {
  return r.state === 'done' && r.domain && r.enrichedAt && r.legal === 'verified' && !CLOSED.test(String(r.companyStatus || '')) && /^((Company number|Legal name|Registered postcode) on its website|Company behind the brand|Copyright holder|Director|Same director as)/.test(r.legalSrc) &&
    !/not read|asks automated|did not respond|No website|Same website|Same exhibitor/i.test(r.note);
}

const COPY_COMPANY = ['legal', 'legalSrc', 'emailable', 'workspace', 'mailHost', 'alsoUses', 'companyNo', 'companyName', 'companyType', 'companyStatus', 'companyAddr', 'chDirector'];
const REUSED = /^Same (website|exhibitor)/;

/** Copies a finished lead's results onto this one. The company and what follows from it always come across as a set; email and contact only fill gaps. */
function applyDonor(ex, donor, patch) {
  COPY_FROM_DONOR.forEach((k) => { if (COPY_COMPANY.indexOf(k) >= 0 || !ex[k]) patch[k] = donor[k]; });
  if (!ex.phone && donor.phone) { patch.phone = donor.phone; patch.phoneSrc = donor.phoneSrc; }
}

/** Same business in another exhibition of the same sector: the key is the sector plus the name without Ltd, The and punctuation. */
function nameKeyFor(ctx, r) {
  const s = ctx.shows && ctx.shows[r.showId];
  const k = normKey(r.name);
  return s && k.length >= 3 ? String(s.sector || '').toLowerCase() + '|' + k : '';
}

function registerDonor(ctx, r) {
  if (!ctx.donors) return;
  if (usableDonor(r)) {
    const old = ctx.donors[r.domain];
    if (!old || old.enrichedAt < r.enrichedAt) ctx.donors[r.domain] = r;
  }
  if (ctx.names && r.state === 'done' && r.enrichedAt && r.legal) {
    const k = nameKeyFor(ctx, r);
    if (k) {
      const list = ctx.names[k] = (ctx.names[k] || []).filter((x) => x.id !== r.id);
      list.push(r);
    }
  }
}

/** Reads the sheet once for this run, so finished leads can stand in for others. */
function loadDonors(ctx) {
  if (ctx.donors && ctx.names) return;
  ctx.donors = ctx.donors || {};
  ctx.names = {};
  ctx.shows = {};
  readTab('Shows', SHOW_COLS).forEach((s) => { ctx.shows[s.id] = s; });
  readTab('Exhibitors', EX_COLS).forEach((r) => registerDonor(ctx, r));
}

function donorFor(domain, selfId, ctx) {
  loadDonors(ctx);
  const d = ctx.donors[domain];
  return d && d.id !== selfId ? d : null;
}

/**
 * The same exhibitor already checked under another exhibition in this sector. The websites must not differ (a different
 * website means a different business that happens to share a name). A properly confirmed company is always borrowed; a weaker
 * result only by a lead that has not been checked yet, so rechecking never settles for someone else's weak answer.
 */
function nameDonorFor(ex, ctx) {
  loadDonors(ctx);
  const list = ctx.names[nameKeyFor(ctx, ex)];
  if (!list) return null;
  const dom = siteDomain(ex.website);
  let best = null, bestRank = -1;
  list.forEach((d) => {
    if (d.id === ex.id || (dom && d.domain && dom !== d.domain)) return;
    const strong = d.legal === 'verified' && !CLOSED.test(String(d.companyStatus || ''));   // a closed company is as weak as a guess
    if (!strong && ex.legal) return;
    const rank = (strong ? 4 : 0) + (REUSED.test(d.note) ? 0 : 2) + (d.domain ? 1 : 0);
    if (rank > bestRank || (rank === bestRank && d.enrichedAt > best.enrichedAt)) { best = d; bestRank = rank; }
  });
  return best;
}

function enrichOne(ex, ctx) {
  const notes = [];
  const patch = {};
  let site = ex.website;
  let late = false;   // set when this exhibitor used up its time allowance and some pages were skipped
  const why = ctx.why = [];   // what this check read and decided, in plain words (shown by "Why this result?")
  _pre = {};
  _cat = 'detail';

  // 0. The same exhibitor (same name, same sector, no different website) already checked under another exhibition: reuse it,
  //    without a single web request. A lead you confirmed yourself, or one already confirmed, is left to its own check.
  if (ex.legalSrc !== 'Confirmed by you' && (ex.legal !== 'verified' || CLOSED.test(String(ex.companyStatus || '')))) {
    const nd = nameDonorFor(ex, ctx);
    const dom0 = siteDomain(ex.website);
    // a website we already know that has been read properly is the better evidence than a weak result under the same name
    const ndStrong = nd && nd.legal === 'verified' && !CLOSED.test(String(nd.companyStatus || ''));
    if (nd && !(!ndStrong && dom0 && donorFor(dom0, ex.id, ctx))) {
      const patch0 = {};
      applyDonor(ex, nd, patch0);
      if (!ex.website && nd.website) { patch0.website = nd.website; patch0.domain = nd.domain; }
      const showName = (ctx.shows[nd.showId] || {}).name || 'another exhibition';
      const was = nd.legal === 'verified' ? '' : String(nd.note || '').replace(/^Same (website|exhibitor)[^.]*(\.\s*|$)/, '');
      patch0.state = 'done'; patch0.enrichedAt = nowIso();
      patch0.note = clip('Same exhibitor as in ' + showName + ', so its results were reused' + (was ? '. ' + was : ''), 240);
      say0(ctx, 'Same name and sector as the lead in ' + showName + (nd.legal === 'verified' ? ', which is confirmed' : ', not yet confirmed') + ': results reused, no pages read');
      return patch0;
    }
  }

  // 1. Some directories only link to a page per exhibitor: read it to find the website.
  if (!site && ex.detailUrl) {
    const d = fetchPage(ex.detailUrl, ctx);
    if (d.late) late = true;
    else if (d.blocked) notes.push(d.down ? 'Could not check whether the show site allows reading its exhibitor pages' : 'The show site asks automated tools not to read exhibitor pages');
    else if (d.body && d.code >= 200 && d.code < 300) {
      const det = parseDetail(d.body, d.url);
      if (det.website) { site = det.website; patch.website = site; patch.domain = siteDomain(site); }
      if (why.length < 70) why.push('Show page ' + d.url + (det.website ? ' gave the website ' + det.website : ' has no website on it'));
      if (det.phone && !ex.phone) { patch.phone = det.phone; patch.phoneSrc = 'show page'; }
    } else notes.push('Could not read the exhibitor page on the show site');
  }
  const domain0 = siteDomain(site);
  if (domain0) patch.domain = domain0;
  const domain = domain0 && !MARKET_HOSTS.test(domain0) ? domain0 : '';
  if (domain0 && !domain) { notes.push('Its web address is a marketplace or social media page, not its own website, so it was not read'); say0(ctx, 'Not read: ' + domain0 + ' is a marketplace or social media site, not its own website'); }

  // 2. Same website already checked (another stand, or another show): reuse it.
  const donor = domain ? donorFor(domain, ex.id, ctx) : null;
  if (donor && ex.legalSrc !== 'Confirmed by you' && placesIn(ex.name).sort().join() === placesIn(donor.name).sort().join()) {
    applyDonor(ex, donor, patch);
    patch.state = 'done'; patch.enrichedAt = nowIso(); patch.note = 'Same website as another exhibitor, so its results were reused';
    return patch;
  }

  // 3. Read the website: the home page, then a contact page if there is no email yet, then its terms and privacy
  //    pages until one gives a company number or names the company behind the site (they nearly always do).
  //    Pages are fetched together where they do not depend on each other, which is where most of the time goes.
  let emails = [], phones = [], person = '';
  const cands = [];     // company numbers written on its own pages: { n, text }
  const names = [];     // company names it writes down, such as "Ickle Bubba Ltd"
  const pcs = [];       // postcodes on its pages
  const owners = [];    // the company behind the brand, where a page says so: { name, kind }
  const texts = [];     // the text of every page read, to look for its directors' names
  let textLen = 0, siteName = '', homeText = '';
  const tried = {};
  const seen = [];      // every page asked for: { url, ok, why, gone }, for the trace and the note
  let noneNoted = false;   // the note already says nothing was found
  const say = (line) => { if (why.length < 70) why.push(clip(line, 400)); };
  const strong = () => cands.length > 0 || names.length > 0;
  // A legal name counts only if it shares enough of the exhibitor's own name: two words when the name has two or more
  // (so a partner's "Little Angels Nursery Ltd" is not taken for "Little Dreamers"), otherwise the one word it has.
  const exKeys = normKey(ex.name).split(' ').filter(Boolean);
  const nameFits = (n) => normKey(n).split(' ').filter((t) => exKeys.indexOf(t) >= 0).length >= Math.min(2, exKeys.length);
  const scan = (pg) => {
    const sc = scanPage(pg.body, pg.url);
    sc.names = legalNameStatements(sc.text, ex.name);
    sc.owners = ownerStatements(sc.text, ownKeys(ex.name, siteName || sc.siteName, domain)).concat(addressedNames(sc.text, ex.name).map((n) => ({ name: n, kind: 'address' })), sc.dataNames.map((n) => ({ name: n, kind: 'data' })));
    return sc;
  };
  const addPage = (sc) => {
    sc.emails.forEach((e) => { if (!emails.some((x) => x.email === e.email)) emails.push(e); });
    sc.phones.forEach((q) => { if (phones.indexOf(q) < 0) phones.push(q); });
    sc.numbers.forEach((n) => { if (!cands.some((c) => c.n === n)) cands.push({ n, text: sc.text }); });
    sc.dataNumbers.forEach((n) => { if (!cands.some((c) => c.n === n)) cands.push({ n, text: sc.text, sd: true }); });
    sc.names.forEach((n) => { if (nameFits(n) && !names.some((x) => normKey(x) === normKey(n))) names.push(n); });
    sc.postcodes.forEach((c) => { if (pcs.indexOf(c) < 0) pcs.push(c); });
    sc.owners.forEach((o) => { if (!owners.some((x) => normKey(x.name) === normKey(o.name))) owners.push(o); });
    if (textLen < 400000) { texts.push(sc.text); textLen += sc.text.length; }
    if (!person && sc.person) person = sc.person;
  };
  // What happened to a page, for the trace and for the note on the lead.
  const record = (pg, sc) => {
    const w = pageWhy(pg, ctx);
    seen.push({ url: pg.url, ok: !w, why: w, gone: pg.code === 404 || pg.code === 410, late: !!pg.late });
    if (w) { say('Could not read ' + pg.url + ': ' + w); return; }
    const bits = [];
    if (sc.numbers.length || sc.dataNumbers.length) bits.push('company number ' + sc.numbers.concat(sc.dataNumbers).join(', '));
    if (sc.names.length) bits.push('names ' + sc.names.join('; '));
    if (sc.owners.length) bits.push('company behind it ' + sc.owners.map((o) => o.name).join('; '));
    if (sc.postcodes.length) bits.push('postcodes ' + sc.postcodes.slice(0, 4).join(', '));
    say('Read ' + pg.url + ' · ' + pg.code + ' · ' + kb(pg.size || pg.body.length) + ' · ' + (bits.length ? bits.join(' · ') : 'no company details on it'));
  };
  // Reads these pages together, then takes them in order, stopping once one has settled which company it is
  // (the same result as reading them one at a time, only quicker).
  const readMany = (urls) => {
    const todo = urls.filter((u) => !tried[u]);
    todo.forEach((u) => { tried[u] = 1; });
    if (!todo.length) return;
    _cat = 'pages';
    const pgs = fetchPages(todo, ctx, 3);
    for (let i = 0; i < pgs.length; i++) {
      const pg = pgs[i];
      if (pg.late) { late = true; record(pg); continue; }
      if (pg.blocked || !pg.body || pg.code < 200 || pg.code >= 300) { record(pg); continue; }
      const sc = scan(pg);
      record(pg, sc);
      addPage(sc);
      if (strong()) { for (let j = i + 1; j < pgs.length; j++) say('Fetched with it, not needed: ' + pgs[j].url); break; }
    }
  };
  say('Checking ' + ex.name + (site ? ' · ' + site : ' · no website yet'));
  if (domain) {
    _cat = 'site';
    const wantCh = ex.legalSrc !== 'Confirmed by you' && !!prop('CH_KEY');
    const side = [dohReq(domain, 'MX'), dohReq(domain, 'TXT')].concat(wantCh ? [chReq(chSearchPath(ex.name))] : []);
    const hp = fetchPages([site + '/'], ctx, undefined, side);
    hp.side.forEach((r, i) => { _pre[side[i].key] = r; });
    const home = hp[0];
    if (home.late) { late = true; record(home); }
    else if (home.blocked) { notes.push(home.down ? 'Website did not respond, so it was not read' : 'Site asks automated tools not to read it'); record(home); }
    else if (home.code >= 200 && home.code < 300 && home.body) {
      const pageHost = (parseUrl(home.url) || {}).host;
      tried[home.url] = 1;
      const s = scan(home);
      record(home, s);
      addPage(s);
      siteName = s.siteName; homeText = s.text.slice(0, 20000);
      if (s.textLen < 200) notes.push('Site loads its content with JavaScript, so little could be read');
      const list = [];
      const contactFirst = !emails.length && !!s.links.contact;
      if (contactFirst) list.push(s.links.contact);
      if (!strong() && wantCh) {
        // its own links to terms and privacy first, then its contact page (often the address and the people behind it),
        // then the usual addresses for the kind of site it is, then its other policy pages
        const origin = originOf(home.url);
        const guesses = s.links.core === 0 ? 5 : s.links.core === 1 ? 3 : 0;
        s.links.legal.slice(0, 2).forEach((u) => list.push(u));
        if (!contactFirst && s.links.contact) list.push(s.links.contact);
        s.links.legal.slice(2, 4).forEach((u) => list.push(u));
        (PLATFORM_GUESSES[s.platform] || []).concat(LEGAL_GUESSES).slice(0, guesses).forEach((g) => list.push(origin + g));
        if (s.platform === 'shopify' && guesses < 2) list.push(origin + '/policies/contact-information');   // Shopify's business details page, seldom linked
        s.links.legal.slice(4).forEach((u) => list.push(u));
      }
      const once = {}, todoList = list.filter((u) => { const k = pathOf(u).replace(/\/+$/, '').toLowerCase(); if (once[k] || k === '' || tried[u]) return false; once[k] = 1; return true; }).slice(0, EXTRA_PAGES);
      if (s.platform) say('Looks like a ' + s.platform + ' site');
      // two at a time: the first two (privacy and terms, nearly always) usually settle it, so the rest are only read if they do not
      for (let i = 0; i < todoList.length && !late; i += PAGE_PAIR) { if (i > 0 && strong()) break; readMany(todoList.slice(i, i + PAGE_PAIR)); }
      if (pageHost && emails.length === 0 && !cands.length && s.textLen >= 200) { notes.push('No email or company number found on the pages read'); noneNoted = true; }
    } else { notes.push('Website did not open' + (home.code ? ' (' + home.code + ')' : '')); record(home); }
  } else if (!site && !late) { notes.push('No website'); say('No website to read'); }

  // 4. Phone, email, contact. Anything already there (typed by you, or from the show) is kept.
  if (!ex.phone && phones[0]) { patch.phone = phones[0]; patch.phoneSrc = 'website'; }
  let email = ex.email, kind = ex.emailKind, esrc = ex.emailSrc;
  if (!email) {
    const pick = pickEmail(emails, domain);
    if (pick) { email = pick.email; kind = pick.kind; esrc = 'website'; patch.email = email; patch.emailKind = kind; patch.emailSrc = esrc; }
  } else if (!kind) { patch.emailKind = FREEMAIL.test(emailDomain(email)) ? 'freemail' : GENERIC_LOCAL.test(email.split('@')[0]) ? 'generic' : 'named'; }
  if (!ex.contact && person) { patch.contact = person; patch.contactSrc = 'website structured data'; }

  // 5. Who runs the mailboxes.
  _cat = 'dns';
  const mailDom = email && !FREEMAIL.test(emailDomain(email)) ? emailDomain(email) : domain;
  if (email && FREEMAIL.test(emailDomain(email))) { patch.workspace = 'no'; patch.mailHost = 'Personal email address'; patch.alsoUses = alsoUsesOnly(mailDom, ctx); }
  else if (mailDom) { const mc = mailCheck(mailDom, ctx); patch.workspace = mc.workspace; patch.mailHost = mc.host; patch.alsoUses = mc.also; }
  else { patch.workspace = 'unknown'; patch.mailHost = ''; patch.alsoUses = ''; }
  if (mailDom) say('Mail for ' + mailDom + ': ' + (patch.mailHost || 'not known') + (patch.alsoUses ? '. Also uses: ' + patch.alsoUses : '. No other services found in its domain records'));

  // 6. Companies House.
  _cat = 'ch';
  if (ex.legalSrc === 'Confirmed by you') {
    patch.emailable = emailableFor(ex.legal, ex.companyStatus, ex.companyType, ex.companyNo);
  } else if (!prop('CH_KEY')) {
    patch.legal = 'none'; patch.legalSrc = ''; patch.emailable = 'consent';
    notes.push('Companies House key not set, so company status was not checked');
  } else {
    try {
      let co = null, how = '', legal = 'none';
      const looked = Object.create(null);
      const lookup = (q) => {
        const k = normKey(q);
        if (!(k in looked)) {
          const h = chSearch(k === normKey(ex.name) ? ex.name : q);
          looked[k] = h;
          say('Companies House search for “' + q + '”: ' + (h ? h.c.name + ' (' + h.c.no + ', ' + (h.c.status || '?') + ', ' + (h.c.pc || 'no postcode') + '), name match ' + Math.round(h.raw * 100) + '%' : 'nothing found'));
        }
        return looked[k];
      };   // one search per name
      // A postcode on its pages counts only where few companies are registered (not a formation agent's or virtual office's address).
      const pcOk = (pc) => {
        if (!pc || pcs.indexOf(pc) < 0) return false;
        if (!postcodeShared(pc, ctx)) return true;
        say(pc + ' is on its pages, but it is a shared address where many companies are registered, so it proves nothing');
        return false;
      };
      // Evidence, strongest first. Anything weaker than these leaves the lead as "to check" for you to decide.
      //  1. a company number on its own pages that the register has, under a name that fits
      if (cands.length) { co = verifyCandidates(cands, ex.name, say); if (co) { legal = 'verified'; how = 'Company number on its website'; } }
      //  2. its pages name the company behind the site ("We are X Ltd") and the register holds exactly that name, once.
      //     A company name written on its own website is taken at its word: no postcode or address has to match.
      //     When the page ran the brand into it ("Venicci UK & Ireland MAGICBABY LTD"), the company part is tried too.
      const stated = (n) => {
        let c = exactCompany(lookup(n), n), said = n;
        const core = c ? '' : coreName(n, ex.name);
        if (core) { c = exactCompany(lookup(core), core); said = core; }
        return c ? { c, said } : null;
      };
      if (!co) {
        for (let i = 0; i < names.length && i < 2 && !co; i++) {
          const f = stated(names[i]);
          if (f) { co = f.c; legal = 'verified'; how = 'Legal name on its website: ' + f.said; }
        }
      }
      //  2b. its pages name the company behind the brand ("a trading name of Y Ltd", "© 2026 Y Ltd", a legalName in its data),
      //      and the register holds exactly that name, once
      const OWNER_HOW = { brand: 'Company behind the brand on its website: ', address: 'Legal name on its website: ', copyright: 'Copyright holder on its website: ', data: 'Legal name on its website (structured data): ' };
      const RANK = { brand: 0, address: 1, data: 2, copyright: 3 };
      const own = owners.filter((o) => !names.some((n) => normKey(n) === normKey(o.name) || normKey(coreName(n, ex.name)) === normKey(o.name)))
        .sort((a, b) => RANK[a.kind] - RANK[b.kind]);
      if (!co) {
        for (let i = 0; i < own.length && i < 3 && !co; i++) {
          const f = stated(own[i].name);
          if (f) { co = f.c; legal = 'verified'; how = OWNER_HOW[own[i].kind] + f.said; }
        }
      }
      let conflict = false;
      if (!co) {
        const hit = lookup(ex.name);
        if (hit && hit.raw >= 0.6) {
          co = hit.c; legal = hit.raw >= 1 && co.status === 'active' ? 'likely' : 'possible'; how = hit.raw >= 1 ? 'Same name on Companies House' : 'Similar name on Companies House';
          //  3. the registered office postcode is written on its own pages, beside a name that fits
          if (pcOk(co.pc)) { legal = 'verified'; how = 'Registered postcode on its website matches: ' + co.pc; }
          else {
            //  otherwise say if its pages name a different company from the one the register gave. That is no longer "likely":
            //  the business seems to trade as another legal entity, so it is left for you to decide rather than offered for bulk confirming
            const named = names.concat(own.map((o) => o.name));
            if (named.length && !named.some((n) => nameScore(n, co.name) >= 0.9)) {
              how += '. Its website names ' + named[0] + ', which is not the name on this record';
              if (legal === 'likely') legal = 'possible';
              conflict = true;
            }
            if (co.pc && pcs.length) how += '. Postcodes on its pages: ' + pcs.slice(0, 2).join(', ') + '. The register has ' + co.pc;
          }
        }
      }
      //  3b. none of that settled it, but another company the search returned is registered at a postcode written on its pages
      if (legal !== 'verified' && pcs.length) {
        const first = looked[normKey(ex.name)] || null;
        const alt = first ? first.all.filter((x) => x.c.pc && pcs.indexOf(x.c.pc) >= 0 && x.raw >= 0.6).sort((a, b) => b.raw - a.raw)[0] : null;
        if (alt && pcOk(alt.c.pc)) { co = alt.c; legal = 'verified'; how = 'Registered postcode on its website matches: ' + co.pc; say('Another company in the search results is registered at ' + co.pc + ', which is written on its pages: ' + co.name); }
      }
      //  4. a company whose name fits closely, backed by its directors: one named on its pages as the person behind it, as its contact,
      //     or in an email address on its own domain, or a director's postcode on its pages. If the exhibitor's own name finds none,
      //     the other names it goes by are searched too. This only ever confirms a company: a name nothing backs up is left as it was.
      if (legal !== 'verified' && !conflict) {
        const ownDomains = [domain, mailDom].filter(Boolean);
        const ev = {
          sentences: sentencesFor(texts, [ex.name, siteName]),
          people: [ex.contact, patch.contact, person].filter(Boolean).map(personKey).filter((p) => p.indexOf(' ') > 0),
          locals: [ex.email, email].concat(emails.filter((e) => ownDomains.indexOf(emailDomain(e.email)) >= 0).map((e) => e.email)).filter(Boolean)
            .map((e) => String(e).split('@')[0].toLowerCase()).filter((l) => !GENERIC_LOCAL.test(l)).map((l) => l.replace(/[^a-z]/g, '')).filter((l) => l.length >= 5),
          pcs,
        };
        const pool = [], done = Object.create(null);
        let officerLooks = 0;
        const fromSearch = (h, via) => (h ? h.all : []).filter((x) => x.raw >= 0.75).sort((a, b) => b.raw - a.raw).forEach((x) => { if (!pool.some((p) => p.c.no === x.c.no)) pool.push({ c: x.c, raw: x.raw, via }); });
        const tryPool = () => {
          for (const p of pool) {
            if (done[p.c.no]) continue;
            done[p.c.no] = 1;
            const tail = p.via ? ' (found by searching “' + p.via + '”)' : '';
            if (p.via && pcOk(p.c.pc)) return { c: p.c, how: 'Registered postcode on its website matches: ' + p.c.pc + tail };
            if (officerLooks >= 3) continue;
            officerLooks++;
            const offs = chOfficers(p.c.no, ctx);
            if (!offs) { say('Directors of ' + p.c.name + ' (' + p.c.no + ') could not be fetched from Companies House just now'); continue; }
            let d = directorEvidence(offs, ev, p.c.name);
            if (d && d.kind === 'dirpost' && !pcOk(d.pc)) d = null;
            say('Directors of ' + p.c.name + ' (' + p.c.no + '): ' + (offs.length ? offs.slice(0, 4).map((o) => o.name).join(', ') : 'none listed') + '. ' + (d ? d.how : 'None of them is named on its pages as the person behind it, as its contact or in its email, and none of their postcodes counts'));
            if (d) return { c: p.c, how: d.how + tail };
          }
          return null;
        };
        fromSearch(looked[normKey(ex.name)], '');
        let found = tryPool();
        if (!found) {
          const vars = searchVariants(ex.name, siteName, domain, homeText).filter((v) => !(normKey(v) in looked)).slice(0, 2);
          if (vars.length) say('Searching Companies House for the other names it goes by: ' + vars.map((v) => '“' + v + '”').join(', '));
          vars.forEach((v) => {
            try { fromSearch(lookup(v), v); } catch (err) { say('Companies House search for “' + v + '” did not answer: ' + clip(String((err && err.message) || err), 60)); }   // an extra search never fails the check
          });
          found = tryPool();
        }
        if (found) { co = found.c; legal = 'verified'; how = found.how; }
      }
      //  4b. The company it landed on has closed (dissolved, in liquidation). An active company registered at the same postcode whose
      //      name shares a word with the business is most likely the one it trades through now. Confirmed when that postcode is on its
      //      pages, or when a director of the closed company is a director of the new one too; otherwise offered for you to decide.
      //      Only after the closed company was confirmed from its own website: a closed company found by its name alone may not be this
      //      business at all. The postcode only says where the business is, and many owners go back to trading on their own, so the
      //      new company is confirmed only when a director of the closed one is a director of it too. Otherwise it is offered.
      if (co && legal === 'verified' && !conflict && CLOSED.test(String(co.status || ''))) {
        const old = co, gone = closedWord(old.status);
        const nu = activeSuccessor(old, ex.name, ctx, say);
        if (nu) {
          const a = chOfficers(old.no, ctx), b = chOfficers(nu.no, ctx);
          const both = a && b ? a.filter((o) => b.some((p) => p.last === o.last && p.first === o.first))[0] : null;
          say(both ? both.name + ' is a director of both' : a && b ? 'No director of ' + old.name + ' is a director of ' + nu.name : 'The directors could not be fetched from Companies House just now');
          co = nu;
          if (both) { legal = 'verified'; how = 'Same director as ' + old.name + ', now ' + gone + ', and registered at the same postcode (' + nu.pc + '): ' + both.name; }
          else { legal = 'possible'; how = 'Active company registered at the same postcode as ' + old.name + ', now ' + gone + ' (' + nu.pc + '). No director in common, so it may not be the same business'; }
        }
      }
      //  5. A franchise class or a branch ("Baby Sensory Kent") often shows the franchisor's or head office's details. If its listed name
      //     adds a place the company's name lacks, or its site says it is a franchise or independently owned, a match by name, director
      //     or postcode is left for you to decide. A company number on its own pages still stands, unless both signs are there.
      if (co && legal === 'verified') {
        const extra = extraPlaces(ex.name, co.name), fr = FRANCHISEE.test(texts.join(' '));
        if (how === 'Company number on its website' ? extra.length && fr : extra.length || fr) {
          const why = extra.length ? 'its listed name adds “' + extra.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') + '”, which the company name does not have' : 'its website says it is a franchise or independently owned';
          say('Not confirmed: ' + why + ', so ' + co.name + ' may be the franchisor or head office');
          legal = 'possible'; how = 'May be a franchise or branch: ' + why + '. Found: ' + how;
        }
      }
      if (co) {
        patch.companyNo = co.no; patch.companyName = co.name; patch.companyType = co.type; patch.companyStatus = co.status; patch.companyAddr = co.addr;
        patch.legal = legal; patch.legalSrc = how; patch.emailable = emailableFor(legal, co.status, co.type, co.no);
        say('Result: ' + legal + '. ' + how);
        if (legal !== 'possible') patch.chDirector = chDirectorName(co.no, ctx);
        if (legal === 'verified' && !ex.contact && !patch.contact && patch.chDirector) { patch.contact = patch.chDirector; patch.contactSrc = 'Companies House director'; }
      } else {
        Object.assign(patch, { companyNo: '', companyName: '', companyType: '', companyStatus: '', companyAddr: '', chDirector: '', legal: 'none', legalSrc: 'No company found', emailable: 'consent' });
        say('Result: no company found');
      }
    } catch (err) {
      notes.push(String((err && err.message) || err));
      patch.legal = ex.legal || 'none'; patch.emailable = ex.emailable || 'consent';
      patch.state = 'error';
    }
  }
  if (FREEMAIL.test(emailDomain(email || '')) && patch.emailable === 'consent') notes.push('Personal email address, which often means a sole trader');
  // For a lead that is still unconfirmed, say what was read, so it is clear whether the evidence was missing or just out of reach.
  // Pages that simply do not exist (a guessed address) are not worth mentioning.
  if (patch.legal && patch.legal !== 'verified' && ex.legalSrc !== 'Confirmed by you') {
    const okN = seen.filter((x) => x.ok).length;
    if (okN) {
      const out = seen.filter((x) => !x.ok && !x.gone && !x.late).slice(0, 3).map((x) => pathOf(x.url).replace(/\/+$/, '').split('/').pop() + ' (' + (/could not be fetched/.test(x.why) ? 'robots.txt unreachable' : /robots/.test(x.why) ? 'robots.txt says no' : (/answered (\d+)/.exec(x.why) || [])[1] || clip(x.why, 24)) + ')');
      notes.push('Read ' + okN + (okN === 1 ? ' page' : ' pages') + (cands.length || names.length || noneNoted ? '' : ' and found no company number or legal name') + (out.length ? '. Could not read ' + out.join(', ') : ''));
    }
  }
  if (late) notes.push(LATE_NOTE);
  patch.note = notes.join('. ');
  if (patch.state !== 'error') patch.state = 'done';
  patch.enrichedAt = nowIso();
  return patch;
}

/* ============================================================
 * Sheet access
 * ============================================================ */

let _ss = null;

function db() {
  if (_ss) return _ss;
  let ss = null;
  const id = prop('SHEET_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) { ss = SpreadsheetApp.create('Exhibitor Leads data'); setProp('SHEET_ID', ss.getId()); }
  [['Shows', SHOW_COLS], ['Exhibitors', EX_COLS]].forEach((t) => {
    if (ss.getSheetByName(t[0])) return;
    const sh = ss.insertSheet(t[0]);
    sh.getRange(1, 1, sh.getMaxRows(), t[1].length).setNumberFormat('@');   // plain text, so 01234567 stays as typed and nothing becomes a formula
    sh.getRange(1, 1, 1, t[1].length).setValues([t[1]]);
    sh.setFrozenRows(1);
  });
  const first = ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1) ss.deleteSheet(first);
  if (prop('EX_COLS') !== String(EX_COLS.length)) { ensureCols(ss.getSheetByName('Exhibitors'), EX_COLS); setProp('EX_COLS', String(EX_COLS.length)); }
  _ss = ss;
  return ss;
}

/** A sheet made by an older release lacks the newest columns: add them on the end, with their heading, as plain text. */
function ensureCols(sh, cols) {
  const have = sh.getMaxColumns();
  if (have < cols.length) sh.insertColumnsAfter(have, cols.length - have);
  const head = sh.getRange(1, 1, 1, cols.length).getValues()[0];
  cols.forEach((c, i) => {
    if (String(head[i] || '') !== '') return;
    sh.getRange(1, i + 1, sh.getMaxRows(), 1).setNumberFormat('@');
    sh.getRange(1, i + 1, 1, 1).setValues([[c]]);
  });
}

function cell(v) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return v == null ? '' : String(v);
}

function readTab(name, cols) {
  const sh = db().getSheetByName(name);
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, cols.length).getValues().map((r, i) => {
    const o = { _row: i + 2 };
    cols.forEach((c, j) => { o[c] = cell(r[j]); });
    return o;
  });
}

function appendObjs(name, cols, objs) {
  if (!objs.length) return;
  const sh = db().getSheetByName(name);
  const rows = objs.map((o) => cols.map((c) => (o[c] == null ? '' : String(o[c]))));
  const need = sh.getLastRow() + rows.length;
  if (sh.getMaxRows() < need) { sh.insertRowsAfter(sh.getMaxRows(), need - sh.getMaxRows() + 200); sh.getRange(2, 1, sh.getMaxRows() - 1, cols.length).setNumberFormat('@'); }
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, cols.length).setValues(rows);
}

function writeObj(name, cols, o) {
  db().getSheetByName(name).getRange(o._row, 1, 1, cols.length).setValues([cols.map((c) => (o[c] == null ? '' : String(o[c])))]);
}

function deleteRowNumbers(name, nums) {
  const sh = db().getSheetByName(name);
  nums.slice().sort((a, b) => b - a).forEach((n) => sh.deleteRow(n));
}

/* ============================================================
 * Actions
 * ============================================================ */

function counts(rows) {
  const c = { total: rows.length, done: 0, corporate: 0, consent: 0, check: 0, google: 0, microsoft: 0, pending: 0 };
  rows.forEach((r) => {
    if (r.state === 'done' || r.state === 'error') {
      c.done++;
      if (r.emailable === 'corporate') c.corporate++; else if (r.emailable === 'check') c.check++; else c.consent++;
      if (r.workspace === 'yes' || r.workspace === 'likely') c.google++;
      else if (/^Microsoft 365/.test(r.mailHost)) c.microsoft++;
    } else c.pending++;
  });
  return c;
}

function pubShow(s) { const o = {}; SHOW_COLS.forEach((c) => { o[c] = s[c]; }); o.urls = String(s.urls || '').split(/\s+/).filter(Boolean); return o; }
function pubEx(r) { const o = {}; EX_COLS.forEach((c) => { if (c !== 'detailUrl') o[c] = r[c]; }); o.blurb = String(r.blurb || '').slice(0, 200); return o; }

function ping() { return { ok: true, v: VERSION, build: BUILD }; }

/* ---------- Notifications through ntfy: a message on the phone every time a check finishes ----------
 * The message goes to ntfy by email, to ntfy-<your code>@ntfy.sh: ntfy makes the subject the title and the body the message.
 * It is not sent to ntfy's web address. ntfy.sh limits web requests per sending address, and Google's servers share their
 * addresses with a great many other scripts, so a web request from here is nearly always turned away (HTTP 429).
 * Mail leaves through Gmail's own servers and gets through. ntfy cannot read a priority, tags or a tap-through link from an email,
 * so the link to the exhibition goes in the message text. */

const NTFY_MAIL = 'ntfy.sh';

function notifyInfo() {
  const t = prop('NTFY_TOPIC'), o = { on: !!t, topic: t, click: !!prop('NTFY_URL') };
  let last = null; try { last = JSON.parse(prop('NTFY_LAST') || 'null'); } catch (e) { last = null; }
  if (t && last && typeof last === 'object') o.last = last;   // what the last send did: a background run has no screen to tell you
  return o;
}

/** Keeps the outcome of the last message (a test or a finished check) so Settings can show it. */
function noteNotify(kind, show, r) {
  try { setProp('NTFY_LAST', JSON.stringify({ at: nowIso(), kind, show: clip(String(show || ''), 60), ok: !!r.ok, error: r.ok ? '' : clip(String(r.error || ''), 200) })); } catch (e) { /* best effort */ }
}

/** The address of the app, without anything after it, for the notification to open. Empty if it is not a plain https address. */
function cleanAppUrl(u) {
  const p = parseUrl(u);
  return p && p.scheme === 'https' && isPublicHost(p.host) && String(u).length <= 300 ? 'https://' + p.host + (p.port ? ':' + p.port : '') + p.path : '';
}

/** Stores the notification code (the ntfy topic) the phone subscribed to, or switches notifications off. */
function setNotify(p) {
  const props = PropertiesService.getScriptProperties();
  if (p.off) { props.deleteProperty('NTFY_TOPIC'); props.deleteProperty('NTFY_URL'); props.deleteProperty('JOBS'); props.deleteProperty('NTFY_SIG'); props.deleteProperty('NTFY_LAST'); return notifyInfo(); }
  const topic = String(p.topic || '').trim();
  if (!/^[A-Za-z0-9_-]{12,64}$/.test(topic)) throw new Error('That notification code does not look right');
  setProp('NTFY_TOPIC', topic);
  const url = cleanAppUrl(p.url);
  if (url) setProp('NTFY_URL', url); else props.deleteProperty('NTFY_URL');
  return notifyInfo();
}

/** What went wrong with an email, in words for the phone. */
function mailError(e) {
  const m = String((e && e.message) || e || '');
  if (/permission|authori[sz]/i.test(m)) return 'Apps Script needs your approval to send email. In Apps Script choose authorise, press Run and approve (the README says how)';
  if (/too many times|quota|limit/i.test(m)) return 'Google has stopped this script sending email for today (its daily limit). It starts again tomorrow';
  return 'The email was not sent (' + clip(m.replace(/^Exception:\s*/i, ''), 80) + ')';
}

/** Sends one message to the notification code by email. Never throws: a failed notification must not get in the way of the checks. */
function sendNtfy(title, message, link) {
  const topic = prop('NTFY_TOPIC');
  if (!topic) return { ok: false, error: 'Set up notifications first' };
  const body = String(message || '') + (link ? '\n\n' + link : '');
  try {
    MailApp.sendEmail({ to: 'ntfy-' + topic + '@' + NTFY_MAIL, subject: String(title || '').replace(/\s+/g, ' ').trim() || 'Exhibitor Leads', body, name: 'Exhibitor Leads' });
    return { ok: true };
  } catch (e) {
    Logger.log('notify: ' + e);
    return { ok: false, error: mailError(e) };
  }
}

function testNotify() {
  if (!prop('NTFY_TOPIC')) throw new Error('Set up notifications first');
  const r = sendNtfy('Exhibitor Leads is connected', 'You will get a message here every time a check finishes.', prop('NTFY_URL'));
  noteNotify('test', '', r);
  if (!r.ok) throw new Error(r.error);
  return { sent: true };
}

/** Run once from the editor after pasting release 10: Google asks you to let this script send email as you. Safe to run again. */
function authorise() {
  Logger.log('Email permission: OK. This script can send ' + MailApp.getRemainingDailyQuota() + ' more emails today.');
}

/** "Baby & Toddler Show: all 120 checked. 34 can email, 29 to check, 57 need consent. 9 sites wouldn’t open." */
function finishedMessage(show, rows) {
  const c = counts(rows), sites = reachInfo(rows).sites;
  const parts = [c.corporate + ' can email'];
  if (c.check) parts.push(c.check + ' to check');
  if (c.consent) parts.push(c.consent + ' ' + (c.consent === 1 ? 'needs' : 'need') + ' consent');
  return show.name + ': all ' + c.total + ' checked. ' + parts.join(', ') + '.' + (sites ? ' ' + sites + (sites === 1 ? ' site' : ' sites') + ' wouldn’t open.' : '');
}

/**
 * Called at the end of every run with how many exhibitors it finished in each exhibition. When an exhibition has nothing left
 * waiting, one message goes out: whether or not you are in the app, and however many exhibitors the check covered (one lead
 * checked again included). A check that takes several runs says nothing until the last one. Two runs that finish the same
 * check at the same moment send one message between them: the exhibition's latest check time says which finish this is.
 */
function notifyFinished(doneBy) {
  try {
    if (!prop('NTFY_TOPIC')) return;
    const ids = Object.keys(doneBy || {});
    if (!ids.length) return;
    const rows = readTab('Exhibitors', EX_COLS), shows = readTab('Shows', SHOW_COLS);
    const send = [];
    withLock(() => {
      let sig = {};
      try { sig = JSON.parse(prop('NTFY_SIG') || '{}') || {}; } catch (e) { sig = {}; }
      Object.keys(sig).forEach((k) => { if (!shows.some((x) => x.id === k)) delete sig[k]; });   // exhibitions that are gone
      ids.forEach((id) => {
        const mine = rows.filter((r) => r.showId === id), show = shows.find((x) => x.id === id);
        if (!show || !mine.length || mine.some((r) => r.state === 'todo' || r.state === '' || r.state === 'working')) return;   // still some to do
        const stamp = mine.reduce((m, r) => (String(r.enrichedAt || '') > m ? String(r.enrichedAt) : m), '') + '|' + mine.length;
        if (sig[id] === stamp) return;   // another run already sent the message for this finish
        sig[id] = stamp; send.push({ show, rows: mine });
      });
      setProp('NTFY_SIG', JSON.stringify(sig));
    });
    send.forEach((x) => {
      const base = prop('NTFY_URL');
      noteNotify('finished', x.show.name, sendNtfy('Checks finished', finishedMessage(x.show, x.rows), base ? base + '#show=' + x.show.id : ''));
    });
  } catch (e) {
    Logger.log('notify: ' + e);
    noteNotify('finished', '', { ok: false, error: 'The message could not be put together (' + clip(String((e && e.message) || e), 80) + ')' });
  }
}

/* ---------- What the checks have been doing: speed, evidence and rechecks (shown in Settings) ---------- */

/** Keeps the last 60 exhibitors' timings: [total ms, requests, site, pages, mail, Companies House, show page, sheet, slowest wait, its host]. */
function noteTiming(log, sheetMs) {
  if (!log.length) return;
  try {
    const saves = log.reduce((a, r) => a + r[7], 0), extra = Math.max(0, sheetMs - saves) / log.length;
    const recs = log.map((r) => { const q = r.slice(); q[0] = Math.round(q[0] + extra); q[7] = Math.round(q[7] + extra); return q; });
    withLock(() => {
      let old = [];
      try { old = JSON.parse(prop('TIMING') || '[]'); } catch (e) { old = []; }
      setProp('TIMING', JSON.stringify(old.concat(recs).slice(-60)));
    });
  } catch (e) { /* timing must never break a check */ }
}

function speedInfo() {
  let r = [];
  try { r = JSON.parse(prop('TIMING') || '[]'); } catch (e) { r = []; }
  if (!r.length) return null;
  const n = r.length, sum = (i) => r.reduce((a, x) => a + (+x[i] || 0), 0);
  const sec = (i) => Math.round(sum(i) / n / 100) / 10;
  const slow = {};
  r.forEach((x) => { if (x[8] >= 5000 && x[9]) slow[x[9]] = Math.max(slow[x[9]] || 0, x[8]); });
  const slowest = Object.keys(slow).sort((a, b) => slow[b] - slow[a]).slice(0, 3).map((h) => ({ host: h, seconds: Math.round(slow[h] / 100) / 10 }));
  return { n, seconds: sec(0), requests: Math.round(10 * sum(1) / n) / 10, site: sec(2), pages: sec(3), mail: sec(4), ch: sec(5), show: sec(6), sheet: sec(7), slowest };
}

/** How each company match was made, across everything that has been checked. */
function evidenceInfo(rows) {
  const e = { number: 0, name: 0, owner: 0, postcode: 0, director: 0, dirpost: 0, carryon: 0, closed: 0, same: 0, conflict: 0, branch: 0, successor: 0, similar: 0, you: 0, none: 0 };
  rows.forEach((r) => {
    if (r.state !== 'done' && r.state !== 'error') return;
    const w = String(r.legalSrc || '');
    if (r.companyNo && CLOSED.test(String(r.companyStatus || '')) && !/confirmed by you/i.test(w)) e.closed++;
    else if (/^Company number on its website/.test(w)) e.number++;
    else if (/^Legal name on its website/.test(w)) e.name++;
    else if (/^(Company behind the brand|Copyright holder) on its website/.test(w)) e.owner++;
    else if (/^Registered postcode on its website/.test(w)) e.postcode++;
    else if (/^Director\u2019s postcode/.test(w)) e.dirpost++;
    else if (/^Director /.test(w)) e.director++;
    else if (/^Same director as /.test(w)) e.carryon++;
    else if (/^Active company registered at the same postcode as /.test(w)) e.successor++;
    else if (/^May be a franchise or branch/.test(w)) e.branch++;
    else if (/^Same name on Companies House/.test(w) && /Its website names /.test(w)) e.conflict++;
    else if (/^Same name on Companies House/.test(w)) e.same++;
    else if (/^Similar name on Companies House/.test(w)) e.similar++;
    else if (/confirmed by you/i.test(w)) e.you++;
    else e.none++;
  });
  return e;
}

/**
 * Sites the app could not read, worked out from the notes the checks left: turned away (403 and the like), robots.txt says no,
 * no answer, or only some pages. Counted by website, so a site shared by several exhibitors counts once.
 */
function reachInfo(rows) {
  const kind = {}, checked = {};
  rows.forEach((r) => {
    if ((r.state !== 'done' && r.state !== 'error') || !r.domain) return;
    checked[r.domain] = 1;
    const n = String(r.note || '');
    const k = /Website did not open \((403|406|429|430|5\d\d)\)/.test(n) ? 1 : /Site asks automated/.test(n) ? 2 : /Website did not/.test(n) ? 3 : /Could not read (?!the exhibitor)/.test(n) ? 4 : 0;
    if (k && (!kind[r.domain] || k < kind[r.domain])) kind[r.domain] = k;
  });
  const out = { checked: Object.keys(checked).length, sites: 0, turnedAway: 0, robots: 0, silent: 0, partial: 0 };
  Object.keys(kind).forEach((d) => { out.sites++; out[['', 'turnedAway', 'robots', 'silent', 'partial'][kind[d]]]++; });
  return out;
}

/** A recheck in progress: where it started and where the same group of leads stands now. */
function recheckInfo(rows) {
  let rc = null;
  try { rc = JSON.parse(prop('RECHECK') || 'null'); } catch (e) { rc = null; }
  if (!rc) return null;
  const now = { corporate: 0, check: 0, consent: 0 };
  let pending = 0;
  rows.forEach((r) => {
    if (rc.scope && r.showId !== rc.scope) return;
    if (r.state === 'done' || r.state === 'error') { if (now[r.emailable] != null) now[r.emailable]++; else now.consent++; } else pending++;
  });
  return Object.assign({}, rc, { now, pending });
}

/**
 * Puts leads that are still "to check" (and, if asked, "consent needed") back in the queue, so the current rules
 * look at them again. Leads you confirmed by hand are left alone. Optionally for one exhibition only.
 */
function recheckWeak(p) {
  return withLock(() => {
    const scope = p.showId ? String(p.showId) : '';
    const all = p.include === 'all';
    const rows = readTab('Exhibitors', EX_COLS);
    const before = { corporate: 0, check: 0, consent: 0 };
    let n = 0;
    const vals = rows.map((r) => {
      const inScope = !scope || r.showId === scope;
      if (inScope && (r.state === 'done' || r.state === 'error')) { if (before[r.emailable] != null) before[r.emailable]++; else before.consent++; }
      const weak = r.emailable === 'check' || (all && r.emailable === 'consent');
      const open = r.legal !== 'verified' || CLOSED.test(String(r.companyStatus || ''));   // a company found but closed is still worth another look
      if (inScope && weak && (r.state === 'done' || r.state === 'error') && open && r.legalSrc !== 'Confirmed by you') { n++; return ['todo', '']; }
      return [r.state, r.note];
    });
    if (n) db().getSheetByName('Exhibitors').getRange(2, EX_COLS.indexOf('state') + 1, rows.length, 2).setValues(vals);   // state and note sit side by side
    setProp('RECHECK', JSON.stringify({ at: nowIso(), scope, include: all ? 'all' : 'check', queued: n, before }));
    return { queued: n, before };
  });
}

/**
 * Runs a check on one lead without saving anything, and says in plain words what it read and what it decided.
 * For working out why a lead is still "to check": was the evidence not there, or out of reach?
 */
function explain(p) {
  const r = readTab('Exhibitors', EX_COLS).find((x) => x.id === p.id);
  if (!r) throw new Error('Not found');
  const ctx = newCtx();
  ctx.donors = {}; ctx.names = {}; ctx.shows = {};   // never borrow another row's result: this shows what the pages say
  ctx.until = Date.now() + EX_MS;
  _T = {}; _slow = { ms: 0, host: '' }; _cat = 'web';
  const t0 = Date.now();
  const patch = enrichOne(Object.assign({}, r), ctx);
  const lines = (ctx.why || []).slice();
  if (r.legalSrc === 'Confirmed by you') lines.unshift('You confirmed this one yourself, so the company is kept as you set it.');
  return {
    build: BUILD, seconds: Math.round((Date.now() - t0) / 100) / 10, lines,
    saved: { legal: r.legal, legalSrc: r.legalSrc, emailable: r.emailable, note: r.note },
    now: { legal: patch.legal || r.legal, legalSrc: patch.legalSrc || r.legalSrc, emailable: patch.emailable || r.emailable, note: patch.note || '' },
  };
}

function status() {
  let trigger = false;
  try { trigger = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'enrichTick'); } catch (e) { trigger = false; }
  const rows = readTab('Exhibitors', EX_COLS);
  return { ok: true, v: VERSION, build: BUILD, ch: !!prop('CH_KEY'), trigger, sheetUrl: db().getUrl(), usage: usageInfo(), speed: speedInfo(), evidence: evidenceInfo(rows), recheck: recheckInfo(rows), reach: reachInfo(rows), notify: notifyInfo() };
}

function list() {
  migrateOnce();
  const shows = readTab('Shows', SHOW_COLS), ex = readTab('Exhibitors', EX_COLS);
  const by = {};
  ex.forEach((r) => { (by[r.showId] = by[r.showId] || []).push(r); });
  return { shows: shows.map((s) => Object.assign(pubShow(s), { counts: counts(by[s.id] || []) })), v: VERSION, usage: usageInfo() };
}

function cleanUrls(text) {
  const out = [];
  String(text || '').split(/\s+/).forEach((u) => {
    u = u.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    const p = parseUrl(u);
    if (p && isPublicHost(p.host) && out.indexOf(u) < 0 && u.length <= 500) out.push(u);
  });
  return out.slice(0, 5);
}
const isoDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s || '')) ? String(s) : '');

function saveShow(p) {
  const name = clip(p.name, 120);
  if (!name) throw new Error('Give the exhibition a name');
  return withLock(() => {
    const shows = readTab('Shows', SHOW_COLS);
    let s = p.id ? shows.find((x) => x.id === p.id) : null;
    const urls = cleanUrls(p.urls).join('\n');
    const fields = { name, sector: clip(p.sector, 40) || 'General', start: isoDay(p.start), end: isoDay(p.end) || isoDay(p.start), urls };
    if (s) {
      Object.assign(s, fields);
      if (p.urls !== undefined && urls !== s.urls) s.status = 'new';
      writeObj('Shows', SHOW_COLS, s);
    } else {
      s = Object.assign({ id: newId(), status: 'new', statusNote: '', addedAt: nowIso(), loadedAt: '' }, fields);
      appendObjs('Shows', SHOW_COLS, [s]);
    }
    return { show: pubShow(s) };
  });
}

function deleteShow(p) {
  return withLock(() => {
    const shows = readTab('Shows', SHOW_COLS).filter((s) => s.id === p.id);
    if (!shows.length) throw new Error('Exhibition not found');
    deleteRowNumbers('Exhibitors', readTab('Exhibitors', EX_COLS).filter((r) => r.showId === p.id).map((r) => r._row));
    deleteRowNumbers('Shows', shows.map((s) => s._row));
    return { ok: true };
  });
}

/** Add parsed entries to a show, skipping ones it already has. */
function addEntries(show, entries) {
  return withLock(() => {
    const have = {};
    const existing = readTab('Exhibitors', EX_COLS).filter((r) => r.showId === show.id);
    existing.forEach((r) => { have[r.domain || normKey(r.name)] = 1; have['n:' + normKey(r.name)] = 1; });
    const fresh = [];
    let skipped = 0;
    entries.forEach((e) => {
      const website = cleanWebsite(e.website);
      const domain = siteDomain(website);
      const nk = normKey(e.name);
      if (!nk || (existing.length + fresh.length) >= 1500) { skipped++; return; }
      if ((domain && have[domain] && have['n:' + nk]) || have['n:' + nk]) { skipped++; return; }
      have[domain || nk] = 1; have['n:' + nk] = 1;
      const email = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(e.email || '') ? e.email.toLowerCase() : '';
      fresh.push({
        id: newId(), showId: show.id, name: clip(e.name, 160), stand: clip(e.stand, 40), category: clip(e.category, 120), blurb: clip(e.blurb, 300),
        website, domain, detailUrl: e.detailUrl || '', phone: clip(e.phone, 30), phoneSrc: e.phone ? (e.phoneSrc || 'directory') : '',
        email, emailKind: email ? (FREEMAIL.test(emailDomain(email)) ? 'freemail' : GENERIC_LOCAL.test(email.split('@')[0]) ? 'generic' : 'named') : '', emailSrc: email ? 'pasted' : '',
        contact: clip(e.contact, 80), contactSrc: e.contact ? 'pasted' : '', chDirector: '', companyNo: '', companyName: '', companyType: '', companyStatus: '', companyAddr: '',
        legal: '', legalSrc: '', emailable: '', workspace: '', mailHost: '', state: 'todo', note: '', addedAt: nowIso(), enrichedAt: '', alsoUses: '',
      });
    });
    appendObjs('Exhibitors', EX_COLS, fresh);
    return { added: fresh.length, skipped };
  });
}

function setShowStatus(id, status, note) {
  withLock(() => {
    const s = readTab('Shows', SHOW_COLS).find((x) => x.id === id);
    if (!s) return;
    s.status = status; s.statusNote = clip(note, 240); s.loadedAt = nowIso();
    writeObj('Shows', SHOW_COLS, s);
  });
}

function loadShow(p) {
  const show = readTab('Shows', SHOW_COLS).find((s) => s.id === p.id);
  if (!show) throw new Error('Exhibition not found');
  const urls = String(show.urls || '').split(/\s+/).filter(Boolean);
  if (!urls.length) throw new Error('Add the exhibitor list link first, or paste the list');
  const ctx = newCtx();
  let entries = [], blocked = 0, failed = 0, how = '';
  urls.forEach((u) => {
    const pg = fetchPage(u, ctx);
    if (pg.blocked && !pg.down) { blocked++; return; }
    if (pg.down || !pg.body || pg.code < 200 || pg.code >= 300) { failed++; return; }
    const r = parseDirectory(pg.body, pg.url);
    how = how || r.how;
    entries = entries.concat(r.entries);
  });
  if (!entries.length) {
    const msg = blocked ? 'This site asks automated tools not to read it. Paste the list instead.'
      : failed ? 'The page did not open. Check the link and try again, or paste the list instead.'
      : 'No exhibitor list could be found on that page. Paste the list instead.';
    setShowStatus(show.id, blocked ? 'blocked' : failed ? 'error' : 'empty', msg);
    return { added: 0, skipped: 0, status: blocked ? 'blocked' : failed ? 'error' : 'empty', note: msg };
  }
  const res = addEntries(show, entries);
  const note = (how === 'grid' ? 'Names only, so each exhibitor\u2019s own page on the show site is read for its website.' : '') + (blocked ? ' One link was skipped because the site asks automated tools not to read it.' : '');
  setShowStatus(show.id, 'loaded', note.trim());
  return Object.assign(res, { status: 'loaded', note: note.trim(), how });
}

function pasteList(p) {
  const show = readTab('Shows', SHOW_COLS).find((s) => s.id === p.showId);
  if (!show) throw new Error('Exhibition not found');
  const entries = parsePasted(clip(p.text, 120000));
  if (!entries.length) throw new Error('Nothing to add. Put one business on each line, with its website if you have it.');
  const res = addEntries(show, entries);
  setShowStatus(show.id, 'loaded', 'Pasted list');
  return Object.assign(res, { status: 'loaded' });
}

/**
 * For each exhibitor, the other exhibitions it is already listed in: the same website anywhere, or the same name within the
 * same sector (unless the two have different websites). Returns a function from a row to a list of exhibition ids.
 */
function alsoInFinder(all, shows) {
  const sector = {};
  shows.forEach((s) => { sector[s.id] = String(s.sector || '').toLowerCase(); });
  const byDomain = {}, byName = {};
  const nameKey = (r) => { const k = normKey(r.name); return sector[r.showId] != null && k.length >= 3 ? sector[r.showId] + '|' + k : ''; };
  all.forEach((r) => {
    if (sector[r.showId] == null) return;
    if (r.domain) (byDomain[r.domain] = byDomain[r.domain] || []).push(r);
    const k = nameKey(r);
    if (k) (byName[k] = byName[k] || []).push(r);
  });
  return (r) => {
    const set = {};
    (r.domain ? byDomain[r.domain] || [] : []).forEach((o) => { if (o.showId !== r.showId) set[o.showId] = 1; });
    (byName[nameKey(r)] || []).forEach((o) => { if (o.showId !== r.showId && !(r.domain && o.domain && r.domain !== o.domain)) set[o.showId] = 1; });
    return Object.keys(set);
  };
}

function rows(p) {
  const shows = readTab('Shows', SHOW_COLS);
  let ids;
  if (p.showId) ids = [String(p.showId)];
  else if (p.sector) ids = shows.filter((s) => s.sector === p.sector).map((s) => s.id);
  else throw new Error('Say which exhibition or sector');
  const set = {};
  ids.forEach((i) => { set[i] = 1; });
  const all = readTab('Exhibitors', EX_COLS);
  const also = alsoInFinder(all, shows);
  return { rows: all.filter((r) => set[r.showId]).map((r) => { const o = pubEx(r); const a = also(r); if (a.length) o.alsoIn = a; return o; }) };
}

/**
 * Takes the next exhibitors to check, up to `max` in one go (one read of the sheet rather than one each).
 * A claim older than CLAIM_MS means the run that took it was cut off, so it is offered again. After MAX_TRIES
 * cut-offs it is marked as skipped instead of being tried for ever.
 */
function claimBatch(showId, skipped, max) {
  return withLock(() => {
    const cutoff = Date.now() - CLAIM_MS;
    const cache = CacheService.getScriptCache();
    const rows = readTab('Exhibitors', EX_COLS);
    const got = [];
    for (let i = 0; i < rows.length && got.length < max; i++) {
      const r = rows[i];
      if (showId && r.showId !== showId) continue;
      const fresh = r.state === 'todo' || r.state === '';
      const stale = r.state === 'working' && Date.parse(r.enrichedAt || 0) < cutoff;
      if (!fresh && !stale) continue;
      if (stale) {
        const cut = (+cache.get('try:' + r.id) || 0) + 1;   // runs cut off while checking this one so far
        if (cut >= MAX_TRIES) {
          r.state = 'error'; r.enrichedAt = nowIso();
          r.note = 'The check ran out of time twice, so it was skipped. Use Check again to try once more';
          r.legal = r.legal || 'none'; r.emailable = r.emailable || 'consent'; r.workspace = r.workspace || 'unknown';
          writeObj('Exhibitors', EX_COLS, r);
          cache.remove('try:' + r.id);
          if (skipped) skipped.push(pubEx(r));
          continue;
        }
        cache.put('try:' + r.id, String(cut), 21600);
      } else cache.remove('try:' + r.id);
      const before = Object.assign({}, r);
      r.state = 'working'; r.enrichedAt = nowIso();
      writeObj('Exhibitors', EX_COLS, r);
      got.push({ row: r, before });
    }
    return got;
  });
}

function claimNext(showId, skipped) { const g = claimBatch(showId, skipped, 1)[0]; return g ? g.row : null; }

function pendingCount(showId) { return readTab('Exhibitors', EX_COLS).filter((x) => (!showId || x.showId === showId) && (x.state === 'todo' || x.state === '' || x.state === 'working')).length; }

/** One row, found from where it was last seen. Falls back to a search if the sheet has shifted (a show deleted meanwhile). */
function rowNow(id, hint) {
  const sh = db().getSheetByName('Exhibitors');
  if (hint >= 2 && hint <= sh.getLastRow()) {
    const v = sh.getRange(hint, 1, 1, EX_COLS.length).getValues()[0];
    if (cell(v[0]) === id) { const o = { _row: hint }; EX_COLS.forEach((c, j) => { o[c] = cell(v[j]); }); return o; }
  }
  return readTab('Exhibitors', EX_COLS).find((x) => x.id === id) || null;
}

/** How many exhibitors a run takes at a time. Small enough that a cut-off run strands only a few. */
const BATCH = 4;

function enrichRun(p) {
  migrateOnce();
  const budget = Math.min(+p.budget || 20, MAX_BUDGET) * 1000, t0 = Date.now();
  const ctx = newCtx();
  const changed = [], skipped = [];
  const showId = p.showId ? String(p.showId) : '';
  const log = [];
  let processed = 0, errors = 0, sheetMs = 0;
  let queue = [];
  try {
    while (Date.now() - t0 < budget) {
      if (!queue.length) {
        const s0 = Date.now();
        queue = claimBatch(showId, skipped, BATCH);
        sheetMs += Date.now() - s0;
        if (!queue.length) break;
      }
      const item = queue.shift(), ex = item.row;
      _T = {}; _slow = { ms: 0, host: '' }; _cat = 'web';
      const e0 = Date.now();
      ctx.until = e0 + EX_MS;
      let patch;
      try { patch = enrichOne(ex, ctx); } catch (err) { patch = { state: 'error', note: 'Check failed: ' + clip(String((err && err.message) || err), 160), enrichedAt: nowIso() }; }
      const checkMs = Date.now() - e0;
      if (patch.state === 'error') errors++;
      const s1 = Date.now();
      const saved = withLock(() => {
        const cur = rowNow(ex.id, ex._row);
        if (!cur) return null;
        Object.keys(patch).forEach((k) => { if (EX_COLS.indexOf(k) >= 0) cur[k] = patch[k]; });
        writeObj('Exhibitors', EX_COLS, cur);
        return cur;
      });
      const saveMs = Date.now() - s1;
      sheetMs += saveMs;
      if (saved) { changed.push(pubEx(saved)); registerDonor(ctx, saved); }
      processed++;
      log.push([checkMs + saveMs, _T.req || 0, _T.site || 0, _T.pages || 0, _T.dns || 0, _T.ch || 0, _T.detail || 0, saveMs, _slow.ms, _slow.host]);
    }
  } finally {
    // anything claimed but not reached goes back in the queue rather than waiting out the claim
    if (queue.length) {
      try {
        withLock(() => queue.forEach((q) => {
          const cur = rowNow(q.row.id, q.row._row);
          if (cur && cur.state === 'working' && cur.enrichedAt === q.row.enrichedAt) { cur.state = q.before.state || 'todo'; cur.enrichedAt = q.before.enrichedAt; writeObj('Exhibitors', EX_COLS, cur); }
        }));
      } catch (e) { /* the claim simply times out */ }
    }
    const doneBy = {};
    changed.concat(skipped).forEach((x) => { doneBy[x.showId] = (doneBy[x.showId] || 0) + 1; });
    notifyFinished(doneBy);
    noteTiming(log, sheetMs);
    noteUsage(0);
  }
  skipped.forEach((x) => { errors++; changed.push(x); });   // exhibitors given up on while looking for the next one
  return { processed, errors, pending: pendingCount(showId), changed, usage: usageInfo() };
}

function enrich(p) { return enrichRun(p); }

function directorOf(r) { return r.contact || (r.legal === 'verified' ? r.chDirector : '') || ''; }

function confirmMatch(p) {
  return withLock(() => {
    const r = readTab('Exhibitors', EX_COLS).find((x) => x.id === p.id);
    if (!r) throw new Error('Not found');
    if (p.number) {
      const n = String(p.number).replace(/\s+/g, '').toUpperCase();
      if (!/^((SC|NI|OC|SO|NC|LP|SL|FC|SE|SA|NF|NL|GE|IP|SP|RC)\d{6}|\d{8})$/.test(n)) throw new Error('A company number is 8 characters, such as 01234567 or SC123456');
      const co = chProfile(n);
      if (!co) throw new Error('Companies House has no company with that number');
      Object.assign(r, { companyNo: co.no, companyName: co.name, companyType: co.type, companyStatus: co.status, companyAddr: co.addr, chDirector: chDirectorName(co.no), legal: 'verified', legalSrc: 'Confirmed by you' });
    } else if (p.yes === false || p.yes === 'no') {
      Object.assign(r, { companyNo: '', companyName: '', companyType: '', companyStatus: '', companyAddr: '', chDirector: '', legal: 'none', legalSrc: 'Confirmed by you', emailable: 'consent' });
    } else {
      if (!r.companyNo) throw new Error('No company to confirm');
      r.legal = 'verified'; r.legalSrc = 'Confirmed by you';
    }
    if (r.legal === 'verified') {
      r.emailable = emailableFor('verified', r.companyStatus, r.companyType, r.companyNo);
      if (!r.contact && r.chDirector) { r.contact = r.chDirector; r.contactSrc = 'Companies House director'; }
    }
    writeObj('Exhibitors', EX_COLS, r);
    return { row: pubEx(r) };
  });
}

/** Companies House search for the "Find on Companies House" picker: a name or a pasted company number, up to 8 matches. */
function searchCompanies(p) {
  if (!prop('CH_KEY')) throw new Error('Companies House is not set up yet. Add the key in Script Properties');
  const q = clip(p.q, 120).trim();
  if (q.length < 2) throw new Error('Type at least two letters of the company name, or its number');
  const num = q.replace(/\s+/g, '').toUpperCase();
  if (/^((SC|NI|OC|SO|NC|LP|SL|FC|SE|SA|NF|NL|GE|IP|SP|RC)\d{6}|\d{6,8})$/.test(num)) {
    const co = chProfile(/^\d+$/.test(num) ? ('00000000' + num).slice(-8) : num);   // a number pasted without its leading zeros still finds it
    if (co) return { items: [co], byNumber: true };
  }
  const r = chGet(chSearchPath(q));
  if (r.code !== 200 || !r.json) throw new Error('Companies House search answered ' + r.code);
  return { items: (r.json.items || []).slice(0, 8).map(chShape) };
}

function confirmLikely(p) {
  return withLock(() => {
    const changed = [];
    readTab('Exhibitors', EX_COLS).filter((r) => r.showId === p.showId && r.legal === 'likely').forEach((r) => {
      r.legal = 'verified'; r.legalSrc = 'Same name, confirmed by you';
      r.emailable = emailableFor('verified', r.companyStatus, r.companyType, r.companyNo);
      if (!r.contact && r.chDirector) { r.contact = r.chDirector; r.contactSrc = 'Companies House director'; }
      writeObj('Exhibitors', EX_COLS, r);
      changed.push(pubEx(r));
    });
    return { changed };
  });
}

function editRow(p) {
  return withLock(() => {
    const r = readTab('Exhibitors', EX_COLS).find((x) => x.id === p.id);
    if (!r) throw new Error('Not found');
    const pt = p.patch || {};
    let recheck = false;
    EDITABLE.forEach((k) => {
      if (pt[k] === undefined) return;
      let v = clip(pt[k], k === 'note' ? 240 : 160);
      if (k === 'website') { v = v ? cleanWebsite(v) : ''; if (pt[k] && !v) throw new Error('That does not look like a web address'); r.domain = siteDomain(v); recheck = recheck || v !== r.website; }
      if (k === 'email') {
        if (v && !/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(v)) throw new Error('That does not look like an email address');
        v = v.toLowerCase(); r.emailKind = v ? (FREEMAIL.test(emailDomain(v)) ? 'freemail' : GENERIC_LOCAL.test(v.split('@')[0]) ? 'generic' : 'named') : ''; r.emailSrc = v ? 'typed by you' : ''; recheck = recheck || v !== r.email;
      }
      if (k === 'phone' && v) { const d = normalisePhone(v); if (!d) throw new Error('That does not look like a UK phone number'); v = formatPhone(d); r.phoneSrc = 'typed by you'; }
      if (k === 'contact') r.contactSrc = v ? 'typed by you' : '';
      r[k] = v;
    });
    if (recheck && r.state !== 'working') r.state = 'todo';
    writeObj('Exhibitors', EX_COLS, r);
    return { row: pubEx(r) };
  });
}

function recheck(p) {
  return withLock(() => {
    const ids = {};
    [].concat(p.ids || p.id || []).forEach((i) => { ids[i] = 1; });
    let n = 0;
    readTab('Exhibitors', EX_COLS).forEach((r) => {
      if (!ids[r.id]) return;
      r.state = 'todo'; r.note = '';
      writeObj('Exhibitors', EX_COLS, r); n++;
    });
    return { reset: n };
  });
}

function deleteRows(p) {
  return withLock(() => {
    const ids = {};
    [].concat(p.ids || []).forEach((i) => { ids[i] = 1; });
    const nums = readTab('Exhibitors', EX_COLS).filter((r) => ids[r.id]).map((r) => r._row);
    deleteRowNumbers('Exhibitors', nums);
    return { deleted: nums.length };
  });
}
