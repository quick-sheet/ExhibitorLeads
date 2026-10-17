/* Exhibitor Leads: the plain logic. No DOM and no network here, so it can be tested with node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

  /* ---------- Dates ---------- */

  /** "2026-10-30" to a day number, or NaN. Days are counted in UTC so daylight saving never shifts them. */
  function dayNum(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    if (!m) return NaN;
    const y = +m[1], mo = +m[2], d = +m[3], t = Date.UTC(y, mo - 1, d);
    const back = new Date(t);
    return back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d ? t / 864e5 : NaN;
  }

  /** Today's date on the phone, as "YYYY-MM-DD". */
  function todayIso(now) {
    const d = now instanceof Date ? now : new Date(now == null ? Date.now() : now);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  const GROUPS = [
    { id: 'upcoming', label: 'Upcoming' },
    { id: 'recent', label: 'Past 12 months' },
    { id: 'older', label: 'Older' },
    { id: 'undated', label: 'No date' },
  ];

  function showGroup(show, today) {
    const s = dayNum(show && show.start);
    if (isNaN(s)) return 'undated';
    let e = dayNum(show.end);
    if (isNaN(e) || e < s) e = s;
    const t = dayNum(today);
    if (e >= t) return 'upcoming';
    return t - e <= 365 ? 'recent' : 'older';
  }

  /** Shows split into Upcoming / Past 12 months / Older / No date, each in a sensible order. Empty groups are left out. */
  function groupShows(shows, today) {
    const by = { upcoming: [], recent: [], older: [], undated: [] };
    (shows || []).forEach((s) => by[showGroup(s, today)].push(s));
    const start = (s) => dayNum(s.start);
    by.upcoming.sort((a, b) => start(a) - start(b) || String(a.name).localeCompare(b.name));
    ['recent', 'older'].forEach((k) => by[k].sort((a, b) => start(b) - start(a) || String(a.name).localeCompare(b.name)));
    by.undated.sort((a, b) => String(a.name).localeCompare(b.name));
    return GROUPS.filter((g) => by[g.id].length).map((g) => ({ id: g.id, label: g.label, shows: by[g.id] }));
  }

  function fmtDates(start, end) {
    const a = dayNum(start);
    if (isNaN(a)) return 'Dates not set';
    let b = dayNum(end);
    if (isNaN(b) || b < a) b = a;
    const da = new Date(a * 864e5), db = new Date(b * 864e5);
    const ya = da.getUTCFullYear(), yb = db.getUTCFullYear(), ma = da.getUTCMonth(), mb = db.getUTCMonth();
    const day = (d) => d.getUTCDate();
    if (a === b) return `${day(da)} ${MONTHS[ma]} ${ya}`;
    if (ya === yb && ma === mb) return `${day(da)} to ${day(db)} ${MONTHS[mb]} ${yb}`;
    if (ya === yb) return `${day(da)} ${MONTHS[ma]} to ${day(db)} ${MONTHS[mb]} ${yb}`;
    return `${day(da)} ${MONTHS[ma]} ${ya} to ${day(db)} ${MONTHS[mb]} ${yb}`;
  }

  function ago(ms, now) {
    const m = Math.round(((now == null ? Date.now() : now) - ms) / 60e3);
    if (m < 2) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 48) return `${h} h ago`;
    return `${Math.round(h / 24)} days ago`;
  }

  /* ---------- Rows: status, labels, counts ---------- */

  const STATUS_LABEL = { corporate: 'Can email', check: 'To check', consent: 'Consent needed', pending: 'Checking' };

  function statusOf(row) {
    if (!row || (row.state !== 'done' && row.state !== 'error')) return 'pending';
    return row.emailable === 'corporate' ? 'corporate' : row.emailable === 'check' ? 'check' : 'consent';
  }

  const isGoogle = (row) => !!row && (row.workspace === 'yes' || row.workspace === 'likely');

  /** The same tallies the Apps Script keeps, worked out here so the screen can update while checks run. */
  function countRows(rows) {
    const c = { total: 0, done: 0, corporate: 0, consent: 0, check: 0, google: 0, pending: 0, likely: 0 };
    (rows || []).forEach((r) => {
      c.total++;
      const st = statusOf(r);
      if (st === 'pending') { c.pending++; return; }
      c.done++; c[st]++;
      if (isGoogle(r)) c.google++;
      if (r.legal === 'likely') c.likely++;
    });
    return c;
  }

  function workspaceShort(row) {
    if (statusOf(row) === 'pending') return '';
    return row.workspace === 'yes' ? 'Google Workspace' : row.workspace === 'likely' ? 'Probably Google' : row.workspace === 'no' ? 'Not Google' : 'Mail not known';
  }

  function workspaceLabel(row) {
    if (statusOf(row) === 'pending') return 'Not checked yet';
    const host = row.mailHost ? ` (${row.mailHost})` : '';
    if (row.workspace === 'yes') return 'Uses Google Workspace';
    if (row.workspace === 'likely') return 'Probably Google Workspace, behind a mail filter';
    if (row.workspace === 'no') return row.mailHost ? `Not Google: ${row.mailHost}` : 'Not Google';
    return 'Could not tell' + host;
  }

  function rowSub(row) {
    const st = statusOf(row), bits = [STATUS_LABEL[st]];
    if (st !== 'pending') bits.push(workspaceShort(row));
    if (row.stand) bits.push(`Stand ${row.stand}`);
    return bits.join(', ');
  }

  const TYPE_LABEL = {
    ltd: 'Private limited company', plc: 'Public limited company', llp: 'Limited liability partnership',
    'limited-partnership': 'Limited partnership', 'scottish-partnership': 'Scottish partnership',
    'private-limited-guarant-nsc': 'Company limited by guarantee', 'private-limited-guarant-nsc-limited-exemption': 'Company limited by guarantee',
    'private-unlimited': 'Private unlimited company', 'charitable-incorporated-organisation': 'Charity (CIO)',
    'industrial-and-provident-society': 'Industrial and provident society', 'royal-charter': 'Royal charter body',
    'registered-society-non-jurisdictional': 'Registered society', 'oversea-company': 'Overseas company',
  };
  function companyTypeLabel(type) {
    if (!type) return '';
    return TYPE_LABEL[type] || (String(type).replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase()));
  }

  function companyUrl(no) {
    const n = String(no || '').replace(/\s+/g, '').toUpperCase();
    return /^[A-Z0-9]{8}$/.test(n) ? `https://find-and-update.company-information.service.gov.uk/company/${n}` : '';
  }

  /** One line on how sure we are about the legal entity. */
  function legalLabel(row) {
    const st = statusOf(row);
    if (st === 'pending') return 'Not checked yet';
    const co = row.companyName ? `${row.companyName}, ${row.companyNo}` : '';
    const state = row.companyStatus && row.companyStatus !== 'active' ? `, ${row.companyStatus}` : '';
    if (row.legal === 'verified') return `Confirmed: ${co}${state}`;
    if (row.legal === 'likely') return `Likely match: ${co}${state}`;
    if (row.legal === 'possible') return `Possible match: ${co}${state}`;
    return 'No company found';
  }

  /** What the status means, in words. A guide only. */
  function emailRule(row) {
    const st = statusOf(row);
    if (st === 'pending') return 'Still being checked.';
    if (st === 'corporate') {
      return 'Confirmed as a limited company or LLP. That makes it a corporate subscriber, so you can email its business address without asking first. Say who you are, make the offer relevant to the business and give a way to opt out.';
    }
    if (st === 'check') {
      if (row.legal === 'verified' && row.companyStatus && row.companyStatus !== 'active') return `Companies House shows this company as ${row.companyStatus}. Look again before emailing.`;
      if (row.legal === 'verified') return 'Confirmed company, but it is not a limited company or LLP. Treat it as needing consent.';
      return 'There is a company with a similar name, but it is not confirmed. Confirm it below, or treat this one as needing consent.';
    }
    return 'No limited company was confirmed, so this could be a sole trader or a partnership. Get consent before emailing.';
  }

  function emailKindLabel(kind) {
    return kind === 'generic' ? 'General address' : kind === 'named' ? 'Named person' : kind === 'freemail' ? 'Personal address' : '';
  }

  const FILTERS = [
    { id: 'all', label: 'All' },
    { id: 'corporate', label: 'Can email' },
    { id: 'consent', label: 'Consent needed' },
    { id: 'check', label: 'To check' },
    { id: 'google', label: 'Google Workspace' },
  ];

  const rank = (r) => ({ corporate: 0, check: 1, consent: 2, pending: 3 }[statusOf(r)] * 2 + (isGoogle(r) ? 0 : 1));

  /** Filter, search and order. The best prospects (can email, then Google Workspace) come first. */
  function filterRows(rows, opts) {
    const f = (opts && opts.filter) || 'all', q = String((opts && opts.q) || '').trim().toLowerCase();
    let out = (rows || []).filter((r) => {
      if (f === 'google') return isGoogle(r);
      if (f !== 'all' && statusOf(r) !== f) return false;
      return true;
    });
    if (q) out = out.filter((r) => [r.name, r.domain, r.contact, r.email, r.companyName, r.stand, r.category].some((v) => String(v || '').toLowerCase().indexOf(q) >= 0));
    return out.slice().sort((a, b) => rank(a) - rank(b) || String(a.name).localeCompare(String(b.name), 'en', { sensitivity: 'base' }));
  }

  function filterCount(c, id) {
    return id === 'all' ? c.total : id === 'google' ? c.google : c[id] || 0;
  }

  /** The sentence under the exhibition name. */
  function summary(c, show) {
    if (!c || !c.total) {
      if (show && (show.status === 'blocked' || show.status === 'empty' || show.status === 'error') && show.statusNote) return show.statusNote;
      return 'No exhibitors yet. Load the exhibitor list, or paste it in.';
    }
    if (c.pending) {
      let s = `Checked ${c.done} of ${c.total} exhibitors so far.`;
      if (c.corporate) s += ` ${c.corporate} can be emailed without asking first.`;
      return s;
    }
    let s = c.corporate ? `${c.corporate} of ${c.total} exhibitors can be emailed without asking first.` : `None of the ${plural(c.total, 'exhibitor')} can be emailed without asking first yet.`;
    const parts = [];
    if (c.consent) parts.push(`${c.consent} ${c.consent === 1 ? 'needs' : 'need'} consent`);
    if (c.check) parts.push(`${c.check} ${c.check === 1 ? 'needs' : 'need'} a quick check`);
    if (parts.length) s += ` ${parts.join(' and ')}.`;
    if (c.google) s += ` ${c.google} ${c.google === 1 ? 'appears' : 'appear'} to use Google Workspace.`;
    return s;
  }

  /* ---------- Sectors ---------- */

  const SECTOR_PRESETS = ['Baby and toddler', 'Whisky and spirits', 'Arts and crafts', 'Food and drink', 'Weddings', 'Gardening', 'Pets', 'Home and interiors', 'Health and wellbeing', 'Toys and games', 'Fashion and beauty', 'Motoring'];

  function cleanSector(s) {
    const t = String(s || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
  }

  /** Reuse the spelling of an existing sector when the new one differs only by case. */
  function matchSector(name, shows) {
    const n = cleanSector(name);
    const hit = (shows || []).find((s) => String(s.sector).toLowerCase() === n.toLowerCase());
    return hit ? hit.sector : n;
  }

  function sectorsFrom(shows) {
    const by = {};
    (shows || []).forEach((s) => {
      const k = s.sector || 'General';
      const o = by[k] = by[k] || { name: k, shows: 0, total: 0, corporate: 0, google: 0, pending: 0 };
      o.shows++;
      const c = s.counts || {};
      o.total += c.total || 0; o.corporate += c.corporate || 0; o.google += c.google || 0; o.pending += c.pending || 0;
    });
    return Object.keys(by).sort((a, b) => a.localeCompare(b)).map((k) => by[k]);
  }

  /** One-tap Google searches, since there is no free search service to call. */
  function searchLinks(sector, now) {
    const y = (now instanceof Date ? now : new Date(now == null ? Date.now() : now)).getFullYear();
    const s = cleanSector(sector).toLowerCase();
    const mk = (label, q) => ({ label, url: 'https://www.google.com/search?hl=en&gl=uk&q=' + encodeURIComponent(q) });
    return [
      mk('Upcoming shows', `${s} exhibition UK ${y} dates tickets`),
      mk(`Shows in ${y + 1}`, `${s} show UK ${y + 1}`),
      mk('Past 12 months', `${s} exhibition UK ${y - 1} ${y} exhibitor list`),
      mk('Exhibitor lists', `${s} exhibition UK exhibitor list`),
      mk('Trade shows', `${s} trade show UK exhibitors`),
    ];
  }

  /* ---------- Sharing and links ---------- */

  function validUrl(u) {
    let t = String(u || '').trim();
    if (!t || /\s/.test(t)) return '';
    if (!/^https?:\/\//i.test(t)) t = 'https://' + t;
    const m = /^(https?):\/\/([^/?#:]+)(?::\d+)?([/?#].*)?$/i.exec(t);
    if (!m || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(m[2])) return '';
    return t;
  }

  /** What Android's Share sheet hands us (title, text, url) becomes a link and a name. */
  function parseShared(p) {
    p = p || {};
    const find = (s) => { const m = /https?:\/\/[^\s<>"']+/i.exec(String(s || '')); return m ? m[0].replace(/[).,;]+$/, '') : ''; };
    const url = find(p.url) || find(p.text) || find(p.title);
    const strip = (s) => String(s || '').replace(/https?:\/\/[^\s<>"']+/gi, '').replace(/\s+/g, ' ').trim();
    const name = strip(p.title) || strip(p.text);
    return { url: url ? validUrl(url) : '', name: name.slice(0, 120) };
  }

  /** The Apps Script web app address, in either of its two forms. */
  function validApiUrl(u) {
    const t = String(u || '').trim();
    return /^https:\/\/script\.google\.com\/(?:macros|a\/macros\/[^/]+|a\/[^/]+\/macros)\/s\/[A-Za-z0-9_-]{10,}\/exec$/.test(t) ? t : '';
  }

  function slug(s, max) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max || 40) || 'list';
  }

  /* ---------- Hero: the stand plan ---------- */

  /**
   * One cell per exhibitor, laid out like a hall plan. Best prospects first, so the bright cells gather at the top.
   * Big lists are scaled down to at most `cap` cells, keeping the proportions.
   */
  function planGrid(c, opts) {
    const cap = (opts && opts.cap) || 300, width = (opts && opts.width) || 300, gap = 3;
    const total = (c && c.total) || 0;
    if (!total) return { w: width, h: 0, cells: [], total: 0, scaled: false };
    const raw = [['c', c.corporate || 0], ['k', c.check || 0], ['n', c.consent || 0], ['p', c.pending || 0]];
    const k = total > cap ? cap / total : 1;
    let kinds = raw.map(([id, n]) => [id, n ? Math.max(1, Math.round(n * k)) : 0]);
    let n = kinds.reduce((s, x) => s + x[1], 0);
    // rounding can overshoot a little: trim from the biggest group
    while (n > cap) { kinds.sort((a, b) => b[1] - a[1]); kinds[0][1]--; n--; }
    const order = { c: 0, k: 1, n: 2, p: 3 };
    kinds.sort((a, b) => order[a[0]] - order[b[0]]);
    const cols = n <= 6 ? Math.max(1, n) : Math.min(24, Math.max(4, Math.ceil(Math.sqrt(n * 2))));
    const size = Math.min(48, Math.floor((width - gap * (cols - 1)) / cols));
    const cells = [];
    kinds.forEach(([id, count]) => { for (let i = 0; i < count; i++) cells.push(id); });
    const out = cells.map((id, i) => ({ k: id, x: (i % cols) * (size + gap), y: Math.floor(i / cols) * (size + gap) }));
    const rows = Math.ceil(n / cols);
    return { w: cols * size + (cols - 1) * gap, h: rows * size + (rows - 1) * gap, size, cols, cells: out, total, shown: n, scaled: k < 1 };
  }

  function planLabel(c) {
    return `Stand plan with one square per exhibitor: ${c.corporate || 0} can be emailed, ${c.check || 0} to check, ${c.consent || 0} need consent, ${c.pending || 0} not checked yet`;
  }

  /* ---------- CSV ---------- */

  const CSV_COLUMNS = ['Business', 'Website', 'Contact name', 'Contact source', 'Email', 'Email type', 'Phone', 'Can email without consent',
    'Company match', 'Company name', 'Company number', 'Company status', 'Companies House page', 'Google Workspace', 'Mail host', 'Exhibition', 'Sector', 'Stand', 'Category', 'Notes'];

  function csvCell(v) {
    let s = String(v == null ? '' : v).replace(/\r\n|\r|\n/g, ' ').trim();
    if (/^[=+\-@\t]/.test(s)) s = "'" + s;   // a spreadsheet must never run exhibitor text as a formula
    return /[",]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  const CAN_TXT = { corporate: 'Yes, corporate subscriber', check: 'Check first', consent: 'No, get consent first', pending: 'Not checked yet' };
  const MATCH_TXT = { verified: 'Confirmed', likely: 'Likely', possible: 'Possible', none: 'None found' };
  const WS_TXT = { yes: 'Yes', likely: 'Probably', no: 'No', unknown: 'Unknown' };

  function toCsv(rows, showsById) {
    const lines = [CSV_COLUMNS.map(csvCell).join(',')];
    (rows || []).forEach((r) => {
      const st = statusOf(r), show = (showsById && showsById[r.showId]) || {};
      const done = st !== 'pending';
      const cells = [
        r.name, r.website, r.contact, r.contact ? r.contactSrc : '', r.email, emailKindLabel(r.emailKind), r.phone, CAN_TXT[st],
        done ? MATCH_TXT[r.legal] || '' : '', r.companyName, r.companyNo, r.companyStatus, companyUrl(r.companyNo),
        done ? WS_TXT[r.workspace] || 'Unknown' : '', r.mailHost,
        r._shows ? r._shows.join('; ') : show.name, r._sector || show.sector, r.stand, r.category, [r.note, r._also && r._also.length ? 'Also listed as ' + r._also.join('; ') : ''].filter(Boolean).join('. '),
      ];
      lines.push(cells.map(csvCell).join(','));
    });
    return '﻿' + lines.join('\r\n') + '\r\n';
  }

  const looseName = (n) => String(n || '').toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '').replace(/^the/, '').replace(/(limited|ltd|plc|llp)$/, '');

  /**
   * Several shows in one list: the same website only once, with every show it appeared at.
   * Brands that share a website (a distributor with several names) become one line, and the other names go in the notes.
   */
  function mergeBySite(rows, showsById) {
    const by = new Map();
    (rows || []).forEach((r) => {
      const key = r.domain ? 'd:' + r.domain : 'n:' + looseName(r.name);
      const show = (showsById && showsById[r.showId]) || {};
      const have = by.get(key);
      if (!have) { by.set(key, { best: Object.assign({}, r, { _shows: show.name ? [show.name] : [], _sector: show.sector }), names: [r.name] }); return; }
      const b = have.best;
      if (show.name && b._shows.indexOf(show.name) < 0) b._shows.push(show.name);
      if (have.names.indexOf(r.name) < 0) have.names.push(r.name);
      // keep whichever copy is more useful, but never lose the show list
      if (rank(r) < rank(b) || (rank(r) === rank(b) && !b.email && r.email)) {
        have.best = Object.assign({}, r, { _shows: b._shows, _sector: b._sector || show.sector });
      }
    });
    return Array.from(by.values()).map((m) => {
      const mine = looseName(m.best.name), seen = {};
      m.best._also = m.names.filter((n) => { const k = looseName(n); if (k === mine || seen[k]) return false; seen[k] = 1; return true; });
      return m.best;
    });
  }

  /* ---------- Daily usage (the Today line in Settings, and the warning) ---------- */

  const WARN_AT = 70;
  const commas = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');

  /**
   * What the sheet reports as used over the last 24 hours, ready to show.
   * Returns null when there is nothing usable, so the screen simply shows no usage rather than a wrong one.
   */
  function usage(u) {
    const lim = u && u.limits;
    if (!lim || !(+lim.fetches > 0) || !(+lim.bgMinutes > 0)) return null;
    const one = (used, limit, text) => {
      used = Math.max(0, +used || 0);
      const exact = (used / limit) * 100;
      return { used, limit, pct: Math.min(100, Math.round(exact)), width: used > 0 ? Math.min(100, Math.max(1.5, exact)) : 0, text };
    };
    const f = +u.fetches || 0, b = +u.bgMinutes || 0;
    const bgShown = b > 0 && b < 1 ? 'under 1' : commas(b);
    const fetches = one(f, +lim.fetches, `${commas(f)} of ${commas(lim.fetches)}`);
    const bg = one(b, +lim.bgMinutes, `${bgShown} of ${commas(lim.bgMinutes)}`);
    const warn = fetches.used / fetches.limit * 100 >= WARN_AT || bg.used / bg.limit * 100 >= WARN_AT;
    let message = '';
    if (warn) {
      message = fetches.used / fetches.limit >= bg.used / bg.limit
        ? `Web requests are at ${fetches.pct}% of Google's daily limit. Checking stops if it runs out, then picks up again.`
        : `Background time is at ${bg.pct}% of Google's daily limit. Checks while the app is closed stop if it runs out, then pick up again.`;
    }
    return { fetches, bg, warn, message };
  }

  return {
    esc, plural, dayNum, todayIso, GROUPS, showGroup, groupShows, fmtDates, ago,
    STATUS_LABEL, statusOf, isGoogle, countRows, workspaceShort, workspaceLabel, rowSub, companyTypeLabel, companyUrl, legalLabel, emailRule, emailKindLabel,
    FILTERS, filterRows, filterCount, summary,
    SECTOR_PRESETS, cleanSector, matchSector, sectorsFrom, searchLinks,
    validUrl, parseShared, validApiUrl, slug, planGrid, planLabel,
    CSV_COLUMNS, csvCell, toCsv, mergeBySite, usage,
  };
});
