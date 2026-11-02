// The side panel runs the whole flow and survives every page load: Next lead opens and fills
// the next Notion lead, the page script reports the send, and Sent is logged to Notion.
// Who you are and what you send live in config/profile.json; the bridge serves it.
const BRIDGE = 'http://127.0.0.1:8131';
const T = self.QF_TEXT;
let P = null; // the profile, once the bridge has sent it
const $ = id => document.getElementById(id);
const COLORS = { '#16a34a': 'var(--green)', '#7c3aed': 'var(--purple)', '#f59e0b': 'var(--amber)', '#dc2626': 'var(--red)' };

// lead: the Notion lead in tabId (null on a page that isn't in the queue)
// mail: the Gmail compose tab opened for this lead {tabId, account, expect, to}
const S = { lead: null, tabId: null, loading: false, submitted: false, logged: false, passed: [], unclearTimer: null, mail: null, askMail: false };

async function post(path, body = {}) {
  try {
    const r = await fetch(BRIDGE + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Quickfill': '1' }, body: JSON.stringify(body) });
    return await r.json();
  } catch (e) {
    return { error: `bridge unreachable (${e.message}). ${BRIDGE_HELP}` };
  }
}
const BRIDGE_HELP = 'Is the bridge running? Mac: launchctl list | grep form-quickfill (scripts/install_mac.sh), or run python3 bridge/bridge.py. Then python3 scripts/doctor.py.';

// The profile, fetched once (and again after an error, so fixing the file and retrying works).
async function ready() {
  if (P) return true;
  const p = await post('/profile');
  if (p.error) { note(RED, `Can't load your profile: ${p.error}`); return false; }
  P = p;
  renderChips();
  showMailFrom();
  return true;
}

// ---------- notes ----------
function clearNotes() { $('notes').textContent = ''; }
function note(color, text) {
  const d = document.createElement('div');
  d.style.color = COLORS[color] || color;
  d.textContent = text;
  $('notes').appendChild(d);
  return d;
}
const GREEN = '#16a34a', PURPLE = '#7c3aed', AMBER = '#f59e0b', RED = '#dc2626';

// ---------- lead card ----------
function showLead(lead, left) {
  S.lead = lead && lead.id ? lead : null;
  $('agency').value = lead ? lead.agency || '' : '';
  $('first').value = lead ? lead.first_name || '' : '';
  $('evidence').textContent = lead && lead.first_name ? `Founder from the pre-scan: ${lead.evidence || 'no detail'}` : lead && lead.id ? `No founder found on their site, so the greeting is "${P ? T.greeting(P, '') : 'Hey there!'}".` : '';
  $('url').textContent = lead ? lead.url || '' : '';
  if (left != null) $('left').textContent = `${left} left`;
  $('answers').innerHTML = '<span class="evidence">None yet.</span>';
  $('ask').classList.add('hidden');
  S.submitted = S.logged = false;
  S.mail = null;
  renderChips();
  showMailFrom();
}
// Agency name and founder first name as they stand in the panel.
function names() {
  return { a: $('agency').value.trim() || 'your agency', f: $('first').value.trim() };
}

// ---------- page script ----------
async function inPage(tabId, func, args = []) {
  await chrome.scripting.executeScript({ target: { tabId }, func: p => { self.QF_PROFILE = p; }, args: [P] });
  await chrome.scripting.executeScript({ target: { tabId }, files: ['templates.js', 'content.js'] });
  const [res] = await chrome.scripting.executeScript({ target: { tabId }, func, args });
  return res ? res.result : null;
}
const activeTab = async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
// The tab the panel works in: the active one, unless that's the Gmail tab it opened, then the lead's.
async function workTab() {
  const tab = await activeTab();
  if (!S.mail || tab.id !== S.mail.tabId) return tab;
  return (await chrome.tabs.get(S.tabId).catch(() => null)) || tab;
}
// Makes tab the panel's tab, looking its site up in the queue if it's a new one.
async function adoptTab(tab) {
  if (tab.id === S.tabId && S.lead) return;
  const lead = await post('/lead', { host: new URL(tab.url).hostname });
  // A site outside the queue (a careers link to DesignRush, say) keeps the current lead.
  if (!lead.id && S.lead) {
    note(AMBER, `This page is not in the queue, so it stays on ${S.lead.agency}. Mark sent logs it there.`);
    S.tabId = tab.id;
    return;
  }
  showLead(lead.id ? lead : { agency: '', first_name: '', url: tab.url });
  if (!lead.id) note(AMBER, 'This page is not in the queue. Fill works, but Sent will not be logged in Notion.');
  S.tabId = tab.id;
}

async function fillTab(tabId) {
  clearNotes();
  let rep;
  try {
    rep = await inPage(tabId, (a, f) => window.__qf.fill({ agency: a, first: f }), [$('agency').value.trim(), $('first').value.trim()]);
  } catch (e) {
    return note(RED, `Can't fill this page (${e.message}).`);
  }
  if (!rep) return note(RED, 'The page script did not answer. Reload the page and try again.');
  rep.notes.forEach(n => note(n.c, n.t));
  if (!rep.leftovers.length) return note(GREEN, 'Check the form, then Send it yourself.');
  const n = note(PURPLE, `agy is answering ${rep.leftovers.length} other field${rep.leftovers.length === 1 ? '' : 's'}… 0 s`);
  const t0 = Date.now(), clock = setInterval(() => { n.textContent = n.textContent.replace(/\d+ s$/, `${Math.round((Date.now() - t0) / 1000)} s`); }, 1000);
  const tab = await chrome.tabs.get(tabId);
  const [{ result: page }] = await chrome.scripting.executeScript({ target: { tabId }, func: () => ({ title: document.title, text: document.body.innerText.slice(0, 3000) }) });
  const res = await post('/fill', { url: tab.url, title: page.title, page_text: page.text, agency: $('agency').value.trim(), fields: rep.leftovers });
  clearInterval(clock);
  if (res.error) { n.textContent = `agy failed: ${res.error}. Fill the amber fields yourself (the Copy list helps).`; n.style.color = COLORS[RED]; return; }
  const out = await inPage(tabId, v => window.__qf.apply(v), [res.values]);
  n.textContent = `agy filled ${out.answers.length} of ${rep.leftovers.length} (${res.seconds} s).`;
  renderAnswers(out.answers);
  const req = out.left.filter(l => l.required);
  if (req.length) note(AMBER, `Still empty and required: ${req.map(l => l.label.split(' | ').pop()).join('; ')}. Type them in, then Remember this if they'll come up again.`);
  else note(GREEN, 'Check the form, then Send it yourself.');
}

// ---------- queue ----------
function waitForLoad(tabId) {
  return new Promise(resolve => {
    const done = () => { chrome.tabs.onUpdated.removeListener(on); clearTimeout(timer); resolve(); };
    const on = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, 30000);
    chrome.tabs.onUpdated.addListener(on);
  });
}

async function nextLead() {
  if (!await ready()) return;
  if (S.lead && !S.logged) S.passed.push(S.lead.id); // moved on without Sent/Skip: stays Needs Human, just not again this session
  $('next').disabled = true;
  clearNotes();
  const nx = await post('/next', { exclude: S.passed });
  $('next').disabled = false;
  $('next').className = 'primary';
  if (nx.error) return note(RED, nx.error);
  if (nx.done) { showLead(null, 0); return note(GREEN, 'Queue finished: no Needs Human leads left.'); }
  const tab = await workTab();
  showLead(nx, nx.left);
  S.tabId = tab.id;
  S.loading = true;
  note(PURPLE, `Opening ${nx.agency}…`);
  await chrome.tabs.update(tab.id, { url: nx.url, active: true });
  await waitForLoad(tab.id);
  await new Promise(r => setTimeout(r, 1500)); // let the site's own scripts build the form
  S.loading = false;
  fillTab(tab.id);
}

async function fillThisPage() {
  if (!await ready()) return;
  const tab = await workTab();
  await adoptTab(tab);
  fillTab(tab.id);
}

// ---------- email instead ----------
// Your Gmail accounts from profile.json's gmail_accounts: u is the number in Chrome's
// mail.google.com/mail/u/N/ for that account. Each email goes from the next one in turn, and
// the name is what Notion's "Email account" column records.
const accounts = () => (P && P.gmail_accounts && P.gmail_accounts.length ? P.gmail_accounts : [{ name: 'Gmail', email: '', u: 0 }]);
const turn = () => (+localStorage.getItem('qf-mail-turn') || 0) % accounts().length;

function showMailFrom() {
  if (!P) return;
  const to = S.lead && S.lead.email;
  $('mailfrom').textContent = `${to ? `Email: ${to}` : 'No email in Notion, so it looks on the page'}. Next one goes from ${accounts()[turn()].name}.`;
}

// Runs in the lead's page: addresses from mailto links and the text, the site's own domain first.
function pageEmails() {
  const host = location.hostname.replace(/^www\./, '');
  const seen = new Map();
  const add = (raw, w) => {
    const e = raw.replace(/^mailto:/i, '').split('?')[0].trim().toLowerCase();
    if (!/^[\w.+-]+@[\w-]+(\.[\w-]+)+$/.test(e) || /\.(png|jpe?g|gif|svg|webp|avif)$/.test(e) || /sentry|wixpress|example\./.test(e)) return;
    seen.set(e, Math.max(seen.get(e) || 0, w));
  };
  document.querySelectorAll('a[href^="mailto:" i]').forEach(a => {
    const h = a.getAttribute('href');
    try { add(decodeURIComponent(h), 1); } catch { add(h, 1); }
  });
  for (const m of document.body.innerText.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) add(m[0], 0);
  const score = e => {
    const d = e.split('@')[1];
    return seen.get(e) + (d === host || host.endsWith('.' + d) || d.endsWith('.' + host) ? 2 : 0) +
      (/^(hello|hi|hey|hola|hallo|bonjour|info|contact|kontakt|studio|team|office|business|projects?|work|new)@/.test(e) ? 1 : 0) -
      (/^(privacy|legal|press|abuse|no-?reply|support|billing)@/.test(e) ? 2 : 0);
  };
  return [...seen.keys()].sort((a, b) => score(b) - score(a));
}

async function openEmail() {
  if (!await ready()) return;
  const tab = await workTab();
  clearNotes();
  await adoptTab(tab);
  let to = S.lead && S.lead.email, where = 'from Notion';
  if (!to) {
    const found = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: pageEmails }).then(r => r[0].result || []).catch(() => []);
    to = found[0] || '';
    where = found.length > 1 ? `found on this page, which also lists ${found.slice(1, 4).join(', ')}` : 'found on this page';
  }
  const acc = accounts()[turn()];
  localStorage.setItem('qf-mail-turn', (turn() + 1) % accounts().length);
  const { a, f } = names();
  const q = { view: 'cm', fs: 1, to, su: T.text(P, 'subject', f, a), body: T.text(P, 'message', f, a) };
  const url = `https://mail.google.com/mail/u/${acc.u}/?` + Object.entries(q).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const mt = await chrome.tabs.create({ url, index: tab.index + 1 });
  S.mail = { tabId: mt.id, account: acc.name, expect: (acc.email || '').toLowerCase(), to };
  note(PURPLE, to ? `Opened an email to ${to} (${where}) from ${acc.name}.` : `No address in Notion or on this page. Opened a blank email from ${acc.name}: type the address in.`);
  note(PURPLE, 'Send it in Gmail. I\'ll ask once that tab moves on or closes, or click Mark sent.');
  showMailFrom();
}

// ---------- sent / skip ----------
// mail: set when you emailed the lead from Gmail instead of using the form
async function logSent(how, mail = null) {
  if (S.logged) return;
  $('ask').classList.add('hidden');
  clearTimeout(S.unclearTimer);
  if (!S.lead) { S.logged = true; return note(AMBER, 'Sent, but this page is not in the queue, so nothing was logged.'); }
  const tab = await chrome.tabs.get(S.tabId).catch(() => null);
  const res = await post('/sent', { id: S.lead.id, url: tab ? tab.url : S.lead.url, how, ...(mail && { account: mail.account, to: mail.to }) });
  if (res.error) return note(RED, `Couldn't log it in Notion: ${res.error}. Click Mark sent to retry.`);
  S.logged = true;
  if (res.pending) { $('next').className = 'go'; return note(GREEN, `Saved ${S.lead.agency} as sent. Notion is unreachable right now, so the bridge will log it within a minute or two of it coming back. Carry on.`); }
  note(GREEN, `Logged ${S.lead.agency} as Contacted in Notion (${mail ? `emailed from ${mail.account}` : how}). ${res.today} sent today.`);
  $('next').className = 'go';
}
function ask(mail) {
  S.askMail = mail;
  $('ask').classList.remove('hidden');
}

async function skipLead() {
  if (!S.lead) return note(AMBER, 'This page is not in the queue, nothing to skip.');
  const res = await post('/skip', { id: S.lead.id, reason: $('reason').value });
  if (res.error) return note(RED, `Couldn't mark the skip: ${res.error}`);
  S.logged = true;
  nextLead();
}

// The page script reports what happened after you clicked Send.
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'cmd-fill') return void fillThisPage();
  if (msg.type !== 'qf-event' || !sender.tab || sender.tab.id !== S.tabId || S.logged) return;
  if (msg.kind === 'submitted') {
    S.submitted = true;
    note(PURPLE, 'Form submitted, waiting for the confirmation…');
  } else if (msg.kind === 'success') logSent(msg.how);
  else if (msg.kind === 'failed') note(RED, `The form shows an error, so nothing was sent: ${msg.how}`);
  else if (msg.kind === 'unclear') ask(false);
});

// A submit that navigates (thank-you page, redirect) ends the page script, so watch the tab too.
// contact_posted=true is where a Shopify theme's contact form lands after sending.
const THANKS_URL = /thank|success|merci|danke|bedankt|gracias|grazie|confirm|submitted|received|sent|contact_posted/i;
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (tabId !== S.tabId || S.loading || S.logged || !info.url) return;
  if (THANKS_URL.test(new URL(info.url).pathname + new URL(info.url).search)) logSent('thank-you page: ' + new URL(info.url).pathname);
  else if (S.submitted) {
    // Navigated after a submit to a page that doesn't say thanks: ask rather than guess.
    S.unclearTimer = setTimeout(() => { if (!S.logged) ask(false); }, 3000);
  }
});

// The Gmail tab: warn if it opened the wrong account (its title names the address), and ask
// once it leaves the compose screen (Gmail rewrites view=cm to tf=cm on load) or is closed.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  const m = S.mail;
  if (!m || tabId !== m.tabId || S.logged) return;
  if (info.status === 'complete') m.loaded = true;
  const who = info.title && info.title.match(/ - ([\w.+-]+@[\w.-]+) - /);
  if (who && !m.checked && m.expect) {
    m.checked = true;
    if (who[1].toLowerCase() !== m.expect) note(RED, `That Gmail tab is ${who[1]}, not ${m.expect}: Gmail's /u/ numbers have moved. Close it without sending.`);
  }
  if (m.loaded && info.url && !/[?&](view|tf)=cm\b|compose=/.test(info.url)) ask(true);
});
chrome.tabs.onRemoved.addListener(tabId => { if (S.mail && tabId === S.mail.tabId && !S.logged) ask(true); });

// ---------- copy chips ----------
function renderChips() {
  if (!P) return;
  const { a, f } = names();
  const you = P.you || {}, ans = P.answers || {};
  const items = [
    ['Message', T.text(P, 'message', f, a)], ['Short message', T.text(P, 'short', f, a)], ['Subject', T.text(P, 'subject', f, a)],
    ['Name', you.full_name], ['First', you.first_name], ['Last', you.last_name], ['Email', you.email], ['Phone', you.phone],
    ['Company', you.company], ['Website', you.website], ['Job title', you.job_title], ['Country', you.country],
    ['Heard via', ans.how_heard], ['Need', ans.what_needed],
    ...Object.entries(P.copy_links || {}),
  ];
  for (const x of facts.about || []) items.push([x.topic.split(' / ')[0], x.answer]);
  for (const x of facts.learned || []) items.push([x.topic, x.answer]);
  chipList($('chips'), items.filter(([, v]) => v));
}
function renderAnswers(list) {
  if (!list.length) return;
  chipList($('answers'), list.map(x => [x.label.slice(0, 40), x.value]));
}
function chipList(box, items) {
  box.textContent = '';
  for (const [k, v] of items) {
    const b = document.createElement('button');
    b.className = 'chip';
    b.title = v;
    b.innerHTML = '<b></b><span></span>';
    b.querySelector('b').textContent = k;
    b.querySelector('span').textContent = v.length > 38 ? v.slice(0, 38) + '…' : v;
    b.onclick = async () => {
      await navigator.clipboard.writeText(v);
      const old = b.querySelector('b').textContent;
      b.querySelector('b').textContent = 'Copied ✓';
      setTimeout(() => { b.querySelector('b').textContent = old; }, 900);
    };
    box.appendChild(b);
  }
}

// ---------- learned facts ----------
let facts = { about: [], learned: [] };
async function loadFacts() {
  const f = await post('/facts');
  if (!f.error) facts = f;
  const box = $('learned');
  box.textContent = '';
  if (!facts.learned.length) box.innerHTML = '<span class="evidence">Nothing yet. Type an answer into a form, then click Remember this.</span>';
  facts.learned.forEach((x, i) => {
    const d = document.createElement('div');
    d.innerHTML = '<span></span><button title="Forget this">×</button>';
    d.querySelector('span').textContent = `${x.topic}: ${x.answer}`;
    d.querySelector('button').onclick = async () => { await post('/forget', { index: i }); loadFacts(); };
    box.appendChild(d);
  });
  renderChips();
}

async function rememberThis() {
  if (!await ready()) return;
  const tab = await activeTab();
  let fields;
  try { fields = await inPage(tab.id, () => window.__qf.collect()); } catch (e) { return note(RED, `Can't read this page (${e.message}).`); }
  if (!fields || !fields.length) return note(AMBER, 'Nothing you typed yourself is in the form yet.');
  $('remember').disabled = true;
  const n = note(PURPLE, `agy is reading the ${fields.length} answer${fields.length === 1 ? '' : 's'} you typed…`);
  const res = await post('/remember', { url: tab.url, agency: $('agency').value.trim(), fields });
  $('remember').disabled = false;
  if (res.error) { n.textContent = `Remember failed: ${res.error}`; n.style.color = COLORS[RED]; return; }
  n.textContent = `agy: ${res.message}`;
  loadFacts();
}

// ---------- wiring ----------
$('next').onclick = nextLead;
$('fill').onclick = fillThisPage;
$('email').onclick = openEmail;
$('sent').onclick = () => logSent('marked sent by hand', S.mail);
$('askyes').onclick = () => logSent('confirmed by hand', S.askMail ? S.mail : null);
$('askno').onclick = () => { $('ask').classList.add('hidden'); S.submitted = false; note(AMBER, 'Not logged. Fix the form and send again, or Skip.'); };
$('skip').onclick = skipLead;
$('remember').onclick = rememberThis;
for (const id of ['agency', 'first']) {
  $(id).addEventListener('input', () => {
    renderChips();
    if (S.tabId) chrome.scripting.executeScript({ target: { tabId: S.tabId }, func: (a, f) => window.__qf && window.__qf.setNames({ agency: a, first: f }), args: [$('agency').value.trim(), $('first').value.trim()] }).catch(() => {});
  });
}
ready().then(loadFacts);
fetch(BRIDGE + '/health').then(r => r.json()).then(h => { $('left').textContent = h.queue ? `${h.queue} in queue` : ''; (h.problems || []).forEach(p => note(RED, p)); })
  .catch(() => note(RED, `Bridge not running. ${BRIDGE_HELP}`));
