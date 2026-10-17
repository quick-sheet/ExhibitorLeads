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
const PROTO = 2;

// Where terms and privacy pages usually live, tried when a site's own links do not lead to them.
const LEGAL_GUESSES = ['/privacy-policy', '/terms-and-conditions', '/terms-of-use', '/terms', '/privacy', '/legal'];

const SHOW_COLS = ['id', 'name', 'sector', 'start', 'end', 'urls', 'status', 'statusNote', 'addedAt', 'loadedAt'];
const EX_COLS = ['id', 'showId', 'name', 'stand', 'category', 'blurb', 'website', 'domain', 'detailUrl',
  'phone', 'phoneSrc', 'email', 'emailKind', 'emailSrc', 'contact', 'contactSrc', 'chDirector',
  'companyNo', 'companyName', 'companyType', 'companyStatus', 'companyAddr',
  'legal', 'legalSrc', 'emailable', 'workspace', 'mailHost', 'state', 'note', 'addedAt', 'enrichedAt'];
const EDITABLE = ['name', 'website', 'phone', 'email', 'contact', 'note'];

const REDIRECTORS = ['share.google', 'g.co', 'goo.gl', 'bit.ly', 't.co', 'tinyurl.com', 'ow.ly', 'buff.ly', 'lnkd.in', 'is.gd'];
const SKIP_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.me|instagram\.com|twitter\.com|x\.com|tiktok\.com|youtube\.com|youtu\.be|linkedin\.com|pinterest\.[a-z.]+|wa\.me|whatsapp\.com|threads\.net|snapchat\.com|vimeo\.com|google\.[a-z.]+|goo\.gl|apple\.com|gstatic\.com|googletagmanager\.com|googleapis\.com|seetickets\.com|eventbrite\.[a-z.]+|ticketmaster\.[a-z.]+|bit\.ly|wixsite\.com)$/i;
const FREEMAIL = /^(gmail\.com|googlemail\.com|hotmail\.com|hotmail\.co\.uk|outlook\.com|outlook\.co\.uk|live\.com|live\.co\.uk|msn\.com|yahoo\.com|yahoo\.co\.uk|ymail\.com|icloud\.com|me\.com|aol\.com|btinternet\.com|btopenworld\.com|sky\.com|talktalk\.net|virginmedia\.com|ntlworld\.com|blueyonder\.co\.uk|protonmail\.com|proton\.me)$/i;
const GENERIC_LOCAL = /^(info|hello|hi|contact|enquiries|enquiry|sales|office|admin|team|support|customer|customers|customerservice|shop|trade|events|wholesale|accounts|bookings|mail|post|general|marketing|orders|help|service)$/i;
const GATEWAY = /(mimecast|pphosted|proofpoint|barracuda|messagelabs|symanteccloud|mailcontrol|forcepoint|trendmicro|iphmx|sophos|mailguard|ppe-hosted|cloudfilter|mxlogic|antispamcloud|spamh|mailhop|mailanyone)/i;

/* ============================================================
 * Web app entry points
 * ============================================================ */

function doGet() { return json({ ok: true, app: 'Exhibitor Leads', v: VERSION }); }

function doPost(e) {
  let b = {};
  try { b = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { b = {}; }
  return json(route(b.action, b));
}

function json(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }

function route(action, p) {
  const routes = { ping, status, list, saveShow, deleteShow, loadShow, pasteList, rows, enrich, confirmMatch, confirmLikely, editRow, recheck, deleteRows };
  p = p || {};
  try {
    if (action === 'ping') return { ok: true, v: VERSION };
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
 * Once after an upgrade: results that were not confirmed (anything but a company number found on its own site,
 * or a company you confirmed) go back in the queue, so the better checking looks at them again.
 */
function migrateOnce() {
  if (+prop('PROTO') >= PROTO) return 0;
  return withLock(() => {
    if (+prop('PROTO') >= PROTO) return 0;
    const rows = readTab('Exhibitors', EX_COLS);
    let n = 0;
    const vals = rows.map((r) => {
      if ((r.state === 'done' || r.state === 'error') && r.legal !== 'verified' && r.legalSrc !== 'Confirmed by you') { n++; return ['todo', '']; }
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
  const num = '((?:SC|NI|OC|SO|NC|LP|SL|FC|SE|SA|NF|NL|GE|IP|SP|RC)\\d{6}|\\d{8}|\\d{7})(?!\\d)';
  const res = [
    new RegExp('(?:company|co\\.?|registered|registration|reg\\.?)\\s*(?:registration\\s*)?(?:number|no\\.?|num\\.?|#)\\s*(?:is|:|-|–)?\\s*' + num, 'gi'),
    new RegExp('registered\\s+in\\s+(?:england(?:\\s*(?:and|&)\\s*wales)?|scotland|wales|northern\\s+ireland)[^0-9A-Za-z]{0,6}(?:company\\s*)?(?:(?:number|no\\.?|num\\.?|#)[^0-9A-Za-z]{0,6})?' + num, 'gi'),
  ];
  const hits = [];
  res.forEach((re) => {
    let m;
    while ((m = re.exec(t))) {
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
function verifyCandidates(cands, name) {
  let first = null, looked = 0;
  for (let i = 0; i < cands.length && looked < 3; i++) {
    const p = chProfile(cands[i].n);
    looked++;
    if (!p) continue;
    if (nameInText(p.name, cands[i].text) || nameScore(name, p.name) >= 0.6) return p;
    if (!first) first = p;
  }
  return cands.length === 1 ? first : null;
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
    if (/terms|privacy|conditions|legal|imprint|company[- ]info|registered/.test(hay)) { if (core.length < 6 && core.indexOf(full) < 0) core.push(full); }
    else if (/about|delivery|returns|cookie|policies/.test(hay)) { if (more.length < 4 && more.indexOf(full) < 0) more.push(full); }
  });
  return { contact, legal: core.concat(more), core: core.length };
}

function scanPage(html, url) {
  const text = stripTags(html);
  const numbers = extractCompanyNumbers(text);
  return { emails: extractEmails(html), phones: extractPhones(html), number: numbers[0] || '', numbers, text, person: extractPerson(html), links: findLinks(html, url), textLen: text.length };
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

function http(url, opts) {
  const o = { method: 'get', muteHttpExceptions: true, followRedirects: false };
  Object.keys(opts || {}).forEach((k) => { o[k] = opts[k]; });
  o.headers = Object.assign({ 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.5', 'Accept-Language': 'en-GB,en;q=0.8' }, (opts && opts.headers) || {});
  _fetched++;
  try {
    const r = UrlFetchApp.fetch(url, o);
    let body = '';
    try { body = String(r.getContentText() || '').slice(0, MAX_BODY); } catch (e) { body = ''; }
    return { code: r.getResponseCode(), headers: lowerKeys(r.getAllHeaders ? r.getAllHeaders() : r.getHeaders()), body };
  } catch (err) {
    return { code: 0, headers: {}, body: '', error: String((err && err.message) || err) };
  }
}

function robotsFor(host, scheme, ctx) {
  if (ctx.robots[host] !== undefined) return ctx.robots[host];
  let groups = 'all';
  const cache = CacheService.getScriptCache();
  const hit = cache.get('rb:' + host);
  if (hit) { try { groups = JSON.parse(hit); ctx.robots[host] = groups; return groups; } catch (e) { /* refetch */ } }
  const r = http(scheme + '://' + host + '/robots.txt');
  if (r.code === 200) groups = parseRobots(r.body);
  else if (r.code >= 400 && r.code < 500) groups = 'all';
  else if (r.code >= 300 && r.code < 400) groups = 'all';
  else groups = 'down';   // unreachable or server error: treated as "do not read", as the standard says
  ctx.robots[host] = groups;
  try { const s = JSON.stringify(groups); if (s.length < 90000) cache.put('rb:' + host, s, groups === 'down' ? 600 : 6 * 3600); } catch (e) { /* cache is optional */ }
  return groups;
}

/**
 * Fetch a page politely: follows redirects, and checks robots.txt before reading any page that isn't
 * just a link shortener. Returns { blocked, code, body, url }.
 */
function fetchPage(url, ctx, maxHops) {
  const key = url + '|' + (maxHops || 4);
  if (ctx && ctx.pages && ctx.pages[key]) return ctx.pages[key];
  const res = fetchPageOnce(url, ctx, maxHops);
  if (ctx && ctx.pages && !res.late) ctx.pages[key] = res;   // a page skipped for lack of time is not remembered as "unreadable"
  return res;
}

function fetchPageOnce(url, ctx, maxHops) {
  let cur = url;
  for (let hop = 0; hop <= (maxHops || 4); hop++) {
    if (ctx && ctx.until && Date.now() > ctx.until) return { blocked: false, late: true, code: 0, body: '', url: cur, error: 'Ran out of time' };
    const p = parseUrl(cur);
    if (!p || !isPublicHost(p.host)) return { blocked: false, code: 0, body: '', url: cur, error: 'Not a public web address' };
    const redirector = REDIRECTORS.some((r) => p.host === r || p.host.slice(-(r.length + 1)) === '.' + r);
    if (!redirector) {
      const rb = robotsFor(p.host, p.scheme, ctx);
      if (!robotsAllows(rb, p.path + p.query)) return { blocked: true, down: rb === 'down', code: 0, body: '', url: cur };
    }
    const r = http(cur);
    if (r.code >= 300 && r.code < 400 && r.headers.location) { cur = resolveUrl(cur, r.headers.location); if (!cur) break; continue; }
    const type = String(r.headers['content-type'] || '');
    if (type && !/html|xml|text/i.test(type)) return { blocked: false, code: r.code, body: '', url: cur, error: 'Not a web page' };
    return { blocked: false, code: r.code, body: r.body, url: cur, error: r.error };
  }
  return { blocked: false, code: 0, body: '', url: cur, error: 'Too many redirects' };
}

function newCtx() { return { robots: {}, mail: {}, donors: null, pages: {} }; }

/* ---------- Mail records (DNS over HTTPS) ---------- */

function dohQuery(name, type) {
  const r = http('https://dns.google/resolve?name=' + encodeURIComponent(name) + '&type=' + type, { headers: { Accept: 'application/dns-json' } });
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
  const gw = hosts.find((h) => GATEWAY.test(h));
  if (gw) return { workspace: 'unknown', host: 'Mail filter (' + hostLabel(gw) + ')', gateway: true };
  return { workspace: 'no', host: 'Other (' + hostLabel(hosts[0]) + ')', gateway: false };
}

function spfHasGoogle(dns) {
  return !!dns && (dns.Answer || []).some((a) => a.type === 16 && /v=spf1/i.test(a.data) && /include:(_spf\.google\.com|google\.com|_netblocks\.google\.com)/i.test(a.data));
}

function mailCheck(domain, ctx) {
  if (!domain) return { workspace: 'unknown', host: '' };
  if (ctx.mail[domain]) return ctx.mail[domain];
  let used = domain;
  let res = classifyMx(dohQuery(used, 'MX'));
  if (/^(No email set up|Domain not found)$/.test(res.host) && regDomain(domain) !== domain) { used = regDomain(domain); res = classifyMx(dohQuery(used, 'MX')); }
  if (res.gateway && spfHasGoogle(dohQuery(used, 'TXT'))) res = { workspace: 'likely', host: 'Google behind a mail filter', gateway: true };
  ctx.mail[domain] = res;
  return res;
}

/* ---------- Companies House ---------- */

function chGet(path) {
  const key = prop('CH_KEY');
  if (!key) return { code: -1 };
  const go = () => http('https://api.company-information.service.gov.uk' + path, { headers: { Authorization: 'Basic ' + Utilities.base64Encode(key + ':') } });
  let r = go();
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
  };
}

function chProfile(number) {
  const r = chGet('/company/' + encodeURIComponent(number));
  if (r.code === 200 && r.json) return chShape(r.json);
  if (r.code === 404) return null;
  throw new Error('Companies House answered ' + r.code);
}

function chSearch(name) {
  const r = chGet('/search/companies?items_per_page=8&q=' + encodeURIComponent(name));
  if (r.code !== 200 || !r.json) throw new Error('Companies House search answered ' + r.code);
  let best = null;
  (r.json.items || []).forEach((it) => {
    const s = nameScore(name, it.title);
    const live = it.company_status === 'active' ? 0.05 : 0;
    if (!best || s + live > best.score) best = { score: s + live, raw: s, c: chShape(it) };
  });
  return best;
}

function chDirectorName(number) {
  const r = chGet('/company/' + encodeURIComponent(number) + '/officers?items_per_page=20');
  if (r.code !== 200 || !r.json) return '';
  const o = (r.json.items || []).find((x) => !x.resigned_on && /director|llp-member|llp-designated-member/.test(String(x.officer_role || '')) && !/\b(ltd|limited|llp|plc|services|holdings)\b/i.test(x.name || ''));
  return o ? titleCaseOfficer(o.name) : '';
}

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

const COPY_FROM_DONOR = ['email', 'emailKind', 'emailSrc', 'contact', 'contactSrc', 'chDirector', 'companyNo', 'companyName', 'companyType', 'companyStatus', 'companyAddr', 'legal', 'legalSrc', 'emailable', 'workspace', 'mailHost'];

/** A finished row can stand in for another exhibitor on the same website, but only when it was properly read. */
function usableDonor(r) {
  return r.state === 'done' && r.domain && r.enrichedAt && r.legal === 'verified' && r.legalSrc === 'Company number on its website' &&
    !/not read|asks automated|did not respond|No website|Same website/i.test(r.note);
}

function registerDonor(ctx, r) {
  if (!ctx.donors || !usableDonor(r)) return;
  const old = ctx.donors[r.domain];
  if (!old || old.enrichedAt < r.enrichedAt) ctx.donors[r.domain] = r;
}

function donorFor(domain, selfId, ctx) {
  if (!ctx.donors) {
    ctx.donors = {};
    readTab('Exhibitors', EX_COLS).forEach((r) => registerDonor(ctx, r));
  }
  const d = ctx.donors[domain];
  return d && d.id !== selfId ? d : null;
}

function enrichOne(ex, ctx) {
  const notes = [];
  const patch = {};
  let site = ex.website;
  let late = false;   // set when this exhibitor used up its time allowance and some pages were skipped

  // 1. Some directories only link to a page per exhibitor: read it to find the website.
  if (!site && ex.detailUrl) {
    const d = fetchPage(ex.detailUrl, ctx);
    if (d.late) late = true;
    else if (d.blocked) notes.push(d.down ? 'Could not check whether the show site allows reading its exhibitor pages' : 'The show site asks automated tools not to read exhibitor pages');
    else if (d.body && d.code >= 200 && d.code < 300) {
      const det = parseDetail(d.body, d.url);
      if (det.website) { site = det.website; patch.website = site; patch.domain = siteDomain(site); }
      if (det.phone && !ex.phone) { patch.phone = det.phone; patch.phoneSrc = 'show page'; }
    } else notes.push('Could not read the exhibitor page on the show site');
  }
  const domain = siteDomain(site);
  if (domain) patch.domain = domain;

  // 2. Same website already checked (another stand, or another show): reuse it.
  const donor = domain ? donorFor(domain, ex.id, ctx) : null;
  if (donor && ex.legalSrc !== 'Confirmed by you') {
    COPY_FROM_DONOR.forEach((k) => { if (!ex[k] || k === 'legal' || k === 'emailable' || k === 'workspace' || k === 'mailHost') patch[k] = donor[k]; });
    if (!ex.phone && donor.phone) { patch.phone = donor.phone; patch.phoneSrc = donor.phoneSrc; }
    patch.state = 'done'; patch.enrichedAt = nowIso(); patch.note = 'Same website as another exhibitor, so its results were reused';
    return patch;
  }

  // 3. Read the website: the home page, then a contact page if there is no email yet, then its terms and privacy
  //    pages one at a time until one gives a company number (they nearly always carry it).
  let emails = [], phones = [], person = '';
  const cands = [];     // company numbers written on its own pages: { n, text }
  const tried = {};
  const addPage = (s) => {
    s.emails.forEach((e) => { if (!emails.some((x) => x.email === e.email)) emails.push(e); });
    s.phones.forEach((q) => { if (phones.indexOf(q) < 0) phones.push(q); });
    s.numbers.forEach((n) => { if (!cands.some((c) => c.n === n)) cands.push({ n, text: s.text }); });
    if (!person && s.person) person = s.person;
  };
  const readExtra = (u) => {
    if (tried[u]) return;
    tried[u] = 1;
    const pg = fetchPage(u, ctx, 2);
    if (pg.late) { late = true; return; }
    if (pg.blocked || !pg.body || pg.code < 200 || pg.code >= 300) return;
    addPage(scanPage(pg.body, pg.url));
  };
  if (domain) {
    const home = fetchPage(site + '/', ctx);
    if (home.late) late = true;
    else if (home.blocked) notes.push(home.down ? 'Website did not respond, so it was not read' : 'Site asks automated tools not to read it');
    else if (home.code >= 200 && home.code < 300 && home.body) {
      const pageHost = (parseUrl(home.url) || {}).host;
      tried[home.url] = 1;
      const s = scanPage(home.body, home.url);
      addPage(s);
      if (s.textLen < 200) notes.push('Site loads its content with JavaScript, so little could be read');
      if (!emails.length && s.links.contact) readExtra(s.links.contact);
      if (!cands.length && ex.legalSrc !== 'Confirmed by you' && prop('CH_KEY')) {
        const queue = s.links.legal.slice(0, 3);
        const origin = originOf(home.url);
        LEGAL_GUESSES.slice(0, s.links.core === 0 ? 4 : s.links.core === 1 ? 2 : 0).forEach((g) => queue.push(origin + g));
        for (let i = 0; i < queue.length && !cands.length && !late; i++) readExtra(queue[i]);
      }
      if (pageHost && emails.length === 0 && !cands.length && s.textLen >= 200) notes.push('No email or company number found on the pages read');
    } else notes.push('Website did not open' + (home.code ? ' (' + home.code + ')' : ''));
  } else if (!site && !late) notes.push('No website');

  // 4. Phone, email, contact. Anything already there (typed by you, or from the show) is kept.
  if (!ex.phone && phones[0]) { patch.phone = phones[0]; patch.phoneSrc = 'website'; }
  let email = ex.email, kind = ex.emailKind, esrc = ex.emailSrc;
  if (!email) {
    const pick = pickEmail(emails, domain);
    if (pick) { email = pick.email; kind = pick.kind; esrc = 'website'; patch.email = email; patch.emailKind = kind; patch.emailSrc = esrc; }
  } else if (!kind) { patch.emailKind = FREEMAIL.test(emailDomain(email)) ? 'freemail' : GENERIC_LOCAL.test(email.split('@')[0]) ? 'generic' : 'named'; }
  if (!ex.contact && person) { patch.contact = person; patch.contactSrc = 'website structured data'; }

  // 5. Who runs the mailboxes.
  const mailDom = email && !FREEMAIL.test(emailDomain(email)) ? emailDomain(email) : domain;
  if (email && FREEMAIL.test(emailDomain(email))) { patch.workspace = 'no'; patch.mailHost = 'Personal email address'; }
  else if (mailDom) { const mc = mailCheck(mailDom, ctx); patch.workspace = mc.workspace; patch.mailHost = mc.host; }
  else { patch.workspace = 'unknown'; patch.mailHost = ''; }

  // 6. Companies House.
  if (ex.legalSrc === 'Confirmed by you') {
    patch.emailable = emailableFor(ex.legal, ex.companyStatus, ex.companyType, ex.companyNo);
  } else if (!prop('CH_KEY')) {
    patch.legal = 'none'; patch.legalSrc = ''; patch.emailable = 'consent';
    notes.push('Companies House key not set, so company status was not checked');
  } else {
    try {
      let co = null, how = '', legal = 'none';
      if (cands.length) { co = verifyCandidates(cands, ex.name); if (co) { legal = 'verified'; how = 'Company number on its website'; } }
      if (!co) {
        const hit = chSearch(ex.name);
        if (hit && hit.raw >= 0.6) { co = hit.c; legal = hit.raw >= 1 && co.status === 'active' ? 'likely' : 'possible'; how = hit.raw >= 1 ? 'Same name on Companies House' : 'Similar name on Companies House'; }
      }
      if (co) {
        patch.companyNo = co.no; patch.companyName = co.name; patch.companyType = co.type; patch.companyStatus = co.status; patch.companyAddr = co.addr;
        patch.legal = legal; patch.legalSrc = how; patch.emailable = emailableFor(legal, co.status, co.type, co.no);
        if (legal !== 'possible') patch.chDirector = chDirectorName(co.no);
        if (legal === 'verified' && !ex.contact && !patch.contact && patch.chDirector) { patch.contact = patch.chDirector; patch.contactSrc = 'Companies House director'; }
      } else {
        Object.assign(patch, { companyNo: '', companyName: '', companyType: '', companyStatus: '', companyAddr: '', chDirector: '', legal: 'none', legalSrc: 'No company found', emailable: 'consent' });
      }
    } catch (err) {
      notes.push(String((err && err.message) || err));
      patch.legal = ex.legal || 'none'; patch.emailable = ex.emailable || 'consent';
      patch.state = 'error';
    }
  }
  if (FREEMAIL.test(emailDomain(email || '')) && patch.emailable === 'consent') notes.push('Personal email address, which often means a sole trader');
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
  _ss = ss;
  return ss;
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
  const c = { total: rows.length, done: 0, corporate: 0, consent: 0, check: 0, google: 0, pending: 0 };
  rows.forEach((r) => {
    if (r.state === 'done' || r.state === 'error') {
      c.done++;
      if (r.emailable === 'corporate') c.corporate++; else if (r.emailable === 'check') c.check++; else c.consent++;
      if (r.workspace === 'yes' || r.workspace === 'likely') c.google++;
    } else c.pending++;
  });
  return c;
}

function pubShow(s) { const o = {}; SHOW_COLS.forEach((c) => { o[c] = s[c]; }); o.urls = String(s.urls || '').split(/\s+/).filter(Boolean); return o; }
function pubEx(r) { const o = {}; EX_COLS.forEach((c) => { if (c !== 'detailUrl') o[c] = r[c]; }); o.blurb = String(r.blurb || '').slice(0, 200); return o; }

function ping() { return { ok: true, v: VERSION }; }

function status() {
  let trigger = false;
  try { trigger = ScriptApp.getProjectTriggers().some((t) => t.getHandlerFunction() === 'enrichTick'); } catch (e) { trigger = false; }
  return { ok: true, v: VERSION, ch: !!prop('CH_KEY'), trigger, sheetUrl: db().getUrl(), usage: usageInfo() };
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
        legal: '', legalSrc: '', emailable: '', workspace: '', mailHost: '', state: 'todo', note: '', addedAt: nowIso(), enrichedAt: '',
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

function rows(p) {
  const shows = readTab('Shows', SHOW_COLS);
  let ids;
  if (p.showId) ids = [String(p.showId)];
  else if (p.sector) ids = shows.filter((s) => s.sector === p.sector).map((s) => s.id);
  else throw new Error('Say which exhibition or sector');
  const set = {};
  ids.forEach((i) => { set[i] = 1; });
  return { rows: readTab('Exhibitors', EX_COLS).filter((r) => set[r.showId]).map(pubEx) };
}

/**
 * Takes the next exhibitor to check. A claim older than CLAIM_MS means the run that took it was cut off,
 * so it is offered again. After MAX_TRIES cut-offs it is marked as skipped instead of being tried for ever.
 */
function claimNext(showId, skipped) {
  return withLock(() => {
    const cutoff = Date.now() - CLAIM_MS;
    const cache = CacheService.getScriptCache();
    const rows = readTab('Exhibitors', EX_COLS);
    for (let i = 0; i < rows.length; i++) {
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
      r.state = 'working'; r.enrichedAt = nowIso();
      writeObj('Exhibitors', EX_COLS, r);
      return r;
    }
    return null;
  });
}

function pendingCount(showId) { return readTab('Exhibitors', EX_COLS).filter((x) => (!showId || x.showId === showId) && (x.state === 'todo' || x.state === '' || x.state === 'working')).length; }

function enrichRun(p) {
  migrateOnce();
  const budget = Math.min(+p.budget || 20, MAX_BUDGET) * 1000, t0 = Date.now();
  const ctx = newCtx();
  const changed = [], skipped = [];
  let processed = 0, errors = 0;
  while (Date.now() - t0 < budget) {
    const ex = claimNext(p.showId ? String(p.showId) : '', skipped);
    if (!ex) break;
    ctx.until = Date.now() + EX_MS;
    let patch;
    try { patch = enrichOne(ex, ctx); } catch (err) { patch = { state: 'error', note: 'Check failed: ' + clip(String((err && err.message) || err), 160), enrichedAt: nowIso() }; }
    if (patch.state === 'error') errors++;
    const saved = withLock(() => {
      const cur = readTab('Exhibitors', EX_COLS).find((x) => x.id === ex.id);
      if (!cur) return null;
      Object.keys(patch).forEach((k) => { if (EX_COLS.indexOf(k) >= 0) cur[k] = patch[k]; });
      writeObj('Exhibitors', EX_COLS, cur);
      return cur;
    });
    if (saved) { changed.push(pubEx(saved)); registerDonor(ctx, saved); }
    processed++;
    noteUsage(0);
  }
  skipped.forEach((x) => { errors++; changed.push(x); });   // exhibitors given up on while looking for the next one
  return { processed, errors, pending: pendingCount(p.showId ? String(p.showId) : ''), changed, usage: usageInfo() };
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
