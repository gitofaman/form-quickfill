// Form Quickfill page script: fills the form and watches for the send. It has no UI of its
// own; the side panel drives it through window.__qf and hears back through runtime messages.
// It never submits: you check the form, solve any CAPTCHA and click Send yourself.
// self.QF_PROFILE (config/profile.json) is set by the side panel before every call.
(() => {
  if (window.__qf) return;
  const prof = () => self.QF_PROFILE || {};
  const T = self.QF_TEXT;
  const re = s => { try { return s ? new RegExp(s, 'i') : null; } catch { return null; } };
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ---------- field reading ----------
  const vis = e => {
    const r = e.getBoundingClientRect(), s = getComputedStyle(e);
    return r.width > 3 && r.height > 3 && s.visibility !== 'hidden' && +s.opacity > 0.05 &&
      e.offsetParent !== null && r.left > -500 && r.top > -5000;
  };
  const txt = el => (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g, ' ').trim();

  function labelOf(e) {
    const b = [e.getAttribute('aria-label'), e.placeholder, e.dataset.name, e.name, e.id];
    for (const id of (e.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) b.push(txt(document.getElementById(id)));
    if (e.id) b.push(txt(document.querySelector(`label[for="${CSS.escape(e.id)}"]`)));
    const pl = e.closest('label'); if (pl) b.push(txt(pl));
    // Webflow often puts <label> next to the input without for=; take it only from a wrapper holding this one control.
    let w = e.parentElement;
    for (let i = 0; i < 3 && w; i++, w = w.parentElement) {
      if (w.querySelectorAll('input:not([type=hidden]),select,textarea').length > 1) break;
      const l = w.querySelector('label'); if (l) { b.push(txt(l)); break; }
    }
    return [...new Set(b.filter(Boolean))].join(' | ').slice(0, 160);
  }
  const optionLabel = e => txt(e.id && document.querySelector(`label[for="${CSS.escape(e.id)}"]`)) || txt(e.closest('label')) || e.value;
  function groupBox(els) {
    let c = els[0].parentElement;
    while (c && !els.every(x => c.contains(x))) c = c.parentElement;
    return c || els[0].parentElement;
  }
  function groupLabel(els) {
    const box = groupBox(els);
    const fs = els[0].closest('fieldset');
    if (fs && fs.querySelector('legend')) return txt(fs.querySelector('legend'));
    const prev = box.previousElementSibling;
    if (prev && txt(prev).length < 150) return txt(prev);
    const head = [...box.querySelectorAll('label,p,div,span,h3,h4,h5')].find(x => !x.querySelector('input') && txt(x) && !els.some(r => optionLabel(r) === txt(x)));
    return (head ? txt(head) : els[0].name || '').slice(0, 150);
  }

  const KINDS = [
    ['trap', /leave.*empty|honeypot|\bhp\b|bot.?field|do not fill/i],
    ['phone', /phone|\btel\b|mobile|telefon|t[ée]l[ée]phone|whatsapp|cell/i],
    ['budget', /budget|price|cost|invest|spend|amount|\brates?\b|salary|compensation/i],
    ['email', /e-?mail|courriel/i],
    ['full', /full.?name|first.?(and|&|-).?last|vor- und nachname|john smith|jane doe/i],
    ['first', /first|vorname|pr[ée]nom|voornaam/i],
    ['last', /last|surname|nachname|achternaam|\bnom de famille/i],
    ['website', /website|url|\bsite|domain|webseite/i],
    ['company', /company|organi[sz]ation|business|firma|firmen|empresa|brand|agency|unternehmen|soci[ée]t[ée]|bedrijf/i],
    ['subject', /subject|topic|betreff|regarding|objet|onderwerp/i],
    ['message', /message|details|tell us|describe|nachricht|comment|how can we|inquiry|enquiry|brief|bericht/i],
    ['jobtitle', /job|title|role|position|funktion/i],
    ['hear', /hear|find us|found us|referr|source/i],
    ['service', /service|need|interest|looking for|help with|reason|category|scope|type/i],
    ['country', /country|location|city|land|pays/i],
    ['timeline', /timeline|deadline|start|when|launch|timeframe|date/i],
    ['file', /file|upload|attach|resume|\bcv\b/i],
    ['consent', /privacy|consent|agree|terms|gdpr|policy|datenschutz|accept/i],
    ['news', /newsletter|subscribe|updates|marketing|resources/i],
    ['name', /name|naam|\bnom\b/i],
  ];
  function kindOf(e, L) {
    const t = (e.type || '').toLowerCase();
    if (t === 'email') return 'email';
    if (t === 'tel') return 'phone';
    if (t === 'file') return 'file';
    if (t === 'url') return 'website';
    if (t === 'date' || t === 'datetime-local') return 'timeline';
    let k = 'unknown';
    for (const [n, r] of KINDS) if (r.test(L)) { k = n; break; }
    // The first textarea gets the outreach message; any later one is a question for agy.
    if (e.tagName === 'TEXTAREA' && k !== 'budget') k = S.msgEl ? 'unknown' : 'message';
    if (e.tagName === 'SELECT' && [...e.options].some(o => /[$€£]\s?\d|\d\s?k\b/i.test(o.text))) k = 'budget';
    return k;
  }

  // ---------- filling ----------
  const S = { form: null, msgEl: null, msgSet: '', subjEl: null, subjSet: '', leftovers: new Map(), ours: new Map(), agency: '', first: '', notes: [] };
  const setVal = (e, v) => {
    const proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement : e.tagName === 'SELECT' ? HTMLSelectElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, 'value').set.call(e, v);
    for (const ev of ['input', 'change', 'blur']) e.dispatchEvent(new Event(ev, { bubbles: true }));
    S.ours.set(e, e.value);
  };
  const tick = e => { if (!e.checked) e.click(); };
  const GREEN = '#16a34a', PURPLE = '#7c3aed', AMBER = '#f59e0b', RED = '#dc2626';
  const mark = (el, color) => { el.style.setProperty('outline', `2px solid ${color}`, 'important'); el.style.setProperty('outline-offset', '2px', 'important'); };
  const note = (c, t) => { if (!S.notes.some(n => n.t === t)) S.notes.push({ c, t }); };

  function pickForm() {
    const forms = [...document.querySelectorAll('form')].filter(f => [...f.querySelectorAll('textarea')].some(vis));
    if (forms.length) return forms.sort((a, b) => b.elements.length - a.elements.length)[0];
    const ta = [...document.querySelectorAll('textarea')].find(vis);
    if (ta) { let c = ta.parentElement; while (c && c !== document.body && c.querySelectorAll('input,select,textarea').length < 3) c = c.parentElement; return c; }
    const any = [...document.querySelectorAll('form')].filter(f => [...f.querySelectorAll('input,select')].filter(vis).length >= 3);
    return any.sort((a, b) => b.elements.length - a.elements.length)[0] || null;
  }

  function writeMessage() {
    const p = prof(), a = S.agency, f = S.first;
    if (S.msgEl && (S.msgEl.value === S.msgSet || !S.msgEl.value)) {
      const full = T.text(p, 'message', f, a), short = T.text(p, 'short', f, a), tiny = T.text(p, 'tiny', f, a), ml = +S.msgEl.maxLength;
      const v = !(ml > 0) || ml >= full.length ? full : ml >= short.length ? short : tiny;
      setVal(S.msgEl, v.slice(0, ml > 0 ? ml : undefined)); S.msgSet = S.msgEl.value;
      if (v !== full) note(AMBER, `Message box limit is ${ml} characters, so it got the ${v === short ? 'short' : 'tiny'} version${v.length > ml ? ', cut off' : ''}. Read it before sending.`);
    }
    if (S.subjEl && (S.subjEl.value === S.subjSet || !S.subjEl.value)) { setVal(S.subjEl, T.text(p, 'subject', f, a)); S.subjSet = S.subjEl.value; }
  }

  function addLeft(el, kind, label, required, options) {
    const id = 'f' + S.leftovers.size;
    S.leftovers.set(id, { el, kind, label, required, options });
    mark(kind === 'radio' || kind === 'checkbox-group' ? groupBox(el) : el, AMBER);
  }

  function fill({ agency, first }) {
    S.agency = agency || ''; S.first = first || ''; S.notes = [];
    const f = pickForm();
    if (!f) return { ok: false, notes: [{ c: RED, t: 'No visible form with a message box here. Open the form (tab, button, popup) and click Fill this page.' }], leftovers: [] };
    const prevMsg = S.msgEl, prevMsgSet = S.msgSet, prevSubj = S.subjEl, prevSubjSet = S.subjSet;
    S.form = f; S.leftovers.clear(); S.msgEl = S.subjEl = null;
    if (document.querySelector('.g-recaptcha,.h-captcha,iframe[src*=recaptcha],iframe[src*=hcaptcha],altcha-widget')) note(AMBER, 'CAPTCHA on the page: solve it yourself before sending.');

    const p = prof(), you = p.you || {}, ans = p.answers || {}, pref = p.prefer_options || {};
    const V = { full: you.full_name, name: you.full_name, first: you.first_name, last: you.last_name, email: you.email, company: you.company, website: you.website, jobtitle: you.job_title, hear: ans.how_heard, service: ans.what_needed };
    const radios = {}, boxes = {};
    let filled = 0, seen = 0, id = 0;
    for (const e of f.querySelectorAll('input,select,textarea')) {
      const t = (e.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset'].includes(t) || /turnstile|recaptcha|captcha/i.test(e.name)) continue;
      const L = labelOf(e), req = e.required || e.getAttribute('aria-required') === 'true', k = kindOf(e, L);
      if (!vis(e) && !['checkbox', 'radio'].includes(t) && e.tagName !== 'SELECT') continue; // honeypots (or the site's own hidden fields): never touch
      seen++;
      if (t === 'radio') { (radios[e.name || 'r' + id++] ||= []).push(e); continue; }
      if (t === 'checkbox') {
        if (k === 'consent' || (req && k !== 'news')) { tick(e); mark(e, GREEN); filled++; }
        else if (k !== 'news') (boxes[e.name || 'c' + id++] ||= []).push(e);
        continue;
      }
      if (k === 'message' && !S.msgEl) { S.msgEl = e; S.msgSet = e === prevMsg ? prevMsgSet : ''; filled++; mark(e, GREEN); continue; }
      if (k === 'subject' && !S.subjEl) { S.subjEl = e; S.subjSet = e === prevSubj ? prevSubjSet : ''; filled++; mark(e, GREEN); continue; }
      if (e.value && e.tagName !== 'SELECT') continue; // leave anything already typed
      if (k === 'phone') {
        if (you.phone) { setVal(e, you.phone); mark(e, GREEN); filled++; }
        else if (req) { mark(e, RED); note(RED, `Required phone field (${L.slice(0, 40)}). Type it yourself or skip this form (no phone in your profile).`); }
        continue;
      }
      if (k === 'file') { if (req) { mark(e, RED); note(RED, `Required file upload (${L.slice(0, 40)}): attach it yourself or skip.`); } continue; }
      if (e.tagName === 'SELECT') {
        if (e.selectedIndex > 0) continue;
        const opts = [...e.options].filter(o => o.value && !o.disabled);
        const want = k === 'hear' ? re(pref.hear) : k === 'service' ? re(pref.service) : k === 'country' && you.country ? new RegExp('^' + esc(you.country) + '$', 'i') : null;
        const hit = want && opts.find(o => want.test(o.text));
        if (hit) { setVal(e, hit.value); mark(e, GREEN); filled++; continue; }
        if (req || ['service', 'hear', 'unknown', 'timeline', 'country', 'budget'].includes(k)) addLeft(e, 'select', L, req, opts.map(o => o.text.trim()));
        continue;
      }
      // Rates, budgets, odd questions: agy answers them from the facts (learned ones included) or leaves them.
      if (['budget', 'unknown', 'message', 'subject'].includes(k)) { addLeft(e, 'text', L, req); continue; }
      if (k === 'country') { if (req && you.country) { setVal(e, you.country); mark(e, GREEN); filled++; } else if (req) addLeft(e, 'text', L, req); continue; }
      if (k === 'timeline') { if (req) addLeft(e, t === 'date' ? 'date' : 'text', L, req); continue; }
      if (!V[k]) { addLeft(e, 'text', L, req); continue; } // not in your profile: agy tries, from the facts
      setVal(e, V[k]); mark(e, GREEN); filled++;
    }
    for (const els of Object.values(radios)) {
      if (els.some(r => r.checked) || (!els.some(vis) && !els.some(r => vis(r.closest('label') || r)))) continue;
      addLeft(els, 'radio', groupLabel(els), els.some(r => r.required), els.map(optionLabel));
    }
    for (const els of Object.values(boxes)) {
      if (els.length < 2 || els.some(c => c.checked)) continue;
      addLeft(els, 'checkbox-group', groupLabel(els), false, els.map(optionLabel));
    }
    writeMessage();
    (S.msgEl || f).scrollIntoView({ block: 'center' });
    if (!S.msgEl) note(RED, 'This form has no message box (newsletter, job alert or booking form?). Look for another form on the site.');
    note(GREEN, `Filled ${filled} of ${seen} fields.`);
    watch();
    return { ok: true, notes: S.notes, fieldCount: seen, leftovers: descriptors() };
  }

  const descriptors = () => [...S.leftovers].map(([id, x]) => ({ id, kind: x.kind, label: x.label, required: x.required, ...(x.options ? { options: x.options.slice(0, 40) } : {}) }));

  function apply(values) {
    const norm = s => String(s).toLowerCase().replace(/\s+/g, ' ').trim();
    const pick = (list, v) => list.find(o => norm(o.label) === norm(v)) || list.find(o => norm(o.label).includes(norm(v)) || norm(v).includes(norm(o.label)));
    const answers = [];
    for (const { id, value } of values) {
      const x = S.leftovers.get(id);
      if (!x || value == null || value === '') continue;
      let ok = false;
      if (x.kind === 'select') { const o = pick([...x.el.options].filter(o => o.value).map(o => ({ o, label: o.text })), value); if (o) { setVal(x.el, o.o.value); ok = true; } }
      else if (x.kind === 'radio' || x.kind === 'checkbox-group') { const o = pick(x.el.map(e => ({ o: e, label: optionLabel(e) })), value); if (o) { tick(o.o); ok = true; } }
      else if (x.kind !== 'date' && !x.el.value) { setVal(x.el, value); ok = true; }
      if (ok) { mark(x.kind === 'radio' || x.kind === 'checkbox-group' ? groupBox(x.el) : x.el, PURPLE); S.leftovers.delete(id); answers.push({ label: x.label.split(' | ').pop(), value }); }
    }
    const left = descriptors();
    return { answers, left };
  }

  function setNames({ agency, first }) { S.agency = agency || ''; S.first = first || ''; writeMessage(); }

  // Everything the form holds that this script didn't put there: what "Remember this" learns from.
  function collect() {
    const out = [];
    for (const e of (S.form || document).querySelectorAll('input,select,textarea')) {
      const t = (e.type || '').toLowerCase();
      if (['hidden', 'submit', 'button', 'image', 'reset', 'file', 'password'].includes(t)) continue;
      if (!vis(e) && !['checkbox', 'radio'].includes(t)) continue;
      if ((t === 'checkbox' || t === 'radio') && !e.checked) continue;
      const value = t === 'checkbox' || t === 'radio' ? optionLabel(e) : e.tagName === 'SELECT' ? (e.options[e.selectedIndex] || {}).text : e.value;
      if (!value || S.ours.get(e) === e.value) continue;
      out.push({ label: t === 'radio' || t === 'checkbox' ? groupLabel([e]) : labelOf(e), value: String(value).slice(0, 500) });
    }
    return out;
  }

  // ---------- send detection ----------
  // Success / error blocks of the common form builders: Webflow, Contact Form 7, WPForms,
  // Gravity Forms, HubSpot. Anything else falls back to "the form went away and the page says thanks".
  const DONE = '.w-form-done, .wpcf7 form.sent .wpcf7-response-output, .wpforms-confirmation-container, .gform_confirmation_message, .submitted-message, .hs-form__thankyou-message';
  const FAIL = '.w-form-fail, .wpcf7 form.invalid .wpcf7-response-output, .wpcf7 form.failed .wpcf7-response-output';
  const THANKS = /thank|merci|danke|bedankt|gracias|grazie|obrigad|tack|received|we'?ll be in touch|we will get back|success|submitted|envoy[ée]|gesendet|verzonden/i;
  let watching = false;
  function watch() {
    if (watching) return;
    watching = true;
    const tell = (kind, how) => chrome.runtime.sendMessage({ type: 'qf-event', kind, how }).catch(() => {});
    document.addEventListener('submit', () => {
      tell('submitted');
      const t0 = Date.now();
      const poll = setInterval(() => {
        const done = [...document.querySelectorAll(DONE)].find(vis);
        const fail = [...document.querySelectorAll(FAIL)].find(vis);
        const gone = S.form && (!S.form.isConnected || !vis(S.form));
        if (done) { clearInterval(poll); return tell('success', 'success message: ' + txt(done).slice(0, 60)); }
        if (fail) { clearInterval(poll); return tell('failed', txt(fail).slice(0, 80)); }
        if (gone && THANKS.test(document.body.innerText.slice(0, 20000))) { clearInterval(poll); return tell('success', 'form replaced by a thank-you message'); }
        if (Date.now() - t0 > 15000) { clearInterval(poll); tell('unclear'); }
      }, 500);
    }, true);
  }

  window.__qf = { fill, apply, setNames, collect };
})();
