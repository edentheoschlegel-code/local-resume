/* LocalResume — 100% in-browser resume builder. No network at runtime.
 * pdf-lib (window.PDFLib) builds the exported PDF. All data lives in
 * localStorage on this device only.
 *
 * SECURITY: every field here is attacker-controlled (name, bullets, school
 * names, etc.), so dynamic strings are ALWAYS written via textContent —
 * never interpolated into innerHTML. A strict CSP (see index.html) enforces
 * the no-upload promise at the browser level. */
"use strict";

// pdf-lib (~200KB) is lazy-loaded on the first PDF export — most visitors never
// export, so it stays out of the initial page load. The service worker caches it
// after first use (offline export works once you've exported online once). These
// are populated by ensurePdfLib() before any export runs. (DOCX export uses jszip,
// which stays eager since it's small.)
let PDFDocument, rgb, StandardFonts;
let _pdfLibPromise = null;
function ensurePdfLib() {
  if (window.PDFLib) {
    if (!PDFDocument) ({ PDFDocument, rgb, StandardFonts } = window.PDFLib);
    return Promise.resolve();
  }
  if (!_pdfLibPromise) {
    _pdfLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "lib/pdf-lib.min.js"; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => { _pdfLibPromise = null; reject(new Error("pdf-lib failed to load")); };
      document.head.appendChild(s);
    });
  }
  return _pdfLibPromise.then(() => { ({ PDFDocument, rgb, StandardFonts } = window.PDFLib); });
}
const STORAGE_KEY = "localresume.v1";
// Soft upper bound shown by the Professional-summary character counter. Matches
// the Resume Score's "good length" band upper bound (200–600 chars). Advisory
// only — nothing is ever truncated at this length.
const SUMMARY_SOFT_MAX = 600;

// ── DOM helpers (textContent-only for anything not a developer constant) ──
const $ = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; };
const txt = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

// ── Accessibility helpers ──────────────────────────────────────────────
// Marks a persistent container as a screen-reader live region so text
// injected into it later (via status()/renderJobMatch/etc.) is announced.
// The node stays in the DOM across re-renders of its children, which is what
// AT needs to actually fire the announcement (a freshly-inserted live region
// with content is unreliable across screen readers).
function markLiveRegion(node) {
  node.setAttribute("role", "status");
  node.setAttribute("aria-live", "polite");
  node.setAttribute("aria-atomic", "true");
  return node;
}

// pdf-lib's standard fonts only support WinAnsi — strip anything outside it
// so drawText never throws on emoji/exotic unicode a user pastes in. WinAnsi
// (cp1252) DOES include common "smart" typography (en/em dash, curly quotes,
// bullet, ellipsis) even though their Unicode code points sit outside the
// Latin-1 block, so those are explicitly allow-listed too. Multi-line text
// MUST be split on "\n" before calling this per-line, never after — this
// function strips newlines, so calling it first would collapse lines.
const pdfSafe = (s) => String(s || "").replace(/[^\x20-\x7E\xA0-\xFF–—‘’“”•…]/g, "");
// Truncates text to fit maxWidth at the given font/size using real glyph
// widths, not a flat character count, so PDF text never overflows its column.
function fitText(font, text, size, maxWidth) {
  if (font.widthOfTextAtSize(text, size) <= maxWidth) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (font.widthOfTextAtSize(text.slice(0, mid) + "…", size) <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

// ── Storage (all state lives on-device; corrupt/missing data never crashes the app) ──
const str = (v, fallback = "") => (typeof v === "string" ? v : fallback);
function sanitizeExperience(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    company: str(raw.company), title: str(raw.title), location: str(raw.location),
    start: str(raw.start), end: str(raw.end), current: !!raw.current,
    bullets: Array.isArray(raw.bullets) ? raw.bullets.filter((b) => typeof b === "string") : [],
  };
}
function sanitizeEducation(raw) {
  if (!raw || typeof raw !== "object") return null;
  return { school: str(raw.school), degree: str(raw.degree), field: str(raw.field), start: str(raw.start), end: str(raw.end) };
}
// A saved tailored version: a NAMED snapshot of the résumé fields
// (template/personal/experience/education/skills/coverLetter). The snapshot is
// itself run through sanitizeSnapshot() so a version can never smuggle in a
// hostile shape when reloaded from disk. Old saved states have no `versions`
// key; sanitizeState() defaults them to [] — fully backward-compatible.
let versionIdSeq = 0;
function makeVersionId() {
  // Stable-enough unique id without any network/crypto dependency. Monotonic
  // counter guards against two versions minted in the same millisecond.
  return "v" + Date.now().toString(36) + "-" + (++versionIdSeq).toString(36);
}
// The résumé-content subset of a full state (everything a version snapshots).
// Reuses the exact same field-level sanitizers as the live state so a loaded
// snapshot is indistinguishable from a freshly-sanitized working résumé.
function sanitizeSnapshot(raw) {
  const s = sanitizeState(raw);
  return {
    template: s.template, personal: s.personal, experience: s.experience,
    education: s.education, skills: s.skills, coverLetter: s.coverLetter,
  };
}
function sanitizeVersion(raw) {
  if (!raw || typeof raw !== "object") return null;
  const name = str(raw.name).trim();
  if (!name) return null; // a nameless version is unusable in the list — drop it
  return {
    id: str(raw.id) || makeVersionId(),
    name: name.slice(0, 80),
    savedAt: str(raw.savedAt),
    snapshot: sanitizeSnapshot(raw.snapshot),
  };
}
function blankState() {
  return {
    template: "classic",
    personal: { name: "", role: "", email: "", phone: "", location: "", website: "", summary: "" },
    experience: [{ company: "", title: "", location: "", start: "", end: "", current: false, bullets: [""] }],
    education: [{ school: "", degree: "", field: "", start: "", end: "" }],
    skills: [],
    coverLetter: { recipientName: "", company: "", greeting: "", body: "" },
    versions: [],
  };
}
// A neutral, fictional starter resume used by "Start from an example". It only
// ever populates the EXISTING state fields (name/role/contact/summary/
// experience/education/skills) through the normal save path — it adds no new
// persisted field. The persona is invented (Jordan Rivera, Product Designer)
// and is NOT a real person; every bullet is quantified and opens with a strong
// action verb so the example doubles as a "good resume" reference.
function sampleResumeState() {
  return {
    name: "Jordan Rivera",
    role: "Product Designer",
    email: "jordan.rivera@example.com",
    phone: "(555) 000-0000",
    location: "Austin, TX",
    website: "linkedin.com/in/jordan-rivera-example",
    summary: "Product designer with 6 years turning complex workflows into simple, usable products across fintech and SaaS. I pair research with fast prototyping to ship interfaces that measurably move retention, conversion, and satisfaction.",
    experience: [
      {
        company: "Alderpoint Software", title: "Senior Product Designer",
        location: "Austin, TX", start: "Mar 2021", end: "", current: true,
        bullets: [
          "Led the redesign of the onboarding flow, lifting activation 32% and cutting time-to-first-value from 9 minutes to under 3.",
          "Shipped a design system adopted by 4 product teams, reducing UI build time by roughly 40%.",
          "Drove usability research with 60+ customers that reshaped the mobile roadmap and raised App Store rating from 3.8 to 4.6.",
        ],
      },
      {
        company: "Fernbrook Labs", title: "Product Designer",
        location: "Remote", start: "Jun 2018", end: "Feb 2021", current: false,
        bullets: [
          "Redesigned the checkout experience, increasing completed purchases 18% and reducing support tickets by 25%.",
          "Built and tested 12 high-fidelity prototypes that shortened stakeholder sign-off from 3 weeks to 5 days.",
        ],
      },
    ],
    education: [
      { school: "Lakemont University", degree: "B.F.A.", field: "Design", start: "2014", end: "2018" },
    ],
    skills: ["User Research", "Figma", "Prototyping", "Design Systems", "Usability Testing", "Accessibility"],
  };
}

function sanitizeState(raw) {
  const fallback = blankState();
  if (!raw || typeof raw !== "object") return fallback;
  const personal = raw.personal && typeof raw.personal === "object" ? raw.personal : {};
  const cl = raw.coverLetter && typeof raw.coverLetter === "object" ? raw.coverLetter : {};
  return {
    template: raw.template === "modern" ? "modern" : raw.template === "editorial" ? "editorial" : raw.template === "executive" ? "executive" : raw.template === "minimal" ? "minimal" : "classic",
    personal: {
      name: str(personal.name), role: str(personal.role), email: str(personal.email), phone: str(personal.phone),
      location: str(personal.location), website: str(personal.website), summary: str(personal.summary),
    },
    experience: Array.isArray(raw.experience) ? raw.experience.map(sanitizeExperience).filter(Boolean) : fallback.experience,
    education: Array.isArray(raw.education) ? raw.education.map(sanitizeEducation).filter(Boolean) : fallback.education,
    skills: Array.isArray(raw.skills) ? raw.skills.filter((s) => typeof s === "string" && s.trim()) : [],
    coverLetter: {
      recipientName: str(cl.recipientName), company: str(cl.company), greeting: str(cl.greeting), body: str(cl.body),
    },
    // Additive + backward-compatible: a pre-versions save has no `versions`
    // key, so old states default cleanly to []. Each entry is deep-sanitized.
    versions: Array.isArray(raw.versions) ? raw.versions.map(sanitizeVersion).filter(Boolean) : [],
  };
}
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return blankState();
    return sanitizeState(JSON.parse(raw));
  } catch { return blankState(); }
}
let state = loadState();
// Which saved version (by id) is currently loaded into the working résumé, so
// the Versions panel can show a "Loaded" badge. null = the working résumé
// hasn't been loaded from any saved version this session. Not persisted — it's
// purely a UI cue for the current session.
let loadedVersionId = null;
let lastSaveError = null;
let saveTimer = null;
function persistNow() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); lastSaveError = null; showAutosaveNote(true); }
  catch (e) { lastSaveError = e; showAutosaveNote(false); }
}
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 400);
}
function showAutosaveNote(ok) {
  const note = $("#autosaveNote");
  if (!note) return;
  note.textContent = ok ? "Saved automatically to this device." : friendly(lastSaveError);
  // Themed error red via --danger: identical #b91c1c in light mode, but the
  // lighter dark-mode value (#f87171) stays readable on the dark card. Falls
  // back to the literal for any engine that can't resolve the var here.
  note.style.color = ok ? "" : "var(--danger, #b91c1c)";
}
function friendly(e) {
  if (e && e.name === "QuotaExceededError") return "Couldn't save — your browser's local storage is full.";
  if (e && e.name) return "Couldn't save — local storage is blocked (this can happen in private browsing).";
  return "Couldn't save right now. Your changes are still on this screen.";
}

// ── Start from an example (free) ───────────────────────────────────────────
// Fills the EXISTING state fields with the fictional sample resume via the
// normal setters + save path (no new persisted field), then rebuilds the editor
// so the live preview and Resume Score update. If the resume already has content
// we confirm first so a real draft is never silently replaced.
function applyStarterExample() {
  const s = sampleResumeState();
  state.personal.name = s.name;
  state.personal.role = s.role;
  state.personal.email = s.email;
  state.personal.phone = s.phone;
  state.personal.location = s.location;
  state.personal.website = s.website;
  state.personal.summary = s.summary;
  // Deep-copy the sample arrays so later edits don't mutate the constant. Runs
  // through sanitizeExperience/Education so the shape matches the save schema.
  state.experience = s.experience.map(sanitizeExperience);
  state.education = s.education.map(sanitizeEducation);
  state.skills = s.skills.slice();
  persistNow();
  buildEditor();
  const msg = $("#editorMsg");
  if (msg) status(msg, "Loaded an example resume — edit any field to make it yours.", "ok");
}

// Small confirm dialog reused for the "replace my draft?" guard. Mirrors the
// vault confirm modal idiom (backdrop + dialog a11y). CSP-safe: textContent only.
function showConfirmModal(title, message, confirmLabel, onConfirm) {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  const heading = txt("h3", null, title); heading.id = "confirmHeading";
  modal.appendChild(heading);
  modal.appendChild(txt("p", "hint", message));
  const goBtn = txt("button", "btn big", confirmLabel); goBtn.type = "button";
  goBtn.onclick = () => { backdrop.remove(); onConfirm(); };
  const cancelBtn = txt("button", "btn ghost", "Cancel"); cancelBtn.type = "button";
  cancelBtn.onclick = () => backdrop.remove();
  const actions = el("div", "pro-actions"); actions.append(goBtn, cancelBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
  setupDialogA11y(backdrop, modal, { labelledBy: "confirmHeading", escCloses: true });
}

// Entry point for the "Start from an example" button. Confirm-before-replace
// when there's real content; otherwise fill straight away.
function startFromExample() {
  if (resumeIsEmpty()) { applyStarterExample(); return; }
  showConfirmModal(
    "Replace with an example?",
    "This replaces what's currently in the editor with a sample resume you can edit. Your current draft will be overwritten.",
    "Replace with example",
    applyStarterExample
  );
}

// Clear the working resume back to a blank page (keeps any saved Pro versions).
// Confirms first so a stray click can't wipe real work.
function startOver() {
  showConfirmModal(
    "Start over?",
    "This clears everything in the editor and returns to a blank resume. Any versions you've saved stay saved.",
    "Clear everything",
    () => {
      const keep = Array.isArray(state.versions) ? state.versions : [];
      state = blankState();
      state.versions = keep;
      scheduleSave();
      buildEditor();
    }
  );
}

// ── Inline compact Resume Score card (editor form column) ────────────────
// A small companion to the full Resume Score view: the same score ring + a
// couple of live checks, right where you're editing. It NEVER computes its own
// score — it calls computeHealth(), the single source the #/score view uses, so
// the two can never disagree. Empty résumé → a gentle "fill it in" nudge.
function buildInlineScoreCard() {
  const panel = el("div", "panel inline-score");
  const head = el("div", "inline-score-head");
  head.appendChild(txt("h3", "inline-score-title", "Resume Score"));
  const link = txt("a", "inline-score-link", "View full score →");
  link.href = "#/score";
  head.appendChild(link);
  panel.appendChild(head);
  const body = el("div"); body.id = "inlineScoreBody"; body.className = "inline-score-body";
  markLiveRegion(body);
  panel.appendChild(body);
  renderInlineScore(body);
  return panel;
}

// Renders the inline score body into `host`. Uses computeHealth() (shared) and
// buildScoreRing() (shared). Shows up to 3 checks — failing first (the useful
// ones), then passing to fill — plus a passing count. Empty state swaps in a
// friendly nudge with no number so an untouched résumé never reads as "0/100".
function renderInlineScore(host) {
  host.innerHTML = "";
  if (resumeIsEmpty()) {
    const empty = el("div", "inline-score-empty");
    empty.appendChild(el("span", "inline-score-empty-ic",
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0Z"/><path d="M12 12l4-3"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/></svg>'));
    empty.appendChild(txt("p", "inline-score-empty-txt", "Fill in your résumé to see your score."));
    host.appendChild(empty);
    return;
  }
  const result = computeHealth();
  const tone = result.score >= 80 ? "good" : result.score >= 50 ? "mid" : "low";
  const top = el("div", `inline-score-top ${tone}`);
  top.appendChild(buildScoreRing(result.score, {
    tone, key: "inline-resume-score", caption: "of 100",
    ariaLabel: `Resume score: ${result.score} out of 100`,
  }));
  const meta = el("div", "inline-score-meta");
  const passed = result.checks.filter((c) => c.ok).length;
  meta.appendChild(txt("span", "inline-score-count tnum", `${passed} of ${result.checks.length} checks passing`));
  // Prefer showing what to fix (failing checks) first; top up with passing ones.
  const failing = result.checks.filter((c) => !c.ok);
  const passing = result.checks.filter((c) => c.ok);
  const shown = failing.concat(passing).slice(0, 3);
  const ul = el("ul", "inline-check-list");
  shown.forEach((c) => {
    const li = el("li", `inline-check ${c.ok ? "good" : "warn"}`);
    const ic = el("span", "inline-check-ic");
    ic.setAttribute("aria-hidden", "true");
    ic.textContent = c.ok ? "✓" : "!";
    li.appendChild(ic);
    const lbl = el("span", "inline-check-label");
    lbl.appendChild(txt("span", "health-sr", c.ok ? "Passed: " : "Needs work: "));
    lbl.appendChild(document.createTextNode(c.label));
    li.appendChild(lbl);
    ul.appendChild(li);
  });
  meta.appendChild(ul);
  top.appendChild(meta);
  host.appendChild(top);
}

// ── On-device Suggestions coach (right rail) ─────────────────────────────
// Honest, on-device coaching. Every item is derived from the EXISTING
// heuristics: failing computeHealth() checks (each carries a real tip + a jump
// to the relevant editor section) and, when a job description is present in Job
// Match, the missing-keyword hints from computeJobMatch(). No AI, no network,
// no "Analyze" button — the list simply reflects the résumé as it stands.

// Static, generic, evergreen recruiter tips. These are widely-known résumé best
// practices, NOT fabricated statistics attributed to LocalResume. Rotated by a
// per-load index so the card feels alive without ever inventing "our data".
const RECRUITER_TIPS = [
  "Résumés with concrete metrics tend to get more interview requests — quantify your wins.",
  "Recruiters skim first. Lead each bullet with a strong action verb (Led, Built, Increased).",
  "Mirror the job posting's language — matching key terms helps you clear ATS filters.",
  "One page per ~10 years of experience keeps a résumé tight and readable.",
  "A short, specific summary beats a long objective — say what you do and the impact you drive.",
];
let recruiterTipIndex = Math.floor(Math.random() * RECRUITER_TIPS.length);

// Which editor section a failing check maps to — so a suggestion can scroll the
// user straight to where they'd fix it. Ids are attached in buildEditor's panels.
const CHECK_TARGETS = {
  contact: "sec-about", summary: "sec-about",
  depth: "sec-experience", metrics: "sec-experience", verbs: "sec-experience",
  skills: "sec-skills", length: "sec-experience",
};

function buildCoachPanel() {
  const panel = el("div", "panel coach-panel");
  const head = el("div", "coach-head");
  head.appendChild(el("span", "coach-head-ic",
    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7c.6.5 1 1.2 1 2h6c0-.8.4-1.5 1-2A7 7 0 0 0 12 2z"/></svg>'));
  head.appendChild(txt("h3", "coach-title", "Résumé coach"));
  panel.appendChild(head);
  panel.appendChild(txt("p", "coach-sub", "On-device tips from your résumé — nothing leaves this device."));
  const body = el("div"); body.id = "coachBody"; body.className = "coach-body";
  markLiveRegion(body);
  panel.appendChild(body);
  renderCoach(body);
  // Static recruiter tip card (rotates per load; generic best-practice, no
  // fabricated stats presented as our own).
  panel.appendChild(buildRecruiterTip());
  return panel;
}

function buildRecruiterTip() {
  const card = el("div", "recruiter-tip");
  const head = el("div", "recruiter-tip-head");
  head.appendChild(el("span", "recruiter-tip-ic",
    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6M10 22h4M8 2h8M12 2v4M12 14a4 4 0 0 0 4-4 4 4 0 0 0-8 0 4 4 0 0 0 4 4z"/></svg>'));
  head.appendChild(txt("span", "recruiter-tip-title", "Recruiter tip"));
  card.appendChild(head);
  card.appendChild(txt("p", "recruiter-tip-body", RECRUITER_TIPS[recruiterTipIndex % RECRUITER_TIPS.length]));
  return card;
}

// Build the actionable suggestion list. Failing Score checks come first (ordered
// by their real weight = impact), each linking to its editor section; then, if a
// job description is loaded, up to a few missing keywords to weave in (linking to
// #/match). All-clear → a positive confirmation state.
function collectSuggestions() {
  const out = [];
  if (resumeIsEmpty()) return out;
  const result = computeHealth();
  result.checks.filter((c) => !c.ok)
    .sort((a, b) => b.weight - a.weight)
    .forEach((c) => {
      out.push({
        kind: "score", weight: c.weight, label: c.label, tip: c.tip,
        target: CHECK_TARGETS[c.id] || null,
      });
    });
  // Missing job-description keywords (only when a match has been run).
  if (jdLastResult && jdLastResult.missing && jdLastResult.missing.length) {
    const miss = jdLastResult.missing.slice(0, 4);
    out.push({
      kind: "keywords", weight: 1.4,
      label: "Add job-matched keywords",
      tip: `The job description mentions ${miss.map((w) => `“${w}”`).join(", ")}${jdLastResult.missing.length > 4 ? ", and more" : ""} — weave the relevant ones into your bullets, summary, or skills.`,
      route: "#/match", routeLabel: "Open Job Match →",
    });
  }
  return out;
}

function renderCoach(host) {
  host.innerHTML = "";
  if (resumeIsEmpty()) {
    const empty = el("div", "coach-empty");
    empty.appendChild(txt("p", "coach-empty-txt", "Start filling in your résumé and tailored, on-device suggestions will appear here."));
    host.appendChild(empty);
    return;
  }
  const items = collectSuggestions().slice(0, 5);
  if (!items.length) {
    const clear = el("div", "coach-clear");
    clear.appendChild(el("span", "coach-clear-ic",
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'));
    clear.appendChild(txt("p", "coach-clear-txt", "Nice — your résumé passes every on-device check. Match it to a specific job to sharpen it further."));
    host.appendChild(clear);
    return;
  }
  const list = el("ul", "coach-list");
  items.forEach((s) => {
    const li = el("li", "coach-item");
    const level = s.weight >= 2 ? "high" : s.weight >= 1.5 ? "medium" : "low";
    const top = el("div", "coach-item-top");
    top.appendChild(txt("span", "coach-item-label", s.label));
    top.appendChild(buildChip(`impact-${level}`, "bolt", `${level.charAt(0).toUpperCase() + level.slice(1)} impact`));
    li.appendChild(top);
    li.appendChild(txt("p", "coach-item-tip", s.tip));
    // Concrete jump: to an editor section (scroll+focus) or to a route (#/match).
    if (s.target) {
      const btn = txt("button", "coach-item-jump", "Go to section →");
      btn.type = "button";
      btn.onclick = () => focusEditorSection(s.target);
      li.appendChild(btn);
    } else if (s.route) {
      const a = txt("a", "coach-item-jump", s.routeLabel || "Open →");
      a.href = s.route;
      li.appendChild(a);
    }
    list.appendChild(li);
  });
  host.appendChild(list);
}

// Scroll a named editor section into view and move focus to it (keyboard/AT).
// Sections are plain panels tagged with a stable id in buildEditor.
function focusEditorSection(id) {
  const sec = document.getElementById(id);
  if (!sec) return;
  try { sec.scrollIntoView({ behavior: "smooth", block: "start" }); } catch { sec.scrollIntoView(); }
  const focusTarget = sec.querySelector("input, textarea, button") || sec;
  try { focusTarget.focus({ preventScroll: true }); } catch { /* older engines */ }
}

// Re-render the inline score card + coach list in place (no full rebuild), on
// every edit. Cheap; safe to call on each keystroke like refreshHealth().
function refreshCoach() {
  const scoreBody = $("#inlineScoreBody");
  if (scoreBody) renderInlineScore(scoreBody);
  const coachBody = $("#coachBody");
  if (coachBody) renderCoach(coachBody);
}

// ── Editor rendering ─────────────────────────────────────────────────────
function buildEditor() {
  const root = $("#editor"); root.innerHTML = "";
  const grid = el("div", "editor-grid");
  const formCol = el("div");
  const previewCol = el("div", "preview-wrap");
  // On-device coaching rail (Suggestions). On wide screens it sits to the right
  // of the preview; on narrow screens the grid collapses and it stacks below the
  // form. Purely derived from the EXISTING heuristics — no network, no AI.
  const railCol = el("div", "coach-rail");
  grid.append(formCol, previewCol, railCol);
  root.appendChild(grid);

  // ── Inline compact Resume Score card (top of the form column) ──
  // Reuses the exact computeHealth() the full Score view uses — same number,
  // never a second definition. Links out to the full #/score view.
  formCol.appendChild(buildInlineScoreCard());

  // ── Start from an example (free) ──
  // Prominent when the resume is empty (kills the blank-page freeze); quietly
  // available as a subtle text button once there's content. Populates existing
  // state fields only — no new persisted field, no Pro gate.
  const empty = resumeIsEmpty();
  const starter = el("div", `panel starter-panel${empty ? " prominent" : ""}`);
  if (empty) {
    const head = el("div", "starter-head");
    head.appendChild(el("span", "starter-ic",
      '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"/><circle cx="12" cy="12" r="3.2"/></svg>'));
    head.appendChild(txt("div", "starter-title", "New here? Start from an example"));
    starter.appendChild(head);
    starter.appendChild(txt("p", "starter-sub", "Load a realistic sample resume, then edit each field to make it yours. Beats staring at a blank page."));
  }
  const starterBtn = txt("button", empty ? "btn" : "btn ghost sm", empty ? "Start from an example" : "Start from an example");
  starterBtn.type = "button";
  starterBtn.id = "starterExampleBtn";
  starterBtn.onclick = startFromExample;
  starter.appendChild(starterBtn);
  // When there's content, offer a quiet "Start over" to wipe back to a blank page.
  if (!empty) {
    const clearBtn = txt("button", "btn ghost sm", "Start over");
    clearBtn.type = "button";
    clearBtn.id = "startOverBtn";
    clearBtn.onclick = startOver;
    starter.appendChild(clearBtn);
  }
  formCol.appendChild(starter);

  // ── Template picker ──
  const tplPanel = el("div", "panel");
  tplPanel.appendChild(txt("h3", null, "Template"));
  const picker = el("div", "template-picker");
  [["classic", "Classic"], ["modern", "Modern"], ["editorial", "Editorial"], ["executive", "Executive"], ["minimal", "Minimal"]].forEach(([id, label]) => {
    const opt = txt("button", `template-opt${state.template === id ? " active" : ""}`, label);
    opt.type = "button";
    opt.setAttribute("aria-pressed", state.template === id ? "true" : "false");
    opt.onclick = () => { state.template = id; scheduleSave(); buildEditor(); };
    picker.appendChild(opt);
  });
  tplPanel.appendChild(picker);
  formCol.appendChild(tplPanel);

  // ── Saved tailored versions (Pro) ──
  formCol.appendChild(buildVersionsPanel());

  // ── Personal info ──
  const pPanel = el("div", "panel"); pPanel.id = "sec-about";
  pPanel.appendChild(txt("h3", null, "About you"));
  pPanel.appendChild(field("Full name", state.personal.name, (v) => { state.personal.name = v; refresh(); }));
  pPanel.appendChild(field("Target role / title", state.personal.role, (v) => { state.personal.role = v; refresh(); }));
  const row1 = el("div", "field-row");
  row1.appendChild(field("Email", state.personal.email, (v) => { state.personal.email = v; refresh(); }, false, { icon: "email" }));
  row1.appendChild(field("Phone", state.personal.phone, (v) => { state.personal.phone = v; refresh(); }, false, { icon: "phone" }));
  pPanel.appendChild(row1);
  const row2 = el("div", "field-row");
  row2.appendChild(field("Location", state.personal.location, (v) => { state.personal.location = v; refresh(); }, false, { icon: "location" }));
  row2.appendChild(field("Website / LinkedIn", state.personal.website, (v) => { state.personal.website = v; refresh(); }, false, { icon: "link" }));
  pPanel.appendChild(row2);
  // Professional summary — with a live character counter. The soft max (600)
  // matches the Resume Score "good length" upper bound (200–600 chars); it never
  // truncates, only advises.
  pPanel.appendChild(field("Professional summary", state.personal.summary, (v) => { state.personal.summary = v; refresh(); }, true, { count: SUMMARY_SOFT_MAX }));
  formCol.appendChild(pPanel);

  // ── Experience ──
  const expPanel = el("div", "panel"); expPanel.id = "sec-experience";
  expPanel.appendChild(txt("h3", null, "Experience"));
  state.experience.forEach((exp, i) => expPanel.appendChild(experienceBlock(exp, i)));
  const addExp = txt("button", "btn ghost sm", "+ Add experience");
  addExp.type = "button";
  addExp.onclick = () => { state.experience.push({ company: "", title: "", location: "", start: "", end: "", current: false, bullets: [""] }); scheduleSave(); buildEditor(); };
  expPanel.appendChild(addExp);
  formCol.appendChild(expPanel);

  // ── Education ──
  const eduPanel = el("div", "panel");
  eduPanel.appendChild(txt("h3", null, "Education"));
  state.education.forEach((edu, i) => eduPanel.appendChild(educationBlock(edu, i)));
  const addEdu = txt("button", "btn ghost sm", "+ Add education");
  addEdu.type = "button";
  addEdu.onclick = () => { state.education.push({ school: "", degree: "", field: "", start: "", end: "" }); scheduleSave(); buildEditor(); };
  eduPanel.appendChild(addEdu);
  formCol.appendChild(eduPanel);

  // ── Skills ──
  const skillsPanel = el("div", "panel"); skillsPanel.id = "sec-skills";
  skillsPanel.appendChild(txt("h3", null, "Skills"));
  const tagList = el("div", "tag-list");
  state.skills.forEach((skill, i) => {
    const tag = el("div", "tag");
    tag.appendChild(txt("span", null, skill));
    const rm = el("button", null, '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>');
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove skill: ${skill}`);
    rm.onclick = () => { state.skills.splice(i, 1); scheduleSave(); buildEditor(); };
    tag.appendChild(rm);
    tagList.appendChild(tag);
  });
  skillsPanel.appendChild(tagList);
  const skillField = el("div", "field"); skillField.style.marginBottom = "0";
  const skillInput = el("input"); skillInput.id = "skillInput"; skillInput.placeholder = "Type a skill and press Enter (e.g. Figma)";
  skillInput.setAttribute("aria-label", "Add a skill");
  skillInput.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    const v = skillInput.value.trim();
    const dupe = state.skills.some((s) => s.toLowerCase() === v.toLowerCase());
    if (v && !dupe) {
      state.skills.push(v); scheduleSave(); buildEditor();
      const refocused = $("#skillInput");
      if (refocused) refocused.focus();
    } else skillInput.value = "";
  });
  skillField.appendChild(skillInput);
  skillsPanel.appendChild(skillField);
  formCol.appendChild(skillsPanel);

  // ── On-device resume health check (free) ──
  formCol.appendChild(buildHealthPanel());

  // ── ATS job-description keyword matcher (free) ──
  formCol.appendChild(buildJobMatchPanel());

  // ── Cover letter (Pro) ──
  formCol.appendChild(buildCoverLetterPanel());

  // ── Export ──
  const actions = el("div", "panel");
  actions.style.cssText = "display:flex; gap:10px; flex-wrap:wrap; align-items:center;";
  const pdfBtn = txt("button", "btn", "Download PDF");
  // Busy state while the PDF builds (first export also lazy-loads pdf-lib).
  pdfBtn.onclick = async () => {
    if (pdfBtn.disabled) return;
    const orig = pdfBtn.textContent; pdfBtn.disabled = true; pdfBtn.textContent = "Generating…";
    try { await doExport(); } finally { pdfBtn.disabled = false; pdfBtn.textContent = orig; }
  };
  const docxBtn = txt("button", "btn ghost", "Export Word (.docx) — Pro"); docxBtn.type = "button"; docxBtn.onclick = doExportDocx;
  // Free third output format: clean, ATS-safe plain text. Copy to clipboard or
  // download as .txt — no Pro gate.
  const copyTxtBtn = txt("button", "btn ghost", "Copy as plain text"); copyTxtBtn.type = "button"; copyTxtBtn.onclick = () => doCopyPlainText(copyTxtBtn);
  const txtBtn = txt("button", "btn ghost", "Download .txt"); txtBtn.type = "button"; txtBtn.onclick = doExportPlainText;
  actions.append(pdfBtn, docxBtn, copyTxtBtn, txtBtn);
  const msgHost = el("div"); msgHost.id = "editorMsg"; msgHost.style.width = "100%";
  markLiveRegion(msgHost);
  actions.appendChild(msgHost);
  const note = txt("div", "autosave-note", "Saved automatically to this device."); note.id = "autosaveNote";
  markLiveRegion(note);
  actions.appendChild(note);
  formCol.appendChild(actions);

  // ── Live preview ──
  previewCol.appendChild(buildPreview());

  // ── On-device Suggestions coach (right rail) ──
  railCol.appendChild(buildCoachPanel());

  function refresh() { scheduleSave(); const st = previewCol.scrollTop; const p = buildPreview(); previewCol.innerHTML = ""; previewCol.appendChild(p); previewCol.scrollTop = st; refreshHealth(); refreshJobMatch(); refreshCoach(); schedulePageFit(); }

  // Initial one-page fit estimate, measured after the first preview paints.
  schedulePageFit();
}

// Measure the one-page fit AFTER layout settles so offsetHeight reflects the
// just-rendered preview, not a stale one. We schedule via rAF (same idiom the
// score ring uses) AND a setTimeout fallback, because rAF callbacks are paused
// while the tab is backgrounded — the timeout guarantees the estimate still
// renders. refreshPageFit() is idempotent, so running twice is harmless.
function schedulePageFit() {
  const run = () => { try { refreshPageFit(); } catch (e) { console.error(e); } };
  requestAnimationFrame(() => requestAnimationFrame(run));
  setTimeout(run, 60);
}

let fieldIdSeq = 0;
// Small inline field decorations — all static developer-constant SVG (no user
// data), so innerHTML here is CSP-safe. `icon` renders a muted glyph inside the
// input's trailing edge (About-you contact fields); `count` renders a live
// "n / max" character counter under a textarea. Neither changes the field's
// binding or value flow — they are presentation only.
const FIELD_ICONS = {
  email: '<path d="M4 6h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z"/><path d="m4 7 8 6 8-6"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.13.96.36 1.9.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.9.34 1.85.57 2.81.7A2 2 0 0 1 22 16.92z"/>',
  location: '<path d="M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0z"/><circle cx="12" cy="10" r="3"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
};
function field(label, value, onChange, isTextarea, opts) {
  opts = opts || {};
  const wrap = el("div", "field");
  const id = `f${++fieldIdSeq}`;
  const labelEl = txt("label", "field-label", label);
  labelEl.htmlFor = id;
  wrap.appendChild(labelEl);
  const input = isTextarea ? el("textarea") : el("input");
  input.id = id;
  input.value = value || "";

  // Optional trailing glyph on single-line contact fields.
  let mount = input;
  if (opts.icon && !isTextarea && FIELD_ICONS[opts.icon]) {
    const shell = el("div", "field-input-wrap");
    input.classList.add("has-icon");
    const ic = el("span", "field-icon",
      `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">${FIELD_ICONS[opts.icon]}</svg>`);
    shell.append(input, ic);
    mount = shell;
  }

  // Optional live character counter (e.g. the Professional summary). Advisory
  // only — it never truncates or blocks input; the max is a soft target and the
  // count turns "over" past it. Announced via a live region for AT.
  let counter = null;
  if (opts.count) {
    counter = el("div", "field-count");
    markLiveRegion(counter);
    const paintCount = () => {
      const n = input.value.length;
      counter.textContent = `${n} / ${opts.count}`;
      counter.classList.toggle("over", n > opts.count);
    };
    input.addEventListener("input", paintCount);
    paintCount();
  }

  input.addEventListener("input", () => onChange(input.value));
  wrap.appendChild(mount);
  if (counter) wrap.appendChild(counter);
  return wrap;
}

function experienceBlock(exp, i) {
  const block = el("div", "entry-block");
  const top = el("div", "entry-top");
  top.appendChild(txt("span", "entry-label", `Role ${i + 1}`));
  if (state.experience.length > 1) {
    const rm = el("button", "rm-entry", '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg> Remove');
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove experience ${i + 1}`);
    rm.onclick = () => { state.experience.splice(i, 1); scheduleSave(); buildEditor(); };
    top.appendChild(rm);
  }
  block.appendChild(top);
  const row1 = el("div", "field-row");
  row1.appendChild(field("Company", exp.company, (v) => { exp.company = v; refreshLive(); }));
  row1.appendChild(field("Title", exp.title, (v) => { exp.title = v; refreshLive(); }));
  block.appendChild(row1);
  const row2 = el("div", "field-row three");
  row2.appendChild(field("Location", exp.location, (v) => { exp.location = v; refreshLive(); }));
  row2.appendChild(field("Start (e.g. Jan 2022)", exp.start, (v) => { exp.start = v; refreshLive(); }));
  row2.appendChild(field("End (or blank if current)", exp.end, (v) => { exp.end = v; refreshLive(); }));
  block.appendChild(row2);
  const curRow = el("label", "checkbox-row");
  const curBox = el("input"); curBox.type = "checkbox"; curBox.checked = exp.current;
  curBox.onchange = () => { exp.current = curBox.checked; scheduleSave(); refreshLive(); };
  curRow.append(curBox, document.createTextNode("I currently work here"));
  block.appendChild(curRow);

  const bulletsWrap = el("div", "bullets");
  exp.bullets.forEach((b, bi) => {
    const cell = el("div", "bullet-cell");
    const row = el("div", "bullet-row");
    const input = el("input"); input.placeholder = "Describe an achievement or responsibility"; input.value = b;
    input.setAttribute("aria-label", "Experience bullet point");
    // Recompute just this bullet's coaching hints on each keystroke (no full
    // rebuild) so the advice tracks what the user is typing, live.
    input.oninput = () => { exp.bullets[bi] = input.value; renderBulletHints(hintHost, input.value); refreshLive(); };
    const rm = el("button", "rm", '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>');
    rm.type = "button";
    rm.setAttribute("aria-label", "Remove bullet");
    rm.onclick = () => { exp.bullets.splice(bi, 1); scheduleSave(); buildEditor(); };
    row.append(input, rm);
    cell.appendChild(row);
    // Inline advisory hints (Action-Verb Coach + Quantify prompter). Live region
    // so the coaching is announced as it changes; never blocks or rewrites.
    const hintHost = el("div", "bullet-hints");
    markLiveRegion(hintHost);
    renderBulletHints(hintHost, b);
    cell.appendChild(hintHost);
    bulletsWrap.appendChild(cell);
  });
  block.appendChild(bulletsWrap);
  const addBullet = txt("button", "btn ghost sm", "+ Add bullet");
  addBullet.type = "button";
  addBullet.onclick = () => { exp.bullets.push(""); scheduleSave(); buildEditor(); };
  block.appendChild(addBullet);
  return block;
}

// Renders the inline, advisory coaching for a single experience bullet into
// `host`: (1) Action-Verb Coach — flags a weak/passive opener and suggests
// strong action verbs; (2) Quantify prompter — flags a bullet with no number/
// metric. Both are purely suggestive; nothing is auto-written. An empty bullet
// shows nothing. Static SVG is a developer constant; all user-derived text goes
// in via textContent (buildBulletHint).
function renderBulletHints(host, text) {
  host.innerHTML = "";
  const t = String(text || "").trim();
  if (!t) return;

  // Action-Verb Coach.
  const weakPhrase = weakOpenerPhrase(t);
  if (weakPhrase || bulletHasWeakOpener(t)) {
    const verbs = STRONG_VERB_SUGGESTIONS.slice(0, 3).join(", ");
    const msg = weakPhrase
      ? `Swap "${weakPhrase}" for a strong verb — e.g. ${verbs}.`
      : `Open with a strong action verb — e.g. ${verbs}.`;
    host.appendChild(buildBulletHint("verb", msg));
  }

  // Quantify-my-impact prompter.
  if (!bulletHasMetric(t)) {
    host.appendChild(buildBulletHint("metric", "Add a metric — a %, $, count, or time."));
  }
}
// One advisory hint chip: an icon + message. `kind` ("verb" | "metric") only
// selects the tint/icon; the icon plus text carry the meaning so colour is
// never the sole signal. `msg` is user-derived, so it is set via textContent.
const BULLET_HINT_ICONS = {
  verb: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
  metric: '<path d="M12 20V10M18 20V4M6 20v-4"/>',
};
function buildBulletHint(kind, msg) {
  const hint = el("div", `bullet-hint ${kind}`);
  const ic = el("span", "bullet-hint-ic",
    `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${BULLET_HINT_ICONS[kind] || BULLET_HINT_ICONS.verb}</svg>`);
  hint.appendChild(ic);
  hint.appendChild(txt("span", "bullet-hint-text", msg));
  return hint;
}

function educationBlock(edu, i) {
  const block = el("div", "entry-block");
  const top = el("div", "entry-top");
  top.appendChild(txt("span", "entry-label", `Education ${i + 1}`));
  if (state.education.length > 1) {
    const rm = el("button", "rm-entry", '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg> Remove');
    rm.type = "button";
    rm.setAttribute("aria-label", `Remove education ${i + 1}`);
    rm.onclick = () => { state.education.splice(i, 1); scheduleSave(); buildEditor(); };
    top.appendChild(rm);
  }
  block.appendChild(top);
  block.appendChild(field("School", edu.school, (v) => { edu.school = v; refreshLive(); }));
  const row = el("div", "field-row");
  row.appendChild(field("Degree", edu.degree, (v) => { edu.degree = v; refreshLive(); }));
  row.appendChild(field("Field of study", edu.field, (v) => { edu.field = v; refreshLive(); }));
  block.appendChild(row);
  const row2 = el("div", "field-row");
  row2.appendChild(field("Start", edu.start, (v) => { edu.start = v; refreshLive(); }));
  row2.appendChild(field("End (or expected)", edu.end, (v) => { edu.end = v; refreshLive(); }));
  block.appendChild(row2);
  return block;
}

function refreshLive() {
  scheduleSave();
  const host = $(".preview-wrap");
  if (!host) return;
  host.innerHTML = "";
  host.appendChild(buildPreview());
  refreshHealth();
  refreshJobMatch();
  refreshCoach();
  schedulePageFit();
}

// ── Live preview ─────────────────────────────────────────────────────────
// True when the resume has essentially nothing to show yet — used to swap the
// blank white paper for a friendly ghost/skeleton so the empty state reads as
// intentional (an affordance), not broken. Pure read over existing state; adds
// no persisted fields.
function resumeIsEmpty() {
  const p = state.personal;
  const anyPersonal = !!(p.name || p.role || p.email || p.phone || p.location || p.website || p.summary);
  const anyExp = state.experience.some((e) => e.company || e.title || (e.bullets || []).some((b) => b && b.trim()));
  const anyEdu = state.education.some((e) => e.school || e.degree || e.field);
  return !(anyPersonal || anyExp || anyEdu || state.skills.length);
}

// Ghost/skeleton preview shown while the resume is empty: soft placeholder lines
// for name/role/contact + a couple of sections, plus a centered affordance. All
// static SVG/markup is a developer constant (no user data), CSP-safe.
function buildPreviewGhost() {
  const card = el("div", `preview ${state.template} preview-ghost`);
  card.setAttribute("aria-hidden", "false");
  const affordance = el("div", "ghost-affordance");
  affordance.appendChild(el("span", "ghost-affordance-ic",
    '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>'));
  affordance.appendChild(txt("div", "ghost-affordance-title", "Your resume builds here as you type"));
  affordance.appendChild(txt("div", "ghost-affordance-sub", "Start with your name in the Editor — the live preview fills in instantly."));
  card.appendChild(affordance);

  const skel = el("div", "ghost-skel"); skel.setAttribute("aria-hidden", "true");
  const line = (w) => { const l = el("span", "ghost-line"); l.style.width = w; return l; };
  const head = el("div", "ghost-head");
  head.appendChild(line("58%")); // name
  head.appendChild(line("34%")); // role
  head.appendChild(line("72%")); // contact
  skel.appendChild(head);
  for (let s = 0; s < 2; s++) {
    const sec = el("div", "ghost-sec");
    sec.appendChild(line("28%")); // section title
    sec.appendChild(line("92%"));
    sec.appendChild(line("80%"));
    sec.appendChild(line("86%"));
    skel.appendChild(sec);
  }
  card.appendChild(skel);
  return card;
}

function buildPreview() {
  if (resumeIsEmpty()) return buildPreviewGhost();
  const card = el("div", `preview ${state.template}`);
  card.appendChild(txt("div", "r-name", state.personal.name || "Your name"));
  if (state.personal.role) card.appendChild(txt("div", "r-role", state.personal.role));
  const contactParts = [state.personal.email, state.personal.phone, state.personal.location, state.personal.website].filter(Boolean);
  if (contactParts.length) card.appendChild(txt("div", "r-contact", contactParts.join("  ·  ")));
  if (state.personal.summary) card.appendChild(txt("div", "r-summary", state.personal.summary));

  const hasExp = state.experience.some((e) => e.company || e.title);
  if (hasExp) {
    const sec = el("div", "r-section");
    sec.appendChild(txt("div", "r-section-title", "Experience"));
    state.experience.forEach((exp) => {
      if (!exp.company && !exp.title) return;
      const entry = el("div", "r-entry");
      const t = el("div", "r-entry-top");
      t.appendChild(txt("div", "r-entry-title", [exp.title, exp.company].filter(Boolean).join(" · ") || "Role"));
      t.appendChild(txt("div", "r-entry-date", [exp.start, exp.current ? "Present" : exp.end].filter(Boolean).join(" – ")));
      entry.appendChild(t);
      if (exp.location) entry.appendChild(txt("div", "r-entry-sub", exp.location));
      const bullets = exp.bullets.filter((b) => b.trim());
      if (bullets.length) {
        const ul = el("ul", "r-bullets");
        bullets.forEach((b) => ul.appendChild(txt("li", null, b)));
        entry.appendChild(ul);
      }
      sec.appendChild(entry);
    });
    card.appendChild(sec);
  }

  const hasEdu = state.education.some((e) => e.school || e.degree);
  if (hasEdu) {
    const sec = el("div", "r-section");
    sec.appendChild(txt("div", "r-section-title", "Education"));
    state.education.forEach((edu) => {
      if (!edu.school && !edu.degree) return;
      const entry = el("div", "r-entry");
      const t = el("div", "r-entry-top");
      t.appendChild(txt("div", "r-entry-title", [edu.degree, edu.field].filter(Boolean).join(", ") || edu.school));
      t.appendChild(txt("div", "r-entry-date", [edu.start, edu.end].filter(Boolean).join(" – ")));
      entry.appendChild(t);
      if (edu.school && (edu.degree || edu.field)) entry.appendChild(txt("div", "r-entry-sub", edu.school));
      sec.appendChild(entry);
    });
    card.appendChild(sec);
  }

  if (state.skills.length) {
    const sec = el("div", "r-section");
    sec.appendChild(txt("div", "r-section-title", "Skills"));
    sec.appendChild(txt("div", "r-skills", state.skills.join("  ·  ")));
    card.appendChild(sec);
  }

  return card;
}

// ── One-page fit estimate (FREE, derived live from the rendered preview) ──
// The on-screen preview column is narrow and its fonts are fixed px, so its live
// height inflates as the column narrows — it is NOT a scaled page. To get an
// honest page count we measure the SAME preview markup at a fixed reference page
// width (Letter at 96dpi = 816px, with the preview's own 40px side padding) in a
// hidden offscreen clone, then divide by a Letter page's printable height. Pure
// measurement — no new state, nothing persisted. Returns null when empty.
const REF_PAGE_W = 816;   // Letter width  @96dpi (8.5in)
const REF_PAGE_H = 1056;  // Letter height @96dpi (11in)
function estimatePageFit() {
  if (resumeIsEmpty()) return null;
  // Build the current resume preview fresh and measure it offscreen at the
  // reference page width so wrapping matches a real printed page, not the column.
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  probe.style.cssText =
    "position:absolute; left:-99999px; top:0; width:" + REF_PAGE_W + "px; visibility:hidden; pointer-events:none;";
  const card = buildPreview();
  if (!card || card.classList.contains("preview-ghost")) return null;
  card.style.width = REF_PAGE_W + "px";
  card.style.minHeight = "0";
  probe.appendChild(card);
  document.body.appendChild(probe);
  const h = card.offsetHeight;
  document.body.removeChild(probe);
  if (!h) return null;
  const pages = h / REF_PAGE_H;
  // Round the human-facing page count up for anything past a hair over a page.
  const pageCount = Math.max(1, Math.ceil(pages - 0.04));
  // Which section is the longest contributor (advisory nudge on WHAT to trim).
  return { pages, pageCount, fits: pageCount <= 1, longest: longestSectionLabel() };
}

// The resume section with the most content, as a friendly label — a purely
// advisory hint about where trimming would help most. Read-only over state.
function longestSectionLabel() {
  const expLen = state.experience.reduce(
    (n, e) => n + (e.company || "").length + (e.title || "").length +
      (e.bullets || []).reduce((s, b) => s + (b || "").length, 0), 0);
  const eduLen = state.education.reduce(
    (n, e) => n + (e.school || "").length + (e.degree || "").length + (e.field || "").length, 0);
  const sumLen = (state.personal.summary || "").length;
  const skillLen = state.skills.join("").length;
  const ranked = [
    ["Experience", expLen], ["Education", eduLen],
    ["Summary", sumLen], ["Skills", skillLen],
  ].sort((a, b) => b[1] - a[1]);
  return ranked[0][1] > 0 ? ranked[0][0] : null;
}

// Renders (or refreshes) the honest one-page fit indicator into #jdFitHost.
// Called after the preview is (re)built so the measurement is against the DOM
// the user currently sees. Advisory only; no gating, no persistence.
function refreshPageFit() {
  const host = document.getElementById("jdFitHost");
  if (!host) return;
  const fit = estimatePageFit();
  host.innerHTML = "";
  if (!fit) return;
  const box = el("div", `jd-fit ${fit.fits ? "ok" : "over"}`);
  const ic = el("span", "jd-fit-ic");
  ic.setAttribute("aria-hidden", "true");
  // Static, developer-constant SVG (no user data) — CSP-safe innerHTML.
  ic.innerHTML = fit.fits
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>';
  box.appendChild(ic);
  const body = el("div", "jd-fit-body");
  if (fit.fits) {
    body.appendChild(txt("span", "jd-fit-title", "Fits on 1 page"));
    body.appendChild(txt("span", "jd-fit-sub", "Your resume prints on a single Letter page."));
  } else {
    body.appendChild(txt("span", "jd-fit-title", `Spilling to ~${fit.pageCount} pages`));
    const sub = fit.longest
      ? `Consider trimming — your ${fit.longest} section is the longest.`
      : "Consider trimming to keep it to one page.";
    body.appendChild(txt("span", "jd-fit-sub", sub));
  }
  box.appendChild(body);
  host.appendChild(box);
}

// ── On-device resume health check (free, 100% local — no libs, no network) ──
// Analyzes the CURRENT resume state and returns a 0-100 score plus a checklist
// of specific, actionable findings. Every check is pure JS over `state`; no
// data ever leaves the device. Recomputed live as the user edits (wired into
// refresh()/refreshLive()) and whenever the editor is rebuilt.

// ~40 strong résumé action verbs. A bullet whose FIRST word is one of these
// reads as an accomplishment ("Led…", "Shipped…") rather than a passive duty
// ("Responsible for…"). Lowercased for case-insensitive matching.
const ACTION_VERBS = new Set([
  "led", "built", "shipped", "launched", "designed", "developed", "created",
  "increased", "reduced", "improved", "delivered", "managed", "drove", "grew",
  "owned", "spearheaded", "architected", "implemented", "automated", "optimized",
  "streamlined", "scaled", "founded", "established", "directed", "coordinated",
  "negotiated", "generated", "boosted", "cut", "saved", "accelerated", "mentored",
  "trained", "resolved", "achieved", "won", "produced", "engineered", "transformed",
  "initiated", "overhauled", "pioneered", "championed",
]);

// Weak, passive bullet OPENERS (multi-word phrases) that signal a duty rather
// than an accomplishment. Matched case-insensitively against the START of a
// bullet by weakOpenerPhrase() below. Purely advisory — the Action-Verb Coach
// suggests strong replacements; nothing is ever auto-rewritten.
const WEAK_OPENERS = [
  "responsible for", "worked on", "helped with", "assisted with",
  "duties included", "in charge of", "tasked with", "involved in",
];
// A rotating-but-stable set of strong action verbs suggested when a weak opener
// (or a non-action first word) is found. Drawn from ACTION_VERBS; kept short so
// the hint stays scannable.
const STRONG_VERB_SUGGESTIONS = ["Led", "Built", "Drove", "Shipped", "Launched", "Owned", "Improved", "Reduced", "Grew"];
// Returns the weak opener phrase a bullet starts with (e.g. "responsible for"),
// or "" if it opens cleanly. Leading punctuation/bullets are ignored so
// "• Responsible for X" still matches.
function weakOpenerPhrase(text) {
  const t = String(text || "").trim().replace(/^[^A-Za-z]+/, "").toLowerCase();
  for (const phrase of WEAK_OPENERS) {
    if (t.startsWith(phrase)) return phrase;
  }
  return "";
}
// True when a bullet's opener is weak in ANY sense the coach cares about: it
// starts with a flagged weak PHRASE, or its first word simply isn't a strong
// action verb. Used only for the advisory inline editor hint (the Resume Score
// "verbs" check keeps its own first-word logic).
function bulletHasWeakOpener(text) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (weakOpenerPhrase(t)) return true;
  const w = bulletFirstWord(t);
  return !!w && !ACTION_VERBS.has(w);
}

// A number-word that stands in for a metric even without a digit ("doubled
// output", "tripled reach"). Lets a bullet count as quantified when it names a
// clear magnitude in words. Whole-word matched, case-insensitive.
const METRIC_WORDS = /\b(doubled|tripled|quadrupled|halved|thousands?|millions?|billions?|hundreds?|dozens?)\b/i;
// A bullet "has a metric" if it contains any digit, a percent sign, or a
// currency/scale symbol — a proxy for quantified impact ("cut costs 30%",
// "$1.2M", "3x faster") — or a magnitude number-word ("doubled signups").
function bulletHasMetric(text) {
  const s = String(text || "");
  return /[0-9%$]/.test(s) || METRIC_WORDS.test(s);
}
// The first word of a bullet, lowercased and stripped of leading punctuation,
// so "Led the team" → "led" and "• Built X" → "built".
function bulletFirstWord(text) {
  const m = String(text || "").trim().replace(/^[^A-Za-z]+/, "").match(/^([A-Za-z][A-Za-z'-]*)/);
  return m ? m[1].toLowerCase() : "";
}
// Every non-empty bullet across all experience entries, each tagged with its
// entry index so offenders can be located if ever needed.
function allBullets() {
  const out = [];
  state.experience.forEach((exp, ei) => {
    (exp.bullets || []).forEach((b) => { if (b && b.trim()) out.push({ text: b.trim(), entry: ei }); });
  });
  return out;
}
// Total visible content length across the whole resume — the sparseness proxy.
function totalContentLength() {
  return resumeCorpus().replace(/\s+/g, " ").trim().length;
}

// Runs every check and returns { score, checks:[{id,label,ok,tip}] }.
// score = weighted pass rate (each check carries a weight; score is the
// percentage of total weight that passed, rounded). Findings are ordered
// contact → summary → experience depth → quantify → verbs → skills → length.
function computeHealth() {
  const p = state.personal;
  const checks = [];
  const add = (id, ok, weight, label, tip) => checks.push({ id, ok, weight, label, tip });

  // 1. Contact completeness — email + phone + location.
  const hasEmail = !!(p.email && p.email.trim());
  const hasPhone = !!(p.phone && p.phone.trim());
  const hasLocation = !!(p.location && p.location.trim());
  const contactOk = hasEmail && hasPhone && hasLocation;
  const missingContact = [!hasEmail && "email", !hasPhone && "phone", !hasLocation && "location"].filter(Boolean);
  add("contact", contactOk, 2, "Contact details complete",
    contactOk ? "Email, phone, and location are all present."
      : `Add your ${missingContact.join(", ")} so employers can reach you.`);

  // 2. Summary present + reasonable length (200–600 chars).
  const summary = (p.summary || "").trim();
  const sLen = summary.length;
  let summaryOk, summaryTip;
  if (!sLen) { summaryOk = false; summaryTip = "Add a short professional summary (aim for 200–600 characters)."; }
  else if (sLen < 200) { summaryOk = false; summaryTip = `Your summary is short (${sLen} chars). Expand it toward 200–600 characters.`; }
  else if (sLen > 600) { summaryOk = false; summaryTip = `Your summary is long (${sLen} chars). Tighten it under 600 characters.`; }
  else { summaryOk = true; summaryTip = `Your summary is a good length (${sLen} characters).`; }
  add("summary", summaryOk, 1.5, "Summary is a good length", summaryTip);

  // 3. Each experience entry has >= 2 bullets.
  const filledEntries = state.experience.filter((e) => (e.company && e.company.trim()) || (e.title && e.title.trim()));
  const thinEntries = filledEntries.filter((e) => (e.bullets || []).filter((b) => b && b.trim()).length < 2);
  let depthOk, depthTip;
  if (!filledEntries.length) { depthOk = false; depthTip = "Add at least one experience entry with 2 or more bullet points."; }
  else if (thinEntries.length) {
    depthOk = false;
    const names = thinEntries.map((e) => (e.title || e.company || "Untitled role").trim()).slice(0, 3);
    depthTip = `Add more detail (2+ bullets) to: ${names.join(", ")}${thinEntries.length > 3 ? "…" : ""}.`;
  } else { depthOk = true; depthTip = "Every experience entry has 2 or more bullet points."; }
  add("depth", depthOk, 2, "Each role has enough detail", depthTip);

  // 4. Quantify — bullets lacking a number/metric.
  const bullets = allBullets();
  const noMetric = bullets.filter((b) => !bulletHasMetric(b.text));
  let metricOk, metricTip;
  if (!bullets.length) { metricOk = false; metricTip = "Add bullet points describing your impact, ideally with numbers."; }
  else if (noMetric.length) {
    metricOk = false;
    const sample = noMetric.slice(0, 3).map((b) => truncate(b.text, 40));
    metricTip = `Quantify these with a number, % or $: "${sample.join('", "')}"${noMetric.length > 3 ? `, +${noMetric.length - 3} more` : ""}.`;
  } else { metricOk = true; metricTip = "Your bullets include concrete numbers — great."; }
  add("metrics", metricOk, 1.5, "Bullets are quantified", metricTip);

  // 5. Strong action-verb openers. A bullet is "weak" if its first word isn't a
  // strong action verb — this already catches the flagged weak PHRASES (e.g.
  // "Responsible for…"), whose first word is never an action verb.
  const weakOpeners = bullets.filter((b) => { const w = bulletFirstWord(b.text); return w && !ACTION_VERBS.has(w); });
  let verbOk, verbTip;
  const suggest = STRONG_VERB_SUGGESTIONS.slice(0, 3).join(", ");
  if (!bullets.length) { verbOk = false; verbTip = "Start each bullet with a strong action verb (Led, Built, Increased…)."; }
  else if (weakOpeners.length) {
    verbOk = false;
    // Prefer naming the flagged weak PHRASES (clearer coaching); fall back to
    // the offending first words when the opener is merely non-action.
    const phrases = [...new Set(weakOpeners.map((b) => weakOpenerPhrase(b.text)).filter(Boolean))];
    if (phrases.length) {
      const shown = phrases.slice(0, 3).map((p) => `"${p}"`);
      verbTip = `Replace weak openers like ${shown.join(", ")}${phrases.length > 3 ? "…" : ""} with a strong verb (try ${suggest}).`;
    } else {
      const sample = weakOpeners.slice(0, 3).map((b) => bulletFirstWord(b.text).replace(/^\w/, (c) => c.toUpperCase()));
      verbTip = `Start with a strong verb instead of: ${sample.join(", ")}${weakOpeners.length > 3 ? "…" : ""} (try ${suggest}).`;
    }
  } else { verbOk = true; verbTip = "Your bullets open with strong action verbs." ; }
  add("verbs", verbOk, 1.5, "Bullets start with action verbs", verbTip);

  // 6. Skills present and >= 5.
  const skillCount = state.skills.length;
  const skillsOk = skillCount >= 5;
  add("skills", skillsOk, 1, "Enough skills listed",
    skillsOk ? `You've listed ${skillCount} skills.`
      : skillCount ? `Add more skills — you have ${skillCount}, aim for at least 5.`
        : "Add at least 5 relevant skills.");

  // 7. Overall content length — flag a very sparse resume.
  const len = totalContentLength();
  const lengthOk = len >= 400;
  add("length", lengthOk, 1, "Resume has enough content",
    lengthOk ? "Your resume has a solid amount of content."
      : "Your resume looks sparse — add more detail to your experience and summary.");

  const totalWeight = checks.reduce((s, c) => s + c.weight, 0);
  const passedWeight = checks.reduce((s, c) => s + (c.ok ? c.weight : 0), 0);
  const score = totalWeight ? Math.round((passedWeight / totalWeight) * 100) : 0;
  return { score, checks };
}
// Word-safe truncation for offender snippets shown in tips.
function truncate(s, n) {
  const t = String(s || "").trim();
  return t.length <= n ? t : t.slice(0, n).trimEnd() + "…";
}

function buildHealthPanel() {
  const panel = el("div", "panel");
  // Panel's own heading — shown when the panel stands alone, but hidden by
  // mountRoutePanels() once it's relocated into #scoreHost (the Résumé Score
  // route already provides an <h2> + subtitle, so this would be a duplicate).
  const selfhead = el("div", "panel-selfhead");
  selfhead.appendChild(txt("h3", null, "Resume Score"));
  selfhead.appendChild(txt("p", "hint", "A quick on-device check of your resume against common recruiter and ATS expectations. Updates live as you edit — nothing leaves your device."));
  panel.appendChild(selfhead);
  const host = el("div"); host.id = "healthResult"; host.className = "health-result";
  markLiveRegion(host);
  panel.appendChild(host);
  renderHealth(host, computeHealth());

  // ── Share my score (free) ──
  // Renders the CURRENT health score to a branded card and shares (native
  // share sheet when available) or falls back to a PNG download — all on-device.
  const shareRow = el("div", "health-share-row");
  const shareBtn = txt("button", "btn ghost sm", "Share my score");
  shareBtn.type = "button";
  shareBtn.id = "healthShareBtn";
  shareBtn.onclick = () => shareScoreCard(shareBtn);
  shareRow.appendChild(shareBtn);
  const shareMsg = el("div"); shareMsg.id = "healthShareMsg"; markLiveRegion(shareMsg);
  shareRow.appendChild(shareMsg);
  panel.appendChild(shareRow);
  return panel;
}

// Draws a square (1080×1080) branded, shareable card for the current resume
// health score onto an offscreen canvas. Pure local canvas work — no network,
// no libraries. Mirrors the license-card renderer's conventions (offscreen
// <canvas>, -apple-system font stack, brand palette). `result` is the exact
// object computeHealth() returns, so the drawn number always matches the panel.
function renderScoreCard(result) {
  const W = 1080, H = 1080;
  const canvas = document.createElement("canvas");
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext("2d");
  const BRAND = "#047857", BRAND_LIGHT = "#34d399", INK = "#1a1a2e", MUTED = "#6b7280";
  const SANS = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

  // Soft off-white background with a brand top bar (matches the app chrome).
  ctx.fillStyle = "#f7f7fb";
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, 60, 60, W - 120, H - 120, 40);
  ctx.fill();
  ctx.strokeStyle = "#e7e8ee"; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = BRAND;
  roundRect(ctx, 60, 60, W - 120, 18, 40);
  ctx.fill();
  ctx.fillRect(60, 68, W - 120, 10); // square off the lower edge of the top bar

  ctx.textBaseline = "top";

  // ── Logo mark (rounded green tile with a document glyph) + wordmark ──
  const logoX = 120, logoY = 128, logoS = 64;
  const g = ctx.createLinearGradient(logoX, logoY, logoX + logoS, logoY + logoS);
  g.addColorStop(0, BRAND_LIGHT); g.addColorStop(1, BRAND);
  ctx.fillStyle = g;
  roundRect(ctx, logoX, logoY, logoS, logoS, 16);
  ctx.fill();
  // little document sheet inside the tile
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, logoX + 18, logoY + 14, 28, 36, 4);
  ctx.fill();
  ctx.fillStyle = BRAND;
  ctx.fillRect(logoX + 23, logoY + 24, 18, 3);
  ctx.fillRect(logoX + 23, logoY + 31, 13, 3);
  ctx.fillStyle = INK;
  ctx.font = `800 46px ${SANS}`;
  ctx.textAlign = "left";
  ctx.fillText("LocalResume", logoX + logoS + 22, logoY + 8);

  // ── Big score ──
  ctx.textAlign = "center";
  ctx.fillStyle = MUTED;
  ctx.font = `700 34px ${SANS}`;
  ctx.fillText("MY RESUME SCORED", W / 2, 300);

  // tone-colored number (green / amber / red), matching the panel's tone bands.
  // Amber == --warn-fill so the shared card uses the same signal hue as the UI.
  const tone = result.score >= 80 ? BRAND : result.score >= 50 ? "#d97706" : "#b91c1c";
  ctx.fillStyle = tone;
  ctx.font = `800 260px ${SANS}`;
  ctx.textBaseline = "middle";
  const scoreText = `${result.score}`;
  ctx.fillText(scoreText, W / 2, 470);
  // "/100" suffix, smaller, baseline-aligned to the big number.
  const numW = ctx.measureText(scoreText).width;
  ctx.fillStyle = MUTED;
  ctx.font = `700 72px ${SANS}`;
  ctx.textAlign = "left";
  ctx.fillText("/100", W / 2 + numW / 2 + 14, 500);
  ctx.textBaseline = "top";

  const passed = result.checks.filter((c) => c.ok).length;
  ctx.textAlign = "center";
  ctx.fillStyle = MUTED;
  ctx.font = `600 30px ${SANS}`;
  ctx.fillText(`${passed} of ${result.checks.length} recruiter & ATS checks passing`, W / 2, 620);

  // ── Top passing areas (up to 3 ✓ items) ──
  const wins = result.checks.filter((c) => c.ok).slice(0, 3);
  let rowY = 700;
  ctx.textAlign = "left";
  const rowX = 180, rowW = W - rowX * 2;
  if (wins.length) {
    wins.forEach((c) => {
      // check-badge
      ctx.fillStyle = BRAND;
      ctx.beginPath();
      ctx.arc(rowX + 18, rowY + 20, 18, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 5; ctx.lineCap = "round";
      ctx.beginPath();
      ctx.moveTo(rowX + 10, rowY + 20);
      ctx.lineTo(rowX + 16, rowY + 27);
      ctx.lineTo(rowX + 27, rowY + 13);
      ctx.stroke();
      ctx.fillStyle = INK;
      ctx.font = `600 34px ${SANS}`;
      ctx.fillText(fitCanvasText(ctx, c.label, rowW - 60), rowX + 52, rowY + 2);
      rowY += 64;
    });
  } else {
    ctx.fillStyle = MUTED;
    ctx.font = `500 30px ${SANS}`;
    ctx.textAlign = "center";
    ctx.fillText("Building my resume, privately, on my device.", W / 2, rowY + 4);
    ctx.textAlign = "left";
  }

  // ── Footer: shield glyph + privacy line + domain ──
  const footY = H - 150;
  ctx.strokeStyle = "#e7e8ee"; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(120, footY - 24); ctx.lineTo(W - 120, footY - 24); ctx.stroke();
  // shield glyph (matches the app's privacy-pill shield)
  const shX = 120, shY = footY + 4, shS = 40;
  ctx.strokeStyle = BRAND; ctx.lineWidth = 5; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(shX + shS / 2, shY);
  ctx.lineTo(shX + shS, shY + shS * 0.28);
  ctx.lineTo(shX + shS, shY + shS * 0.55);
  ctx.bezierCurveTo(shX + shS, shY + shS * 0.9, shX + shS / 2, shY + shS * 1.05, shX + shS / 2, shY + shS * 1.05);
  ctx.bezierCurveTo(shX + shS / 2, shY + shS * 1.05, shX, shY + shS * 0.9, shX, shY + shS * 0.55);
  ctx.lineTo(shX, shY + shS * 0.28);
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = MUTED;
  ctx.font = `500 30px ${SANS}`;
  ctx.textAlign = "left";
  ctx.fillText("Built privately on my device", shX + shS + 20, footY + 8);
  ctx.fillStyle = BRAND;
  ctx.font = `700 30px ${SANS}`;
  ctx.fillText("localresumeapp.com", shX + shS + 20, footY + 48);

  return canvas;
}

// Rounded-rectangle path helper for the score card (no roundRect reliance so
// it works on every canvas engine the app targets).
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// Truncates a label with an ellipsis to fit maxWidth at the ctx's current font
// (measured with real glyph widths, like the PDF fitText helper).
function fitCanvasText(ctx, text, maxWidth) {
  const s = String(text || "");
  if (ctx.measureText(s).width <= maxWidth) return s;
  let lo = 0, hi = s.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(s.slice(0, mid) + "…").width <= maxWidth) lo = mid; else hi = mid - 1;
  }
  return s.slice(0, lo) + "…";
}

// Turns the score-card canvas into a PNG blob and shares it via the native
// share sheet when the browser supports sharing files, otherwise falls back to
// a plain PNG download. Sharing is NEVER required — download always works.
// Reuses computeHealth() so the shared number is exactly what the panel shows.
function shareScoreCard(btn) {
  const msgHost = $("#healthShareMsg");
  let canvas;
  try {
    canvas = renderScoreCard(computeHealth());
  } catch (e) {
    if (msgHost) status(msgHost, "Couldn't build the card — try again.", "err");
    return;
  }
  if (btn) { btn.disabled = true; btn.textContent = "Preparing…"; }
  const reset = () => { if (btn) { btn.disabled = false; btn.textContent = "Share my score"; } };
  canvas.toBlob(async (blob) => {
    if (!blob) { reset(); if (msgHost) status(msgHost, "Couldn't build the card — try again.", "err"); return; }
    const filename = "localresume-score.png";
    try {
      // Feature-detect file sharing (navigator.canShare with a File) before
      // attempting share; anything else falls through to the download path.
      const file = (typeof File === "function") ? new File([blob], filename, { type: "image/png" }) : null;
      if (file && navigator.canShare && navigator.canShare({ files: [file] }) && navigator.share) {
        try {
          // Race the share against a timeout: some environments never resolve
          // or reject navigator.share() (a dismissed/hung sheet), which would
          // otherwise leave the button stuck disabled on "Preparing…" forever.
          await Promise.race([
            navigator.share({ files: [file], title: "My resume score" }),
            new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("share timed out"), { name: "TimeoutError" })), 60000)),
          ]);
          if (msgHost) status(msgHost, "Shared your score card.", "ok");
          return;
        } catch (e) {
          // User cancelled the share sheet, or share failed/timed out — fall
          // back to a download so the action is never a dead end.
          if (e && e.name === "AbortError") { if (msgHost) msgHost.innerHTML = ""; return; }
        }
      }
      downloadScoreCardPng(blob, filename);
      if (msgHost) status(msgHost, "Saved your score card to downloads.", "ok");
    } finally {
      // Always re-enable the button, on every path (share resolved, rejected,
      // timed out, cancelled, or download fallback) so it can never brick.
      reset();
    }
  }, "image/png");
}

// Downloads a PNG blob via the same <a download> pattern the license-card PNG
// download uses (octet-stream not needed — image/png is not hijacked by Safari
// the way application/pdf is).
function downloadScoreCardPng(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = el("a"); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// Re-render just the health result into its existing live region if the panel
// is currently on screen. Cheap enough to call on every keystroke.
function refreshHealth() {
  const host = $("#healthResult");
  if (host) renderHealth(host, computeHealth());
}

// ── Score ring gauge (shared: Resume Score + Job match) ─────────────────
// ONE standardized ring component, pure SVG + CSS — no canvas, no libs. The
// real circumference (2πr) drives stroke-dasharray/-offset so it renders
// identically on engines without SVG2 pathLength support. The fill animates
// from the last value rendered under the same `key` (subtle recompute motion);
// the transition lives in CSS behind prefers-reduced-motion, so with reduced
// motion the offset simply jumps — no animation is ever implied here.
const ringLastValue = new Map();
function svgNode(tag, attrs) {
  const n = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.keys(attrs || {}).forEach((k) => n.setAttribute(k, String(attrs[k])));
  return n;
}
function buildScoreRing(value, opts) {
  opts = opts || {};
  const v = Math.max(0, Math.min(100, Math.round(Number(value) || 0)));
  const tone = opts.tone || "good";
  const wrap = el("div", `score-ring ${tone}`);
  wrap.setAttribute("role", "img");
  wrap.setAttribute("aria-label", opts.ariaLabel || `Resume score: ${v} out of 100`);
  const R = 52, C = 2 * Math.PI * R;
  const svg = svgNode("svg", { viewBox: "0 0 120 120", "aria-hidden": "true", focusable: "false" });
  svg.appendChild(svgNode("circle", { class: "score-ring-track", cx: 60, cy: 60, r: R, fill: "none", "stroke-width": 11 }));
  const prev = opts.key != null && ringLastValue.has(opts.key) ? ringLastValue.get(opts.key) : 0;
  if (opts.key != null) ringLastValue.set(opts.key, v);
  const fill = svgNode("circle", {
    class: "score-ring-fill", cx: 60, cy: 60, r: R, fill: "none", "stroke-width": 11,
    "stroke-linecap": "round", transform: "rotate(-90 60 60)",
    "stroke-dasharray": C, "stroke-dashoffset": C * (1 - prev / 100),
  });
  // A rounded linecap paints a dot even at zero length — hide the fill at 0.
  fill.style.opacity = prev === 0 && v === 0 ? "0" : "1";
  svg.appendChild(fill);
  wrap.appendChild(svg);
  const text = el("div", "score-ring-text");
  text.setAttribute("aria-hidden", "true"); // the wrapper's aria-label carries the value
  text.appendChild(txt("span", "score-ring-num tnum", `${v}${opts.suffix || ""}`));
  if (opts.caption) text.appendChild(txt("span", "score-ring-cap", opts.caption));
  wrap.appendChild(text);
  // Commit the starting offset, then set the target on the next frame so the
  // CSS transition (when motion is allowed) sweeps the ring to its new value.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    fill.style.opacity = v === 0 ? "0" : "1";
    fill.setAttribute("stroke-dashoffset", String(C * (1 - v / 100)));
  }));
  return wrap;
}

// ── Shared chip/tag component (impact tags + keyword chips) ─────────────
// Icon + text together carry the meaning, so colour is never the only signal.
// Icon markup is a fixed developer constant; `label` goes in via textContent.
const CHIP_ICONS = {
  check: '<path d="M20 6 9 17l-5-5"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  bolt: '<path d="M13 2 3 14h7l-1 8 10-12h-7l1-8z"/>',
};
function buildChip(kind, icon, label) {
  const chip = el("span", `lr-chip ${kind}`);
  const ic = el("span", "lr-chip-icon", `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${CHIP_ICONS[icon] || CHIP_ICONS.check}</svg>`);
  chip.appendChild(ic);
  chip.appendChild(txt("span", null, label));
  return chip;
}

// ── Resume Score category breakdown ─────────────────────────────────────
// Honest buckets over the REAL computeHealth() checks — every category number
// is recomputed live from the same weighted checks (no invented metrics).
const HEALTH_CATEGORIES = [
  { label: "Contact & Basics", ids: ["contact"] },
  { label: "Summary", ids: ["summary"] },
  { label: "Experience quality", ids: ["depth", "metrics", "verbs"] },
  { label: "Skills", ids: ["skills"] },
  { label: "Completeness", ids: ["length"] },
];
// Impact tag derived from the check's existing WEIGHT (2 → High, 1.5 → Medium,
// 1 → Low) — the same weights that drive the score, surfaced honestly.
function impactFromWeight(w) { return w >= 2 ? "High" : w >= 1.5 ? "Medium" : "Low"; }

function healthCheckRow(c) {
  const li = el("li", `health-row ${c.ok ? "good" : "warn"}`);
  const icon = el("span", "health-icon");
  // Decorative status glyph; the row also carries a screen-reader status word.
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = c.ok ? "✓" : "!";
  li.appendChild(icon);
  const body = el("div", "health-body");
  const labelRow = el("div", "health-label-row");
  const label = el("div", "health-label");
  label.appendChild(txt("span", "health-sr", c.ok ? "Passed: " : "Needs work: "));
  label.appendChild(document.createTextNode(c.label));
  labelRow.appendChild(label);
  // Impact tag on suggestions (failing checks), from the check's real weight.
  if (!c.ok) {
    const level = impactFromWeight(c.weight);
    labelRow.appendChild(buildChip(`impact-${level.toLowerCase()}`, "bolt", `${level} impact`));
  }
  body.appendChild(labelRow);
  body.appendChild(txt("div", "health-tip", c.tip));
  li.appendChild(body);
  return li;
}

function renderHealth(host, result) {
  host.innerHTML = "";
  const scoreWrap = el("div", "health-score");
  const tone = result.score >= 80 ? "good" : result.score >= 50 ? "mid" : "low";
  scoreWrap.classList.add(tone);
  scoreWrap.appendChild(buildScoreRing(result.score, {
    tone, key: "resume-score", caption: "of 100",
    ariaLabel: `Resume score: ${result.score} out of 100`,
  }));
  const passed = result.checks.filter((c) => c.ok).length;
  const meta = el("span", "health-score-meta");
  meta.appendChild(txt("span", "health-score-label", "Resume Score"));
  meta.appendChild(txt("span", "health-score-sub", `${passed} of ${result.checks.length} checks passing`));
  scoreWrap.appendChild(meta);
  host.appendChild(scoreWrap);

  // Category rows — label, per-category bar from the member checks' weights,
  // then the existing check rows (with impact tags) under each.
  const byId = new Map(result.checks.map((c) => [c.id, c]));
  const covered = new Set();
  const cats = HEALTH_CATEGORIES.map((cat) => {
    const checks = cat.ids.map((id) => byId.get(id)).filter(Boolean);
    checks.forEach((c) => covered.add(c.id));
    return { label: cat.label, checks };
  }).filter((cat) => cat.checks.length);
  // Defensive: a future check that isn't bucketed yet still gets shown.
  const leftovers = result.checks.filter((c) => !covered.has(c.id));
  if (leftovers.length) cats.push({ label: "Other checks", checks: leftovers });

  const catList = el("div", "health-cats");
  cats.forEach((cat) => {
    const totalW = cat.checks.reduce((s, c) => s + c.weight, 0);
    const passedW = cat.checks.reduce((s, c) => s + (c.ok ? c.weight : 0), 0);
    const pct = totalW ? Math.round((passedW / totalW) * 100) : 0;
    const catTone = pct >= 80 ? "good" : pct >= 50 ? "mid" : "low";
    const row = el("section", "health-cat");
    const head = el("div", "health-cat-head");
    head.appendChild(txt("h4", "health-cat-label", cat.label));
    const pctEl = txt("span", `health-cat-pct ${catTone} tnum`, `${pct}`);
    pctEl.setAttribute("aria-hidden", "true"); // the bar below carries the value
    head.appendChild(pctEl);
    row.appendChild(head);
    const bar = el("div", `health-cat-bar ${catTone}`);
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `${cat.label}: ${pct} out of 100`);
    const fill = el("span", "health-cat-bar-fill");
    fill.style.width = `${pct}%`;
    bar.appendChild(fill);
    row.appendChild(bar);
    const ul = el("ul", "health-list");
    cat.checks.forEach((c) => ul.appendChild(healthCheckRow(c)));
    row.appendChild(ul);
    catList.appendChild(row);
  });
  host.appendChild(catList);
}

// ── ATS job-description keyword matcher (free, 100% local string work) ────
// Stopwords: high-frequency English + generic job-post filler that would
// otherwise dominate the ranked keyword list and drown out real skills.
const JD_STOPWORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "your", "with", "have", "has", "had",
  "this", "that", "these", "those", "will", "would", "can", "could", "should", "shall",
  "our", "their", "them", "they", "our", "was", "were", "been", "being", "from", "into",
  "onto", "than", "then", "them", "who", "whom", "whose", "which", "what", "when", "where",
  "why", "how", "all", "any", "each", "few", "more", "most", "other", "some", "such", "own",
  "same", "too", "very", "just", "also", "about", "above", "below", "over", "under", "out",
  "off", "per", "via", "etc", "including", "include", "includes", "included", "such",
  "role", "roles", "job", "jobs", "work", "working", "team", "teams", "company", "companies",
  "candidate", "candidates", "applicant", "applicants", "position", "positions", "opportunity",
  "opportunities", "responsibilities", "responsibility", "requirements", "requirement",
  "required", "require", "requires", "preferred", "plus", "must", "ability", "able", "years",
  "year", "experience", "experienced", "skills", "skill", "strong", "excellent", "good",
  "great", "looking", "seeking", "join", "help", "helps", "helping", "within", "across",
  "using", "used", "use", "uses", "well", "new", "like", "want", "need", "needs", "make",
  "made", "get", "got", "day", "days", "one", "two", "three", "may", "might", "both", "there",
  "here", "while", "during", "between", "based", "part", "full", "time", "days", "week",
  "month", "months", "environment", "environments", "us", "we", "it", "its", "his", "her",
  "she", "him", "he", "as", "at", "by", "in", "of", "on", "or", "to", "be", "an", "a", "is",
]);

// Split any resume/JD text into normalized word tokens: lowercase, punctuation
// stripped, hyphens/slashes treated as separators (so "front-end" → "front",
// "end"). Digits are kept in tokens (e.g. "es6", "html5") but a token that is
// ONLY digits is dropped so "2024"/"5" aren't ranked as keywords.
function jdTokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !/^\d+$/.test(w));
}

// The FULL resume text across every section — the corpus we check JD keywords
// against. Includes summary, all experience (company/title/location/bullets),
// all education, and skills, so a keyword present anywhere on the resume counts
// as matched.
function resumeCorpus() {
  const p = state.personal;
  const parts = [p.name, p.role, p.summary, p.location];
  state.experience.forEach((e) => {
    parts.push(e.company, e.title, e.location);
    (e.bullets || []).forEach((b) => parts.push(b));
  });
  state.education.forEach((e) => parts.push(e.school, e.degree, e.field));
  state.skills.forEach((s) => parts.push(s));
  return parts.filter(Boolean).join(" ");
}

// Rank JD tokens by frequency (desc), tie-broken by first appearance so the
// output is stable. Returns up to `limit` distinct keywords.
function rankJdKeywords(jdText, limit = 25) {
  const tokens = jdTokenize(jdText).filter((w) => !JD_STOPWORDS.has(w));
  const freq = new Map();
  const firstSeen = new Map();
  tokens.forEach((w, i) => {
    freq.set(w, (freq.get(w) || 0) + 1);
    if (!firstSeen.has(w)) firstSeen.set(w, i);
  });
  return [...freq.keys()]
    .sort((a, b) => (freq.get(b) - freq.get(a)) || (firstSeen.get(a) - firstSeen.get(b)))
    .slice(0, limit);
}

// Compare the top JD keywords against the resume corpus. A keyword matches if
// it appears as a whole token in the resume (same tokenizer both sides, so
// "React" in a bullet matches "react" from the JD, and partial substrings like
// "java" inside "javascript" do NOT false-match).
function computeJobMatch(jdText) {
  const keywords = rankJdKeywords(jdText);
  const resumeTokens = new Set(jdTokenize(resumeCorpus()));
  const matched = [];
  const missing = [];
  keywords.forEach((k) => (resumeTokens.has(k) ? matched : missing).push(k));
  const score = keywords.length ? Math.round((matched.length / keywords.length) * 100) : 0;
  return { keywords, matched, missing, score };
}

// ── Tailor-to-Job placement heuristics (PRO advisory) ────────────────────
// For a MISSING keyword, suggest WHERE it most naturally belongs on the resume.
// Pure, local string heuristics over the keyword itself — no network, no model,
// and NEVER any fabricated experience. The output is advisory copy plus, for
// clearly skill-like terms, an offer to append the term to the Skills list
// (user-approved). Everything here is derived on the fly; nothing is persisted
// beyond the normal Skills save the user explicitly triggers.

// Terms that read as tools/technologies/competencies — i.e. things that belong
// in a Skills list. Whole-keyword membership check (the JD tokenizer already
// lower-cased and split them). Deliberately conservative: when unsure we advise
// a placement hint rather than offering a one-tap Skills add.
const SKILL_LIKE_TERMS = new Set([
  // languages / core tech
  "javascript", "typescript", "python", "java", "ruby", "php", "swift", "kotlin",
  "golang", "rust", "scala", "css", "html", "sql", "nosql", "graphql", "bash",
  // frameworks / libraries / platforms
  "react", "angular", "vue", "svelte", "node", "nodejs", "django", "flask",
  "rails", "spring", "express", "next", "nuxt", "redux", "jquery", "bootstrap",
  "tailwind", "sass", "webpack", "vite",
  // cloud / infra / devops
  "aws", "azure", "gcp", "docker", "kubernetes", "terraform", "ansible", "jenkins",
  "linux", "nginx", "redis", "kafka", "postgres", "postgresql", "mysql", "mongodb",
  "elasticsearch", "serverless", "microservices", "devops", "cicd",
  // data / analytics
  "tableau", "powerbi", "excel", "pandas", "numpy", "spark", "hadoop", "snowflake",
  "analytics", "sqlalchemy", "pytorch", "tensorflow",
  // design / product tooling
  "figma", "sketch", "photoshop", "illustrator", "indesign", "invision", "framer",
  "wireframing", "prototyping", "usability", "accessibility",
  // ways of working / methodologies
  "agile", "scrum", "kanban", "jira", "confluence", "git", "github", "gitlab",
  "waterfall", "lean", "devsecops",
  // office / crm / other named tools
  "salesforce", "hubspot", "sap", "workday", "quickbooks", "wordpress", "shopify",
  "zendesk", "slack", "notion", "airtable", "powerpoint", "word", "outlook",
  // marketing / seo
  "seo", "sem", "ppc", "hootsuite", "mailchimp", "adwords", "analytics",
]);

// Suffixes that strongly suggest a tool/technology even when the exact term
// isn't in the curated set (e.g. "kubernetes", "postgresql"). Advisory only.
function looksLikeSkill(word) {
  const w = String(word || "").toLowerCase();
  if (SKILL_LIKE_TERMS.has(w)) return true;
  // Framework/tech-ish shapes: "*js", "*db", "*sql", "*ops".
  return /(?:js|db|sql|ops|css|api)$/.test(w) && w.length >= 4;
}

// Verbs / soft competencies that read as things you DEMONSTRATE in an
// experience bullet, not list as a skill (e.g. "mentored", "led", "stakeholder").
const EXPERIENCE_LIKE_TERMS = new Set([
  "led", "leadership", "managed", "management", "mentored", "mentoring", "coached",
  "coaching", "collaborated", "collaboration", "communication", "communicated",
  "stakeholder", "stakeholders", "cross", "functional", "presented", "presentation",
  "negotiated", "negotiation", "facilitated", "coordinated", "coordination",
  "ownership", "initiative", "delivered", "delivery", "launched", "shipped",
  "scaled", "growth", "revenue", "budget", "roadmap", "strategy", "strategic",
  "hiring", "onboarding", "training", "supervised", "supervision",
]);

// Terms that read as domain/industry/summary framing (nouns describing the field
// or seniority) — best surfaced in the Summary where you position yourself.
function looksLikeSummaryTerm(word) {
  const w = String(word || "").toLowerCase();
  return /(?:^senior$|^junior$|^lead$|^principal$|^staff$| industry$|^healthcare$|^fintech$|^saas$|^b2b$|^b2c$|^enterprise$|^startup$)/.test(w);
}

// Decide the single best placement hint for one missing keyword. Returns
// { where, insertToSkills, tip }:
//   where            — "Skills" | "Experience" | "Summary"
//   insertToSkills   — true only for clearly skill-like terms (offers one-tap add)
//   tip              — advisory sentence (user-derived text goes in via textContent)
function placementForKeyword(word) {
  const w = String(word || "").trim();
  const lw = w.toLowerCase();
  if (looksLikeSkill(lw)) {
    return {
      where: "Skills",
      insertToSkills: true,
      tip: "Looks like a tool or technology — add it to your Skills if you genuinely use it.",
    };
  }
  if (EXPERIENCE_LIKE_TERMS.has(lw)) {
    return {
      where: "Experience",
      insertToSkills: false,
      tip: "Reads as something you'd show in action — weave it into a relevant Experience bullet where it's true.",
    };
  }
  if (looksLikeSummaryTerm(lw)) {
    return {
      where: "Summary",
      insertToSkills: false,
      tip: "Positioning term — consider reflecting it in your Summary if it fits your background.",
    };
  }
  // Default: unclear shape. Advise the Summary/Experience as the honest home for
  // context words, and do NOT offer a Skills add (avoids junk skills).
  return {
    where: "Experience or Summary",
    insertToSkills: false,
    tip: "If this genuinely applies to you, work it into an Experience bullet or your Summary — only where it's true.",
  };
}

// Append a user-approved skill through the SAME save path the Skills editor
// uses (dedupe case-insensitively; never fabricate). Returns true if added.
// No new persisted field — this writes only to the existing state.skills array.
function addSkillFromTailor(term) {
  const v = String(term || "").trim();
  if (!v) return false;
  const dupe = state.skills.some((s) => s.toLowerCase() === v.toLowerCase());
  if (dupe) return false;
  state.skills.push(v);
  scheduleSave();
  return true;
}

function buildJobMatchPanel() {
  const panel = el("div", "panel");
  panel.appendChild(txt("h3", null, "Match a job description"));
  panel.appendChild(txt("p", "hint", "Paste a job description and we'll compare its key terms against your whole resume — all on this device. See what's already covered and what to add before you apply."));

  // One-page fit indicator (FREE) — derived live from the rendered preview. Its
  // content is filled by refreshPageFit() once the preview is mounted, and kept
  // in sync on every edit. Live region so the estimate is announced as it moves.
  const fitHost = el("div"); fitHost.id = "jdFitHost";
  markLiveRegion(fitHost);
  panel.appendChild(fitHost);

  const taWrap = el("div", "field"); taWrap.style.marginBottom = "12px";
  const ta = el("textarea"); ta.id = "jdInput";
  ta.placeholder = "Paste the job description here…";
  ta.setAttribute("aria-label", "Paste the job description");
  ta.style.minHeight = "120px";
  ta.value = jdLastInput;
  ta.addEventListener("input", () => { jdLastInput = ta.value; });
  taWrap.appendChild(ta);
  panel.appendChild(taWrap);

  const actionRow = el("div"); actionRow.style.cssText = "display:flex; gap:10px; flex-wrap:wrap; align-items:center;";
  const matchBtn = txt("button", "btn sm", "Match against my resume"); matchBtn.type = "button";
  const clearBtn = txt("button", "btn ghost sm", "Clear"); clearBtn.type = "button";
  actionRow.append(matchBtn, clearBtn);
  panel.appendChild(actionRow);

  const resultHost = el("div"); resultHost.id = "jdResult"; resultHost.className = "jd-result";
  markLiveRegion(resultHost);
  panel.appendChild(resultHost);

  matchBtn.onclick = () => {
    const jd = $("#jdInput").value;
    jdLastInput = jd;
    if (!jd.trim()) { renderJobMatchEmpty(resultHost, "Paste a job description above, then tap Match."); return; }
    const result = computeJobMatch(jd);
    jdLastResult = result;
    renderJobMatch(resultHost, result);
    // Surface the newly-found missing keywords in the editor's coach rail too.
    refreshCoach();
  };
  clearBtn.onclick = () => {
    const input = $("#jdInput"); if (input) input.value = "";
    jdLastInput = ""; jdLastResult = null;
    resultHost.innerHTML = "";
    refreshCoach();
  };

  // If a match was already run, RECOMPUTE it against the current resume when
  // the panel is rebuilt (e.g. after editing the resume) so the score reflects
  // the edit instead of showing a stale number from before the change.
  if (jdLastResult) { jdLastResult = computeJobMatch(jdLastInput); renderJobMatch(resultHost, jdLastResult); }
  return panel;
}
// Ephemeral, in-memory only (never persisted — a JD is transient and not part
// of the resume): survives buildEditor() re-renders within a session.
let jdLastInput = "";
let jdLastResult = null;

// Keep the ATS match score in sync with resume edits that DON'T rebuild the
// whole editor (text-field edits go through refresh()/refreshLive(), which
// don't remount the JD panel). Recompute against the current resume corpus and
// re-render into the mounted result host so the shown score never goes stale.
function refreshJobMatch() {
  if (!jdLastResult) return;
  const host = $("#jdResult");
  if (!host) return;
  jdLastResult = computeJobMatch(jdLastInput);
  renderJobMatch(host, jdLastResult);
  refreshCoach();
}

function renderJobMatchEmpty(host, msg) {
  host.innerHTML = "";
  host.appendChild(txt("p", "hint", msg));
}

function renderJobMatch(host, result) {
  host.innerHTML = "";
  if (!result.keywords.length) {
    host.appendChild(txt("p", "hint", "No distinctive keywords found in that text — try pasting a fuller job description."));
    return;
  }
  const scoreWrap = el("div", "jd-score");
  const tone = result.score >= 70 ? "good" : result.score >= 40 ? "mid" : "low";
  scoreWrap.classList.add(tone);
  // Same standardized ring component the Resume Score uses.
  scoreWrap.appendChild(buildScoreRing(result.score, {
    tone, key: "job-match", suffix: "%", caption: "match",
    ariaLabel: `Job match: ${result.score} out of 100`,
  }));
  const meta = el("span", "jd-score-meta");
  meta.appendChild(txt("span", "jd-score-title", "Overall match"));
  meta.appendChild(txt("span", "jd-score-label", `${result.matched.length} of ${result.keywords.length} key terms on your resume`));
  scoreWrap.appendChild(meta);
  host.appendChild(scoreWrap);

  // Matched/missing keyword chips: shared chip component, icon + group title
  // + tint together — colour is never the only signal.
  const chipGroup = (title, words, kind, icon) => {
    if (!words.length) return;
    const grp = el("div", "jd-group");
    grp.appendChild(txt("div", "jd-group-title", `${title} (${words.length})`));
    const chips = el("div", "jd-chips");
    words.forEach((w) => chips.appendChild(buildChip(kind, icon, w)));
    grp.appendChild(chips);
    host.appendChild(grp);
  };
  chipGroup("Matched", result.matched, "matched", "check");
  chipGroup("Missing — consider adding", result.missing, "missing", "plus");

  // ── Tailor to this job (PRO) — placement hints for the missing terms ──
  // Free users keep the matched/missing lists above unchanged; the WHERE-to-add
  // guidance and one-tap Skills add are the Pro layer. Nothing is fabricated.
  if (result.missing.length) renderTailorSection(host, result);
}

// Renders the Tailor-to-Job block below the missing chips. When the user isn't
// Pro, shows a compact unlock affordance that opens the existing paywall via
// showProModal(); gating is a pure Billing.isPro() read + showProModal() call —
// billing internals are never touched. When Pro, shows per-keyword placement
// hints and a user-approved "Add to Skills" for skill-like terms.
function renderTailorSection(host, result) {
  const grp = el("div", "jd-group jd-tailor");
  const head = el("div", "jd-tailor-head");
  head.appendChild(txt("div", "jd-group-title", "Tailor to this job"));
  head.appendChild(txt("span", "jd-tailor-pro", "Pro"));
  grp.appendChild(head);

  let isPro = false;
  try { isPro = Billing.isPro(); } catch { isPro = false; }

  if (!isPro) {
    grp.appendChild(txt("p", "jd-tailor-lock-note",
      "Unlock Pro to see where to add each missing term — Skills, a specific experience bullet, or your Summary — plus one-tap adds for skills."));
    const unlock = txt("button", "btn ghost sm", "Unlock Pro to see where to add these");
    unlock.type = "button";
    unlock.onclick = () => { try { showProModal(); } catch (e) { console.error(e); } };
    grp.appendChild(unlock);
    host.appendChild(grp);
    return;
  }

  grp.appendChild(txt("p", "jd-tailor-intro",
    "Where each missing term most naturally belongs. Only add what's genuinely true — nothing here is auto-written."));
  const list = el("ul", "jd-tailor-list");
  result.missing.forEach((word) => {
    const place = placementForKeyword(word);
    const li = el("li", "jd-tailor-row");
    const main = el("div", "jd-tailor-main");
    main.appendChild(txt("span", "jd-tailor-term", word));
    // Static-constant SVG arrow (no user data) — CSP-safe.
    const whereWrap = el("span", "jd-tailor-where");
    whereWrap.appendChild(txt("span", "jd-tailor-arrow", "→"));
    whereWrap.appendChild(txt("span", "jd-tailor-dest", place.where));
    main.appendChild(whereWrap);
    li.appendChild(main);
    li.appendChild(txt("div", "jd-tailor-tip", place.tip));

    if (place.insertToSkills) {
      const already = state.skills.some((s) => s.toLowerCase() === word.toLowerCase());
      const addBtn = txt("button", "btn ghost sm jd-tailor-add",
        already ? "In Skills ✓" : "Add to Skills");
      addBtn.type = "button";
      if (already) { addBtn.disabled = true; }
      else {
        addBtn.onclick = () => {
          if (addSkillFromTailor(word)) {
            // Rebuild the editor so the Skills tag list + preview + score reflect
            // the add, then re-run the match so this term now reads as matched.
            buildEditor();
            const rHost = document.getElementById("jdResult");
            if (rHost && jdLastResult) { jdLastResult = computeJobMatch(jdLastInput); renderJobMatch(rHost, jdLastResult); }
          }
        };
      }
      li.appendChild(addBtn);
    }
    list.appendChild(li);
  });
  grp.appendChild(list);
  host.appendChild(grp);
}

// ── PDF export (ATS-safe: single column, real selectable text, standard reading order) ──
function status(host, msg, kind) {
  host.innerHTML = "";
  const s = el("div", `status-msg ${kind}`);
  // Errors announce assertively (interrupt); success/info stay polite via the
  // host's own aria-live. aria-atomic makes AT read the whole node as one unit.
  if (kind === "err") { s.setAttribute("role", "alert"); s.setAttribute("aria-atomic", "true"); }
  s.appendChild(document.createTextNode(msg));
  host.appendChild(s);
}

// Polished purchase-failure state for the paywall. Rendered ONLY on a genuine
// error (not cancel, not offline). `onRetry` re-runs the exact same buy flow the
// "Unlock Pro" button uses — this never reimplements billing, it just calls back.
// All strings here are developer constants, so DOM building via el/txt is safe.
function renderProError(host, onRetry) {
  host.innerHTML = "";
  const box = el("div", "pro-error");
  // Treat the whole panel as one assertive alert so AT reads it as a unit.
  box.setAttribute("role", "alert");
  box.setAttribute("aria-atomic", "true");

  // Soft danger circle + X. aria-hidden — the text below carries the meaning.
  const mark = el("div", "pro-error-mark", `
    <svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true" focusable="false">
      <circle cx="24" cy="24" r="21" fill="var(--danger-soft)" stroke="var(--danger)" stroke-width="2"/>
      <path d="M17 17 L31 31 M31 17 L17 31" fill="none" stroke="var(--danger)" stroke-width="3" stroke-linecap="round"/>
    </svg>`);
  mark.setAttribute("aria-hidden", "true");
  box.appendChild(mark);

  box.appendChild(txt("h4", "pro-error-title", "Something went wrong"));
  box.appendChild(txt("p", "pro-error-body",
    // "no charge was made just now" — scoped to THIS attempt; never a blanket "nothing was charged".
    "If your card was charged, your Pro will unlock automatically on your next visit — otherwise no charge was made just now."));

  if (IS_NATIVE) {
    // On iOS the most common cause of this card is an already-owned purchase with an
    // unsynced receipt (fresh reinstall) — the fix is the Restore Purchases link sitting
    // just below on this same paywall, so point straight at it.
    box.appendChild(txt("p", "pro-error-body",
      "Already bought Pro? Tap Restore Purchases below to bring it back — no new charge."));
  }

  const support = el("p", "pro-error-support");
  support.append("Still stuck? Email ");
  const mail = txt("a", null, "support@localresumeapp.com");
  mail.href = "mailto:support@localresumeapp.com";
  support.appendChild(mail);
  support.append(IS_NATIVE ? " with your App Store receipt and we'll sort it out." : " with your Stripe receipt and we'll sort it out.");
  box.appendChild(support);

  const retry = txt("button", "btn big pro-error-retry", "Try again");
  retry.type = "button";
  retry.onclick = () => onRetry();
  box.appendChild(retry);

  host.appendChild(box);
  // Move keyboard focus to the primary action so the user lands on the fix.
  retry.focus();
}

async function doExport() {
  const msgHost = $("#editorMsg");
  try {
    await ensurePdfLib(); // loads pdf-lib on demand (first export)
    const pdf = await PDFDocument.create();
    const isEditorial = state.template === "editorial";
    const isExecutive = state.template === "executive";
    const isMinimal = state.template === "minimal";
    // EDITORIAL and EXECUTIVE use a serif face (built-in "Times") to match their
    // on-screen serif look; MINIMAL, MODERN and CLASSIC keep Helvetica sans.
    const useSerif = isEditorial || isExecutive;
    const bold = await pdf.embedFont(useSerif ? StandardFonts.TimesRomanBold : StandardFonts.HelveticaBold);
    const reg = await pdf.embedFont(useSerif ? StandardFonts.TimesRoman : StandardFonts.Helvetica);
    const italic = isEditorial ? await pdf.embedFont(StandardFonts.TimesRomanItalic) : reg;
    const ink = rgb(0.10, 0.10, 0.18);
    const muted = rgb(0.42, 0.45, 0.5);
    // Editorial accent: dusty rose #9e4a5b (print-safe), matching the preview.
    const rose = rgb(0.62, 0.29, 0.357);
    // Executive accent: deep charcoal-green #123a2e (print-friendly, restrained).
    const deep = rgb(0.071, 0.227, 0.18);
    // Minimal accent: none — pure ink/grey. A near-black name, hair-thin grey rules.
    const brand = state.template === "modern" ? rgb(0.016, 0.471, 0.341)
      : isEditorial ? rose : isExecutive ? deep : rgb(0.10, 0.10, 0.18);
    const pageWidth = 612, pageHeight = 792;
    const marginX = 56, rightEdge = pageWidth - marginX, contentWidth = rightEdge - marginX;
    const topY = 740, bottomLimit = 54;

    // Real pagination: `page`/`y` are mutable and every draw call below goes
    // through ensureRoom() first, so content that doesn't fit starts a new
    // page instead of being silently skipped or drawn off the visible page.
    let page, y;
    function addPage() {
      page = pdf.addPage([pageWidth, pageHeight]);
      if (state.template === "modern") {
        page.drawRectangle({ x: 0, y: pageHeight - 12, width: pageWidth, height: 12, color: rgb(0.016, 0.471, 0.341) });
      }
      y = topY;
    }
    function ensureRoom(needed) {
      if (y - needed < bottomLimit) addPage();
    }
    addPage();

    // Header treatment branches on the selected template so the EXPORTED PDF
    // matches the on-screen preview: MODERN = left-aligned green name; CLASSIC =
    // centred ink name + centred contact line closed by a full-width ink rule.
    const isModern = state.template === "modern";
    // EDITORIAL, EXECUTIVE, MODERN and MINIMAL are all left-aligned; CLASSIC is centred.
    const leftAligned = isModern || isEditorial || isExecutive || isMinimal;
    // Centre a run of text within the content column (Classic only).
    const centeredX = (str, font, size) => marginX + (contentWidth - font.widthOfTextAtSize(str, size)) / 2;
    const nameSafe = pdfSafe((state.personal.name || "").trim()) || "Your name";
    // EXECUTIVE: large authoritative name. EDITORIAL: large serif. MINIMAL: small,
    // understated. Others: 22.
    const nameSize = isExecutive ? 27 : isEditorial ? 26 : isMinimal ? 19 : 22;
    // Editorial: large near-black serif name; Executive: deep charcoal-green;
    // Modern: green; Minimal/Classic: ink.
    const nameColor = isModern ? brand : isExecutive ? deep : ink;
    const nameX = leftAligned ? marginX : centeredX(fitText(bold, nameSafe, nameSize, contentWidth), bold, nameSize);
    // Minimal draws the name with letter-spacing via a per-char loop; others draw a single run.
    if (isMinimal) {
      const ls = 0.6;
      let cx = marginX;
      for (const ch of fitText(bold, nameSafe, nameSize, contentWidth)) {
        page.drawText(ch, { x: cx, y, size: nameSize, font: bold, color: ink });
        cx += bold.widthOfTextAtSize(ch, nameSize) + ls;
      }
    } else {
      page.drawText(fitText(bold, nameSafe, nameSize, contentWidth), { x: nameX, y, size: nameSize, font: bold, color: nameColor });
    }
    y -= isExecutive ? 20 : isEditorial ? 22 : isMinimal ? 17 : 20;
    // EXECUTIVE: a confident full-width deep rule directly under the name, before
    // the role line — the signature senior header treatment. Print-friendly (a
    // 1.4pt line, not an ink-guzzling band).
    if (isExecutive) {
      y += 4;
      page.drawLine({ start: { x: marginX, y }, end: { x: rightEdge, y }, thickness: 1.4, color: deep });
      y -= 12;
    }
    if (state.personal.role) {
      const roleSafe = pdfSafe(state.personal.role);
      // Editorial: dusty-rose; Executive: deep charcoal-green uppercase; Minimal:
      // muted grey; Modern: green; Classic: ink.
      const roleColor = isModern ? brand : isEditorial ? rose : isExecutive ? deep : isMinimal ? muted : ink;
      const roleFont = (isEditorial || isMinimal) ? reg : bold;
      const roleStr = isExecutive ? roleSafe.toUpperCase() : roleSafe;
      const roleSize = isMinimal ? 10.5 : isExecutive ? 11 : 12;
      const roleX = leftAligned ? marginX : centeredX(fitText(roleFont, roleStr, roleSize, contentWidth), roleFont, roleSize);
      // Executive: letter-space the uppercase role for gravitas.
      if (isExecutive) {
        const ls = 1.5;
        let cx = roleX;
        for (const ch of fitText(roleFont, roleStr, roleSize, contentWidth)) {
          page.drawText(ch, { x: cx, y, size: roleSize, font: roleFont, color: roleColor });
          cx += roleFont.widthOfTextAtSize(ch, roleSize) + ls;
        }
      } else {
        page.drawText(fitText(roleFont, roleStr, roleSize, contentWidth), { x: roleX, y, size: roleSize, font: roleFont, color: roleColor });
      }
      y -= 16;
    }
    const contactParts = [state.personal.email, state.personal.phone, state.personal.location, state.personal.website].filter(Boolean).map(pdfSafe);
    if (contactParts.length) {
      const contactStr = fitText(reg, contactParts.join("   ·   "), 9.5, contentWidth);
      const contactX = leftAligned ? marginX : centeredX(contactStr, reg, 9.5);
      page.drawText(contactStr, { x: contactX, y, size: 9.5, font: reg, color: muted });
      y -= 14;
      if (!leftAligned) {
        // Classic: a thin full-width ink rule closes the centred header block.
        page.drawLine({ start: { x: marginX, y }, end: { x: rightEdge, y }, thickness: 1, color: ink });
      }
      y -= 6;
    }

    if (state.personal.summary) {
      // Split on real newlines first so paragraph breaks survive into the
      // PDF instead of being merged into one run-on line by the word-wrap.
      pdfSafe(state.personal.summary).split("\n").forEach((para) => {
        const words = para.split(/\s+/).filter(Boolean);
        if (!words.length) { ensureRoom(13); y -= 13; return; }
        let line = "";
        words.forEach((w) => {
          const candidate = line ? line + " " + w : w;
          if (reg.widthOfTextAtSize(candidate, 10) > contentWidth) {
            ensureRoom(13);
            page.drawText(line, { x: marginX, y, size: 10, font: reg, color: rgb(0.2, 0.2, 0.24) }); y -= 13;
            line = w;
          } else line = candidate;
        });
        if (line) { ensureRoom(13); page.drawText(line, { x: marginX, y, size: 10, font: reg, color: rgb(0.2, 0.2, 0.24) }); y -= 13; }
      });
      y -= 8;
    }

    function sectionHeader(title) {
      ensureRoom(6 + 4 + 16 + 13); // header + rule + gap + room for at least one content line, so headers never sit orphaned at a page bottom
      y -= isExecutive ? 10 : isMinimal ? 12 : isEditorial ? 8 : 6;
      // EXECUTIVE: UPPERCASE bold serif heading in deep charcoal-green over a SOLID
      // full-width rule. EDITORIAL: UPPERCASE letter-spaced near-black serif over a
      // hairline. MINIMAL: UPPERCASE, wide letter-spaced small grey label, NO rule.
      // Others: brand-coloured title over a light rule.
      const headText = (isEditorial || isExecutive || isMinimal) ? title.toUpperCase() : title;
      const headColor = isEditorial ? ink : isExecutive ? deep : isMinimal ? muted : brand;
      const headSize = isMinimal ? 9 : 10.5;
      if (isEditorial || isExecutive || isMinimal) {
        // Simulate letter-spacing by drawing characters with a fixed gap.
        const ls = isMinimal ? 2.4 : isExecutive ? 1.6 : 1.8;
        const headFont = isMinimal ? reg : bold;
        let cx = marginX;
        for (const ch of headText) {
          page.drawText(ch, { x: cx, y, size: headSize, font: headFont, color: headColor });
          cx += headFont.widthOfTextAtSize(ch, headSize) + ls;
        }
      } else {
        page.drawText(headText, { x: marginX, y, size: headSize, font: bold, color: headColor });
      }
      y -= 4;
      // MINIMAL has no section rule — just generous whitespace. Others draw a rule
      // (EXECUTIVE a solid deep 1pt line; EDITORIAL/others a light hairline).
      if (!isMinimal) {
        page.drawLine({ start: { x: marginX, y }, end: { x: rightEdge, y }, thickness: isExecutive ? 1 : 1, color: isExecutive ? deep : isEditorial ? rgb(0.78, 0.78, 0.8) : rgb(0.85, 0.85, 0.88) });
      }
      y -= isMinimal ? 12 : 16;
    }
    function wrapBullet(text) {
      const words = pdfSafe(text).split(/\s+/).filter(Boolean);
      const lines = []; let line = "";
      const maxW = contentWidth - 14;
      words.forEach((w) => {
        const candidate = line ? line + " " + w : w;
        if (reg.widthOfTextAtSize(candidate, 9.5) > maxW) { lines.push(line); line = w; } else line = candidate;
      });
      if (line) lines.push(line);
      return lines;
    }
    // Draws a bold title on the left and a date range right-aligned on the
    // same line, budgeting the title's fitText width around the date's
    // actual measured width so long titles can never overlap long dates.
    function titleDateRow(titleLine, dateLine, size) {
      const dateSafe = dateLine ? pdfSafe(dateLine) : "";
      const dateWidth = dateSafe ? reg.widthOfTextAtSize(dateSafe, 9) : 0;
      const gap = dateSafe ? 14 : 0;
      const titleMaxWidth = Math.max(80, contentWidth - dateWidth - gap);
      page.drawText(fitText(bold, pdfSafe(titleLine), size, titleMaxWidth), { x: marginX, y, size, font: bold, color: ink });
      if (dateSafe) page.drawText(dateSafe, { x: rightEdge - dateWidth, y: y + 1, size: 9, font: reg, color: muted });
    }

    const experienceEntries = state.experience.filter((e) => e.company || e.title);
    if (experienceEntries.length) {
      sectionHeader("Experience");
      experienceEntries.forEach((exp) => {
        ensureRoom(13 + (exp.location ? 13 : 0));
        const titleLine = [exp.title, exp.company].filter(Boolean).join(" · ") || "Role";
        const dateLine = [exp.start, exp.current ? "Present" : exp.end].filter(Boolean).join(" – ");
        titleDateRow(titleLine, dateLine, 11);
        y -= 13;
        if (exp.location) { page.drawText(pdfSafe(exp.location), { x: marginX, y, size: 9.5, font: italic, color: muted }); y -= 13; }
        exp.bullets.filter((b) => b.trim()).forEach((b) => {
          wrapBullet(b).forEach((line, li) => {
            ensureRoom(12.5);
            const prefix = li === 0 ? "•  " : "   ";
            page.drawText(prefix + line, { x: marginX + 4, y, size: 9.5, font: reg, color: rgb(0.2, 0.2, 0.24) }); y -= 12.5;
          });
        });
        y -= 6;
      });
    }

    const educationEntries = state.education.filter((e) => e.school || e.degree);
    if (educationEntries.length) {
      sectionHeader("Education");
      educationEntries.forEach((edu) => {
        ensureRoom(13 + (edu.school && (edu.degree || edu.field) ? 13 : 0));
        const titleLine = [edu.degree, edu.field].filter(Boolean).join(", ") || edu.school;
        const dateLine = [edu.start, edu.end].filter(Boolean).join(" – ");
        titleDateRow(titleLine, dateLine, 10.5);
        y -= 13;
        if (edu.school && (edu.degree || edu.field)) { page.drawText(pdfSafe(edu.school), { x: marginX, y, size: 9.5, font: italic, color: muted }); y -= 13; }
        y -= 4;
      });
    }

    if (state.skills.length) {
      sectionHeader("Skills");
      // Wrap across as many lines as needed instead of hard-truncating to
      // one line, so a long skill list is never silently cut off.
      let line = "";
      state.skills.map(pdfSafe).forEach((it) => {
        const candidate = line ? line + "   ·   " + it : it;
        if (reg.widthOfTextAtSize(candidate, 9.5) > contentWidth) {
          ensureRoom(13);
          page.drawText(line, { x: marginX, y, size: 9.5, font: reg, color: rgb(0.2, 0.2, 0.24) }); y -= 13;
          line = it;
        } else line = candidate;
      });
      if (line) { ensureRoom(13); page.drawText(line, { x: marginX, y, size: 9.5, font: reg, color: rgb(0.2, 0.2, 0.24) }); y -= 13; }
    }

    const bytes = await pdf.save();
    const safeName = (state.personal.name || "resume").replace(/[^\w.-]+/g, "-").slice(0, 40);
    await downloadPdfBytes(bytes, `${safeName}-resume.pdf`);
    status(msgHost, "PDF ready — saved to your downloads.", "ok");
  } catch (e) {
    status(msgHost, "Couldn't export that — try again. Your data on this device is unaffected.", "err");
  }
}
// Safari (desktop and iOS) treats a blob: URL typed "application/pdf" as
// viewable content and opens its own PDF viewer instead of honoring the
// <a download> attribute below, so the file never actually reaches
// Downloads. "application/octet-stream" has no built-in viewer, so every
// browser treats it as an opaque file and saves it instead — the file's
// .pdf extension (set on the <a download> filename) is what makes it
// open correctly afterward. The Capacitor native path re-reads the raw
// bytes via FileReader, so this is safe there too.
async function downloadPdfBytes(bytes, filename) {
  const blob = new Blob([bytes], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  if (window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform()) {
    // Directory is a plain JS enum exported from the @capacitor/filesystem
    // *package* (not a "plugin"), so it's never present on
    // window.Capacitor.Plugins in this no-bundler, plain-<script>-tag app —
    // destructuring it from there silently yields undefined, and
    // `directory: undefined.Cache` throws. "CACHE" is that enum's actual
    // underlying string value (confirmed against the vendored package),
    // used directly instead of a reference that doesn't exist here.
    const { Filesystem } = window.Capacitor.Plugins;
    const { Share } = window.Capacitor.Plugins;
    const base64 = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1]); r.readAsDataURL(blob); });
    const { uri } = await Filesystem.writeFile({ path: filename, data: base64, directory: "CACHE" });
    await Share.share({ title: filename, files: [uri] });
  } else {
    const a = el("a"); a.href = url; a.download = filename; document.body.appendChild(a); a.click();
    document.body.removeChild(a); setTimeout(() => URL.revokeObjectURL(url), 4000);
  }
}

// ── Plain-text / ATS export (free, pure string building) ────────────────────
// Builds a clean, ATS-safe plain-text rendering of the resume: name / role /
// contact on top, then SUMMARY, EXPERIENCE (company·title·dates + dash bullets),
// EDUCATION, and SKILLS as a comma list. Sections with no content are skipped.
// No markup, no libraries, no network — just a string. Uses "\n" line breaks;
// the download path normalizes to CRLF for maximum cross-editor compatibility.
function buildResumePlainText(st) {
  const p = st.personal || {};
  const lines = [];
  const push = (s) => lines.push(s);
  const blank = () => { if (lines.length && lines[lines.length - 1] !== "") push(""); };

  // Header — name, role, contact.
  push((p.name || "").trim() || "Your name");
  if (p.role && p.role.trim()) push(p.role.trim());
  const contact = [p.email, p.phone, p.location, p.website].filter((v) => v && v.trim());
  if (contact.length) push(contact.join("  |  "));

  const heading = (title) => { blank(); push(title); push("=".repeat(title.length)); };

  if (p.summary && p.summary.trim()) {
    heading("SUMMARY");
    p.summary.split("\n").forEach((l) => push(l.trim()));
  }

  const experienceEntries = (st.experience || []).filter((e) => (e.company && e.company.trim()) || (e.title && e.title.trim()));
  if (experienceEntries.length) {
    heading("EXPERIENCE");
    experienceEntries.forEach((exp, i) => {
      if (i > 0) push("");
      const titleLine = [exp.title, exp.company].filter((v) => v && v.trim()).join(" · ") || "Role";
      const dateLine = [exp.start, exp.current ? "Present" : exp.end].filter((v) => v && v.trim()).join(" – ");
      push([titleLine, dateLine].filter(Boolean).join("  |  "));
      if (exp.location && exp.location.trim()) push(exp.location.trim());
      (exp.bullets || []).filter((b) => b && b.trim()).forEach((b) => push("- " + b.trim()));
    });
  }

  const educationEntries = (st.education || []).filter((e) => (e.school && e.school.trim()) || (e.degree && e.degree.trim()));
  if (educationEntries.length) {
    heading("EDUCATION");
    educationEntries.forEach((edu, i) => {
      if (i > 0) push("");
      const titleLine = [edu.degree, edu.field].filter((v) => v && v.trim()).join(", ") || edu.school;
      const dateLine = [edu.start, edu.end].filter((v) => v && v.trim()).join(" – ");
      push([titleLine, dateLine].filter(Boolean).join("  |  "));
      if (edu.school && (edu.degree || edu.field) && edu.school.trim()) push(edu.school.trim());
    });
  }

  const skills = (st.skills || []).filter((s) => s && s.trim());
  if (skills.length) {
    heading("SKILLS");
    push(skills.map((s) => s.trim()).join(", "));
  }

  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

// A stable, filesystem-safe base for the .txt / clipboard filename.
function resumeFileBase() {
  return (state.personal.name || "resume").replace(/[^\w.-]+/g, "-").slice(0, 40) || "resume";
}

// "Download .txt" — builds the plain text and saves it as <name>-resume.txt via
// the octet-stream download path (same Safari-safe pattern as the PDF/DOCX).
async function doExportPlainText() {
  const msgHost = $("#editorMsg");
  try {
    const text = buildResumePlainText(state);
    // Normalize to CRLF so Windows Notepad and older editors render line breaks.
    const bytes = new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n"));
    await downloadPdfBytes(bytes, `${resumeFileBase()}-resume.txt`);
    status(msgHost, "Plain-text resume saved to your downloads.", "ok");
  } catch (e) {
    status(msgHost, "Couldn't export that — try again. Your data on this device is unaffected.", "err");
  }
}

// "Copy as plain text" — writes the plain-text resume to the clipboard. Falls
// back to a legible message if the clipboard API is blocked/unavailable.
async function doCopyPlainText(btn) {
  const msgHost = $("#editorMsg");
  let text;
  try { text = buildResumePlainText(state); }
  catch { status(msgHost, "Couldn't build the text — try again.", "err"); return; }
  try {
    if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error("no clipboard");
    await navigator.clipboard.writeText(text);
    if (btn) {
      const prev = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = prev; }, 2000);
    }
    status(msgHost, "Plain-text resume copied to your clipboard.", "ok");
  } catch {
    status(msgHost, "Couldn't copy automatically — use “Download .txt” instead.", "info");
  }
}

// ── ATS-safe Word (.docx) export (Pro) ─────────────────────────────────────
// Hand-builds a minimal, VALID WordprocessingML .docx via JSZip. ATS-safe by
// design: single column, one standard font (Calibri), real heading paragraphs,
// and bullets emitted as literal "• " text runs (no numbering XML) because
// applicant-tracking parsers read those far more reliably than w:numPr lists.
//
// SECURITY: every value below originates from attacker-controlled state, so it
// is passed through docxEscape() before it touches XML — &, <, >, ", ' are all
// entity-encoded so a pasted "<script>" or "Smith & Co" can never break the
// document's XML or inject markup. Nothing here is innerHTML; it's zip bytes.
function docxEscape(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// One <w:p> paragraph. `opts`: { bold, size (half-points), style, spaceAfter,
// color }. `text` is escaped here so callers pass raw user strings. w:spacing
// values are in twips (1/20 pt). xml:space="preserve" keeps the leading "• ".
function docxParagraph(text, opts) {
  opts = opts || {};
  const runProps = [];
  if (opts.bold) runProps.push("<w:b/>");
  if (opts.size) runProps.push('<w:sz w:val="' + opts.size + '"/>');
  if (opts.color) runProps.push('<w:color w:val="' + opts.color + '"/>');
  const rPr = runProps.length ? "<w:rPr>" + runProps.join("") + "</w:rPr>" : "";
  const pPrParts = [];
  if (opts.style) pPrParts.push('<w:pStyle w:val="' + opts.style + '"/>');
  const spaceAfter = opts.spaceAfter == null ? 0 : opts.spaceAfter;
  pPrParts.push('<w:spacing w:after="' + spaceAfter + '"/>');
  const pPr = "<w:pPr>" + pPrParts.join("") + "</w:pPr>";
  return "<w:p>" + pPr + '<w:r>' + rPr + '<w:t xml:space="preserve">' + docxEscape(text) + "</w:t></w:r></w:p>";
}

// Builds the whole resume as a valid .docx and returns its raw bytes
// (Uint8Array). Empty sections are skipped entirely. Synchronous zip build
// (STORE, no compression) keeps it fast and dependency-light.
function buildResumeDocx(st) {
  const p = st.personal || {};
  const body = [];

  // Name — large bold. Falls back so an empty resume still produces a valid file.
  body.push(docxParagraph((p.name || "").trim() || "Your name", { bold: true, size: 44, spaceAfter: 40 }));
  if (p.role && p.role.trim()) body.push(docxParagraph(p.role, { bold: true, size: 24, color: "047857", spaceAfter: 40 }));

  // Contact line — single joined paragraph (ATS parsers prefer one line).
  const contact = [p.email, p.phone, p.location, p.website].filter((v) => v && v.trim());
  if (contact.length) body.push(docxParagraph(contact.join("  |  "), { size: 18, color: "595959", spaceAfter: 120 }));

  const heading = (title) => body.push(docxParagraph(title, { style: "Heading1", bold: true, size: 24, color: "047857", spaceAfter: 60 }));

  if (p.summary && p.summary.trim()) {
    heading("SUMMARY");
    // Preserve author paragraph breaks: each line becomes its own <w:p>.
    p.summary.split("\n").forEach((line) => body.push(docxParagraph(line, { size: 20, spaceAfter: 60 })));
  }

  const experienceEntries = (st.experience || []).filter((e) => (e.company && e.company.trim()) || (e.title && e.title.trim()));
  if (experienceEntries.length) {
    heading("EXPERIENCE");
    experienceEntries.forEach((exp) => {
      const titleLine = [exp.title, exp.company].filter((v) => v && v.trim()).join(" · ") || "Role";
      body.push(docxParagraph(titleLine, { bold: true, size: 22, spaceAfter: 0 }));
      const dateLine = [exp.start, exp.current ? "Present" : exp.end].filter((v) => v && v.trim()).join(" – ");
      const subParts = [exp.location, dateLine].filter((v) => v && v.trim());
      if (subParts.length) body.push(docxParagraph(subParts.join("  |  "), { size: 18, color: "595959", spaceAfter: 40 }));
      (exp.bullets || []).filter((b) => b && b.trim()).forEach((b) => {
        // Literal "• " prefix — most ATS-safe bullet form.
        body.push(docxParagraph("• " + b.trim(), { size: 20, spaceAfter: 20 }));
      });
      body.push(docxParagraph("", { size: 12, spaceAfter: 80 })); // gap between entries
    });
  }

  const educationEntries = (st.education || []).filter((e) => (e.school && e.school.trim()) || (e.degree && e.degree.trim()));
  if (educationEntries.length) {
    heading("EDUCATION");
    educationEntries.forEach((edu) => {
      const titleLine = [edu.degree, edu.field].filter((v) => v && v.trim()).join(", ") || edu.school;
      body.push(docxParagraph(titleLine, { bold: true, size: 22, spaceAfter: 0 }));
      const subParts = [edu.school && (edu.degree || edu.field) ? edu.school : "", [edu.start, edu.end].filter((v) => v && v.trim()).join(" – ")].filter((v) => v && v.trim());
      if (subParts.length) body.push(docxParagraph(subParts.join("  |  "), { size: 18, color: "595959", spaceAfter: 80 }));
      else body.push(docxParagraph("", { size: 12, spaceAfter: 80 }));
    });
  }

  const skills = (st.skills || []).filter((s) => s && s.trim());
  if (skills.length) {
    heading("SKILLS");
    body.push(docxParagraph(skills.join(", "), { size: 20, spaceAfter: 0 }));
  }

  const documentXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    "<w:body>" + body.join("") +
    // Final sectPr: US Letter (12240×15840 twips), 1" margins (1440 twips).
    '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>' +
    "</w:body></w:document>";

  // styles.xml — sets Calibri as the document default so every run without an
  // explicit font renders in a standard, ATS-friendly typeface, and defines the
  // Heading1 style referenced by section headers.
  const stylesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault></w:docDefaults>' +
    '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>' +
    '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>' +
    "</w:styles>";

  const contentTypesXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    "</Types>";

  const relsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
    "</Relationships>";

  const docRelsXml =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    "</Relationships>";

  const zip = new JSZip();
  zip.file("[Content_Types].xml", contentTypesXml);
  zip.file("_rels/.rels", relsXml);
  zip.file("word/_rels/document.xml.rels", docRelsXml);
  zip.file("word/document.xml", documentXml);
  zip.file("word/styles.xml", stylesXml);
  return zip.generateAsync({ type: "uint8array", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
}

// Gated Pro export. Mirrors the cover-letter gate pattern: sync isPro() first,
// then a fresh network re-check, and only then the paywall — so a returning Pro
// customer whose cache hasn't warmed yet isn't wrongly shown the modal.
async function doExportDocx(ev) {
  const msgHost = $("#editorMsg");
  if (!Billing.isPro()) {
    // Busy-state: disable the gated button + show "Checking…" while the
    // entitlement re-check runs, guarding against double-clicks.
    const btn = ev && ev.currentTarget;
    let restoreBtn = null;
    if (btn && !btn.disabled) {
      const prev = btn.textContent;
      btn.disabled = true; btn.textContent = "Checking…";
      restoreBtn = () => { btn.disabled = false; btn.textContent = prev; };
    } else if (btn && btn.disabled) {
      return; // already checking — ignore the stacked click
    }
    let pro = false;
    try { pro = await Billing.refreshProStatus(); } catch { pro = Billing.isPro(); }
    if (restoreBtn) restoreBtn();
    // A verified re-check just ran — reconcile access so a revocation surfaces
    // its kind notice + re-lock here too (fails OPEN offline, so no false trip).
    reconcileProAccess();
    if (!pro) {
      // Remember the intent so a successful unlock/restore runs the export.
      setPendingIntent(() => doExportDocx());
      const jdContext = (jdLastResult && !$(".modal-backdrop.pro-paywall"))
        ? "You checked this job — export in the format ATS read best." : null;
      showProModal(jdContext ? { contextLine: jdContext } : undefined);
      return;
    }
  }
  try {
    const bytes = await buildResumeDocx(state);
    const safeName = (state.personal.name || "resume").replace(/[^\w.-]+/g, "-").slice(0, 40);
    // Same octet-stream download path the PDF export uses (Safari won't hijack
    // an octet-stream blob), with the .docx extension driving the file type.
    await downloadPdfBytes(bytes, `${safeName}-resume.docx`);
    status(msgHost, "Word (.docx) ready — saved to your downloads.", "ok");
  } catch (e) {
    status(msgHost, "Couldn't export that — try again. Your data on this device is unaffected.", "err");
  }
}

// ── Saved tailored versions (Pro) ────────────────────────────────────────
// One master résumé, plus named snapshots for different jobs. The WORKING
// résumé is always `state`; each version is a sanitized snapshot of the six
// content fields. Free tier keeps its single working résumé and may hold ONE
// saved version; saving a SECOND version is the Pro line (see gate below).
//
// GATE: mirrors the export/cover-letter pattern — a sync isPro() fast-path,
// then a verified refreshProStatus() re-check (fails OPEN offline), and only
// then the paywall, with the save re-run as a pending intent on unlock.

// Build a snapshot of the current working résumé (content fields only).
function snapshotFromState() {
  return sanitizeSnapshot(state);
}

// Overwrite the working résumé with a version's snapshot. Runs the snapshot
// through the same sanitizers as a disk load, so nothing hostile reaches the
// editor, then rebuilds. Marks which version is now loaded.
function applyVersionSnapshot(version) {
  const snap = sanitizeSnapshot(version.snapshot);
  state.template = snap.template;
  state.personal = snap.personal;
  state.experience = snap.experience;
  state.education = snap.education;
  state.skills = snap.skills;
  state.coverLetter = snap.coverLetter;
  // versions array itself is untouched — it lives on the working state and
  // persists across loads.
  loadedVersionId = version.id;
  persistNow();
  buildEditor();
}

// Persist a brand-new version from the current working résumé. `name` is
// already trimmed/validated by the caller.
function commitNewVersion(name) {
  const version = {
    id: makeVersionId(),
    name: name.slice(0, 80),
    savedAt: new Date().toISOString(),
    snapshot: snapshotFromState(),
  };
  state.versions.push(version);
  loadedVersionId = version.id; // the just-saved version is now the "loaded" one
  persistNow();
  buildEditor();
  const msg = $("#versionsMsg");
  if (msg) status(msg, `Saved “${name}” as a new version.`, "ok");
}

// The Pro gate for CREATING a new version. Free tier may keep exactly one
// saved version; a second one requires Pro. We check the gate against how many
// versions already exist (so a free user's first save is allowed, the second
// opens the paywall). Pro users are never gated.
function isProSync() { try { return Billing.isPro(); } catch { return false; } }

async function requestSaveVersion(ev) {
  // Free tier: the single working résumé + at most ONE saved version. Saving a
  // second version is the Pro action.
  const wouldExceedFree = state.versions.length >= 1;
  if (wouldExceedFree && !isProSync()) {
    const btn = ev && ev.currentTarget;
    let restoreBtn = null;
    if (btn && !btn.disabled) {
      const prev = btn.textContent;
      btn.disabled = true; btn.textContent = "Checking…";
      restoreBtn = () => { btn.disabled = false; btn.textContent = prev; };
    } else if (btn && btn.disabled) {
      return; // already checking — ignore the stacked click
    }
    let pro = false;
    try { pro = await Billing.refreshProStatus(); } catch { pro = isProSync(); }
    if (restoreBtn) restoreBtn();
    reconcileProAccess();
    if (!pro) {
      // Resume the save flow (re-checking the gate) after a successful unlock.
      setPendingIntent(() => requestSaveVersion());
      showProModal({ contextLine: "Save this as a tailored version — one master résumé, a tuned copy for every job." });
      return;
    }
  }
  promptVersionName("Save current résumé as a version", "", (name) => commitNewVersion(name));
}

// Rename an existing version in place (no Pro gate — renaming what you already
// own is always allowed).
function renameVersion(version) {
  promptVersionName("Rename version", version.name, (name) => {
    version.name = name.slice(0, 80);
    persistNow();
    buildEditor();
    const msg = $("#versionsMsg");
    if (msg) status(msg, "Renamed.", "ok");
  });
}

// Delete a version after a confirm. If the deleted version was the loaded one,
// clear the loaded badge (the working résumé itself is untouched).
function deleteVersion(version) {
  showConfirmModal(
    "Delete this version?",
    `“${version.name}” will be removed. Your working résumé on screen is not affected.`,
    "Delete version",
    () => {
      state.versions = state.versions.filter((v) => v.id !== version.id);
      if (loadedVersionId === version.id) loadedVersionId = null;
      persistNow();
      buildEditor();
      const msg = $("#versionsMsg");
      if (msg) status(msg, "Version deleted.", "ok");
    }
  );
}

// Load a version into the working résumé, confirming first so unsaved working
// edits are never silently discarded.
function loadVersion(version) {
  showConfirmModal(
    "Load this version?",
    `This replaces the résumé you're editing with “${version.name}”. Any unsaved changes to the current résumé will be lost — save them as a version first if you want to keep them.`,
    "Load version",
    () => applyVersionSnapshot(version)
  );
}

// A tiny single-input prompt modal (name a version / rename it). Reuses the
// paywall's dialog a11y (focus trap, Escape, labelled). CSP-safe: textContent
// + value only; the name is never written via innerHTML. Trims + requires a
// non-empty name; caps length so the list stays tidy.
function promptVersionName(title, initial, onConfirm) {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  const heading = txt("h3", null, title); heading.id = "versionNameHeading";
  modal.appendChild(heading);
  modal.appendChild(txt("p", "hint", "Give it a name you'll recognize, e.g. “Acme — Product Designer”."));
  const input = document.createElement("input");
  input.type = "text";
  input.className = "version-name-input";
  input.maxLength = 80;
  input.placeholder = "Acme — Product Designer";
  input.value = initial || "";
  input.setAttribute("aria-label", "Version name");
  input.setAttribute("autocomplete", "off"); input.spellcheck = false;
  modal.appendChild(input);
  const msgHost = el("div", "pro-msg"); markLiveRegion(msgHost);
  const goBtn = txt("button", "btn big", "Save"); goBtn.type = "button";
  const submit = () => {
    const name = input.value.trim();
    if (!name) { status(msgHost, "Please enter a name for this version.", "err"); input.focus(); return; }
    backdrop.remove();
    onConfirm(name);
  };
  goBtn.onclick = submit;
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } });
  const cancelBtn = txt("button", "btn ghost", "Cancel"); cancelBtn.type = "button";
  cancelBtn.onclick = () => backdrop.remove();
  const actions = el("div", "pro-actions"); actions.append(goBtn, cancelBtn);
  modal.append(actions, msgHost);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
  setupDialogA11y(backdrop, modal, { labelledBy: "versionNameHeading", escCloses: true });
}

// A short, human "saved at" label. Never throws on a missing/garbage date.
function versionSavedLabel(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  try {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch { return ""; }
}

// The Versions panel — a compact control near the top of the editor. Free
// users see it (the feature is discoverable); the SAVE button opens the paywall
// on the second save via requestSaveVersion(). The list shows each saved
// version with load / rename / delete and a "Loaded" badge on the active one.
function buildVersionsPanel() {
  const panel = el("div", "panel versions-panel");
  const head = el("div", "versions-head");
  head.appendChild(txt("h3", null, "Versions"));
  const pro = isProSync();
  if (!pro) head.appendChild(txt("span", "versions-pro-tag", "Pro"));
  panel.appendChild(head);
  panel.appendChild(txt("p", "hint versions-sub",
    "Keep one master résumé and save a tuned copy for every job — switch between them anytime."));

  const saveBtn = txt("button", "btn ghost sm versions-save", "Save current as a new version");
  saveBtn.type = "button";
  saveBtn.onclick = (e) => requestSaveVersion(e);
  panel.appendChild(saveBtn);

  const list = el("div", "versions-list");
  if (!state.versions.length) {
    list.appendChild(txt("p", "hint versions-empty", "No saved versions yet. Tailor your résumé for a job, then save it here."));
  } else {
    state.versions.forEach((v) => list.appendChild(versionRow(v)));
  }
  panel.appendChild(list);

  const msgHost = el("div"); msgHost.id = "versionsMsg"; markLiveRegion(msgHost);
  panel.appendChild(msgHost);
  return panel;
}

// One row in the versions list: name + saved date + Loaded badge, and
// load/rename/delete controls. All user text via textContent.
function versionRow(v) {
  const row = el("div", "version-row");
  if (loadedVersionId === v.id) row.classList.add("is-loaded");
  const info = el("div", "version-info");
  const nameLine = el("div", "version-nameline");
  nameLine.appendChild(txt("span", "version-name", v.name));
  if (loadedVersionId === v.id) {
    const badge = txt("span", "version-badge", "Loaded");
    badge.setAttribute("aria-label", "Currently loaded version");
    nameLine.appendChild(badge);
  }
  info.appendChild(nameLine);
  const savedLabel = versionSavedLabel(v.savedAt);
  if (savedLabel) info.appendChild(txt("span", "version-date", "Saved " + savedLabel));
  row.appendChild(info);

  const actions = el("div", "version-actions");
  const loadBtn = txt("button", "btn ghost sm", "Load"); loadBtn.type = "button";
  loadBtn.setAttribute("aria-label", `Load version: ${v.name}`);
  loadBtn.onclick = () => loadVersion(v);
  const renameBtn = txt("button", "btn ghost sm", "Rename"); renameBtn.type = "button";
  renameBtn.setAttribute("aria-label", `Rename version: ${v.name}`);
  renameBtn.onclick = () => renameVersion(v);
  const delBtn = txt("button", "btn ghost sm version-del", "Delete"); delBtn.type = "button";
  delBtn.setAttribute("aria-label", `Delete version: ${v.name}`);
  delBtn.onclick = () => deleteVersion(v);
  actions.append(loadBtn, renameBtn, delBtn);
  row.appendChild(actions);
  return row;
}

// ── Cover letter (Pro) ───────────────────────────────────────────────────
function buildCoverLetterPanel() {
  const panel = el("div", "panel");
  panel.appendChild(txt("h3", null, "Cover letter (Pro)"));
  if (!Billing.isPro()) {
    const lockNote = txt("p", "hint", "Write a matching cover letter and export it as its own PDF.");
    const unlock = txt("button", "btn ghost sm", "Unlock Pro"); unlock.type = "button";
    unlock.onclick = () => {
      // After unlock/restore, re-render so the now-unlocked cover-letter panel
      // is revealed and scrolled into view (the intent the user was after).
      setPendingIntent(() => {
        const clPanel = $(".panel h3");
        // refreshAfterProChange already rebuilt the editor; just bring the
        // cover-letter section into view for a smooth resume of intent.
        const heads = Array.from(document.querySelectorAll(".panel h3"));
        const clHead = heads.find((h) => /cover letter/i.test(h.textContent));
        if (clHead && clHead.scrollIntoView) clHead.scrollIntoView({ behavior: "smooth", block: "center" });
        void clPanel;
      });
      showProModal();
    };
    panel.append(lockNote, unlock);
    return panel;
  }
  const cl = state.coverLetter;
  panel.appendChild(field("Recipient name (optional)", cl.recipientName, (v) => { cl.recipientName = v; scheduleSave(); }));
  panel.appendChild(field("Company", cl.company, (v) => { cl.company = v; scheduleSave(); }));
  panel.appendChild(field("Greeting", cl.greeting || "Dear Hiring Manager,", (v) => { cl.greeting = v; scheduleSave(); }));
  panel.appendChild(field("Letter body", cl.body, (v) => { cl.body = v; scheduleSave(); }, true));
  const exportBtn = txt("button", "btn ghost sm", "Download Cover Letter PDF"); exportBtn.type = "button";
  // Busy state while the PDF builds (first export also lazy-loads pdf-lib).
  exportBtn.onclick = async () => {
    if (exportBtn.disabled) return;
    const orig = exportBtn.textContent; exportBtn.disabled = true; exportBtn.textContent = "Generating…";
    try { await doExportCoverLetter(); } finally { exportBtn.disabled = false; exportBtn.textContent = orig; }
  };
  panel.appendChild(exportBtn);
  const msgHost = el("div"); msgHost.id = "coverLetterMsg"; markLiveRegion(msgHost); panel.appendChild(msgHost);
  return panel;
}
// ── Pro experience layer (celebration, self-heal, resume-intent, a11y) ───
// A one-time "celebrated" flag so the ownership moment fires exactly once per
// browser, ever — never on later visits, never on a restore.
const CELEBRATED_KEY = "localresume.celebrated";
function hasCelebrated() { try { return localStorage.getItem(CELEBRATED_KEY) === "1"; } catch { return false; } }
function markCelebrated() { try { localStorage.setItem(CELEBRATED_KEY, "1"); } catch { /* private-browsing: may re-fire, acceptable */ } }
function clearCelebrated() { try { localStorage.removeItem(CELEBRATED_KEY); } catch { /* private-browsing: harmless */ } }

// ── Refund request (customer-initiated, request-only) ────────────────────
// A refund is money movement, so the app NEVER executes one — this only makes
// ASKING effortless. The link hands off to the user's own mail client via a
// pre-filled mailto: (subject + body). A real person (Eden / support) reviews
// and processes it through Stripe. No refund/charge API is ever called here.
const SUPPORT_EMAIL = "support@localresumeapp.com";
// True only inside the Capacitor iOS/Android shell. On iOS, Pro is bought via Apple
// In-App Purchase (Guideline 3.1.1) — so the paywall/success/restore UI must NOT reference
// Stripe checkout, email receipts, "your statement", or the web-only restore-CODE mechanism.
// Every use is `if (IS_NATIVE) {…} else {…exact existing web copy…}` so the live web build is
// byte-for-byte unchanged.
const IS_NATIVE = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
const REFUND_EXPECTATION = "30-day money-back guarantee. Email us and a real person reviews it — no forms, no runaround. Once approved, your refund goes back to your original payment method and takes about 5–10 business days to appear on your statement.";
// Builds the pre-filled mailto: URL. The restore code (if any on this device)
// is auto-inserted so support can find the purchase; a null code is stated
// plainly rather than left blank.
function buildRefundMailto() {
  let code = null;
  try { code = Billing.getRestoreCode(); } catch { code = null; }
  const subject = "Refund request — LocalResume Pro";
  const body =
    "Hi LocalResume team,\n\n" +
    "I'd like to request a refund for my LocalResume Pro purchase.\n\n" +
    "My restore code: " + (code || "(no code on this device)") + "\n" +
    "Reason (optional): \n\n" +
    "Thanks — I understand a real person will review this and reply.\n";
  return "mailto:" + SUPPORT_EMAIL + "?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
}
// ── Graceful, non-destructive access-stop (Pro revoked / refunded) ───────
// When Eden processes a refund, RevenueCat revokes the entitlement and the next
// VERIFIED refreshProStatus() returns false (it fails OPEN offline, so an
// offline owner keeps isPro()===true and never trips this). We track a "was_pro"
// flag and, on a genuine true→false transition, show ONE calm notice, reset the
// celebration flag, and re-lock gated OUTPUT — without ever touching user data.
const WAS_PRO_KEY = "localresume.was_pro";
function setWasPro(v) { try { localStorage.setItem(WAS_PRO_KEY, v ? "1" : "0"); } catch { /* private-browsing: harmless */ } }
function getWasPro() { try { return localStorage.getItem(WAS_PRO_KEY) === "1"; } catch { return false; } }

// Call AFTER any refreshProStatus() (boot + gate checks). If Pro is now a
// verified false but we'd recorded them as Pro, treat it as a real revocation
// (refund/expiry) and run the kind, non-destructive access-stop exactly once.
// Otherwise, if they're Pro, remember that so a future revocation is detectable.
function reconcileProAccess() {
  let isPro = false;
  try { isPro = Billing.isPro(); } catch { isPro = false; }
  if (isPro) { setWasPro(true); return; }
  // Not Pro right now. Only a genuine verified false that FOLLOWS a known-Pro
  // state is a revocation — a never-Pro visitor has was_pro unset and is skipped.
  if (getWasPro()) handleAccessStop();
}

// The revocation transition itself. NON-DESTRUCTIVE: it re-gates only Pro
// OUTPUT/exports (via refreshAfterProChange, exactly as for a never-Pro user)
// and never deletes or clears any saved resume, cover letter, or document.
let accessStopShown = false; // guard against a double-fire within one session
function handleAccessStop() {
  if (accessStopShown) return;
  accessStopShown = true;
  // 2. Never repeat the notice.
  setWasPro(false);
  // 3. Reset celebration so a fresh re-purchase celebrates again.
  clearCelebrated();
  // 1. One-time calm, dismissible notice.
  showAccessEndedBanner();
  // 4. Re-lock gated buttons + hide the footer license link / self-heal nag.
  try { refreshAfterProChange(); } catch (e) { console.error(e); }
}

// A calm, dismissible top banner reusing the app's banner slot/idiom (like
// save-nag / selfheal-nag). No guilt, no hard re-sell — data-safe reassurance.
function showAccessEndedBanner() {
  if ($("#accessEndedBanner")) return;
  const b = el("div", "access-ended-nag"); b.id = "accessEndedBanner";
  b.setAttribute("role", "status");
  b.setAttribute("aria-live", "polite");
  // Says WHY (a refund is the one thing that verifiably revokes access) and gives an
  // escape hatch, so a mistaken revocation never dead-ends on this banner.
  b.appendChild(txt("span", "access-ended-text",
    "Your LocalResume Pro access has ended — this usually follows a refund. If it's unexpected, email support@localresumeapp.com and we'll sort it out. Everything you made is safe and still here, and every free feature keeps working — you're always welcome back."));
  const closeBtn = txt("button", "access-ended-close", "×"); closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Dismiss");
  closeBtn.onclick = () => b.remove();
  b.appendChild(closeBtn);
  document.body.insertBefore(b, document.body.firstChild);
}

// Renders the quiet "Need a refund?" entry (a details/summary disclosure with a
// calm expectation line + a mailto button). Owner-only; callers gate on isPro().
function buildRefundEntry() {
  const wrap = el("details", "refund-entry");
  const summary = txt("summary", "refund-summary", "Need a refund?");
  wrap.appendChild(summary);
  wrap.appendChild(txt("p", "refund-expect", REFUND_EXPECTATION));
  const mailBtn = txt("a", "btn ghost sm refund-btn", "Email a refund request");
  mailBtn.href = buildRefundMailto();
  wrap.appendChild(mailBtn);
  return wrap;
}

// ── Resume-the-gated-intent ────────────────────────────────────────────
// When a gate opens the paywall, we stash the exact action the user was after
// (a zero-arg closure). After a successful unlock OR restore we run it once and
// clear it, so they aren't dropped back to hunt for the button they clicked.
let pendingIntent = null;
function setPendingIntent(fn) { pendingIntent = typeof fn === "function" ? fn : null; }
function runPendingIntent() {
  const fn = pendingIntent;
  pendingIntent = null;
  if (fn) { try { fn(); } catch (e) { console.error("LocalResume: pending intent failed", e); } }
}

// Called after ANY change to Pro status (purchase, mint, restore, boot-refresh)
// so every gated surface re-renders and the license link/self-heal banner sync.
function refreshAfterProChange() {
  // Record ownership so a later verified revocation is detectable. Safe against
  // recursion: when Pro is true this just sets the flag; when called from within
  // handleAccessStop() the flag was already cleared, so it won't re-fire.
  try { reconcileProAccess(); } catch (e) { console.error(e); }
  try { buildEditor(); } catch (e) { console.error(e); }
  try { updateLicenseFooterLink(); } catch (e) { console.error(e); }
  try { updateUnlockProCard(); } catch (e) { console.error(e); }
  try { maybeShowSaveNag(); } catch (e) { console.error(e); }
  try { maybeShowSelfHealNag(); } catch (e) { console.error(e); }
}

// Lightweight aria-live toast for transient success (e.g. restore succeeded).
function showToast(message) {
  const existing = $(".lr-toast");
  if (existing) existing.remove();
  const toast = el("div", "lr-toast");
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.appendChild(document.createTextNode(message));
  document.body.appendChild(toast);
  setTimeout(() => { if (toast.parentNode) toast.remove(); }, 4200);
}

// Pure-CSS/DOM confetti, reduced-motion aware. The CSS hides .confetti-layer
// entirely under prefers-reduced-motion, but we ALSO short-circuit here so no
// nodes are created and no motion is implied — the message alone carries it.
function fireConfetti() {
  try {
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  } catch { /* if matchMedia throws, fall through to the CSS guard */ }
  const layer = el("div", "confetti-layer");
  layer.setAttribute("aria-hidden", "true");
  const colors = ["#047857", "#34d399", "#a7f3d0", "#065f46", "#6ee7b7"];
  for (let i = 0; i < 42; i++) {
    const piece = el("div", "confetti-piece");
    piece.style.left = Math.random() * 100 + "vw";
    piece.style.background = colors[i % colors.length];
    piece.style.animationDuration = (2.6 + Math.random() * 1.8) + "s";
    piece.style.animationDelay = (Math.random() * 0.5) + "s";
    piece.style.width = (6 + Math.random() * 6) + "px";
    piece.style.height = (10 + Math.random() * 8) + "px";
    layer.appendChild(piece);
  }
  document.body.appendChild(layer);
  setTimeout(() => { if (layer.parentNode) layer.remove(); }, 5200);
}

// ── Paywall a11y helpers (focus move + trap + Escape) ──────────────────
// Wires a modal backdrop as a proper dialog: labelled, focus moved inside,
// Tab focus trapped, and (when closable) Escape closes it. Returns nothing;
// the caller keeps its own reference to backdrop for removal.
function setupDialogA11y(backdrop, modal, { labelledBy, escCloses } = {}) {
  modal.setAttribute("role", "dialog");
  modal.setAttribute("aria-modal", "true");
  if (labelledBy) modal.setAttribute("aria-labelledby", labelledBy);
  const prevFocus = document.activeElement;
  const focusables = () => Array.from(modal.querySelectorAll(
    'button, [href], input, textarea, select, [tabindex]:not([tabindex="-1"])'
  )).filter((n) => !n.disabled && n.offsetParent !== null);
  // Move focus into the modal (first focusable, else the modal itself).
  setTimeout(() => {
    const f = focusables();
    if (f.length) f[0].focus();
    else { modal.setAttribute("tabindex", "-1"); modal.focus(); }
  }, 0);
  backdrop.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && escCloses) {
      e.preventDefault();
      backdrop.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
      return;
    }
    if (e.key !== "Tab") return;
    const f = focusables();
    if (!f.length) { e.preventDefault(); return; }
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  // Restore focus to the opener when the backdrop is removed.
  const mo = new MutationObserver(() => {
    if (!document.body.contains(backdrop)) {
      mo.disconnect();
      if (prevFocus && prevFocus.focus && document.body.contains(prevFocus)) prevFocus.focus();
    }
  });
  mo.observe(document.body, { childList: true });
}

// ── Restore-code input auto-format (mirrors billing's normalization) ────
// Uppercases, strips junk, and regroups into LRES-XXXX-XXXX-XXXX as the user
// types or pastes. Billing normalizes on its side too; this just makes the
// field look right. Prefix is fixed by the billing contract.
const RESTORE_PREFIX = "LRES";
function formatRestoreCode(raw) {
  const val = String(raw || "");
  // Leave a raw account id ($RCAnonymousID:… or a legacy custom id — the Fix C
  // fallback restore code) untouched; those are case-sensitive, and their marker
  // chars never appear in a real minted code.
  if (/[_$]/.test(val)) return val.trim();
  let s = val.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // A valid code body can NEVER contain "LRES" (the L isn't in the code alphabet), so any
  // "LRES" is a prefix marker — take everything after the LAST one. Strips a doubled
  // "LRES-LRES-…" AND a leading label like "Code: LRES-…" that survived char-stripping.
  const pi = s.lastIndexOf(RESTORE_PREFIX);
  if (pi >= 0) s = s.slice(pi + RESTORE_PREFIX.length);
  // Body chars come only from billing's unambiguous CODE_ALPHABET (no 0/O/1/I/L).
  const body = s.replace(/[^23456789ABCDEFGHJKMNPQRSTUVWXYZ]/g, "").slice(0, 12);
  const groups = body.match(/.{1,4}/g) || [];
  return groups.length ? RESTORE_PREFIX + "-" + groups.join("-") : "";
}
// A backup's carried Pro code is only worth a billing check when it LOOKS like a real
// credential: a minted code (LRES- + 12 chars of billing's unambiguous alphabet) or a raw
// RC identity (contains $ or _, e.g. $RCAnonymousID:… — the fallback credential a code-mint
// failure can legitimately store and export). Junk (a hand-edited backup) could only ever
// come back "not entitled" or network-error — and the import flow's network-error path
// deliberately keeps every version, which would let a made-up code sidestep the free-tier
// cap while offline. NOTE: tested on the stripped string directly, not via
// formatRestoreCode(), which ADDS the prefix to any stray letters and would wave junk through.
function looksLikeRestoreCredential(raw) {
  const val = String(raw || "").trim();
  if (!val) return false;
  if (/[_$]/.test(val)) return true; // raw RC identity — case-sensitive, never reformatted
  // Same normalization steps the formatter uses (uppercase, strip separators, take what
  // follows the LAST prefix marker) — but the prefix must actually be there.
  const s = val.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const pi = s.lastIndexOf(RESTORE_PREFIX);
  if (pi < 0) return false;
  return /^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{12}$/.test(s.slice(pi + RESTORE_PREFIX.length));
}
// Live handler: ONLY uppercase in place (non-destructive, caret kept), and
// normalize once at submit. A live regrouper that injects the prefix creates a
// feedback loop that absorbs a hand-typed L-R-E-S into the code body
// ("LRES-LRES-…", truncating the real tail) — the exact owner-lockout Local PDF
// already hit and fixed; this mirrors its proven normalize-at-submit pattern.
function wireRestoreInput(input) {
  input.addEventListener("input", () => {
    const val = input.value;
    if (/[_$]/.test(val)) return; // case-sensitive raw ids stay exactly as pasted
    const up = val.toUpperCase();
    if (up !== val) {
      const pos = input.selectionStart;
      input.value = up;
      try { input.setSelectionRange(pos, pos); } catch {}
    }
  });
}

// ── Pro license card (loss-proofing the restore code) ───────────────────
const CODE_ACK_KEY = "localresume.code_ack";
function ackLicenseSaved() {
  try { localStorage.setItem(CODE_ACK_KEY, "1"); } catch { /* private-browsing lockout — nag just reappears next load */ }
  const banner = $("#saveNagBanner");
  if (banner) banner.remove();
}
function downloadLicenseCardPng(canvas) {
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = el("a"); a.href = url; a.download = "localresume-pro-license.png";
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }, "image/png");
}
function licenseCardCanvas(code) {
  const canvas = Billing.renderLicenseCard(code, "LocalResume");
  canvas.className = "license-card-canvas";
  return canvas;
}

function showLicenseCardModal() {
  const code = Billing.getRestoreCode();
  if (!code) return;
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal license-modal");
  const lcHeading = txt("h3", null, "Your Pro license card"); lcHeading.id = "lcHeading";
  modal.appendChild(lcHeading);
  modal.appendChild(txt("p", "hint", "Download or print this card and keep it somewhere safe — it's the key that restores your Pro purchase on any device."));
  const canvas = licenseCardCanvas(code);
  modal.appendChild(canvas);
  const dlBtn = txt("button", "btn ghost", "Download card (PNG)"); dlBtn.type = "button";
  dlBtn.onclick = () => downloadLicenseCardPng(canvas);
  const copyBtn = txt("button", "btn ghost", "Copy code"); copyBtn.type = "button";
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(code); copyBtn.textContent = "Copied!"; }
    catch { copyBtn.textContent = "Couldn't copy"; }
    setTimeout(() => { copyBtn.textContent = "Copy code"; }, 2000);
  };
  const saveBtn = txt("button", "btn big", "I've saved it"); saveBtn.type = "button";
  saveBtn.onclick = () => { ackLicenseSaved(); backdrop.remove(); };
  const actions = el("div", "pro-actions"); actions.append(dlBtn, copyBtn, saveBtn);
  modal.appendChild(actions);
  // Quiet, guilt-free refund path for owners — one clear route, no retention trap.
  modal.appendChild(buildRefundEntry());
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
  setupDialogA11y(backdrop, modal, { labelledBy: "lcHeading", escCloses: true });
}

function showRestoreCodeModal(code) {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal license-modal");
  const rcHeading = txt("h3", null, "You're Pro — save your restore code"); rcHeading.id = "rcHeading";
  modal.appendChild(rcHeading);
  modal.appendChild(txt("p", "hint", "This code unlocks Pro again on another device or browser. Save it somewhere safe now — since there are no accounts, it's the key you'll use next time."));
  const receiptNote = el("p", "hint");
  receiptNote.append("Keep your receipt email too — it's your proof of purchase. Questions? ");
  const rcSupport = txt("a", null, "support@localresumeapp.com");
  rcSupport.href = "mailto:support@localresumeapp.com";
  receiptNote.appendChild(rcSupport);
  modal.appendChild(receiptNote);
  const codeBox = el("div", "restore-code-box");
  const codeText = txt("code", "restore-code-value", code || "—");
  codeBox.appendChild(codeText);
  const copyBtn = txt("button", "btn ghost sm", "Copy"); copyBtn.type = "button";
  copyBtn.onclick = async () => {
    try { await navigator.clipboard.writeText(code); copyBtn.textContent = "Copied!"; }
    catch { copyBtn.textContent = "Couldn't copy — select and copy manually"; }
    setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
  };
  codeBox.appendChild(copyBtn);
  modal.appendChild(codeBox);
  if (code) {
    const canvas = licenseCardCanvas(code);
    modal.appendChild(canvas);
    const dlBtn = txt("button", "btn ghost", "Download card (PNG)"); dlBtn.type = "button";
    dlBtn.onclick = () => downloadLicenseCardPng(canvas);
    const dlWrap = el("div", "pro-actions"); dlWrap.style.marginBottom = "10px";
    dlWrap.appendChild(dlBtn);
    modal.appendChild(dlWrap);
  }
  const doneBtn = txt("button", "btn big", "I've saved it"); doneBtn.type = "button";
  doneBtn.onclick = () => { ackLicenseSaved(); backdrop.remove(); refreshAfterProChange(); };
  const actions = el("div", "pro-actions"); actions.append(doneBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  // Code-save modal: Escape must NOT close it (guardrail) — it's a save-your-key moment.
  setupDialogA11y(backdrop, modal, { labelledBy: "rcHeading", escCloses: false });
}

// ── Celebration / ownership moment (once per lifetime) ──────────────────
// Shows a warm one-time unlock moment: headline, thank-you, "what you just
// unlocked" list, brief reduced-motion-aware confetti, THEN the existing
// save-your-code / license-card section (or an amber self-heal note when the
// code couldn't be minted). Sets the celebrated flag so it never fires again.
// `code` is the restore code (may be null → amber path). `alreadyOwned` = billing
// confirmed an existing purchase without attempting a mint, so a null code takes a
// calm no-failure-framing path instead of amber.
function showCelebrationModal(code, alreadyOwned) {
  const alreadyCelebrated = hasCelebrated();
  markCelebrated();
  fireConfetti();
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal license-modal");

  const head = el("div", "celebrate-head");
  const title = txt("div", "celebrate-title", "It's yours — forever."); title.id = "celebrateTitle";
  head.appendChild(title);
  head.appendChild(txt("p", "celebrate-thanks", IS_NATIVE
    ? "Thank you for supporting a private, on-device tool. LocalResume Pro is now unlocked on this device."
    : "Thank you for supporting a private, on-device tool. LocalResume Pro is now unlocked on this browser."));
  modal.appendChild(head);

  const unlocked = el("ul", "celebrate-unlocked");
  ["ATS-ready Word (.docx) export", "The cover-letter builder + its PDF export", "Tailor-to-job hints", "Unlimited saved versions"].forEach((f) => unlocked.appendChild(txt("li", null, f)));
  modal.appendChild(unlocked);

  modal.appendChild(el("hr", "celebrate-divider"));

  if (code) {
    // Normal path: reveal the save-your-code / license-card section inline.
    modal.appendChild(txt("h3", null, "Save your restore code"));
    modal.appendChild(txt("p", "hint", "This code unlocks Pro again on another device or browser. Save it somewhere safe now — since there are no accounts, it's the key you'll use next time."));
    const codeBox = el("div", "restore-code-box");
    codeBox.appendChild(txt("code", "restore-code-value", code));
    const copyBtn = txt("button", "btn ghost sm", "Copy"); copyBtn.type = "button";
    copyBtn.onclick = async () => {
      try { await navigator.clipboard.writeText(code); copyBtn.textContent = "Copied!"; }
      catch { copyBtn.textContent = "Couldn't copy — select and copy manually"; }
      setTimeout(() => { copyBtn.textContent = "Copy"; }, 2000);
    };
    codeBox.appendChild(copyBtn);
    modal.appendChild(codeBox);
    const canvas = licenseCardCanvas(code);
    modal.appendChild(canvas);
    const dlBtn = txt("button", "btn ghost", "Download card (PNG)"); dlBtn.type = "button";
    dlBtn.onclick = () => downloadLicenseCardPng(canvas);
    const dlWrap = el("div", "pro-actions"); dlWrap.style.marginBottom = "10px";
    dlWrap.appendChild(dlBtn);
    modal.appendChild(dlWrap);
    const doneBtn = txt("button", "btn big", "I've saved it"); doneBtn.type = "button";
    doneBtn.onclick = () => { ackLicenseSaved(); backdrop.remove(); refreshAfterProChange(); };
    const actions = el("div", "pro-actions"); actions.appendChild(doneBtn);
    modal.appendChild(actions);
  } else if (IS_NATIVE) {
    // Apple IAP mints no restore CODE — cross-device restore is handled by the Apple Account +
    // "Restore Purchases", so skip the mint section entirely and show a clean success.
    modal.appendChild(txt("p", "hint", "Pro is unlocked on this device — and it restores free on your other Apple devices. Just tap “Restore Purchases” there, signed in with the same Apple Account."));
    const doneBtn = txt("button", "btn big", "Done"); doneBtn.type = "button";
    doneBtn.onclick = () => { backdrop.remove(); refreshAfterProChange(); };
    const actions = el("div", "pro-actions"); actions.appendChild(doneBtn);
    modal.appendChild(actions);
  } else if (alreadyOwned) {
    // Already-owned unlock with no stored code: NO mint ran on this pass, so never claim
    // one failed. Calm confirm — the self-heal banner offers to create a code afterwards.
    modal.appendChild(txt("p", "hint", "Pro is unlocked on this device."));
    const doneBtn = txt("button", "btn big", "Done"); doneBtn.type = "button";
    doneBtn.onclick = () => { backdrop.remove(); refreshAfterProChange(); };
    const actions = el("div", "pro-actions"); actions.appendChild(doneBtn);
    modal.appendChild(actions);
  } else {
    // Amber self-heal path: paid, but code-mint failed. Honest, never silent.
    const note = el("div", "amber-note");
    note.appendChild(document.createTextNode("One thing — we couldn't create your restore code just now. Pro already works on this browser. Tap to create your code for other devices."));
    const mintBtn = txt("button", "btn", "Create my restore code"); mintBtn.type = "button";
    const mintMsg = el("div", "pro-msg"); markLiveRegion(mintMsg);
    mintBtn.onclick = async () => {
      mintBtn.disabled = true; mintBtn.textContent = "Creating…";
      let res;
      try { res = await Billing.mintRestoreCode(); } catch { res = { ok: false, restoreCode: null }; }
      if (res && res.ok && res.restoreCode) {
        backdrop.remove();
        showRestoreCodeModal(res.restoreCode);
        refreshAfterProChange();
      } else {
        mintBtn.disabled = false; mintBtn.textContent = "Create my restore code";
        status(mintMsg, "No luck yet — Pro still works here; we'll offer again next visit, and support@localresumeapp.com + your receipt always work.", "info");
      }
    };
    note.appendChild(mintBtn);
    modal.appendChild(note);
    modal.appendChild(mintMsg);
    const doneBtn = txt("button", "btn big", "Done"); doneBtn.type = "button";
    doneBtn.onclick = () => { backdrop.remove(); refreshAfterProChange(); };
    const actions = el("div", "pro-actions"); actions.appendChild(doneBtn);
    modal.appendChild(actions);
  }

  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  setupDialogA11y(backdrop, modal, { labelledBy: "celebrateTitle", escCloses: false });
  // Guard against a double-celebration if somehow called twice in one session.
  void alreadyCelebrated;
}

// Routes a successful purchase to the right post-unlock experience: celebrate
// once per lifetime, otherwise (already celebrated — e.g. a repeat unlock) just
// show the plain save-code / self-heal flow. Then resumes any pending intent.
// `alreadyOwned` marks billing's already-owned successes (the pre-checkout peek /
// the re-buy guard): NO mint ran on that pass, so a missing code must read as a
// calm success, never as "we couldn't create your restore code".
function handleUnlockSuccess(code, alreadyOwned) {
  // Prefer the code this browser already holds — most already-owned passes have one.
  if (!code && alreadyOwned) { try { code = Billing.getRestoreCode(); } catch { /* keep null */ } }
  if (!hasCelebrated()) {
    showCelebrationModal(code, alreadyOwned);
  } else if (code) {
    showRestoreCodeModal(code);
  } else if (alreadyOwned) {
    // Calm neutral confirm — the self-heal banner (refreshAfterProChange below) offers
    // to create a code without any failure framing.
    showToast("Pro is unlocked on this device.");
  } else {
    // Already celebrated before but no code this time — offer the mint path.
    showNoCodeSelfHealModal();
  }
  refreshAfterProChange();
  runPendingIntent();
}

// Called when the charge SUCCEEDED but the entitlement is still attaching (billing
// returned { pending:true }). The customer HAS paid — so this must never read as a
// failure. Reassure, give them their restore code now, and quietly promote to a full
// unlock the moment the entitlement lands (no manual reload needed).
function handlePurchasePending(restoreCode, message) {
  const msg = message || "Your payment went through — your Pro is unlocking now. If it doesn't appear in a moment, reload this page.";
  showToast(msg); // role=status aria-live — surfaces the reassurance visually and to AT
  if (restoreCode) showRestoreCodeModal(restoreCode); // they paid; hand over their key straight away
  let tries = 0;
  const timer = setInterval(async () => {
    tries++;
    let pro = false;
    try { pro = await Billing.refreshProStatus(); } catch (e) { pro = false; }
    if (pro || tries >= 4) {
      clearInterval(timer);
      if (pro) { try { reconcileProAccess(); } catch (e) {} refreshAfterProChange(); }
    }
  }, 2500);
}

// Amber "paid but no code" modal used when the celebration has already fired.
function showNoCodeSelfHealModal() {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  if (IS_NATIVE) {
    // Apple IAP mints no restore CODE — cross-device restore is handled by the Apple Account +
    // "Restore Purchases", so skip the mint flow and show a clean success instead.
    modal.appendChild(txt("h3", null, "You're Pro"));
    modal.appendChild(txt("p", "hint", "Pro is unlocked on this device — and it restores free on your other Apple devices. Just tap “Restore Purchases” there, signed in with the same Apple Account."));
    const doneBtn = txt("button", "btn big", "Done"); doneBtn.type = "button";
    doneBtn.onclick = () => { backdrop.remove(); refreshAfterProChange(); };
    const actions = el("div", "pro-actions"); actions.appendChild(doneBtn);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
    document.body.appendChild(backdrop);
    setupDialogA11y(backdrop, modal, { escCloses: true });
    return;
  }
  modal.appendChild(txt("h3", null, "You're Pro on this browser"));
  const note = el("div", "amber-note");
  note.appendChild(document.createTextNode("We couldn't create your restore code just now. Pro already works here. Tap to create your code for other devices."));
  const mintBtn = txt("button", "btn", "Create my restore code"); mintBtn.type = "button";
  const mintMsg = el("div", "pro-msg"); markLiveRegion(mintMsg);
  mintBtn.onclick = async () => {
    mintBtn.disabled = true; mintBtn.textContent = "Creating…";
    let res;
    try { res = await Billing.mintRestoreCode(); } catch { res = { ok: false, restoreCode: null }; }
    if (res && res.ok && res.restoreCode) { backdrop.remove(); showRestoreCodeModal(res.restoreCode); refreshAfterProChange(); }
    else { mintBtn.disabled = false; mintBtn.textContent = "Create my restore code"; status(mintMsg, "No luck yet — Pro still works here; we'll offer again next visit, and support@localresumeapp.com + your receipt always work.", "info"); }
  };
  note.appendChild(mintBtn);
  const doneBtn = txt("button", "btn ghost", "Done"); doneBtn.type = "button";
  doneBtn.onclick = () => backdrop.remove();
  const actions = el("div", "pro-actions"); actions.appendChild(doneBtn);
  modal.append(note, mintMsg, actions);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
  setupDialogA11y(backdrop, modal, { escCloses: true });
}

function showRestoreEntryModal() {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  const heading = txt("h3", null, "Restore Pro"); heading.id = "restoreHeading";
  modal.appendChild(heading);
  modal.appendChild(txt("p", "hint", "Enter the restore code you saved when you unlocked Pro."));
  const input = document.createElement("input");
  input.type = "text"; input.placeholder = "LRES-XXXX-XXXX-XXXX"; input.className = "restore-code-input";
  input.setAttribute("autocapitalize", "characters"); input.setAttribute("autocomplete", "off"); input.spellcheck = false;
  wireRestoreInput(input);
  modal.appendChild(input);
  const msgHost = el("div", "pro-msg"); markLiveRegion(msgHost);
  const goBtn = txt("button", "btn big", "Restore"); goBtn.type = "button";
  goBtn.onclick = async () => {
    goBtn.disabled = true; goBtn.textContent = "Checking…";
    let res;
    try { res = await Billing.restoreWithCode(formatRestoreCode(input.value)); } catch { res = { ok: false, error: "Couldn't restore — try again." }; }
    if (res.ok) { backdrop.remove(); onRestoreSuccess(); }
    else {
      goBtn.disabled = false; goBtn.textContent = "Restore";
      status(msgHost, res.offline
        ? "You're offline — restoring Pro needs a connection to verify your code. Everything else works offline."
        : (res.error || "Couldn't restore — try again."), res.offline ? "info" : "err");
    }
  };
  const closeBtn = txt("button", "btn ghost", "Cancel"); closeBtn.type = "button";
  closeBtn.onclick = () => backdrop.remove();
  const actions = el("div", "pro-actions"); actions.append(goBtn, closeBtn);
  modal.append(actions, msgHost);
  // Lost-code escape hatch: the answer used to live only on the support page — a buyer
  // standing in this modal without their code should see the path right here.
  const lostLine = el("p", "hint");
  lostLine.append("Lost your code? Email ");
  const lostMail = txt("a", null, SUPPORT_EMAIL);
  lostMail.href = "mailto:" + SUPPORT_EMAIL;
  lostLine.appendChild(lostMail);
  lostLine.append(" and we'll help.");
  modal.appendChild(lostLine);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
  setupDialogA11y(backdrop, modal, { labelledBy: "restoreHeading", escCloses: true });
}

// Shared restore-success feedback: toast + announce, reveal license link, sync
// every gated surface, and resume any pending intent (the export/gate action
// the user was mid-way through when they went to restore).
function onRestoreSuccess() {
  refreshAfterProChange();
  showToast("Welcome back — Pro is unlocked on this device.");
  runPendingIntent();
}

// ── Localized price (iOS) ────────────────────────────────────────────────
// Apple charges the storefront's localized price, which for a non-US buyer differs from
// the hardcoded "$12.99". Fetch Apple's own priceString once (billing caps it at 2.5s and
// never throws) and swap it into the paywall + sidebar card when it arrives — the USD
// string stays as the instant placeholder and the fallback whenever the fetch misses.
// The typeof guard keeps an older billing.js bundle harmless: it simply keeps the fallback.
let nativePricePromise = null;
function getNativePrice() {
  if (!IS_NATIVE || typeof Billing.getNativeLocalizedPrice !== "function") return Promise.resolve(null);
  if (!nativePricePromise) {
    nativePricePromise = Billing.getNativeLocalizedPrice()
      .then((p) => (typeof p === "string" && p ? p : null))
      .catch(() => null);
  }
  return nativePricePromise;
}
// Sidebar "Unlock Pro" card: same swap for its always-visible price line + aria-label.
function applyNativePriceToUnlockCard() {
  getNativePrice().then((p) => {
    if (!p) return;
    const card = $("#unlockProCard");
    if (!card) return;
    const amt = card.querySelector(".unlock-pro-price");
    if (amt) amt.textContent = p + " · one-time";
    card.setAttribute("aria-label", "Unlock LocalResume Pro — " + p + " one-time");
  });
}

// True when localStorage genuinely persists (a hard private-browsing mode can block it) —
// probed at paywall-open time so a buyer whose purchase can't be remembered is told BEFORE paying.
function storageProbeOk() {
  try {
    localStorage.setItem("localresume.storage_probe", "1");
    localStorage.removeItem("localresume.storage_probe");
    return true;
  } catch { return false; }
}

// `opts.contextLine` — optional lead-in shown at the top of the paywall (e.g.
// after a job-description match). Guards against stacking two backdrops.
function showProModal(opts) {
  opts = opts || {};
  if ($(".modal-backdrop.pro-paywall")) return; // never stack two paywalls
  const backdrop = el("div", "modal-backdrop pro-paywall");
  const modal = el("div", "modal pro-modal");
  const heading = txt("h3", null, "LocalResume Pro"); heading.id = "proHeading";
  modal.appendChild(heading);
  if (opts.contextLine) modal.appendChild(txt("div", "pro-context", opts.contextLine));
  const price = el("div", "pro-price");
  const priceAmt = txt("span", "pro-price-amt", "$12.99");
  price.appendChild(priceAmt);
  price.appendChild(txt("span", "pro-price-note", " one-time"));
  modal.appendChild(price);
  // iOS: show Apple's localized storefront price (what the Apple sheet will actually
  // charge) as soon as it's known — "$12.99" stays as the instant placeholder/fallback.
  // Web is untouched: web genuinely bills USD $12.99.
  if (IS_NATIVE) getNativePrice().then((p) => { if (p) priceAmt.textContent = p; });
  const list = el("ul", "pro-features");
  // Outcome-framed benefit bullets (copy refresh).
  [
    "Save unlimited tailored versions — keep one master résumé and a tuned copy for every job.",
    "Export to Word (.docx) — the format ATS and recruiters actually ask for",
    "Cover-letter builder, matched to your resume, with PDF export",
    "Tailor to any job — see exactly where to add each missing keyword (Skills, a bullet, or your summary), with one-tap adds.",
  ].forEach((f) => list.appendChild(txt("li", null, f)));
  modal.appendChild(list);
  // Durable one-time reassurance line.
  modal.appendChild(txt("p", "pro-reassure", "One-time unlock — yours forever, for every resume and cover letter you make. No subscription."));
  if (IS_NATIVE) {
    // Apple IAP: no Stripe, no email receipt, no "your statement" (Apple bills), no self-run
    // money-back (refunds go through Apple's Report a Problem). One clean line replaces all three.
    modal.appendChild(txt("p", "hint", "Payment is handled securely by the App Store, with the Apple Account you already use — it restores free on your other Apple devices."));
  } else {
    // "(via RevenueCat)" matches the checkout window's own header, so the buyer never
    // meets a payment name mid-payment that the paywall didn't introduce first.
    modal.appendChild(txt("p", "hint", "Secure checkout by Stripe (via RevenueCat). You'll enter an email for your receipt only — it's not an account, and we never see your card."));
    const reassure = el("p", "hint");
    reassure.append("30-day money-back guarantee — email ");
    const supportLink = txt("a", null, "support@localresumeapp.com");
    supportLink.href = "mailto:support@localresumeapp.com";
    reassure.appendChild(supportLink);
    reassure.append(".");
    modal.appendChild(reassure);
    // Cross-store honesty, said BEFORE paying: this web unlock and the App Store unlock
    // are separate purchases (same line the support page already uses).
    modal.appendChild(txt("p", "hint", "The iPhone and iPad app sells Pro separately through the App Store."));
    // Private-browsing safety: this browser won't remember the purchase after the visit —
    // say so once, before they buy, so the receipt + restore code get saved somewhere real.
    if (!storageProbeOk()) {
      modal.appendChild(txt("p", "hint", "Heads up — this browser isn't saving data, so keep your receipt and restore code somewhere safe after you buy."));
    }
  }
  const msgHost = el("div", "pro-msg"); markLiveRegion(msgHost);
  const buyBtn = txt("button", "btn big", "Unlock Pro"); buyBtn.type = "button";
  // The purchase flow, factored out so the polished error state's "Try again"
  // button can re-run the EXACT same path (same Billing.purchasePro() call) —
  // no billing logic is duplicated.
  const runBuy = async () => {
    msgHost.innerHTML = "";
    buyBtn.disabled = true; buyBtn.textContent = "Processing…";
    let res;
    try { res = await Billing.purchasePro(); }
    catch { res = { ok: false, error: "Something went wrong finishing up." }; }
    if (res.ok) {
      // Paid. Close the paywall, then celebrate + save-code / self-heal flow,
      // which also resumes any pending intent.
      backdrop.remove();
      // alreadyOwned rides along so a codeless already-owned success reads calm, not amber.
      handleUnlockSuccess(res.restoreCode || null, !!res.alreadyOwned);
      return;
    }
    // Not paid — branch on the specific failure shape. Reset the button so
    // they can try again, but never nag on a deliberate cancel.
    buyBtn.disabled = false; buyBtn.textContent = "Unlock Pro";
    if (res.inFlight) {
      // A purchase from a moment ago is still settling (entitlement attaching). Don't open a
      // second checkout or show an error — reassure, and Pro unlocks itself when it lands.
      status(msgHost, "Your purchase is still going through — give it a moment and Pro will unlock automatically.", "info");
    } else if (res.cancelled) {
      status(msgHost, "No charge was made — Pro will be here whenever you're ready.", "info");
    } else if (res.offline) {
      // "no charge was made just now" — scoped to THIS attempt; never a blanket "nothing was charged".
      status(msgHost, "You're offline — buying Pro needs a connection for the secure checkout. Everything else works offline, and no charge was made just now.", "info");
    } else if (res.pending) {
      // PAID — the charge SUCCEEDED; the entitlement is only still attaching (a few seconds).
      // Never show the "purchase didn't start / you weren't charged" state or a re-buy button to
      // someone who just paid. Reassure, hand over the code, and auto-unlock when it lands.
      backdrop.remove();
      handlePurchasePending(res.restoreCode || null, res.error);
    } else {
      // Genuine error — polished on-brand error state (re-runs this same flow).
      renderProError(msgHost, runBuy);
    }
  };
  buyBtn.onclick = runBuy;
  const closeBtn = txt("button", "btn ghost", "Not now"); closeBtn.type = "button";
  closeBtn.onclick = () => backdrop.remove();
  const restoreLink = txt("button", "restore-link", IS_NATIVE ? "Restore Purchases" : "Already Pro? Restore with a code"); restoreLink.type = "button";
  if (IS_NATIVE) {
    // Apple's required "Restore Purchases": re-syncs this Apple Account's receipt with the App Store.
    // No typed restore code on iOS — Apple carries the entitlement across the buyer's devices.
    restoreLink.onclick = async () => {
      const prev = restoreLink.textContent;
      restoreLink.disabled = true; restoreLink.textContent = "Restoring…";
      let res;
      try { res = await Billing.restorePurchases(); }
      catch (e) { console.error("LocalResume: restore threw", e); res = { ok: false }; }
      if (res && res.ok) { backdrop.remove(); refreshAfterProChange(); runPendingIntent(); }
      else {
        restoreLink.disabled = false; restoreLink.textContent = prev;
        status(msgHost, "No previous purchase found. Make sure you're signed in with the Apple Account you bought Pro with.", "info");
      }
    };
  } else {
    restoreLink.onclick = () => { backdrop.remove(); showRestoreEntryModal(); };
  }
  // Charge-descriptor reassurance: this app bills under the "Eden Apps" family
  // name, so a LocalResume buyer recognizes the statement line. Web-only — on iOS
  // Apple bills, so there's no "Eden Apps" statement line to explain.
  if (!IS_NATIVE) {
    const stmtNote = document.createElement("p");
    stmtNote.style.cssText = "margin:12px 0 0; font-size:13.5px; font-weight:500;";
    stmtNote.innerHTML = 'Shows on your statement as <strong>“Eden Apps”</strong>';
    modal.appendChild(stmtNote);
  }
  const actions = el("div", "pro-actions"); actions.append(buyBtn, closeBtn);
  modal.append(actions, msgHost, restoreLink);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
  // Escape closes the PAYWALL (only the paywall — code-save modals set escCloses:false).
  setupDialogA11y(backdrop, modal, { labelledBy: "proHeading", escCloses: true });
}
async function doExportCoverLetter() {
  const msgHost = $("#coverLetterMsg");
  try {
    await ensurePdfLib(); // loads pdf-lib on demand (first export)
    const cl = state.coverLetter;
    const pdf = await PDFDocument.create();
    const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
    const reg = await pdf.embedFont(StandardFonts.Helvetica);
    const ink = rgb(0.10, 0.10, 0.18);
    const muted = rgb(0.42, 0.45, 0.5);
    const pageWidth = 612, pageHeight = 792;
    const marginX = 56, rightEdge = pageWidth - marginX, contentWidth = rightEdge - marginX;
    const topY = 740, bottomLimit = 54;

    // Real pagination: `page`/`y` are mutable and drawing goes through
    // ensureRoom() first, so a long cover-letter body flows onto new pages
    // instead of being silently dropped once it reaches the bottom margin
    // (this mirrors the resume export in doExport()).
    let page, y;
    function addPage() {
      page = pdf.addPage([pageWidth, pageHeight]);
      y = topY;
    }
    function ensureRoom(needed) {
      if (y - needed < bottomLimit) addPage();
    }
    addPage();

    const nameSafe = pdfSafe((state.personal.name || "").trim()) || "Your name";
    page.drawText(nameSafe, { x: marginX, y, size: 18, font: bold, color: ink }); y -= 18;
    const contactParts = [state.personal.email, state.personal.phone, state.personal.location].filter(Boolean).map(pdfSafe);
    if (contactParts.length) { page.drawText(fitText(reg, contactParts.join("   ·   "), 9.5, contentWidth), { x: marginX, y, size: 9.5, font: reg, color: muted }); y -= 24; }
    else y -= 12;

    page.drawText(new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }), { x: marginX, y, size: 10, font: reg, color: muted }); y -= 24;

    const recipientLines = [cl.recipientName, cl.company].filter(Boolean).map(pdfSafe);
    recipientLines.forEach((line) => { page.drawText(line, { x: marginX, y, size: 10.5, font: reg, color: ink }); y -= 14; });
    if (recipientLines.length) y -= 10;

    const greeting = pdfSafe(cl.greeting || "Dear Hiring Manager,");
    ensureRoom(22);
    page.drawText(greeting, { x: marginX, y, size: 10.5, font: reg, color: ink }); y -= 22;

    const bodyText = pdfSafe(cl.body || "");
    bodyText.split("\n").forEach((para) => {
      const words = para.split(/\s+/).filter(Boolean);
      if (!words.length) { ensureRoom(14); y -= 14; return; }
      let line = "";
      words.forEach((w) => {
        const candidate = line ? line + " " + w : w;
        if (reg.widthOfTextAtSize(candidate, 10.5) > contentWidth) {
          ensureRoom(15);
          page.drawText(line, { x: marginX, y, size: 10.5, font: reg, color: rgb(0.2, 0.2, 0.24) }); y -= 15;
          line = w;
        } else line = candidate;
      });
      if (line) { ensureRoom(15); page.drawText(line, { x: marginX, y, size: 10.5, font: reg, color: rgb(0.2, 0.2, 0.24) }); y -= 15; }
    });
    y -= 14;
    // Sign-off travels with the body — start a fresh page if it won't fit,
    // never drop it.
    ensureRoom(40);
    page.drawText("Sincerely,", { x: marginX, y, size: 10.5, font: reg, color: ink }); y -= 28;
    page.drawText(nameSafe, { x: marginX, y, size: 10.5, font: bold, color: ink });

    const bytes = await pdf.save();
    const safeName = (state.personal.name || "cover-letter").replace(/[^\w.-]+/g, "-").slice(0, 40);
    await downloadPdfBytes(bytes, `${safeName}-cover-letter.pdf`);
    status(msgHost, "Cover letter PDF ready — saved to your downloads.", "ok");
  } catch (e) {
    status(msgHost, "Couldn't export that — try again. Your data on this device is unaffected.", "err");
  }
}

// ── Data vault (backup / restore everything, still 100% local) ──────────
function showVaultMessageModal(message) {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  modal.appendChild(txt("h3", null, "Restore from backup"));
  modal.appendChild(txt("p", "hint", message));
  const okBtn = txt("button", "btn big", "OK"); okBtn.type = "button";
  okBtn.onclick = () => backdrop.remove();
  const actions = el("div", "pro-actions"); actions.append(okBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
}

// Shown when a backup imported successfully but Pro didn't come along (its carried code did
// not unlock, was junk-shaped, or a codeless backup was trimmed to the free cap). `message`
// tailors the detail line to what actually happened; `title` optionally softens the heading
// for cases where no unlock was attempted (e.g. the codeless-trim disclosure). Always offers
// a one-tap path to enter a restore code. WEB-ONLY by construction: the iOS import path is
// data-only and returns before reaching this modal, so code entry never surfaces on iOS.
function showProRestoreFailedAfterImportModal(message, title) {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  modal.appendChild(txt("h3", null, title || "Backup restored — Pro didn't unlock"));
  modal.appendChild(txt("p", "hint", message || "Your data imported and is safe. The Pro code saved in this backup didn't unlock Pro on this browser — it may be a temporary connection issue, or the code is no longer active. You can enter your restore code to try again."));
  const goBtn = txt("button", "btn big", "Enter restore code"); goBtn.type = "button";
  goBtn.onclick = () => { backdrop.remove(); showRestoreEntryModal(); };
  const closeBtn = txt("button", "btn ghost", "Not now"); closeBtn.type = "button";
  closeBtn.onclick = () => backdrop.remove();
  const actions = el("div", "pro-actions"); actions.append(goBtn, closeBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
}

function showVaultConfirmModal(message, onConfirm) {
  const backdrop = el("div", "modal-backdrop");
  const modal = el("div", "modal pro-modal");
  modal.appendChild(txt("h3", null, "Restore from backup?"));
  modal.appendChild(txt("p", "hint", message));
  const goBtn = txt("button", "btn big", "Replace my data"); goBtn.type = "button";
  goBtn.onclick = () => { backdrop.remove(); onConfirm(); };
  const cancelBtn = txt("button", "btn ghost", "Cancel"); cancelBtn.type = "button";
  cancelBtn.onclick = () => backdrop.remove();
  const actions = el("div", "pro-actions"); actions.append(goBtn, cancelBtn);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  backdrop.addEventListener("click", (e) => { if (e.target === backdrop) backdrop.remove(); });
  document.body.appendChild(backdrop);
}

function exportVault() {
  persistNow(); // flush any debounced edits so the file matches what's on screen
  const now = new Date();
  const payload = {
    app: "localresume",
    version: 1,
    exportedAt: now.toISOString(),
    state,
    proRestoreCode: Billing.getRestoreCode() || null,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = el("a"); a.href = url;
  a.download = `localresume-backup-${now.toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// The free plan allows exactly ONE saved version (enforced at save time). An
// imported backup can carry many, so re-apply the cap for non-Pro users on import
// — otherwise a hand-edited/imported backup unlocks unlimited versions for free.
function capVersionsForFreeTier() {
  let pro = false; try { pro = Billing.isPro(); } catch { pro = false; }
  if (!pro && Array.isArray(state.versions) && state.versions.length > 1) {
    state.versions = state.versions.slice(0, 1);
    return true; // trimmed — callers can say so honestly instead of claiming everything is intact
  }
  return false;
}
function importVault(file) {
  const reader = new FileReader();
  reader.onerror = () => showVaultMessageModal("Couldn't read that file — try again.");
  reader.onload = () => {
    let payload;
    try { payload = JSON.parse(String(reader.result)); }
    catch { showVaultMessageModal("That file couldn't be read as a backup — it isn't valid JSON."); return; }
    if (!payload || typeof payload !== "object" || payload.app !== "localresume") {
      const other = payload && typeof payload.app === "string" && payload.app.trim() ? payload.app.trim() : null;
      showVaultMessageModal(other ? `That backup is from ${other}.` : "That file doesn't look like a LocalResume backup.");
      return;
    }
    // Same guards as loadState() — corrupt or hostile fields never reach the app.
    const incoming = sanitizeState(payload.state);
    const when = payload.exportedAt ? new Date(payload.exportedAt) : null;
    const dateLabel = when && !isNaN(when) ? when.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" }) : "an unknown date";
    showVaultConfirmModal(`Replace everything in this app with the backup from ${dateLabel}? Your current data will be overwritten.`, async () => {
      state = incoming;
      if (IS_NATIVE) {
        // iOS has NO typed restore codes: importing a backup restores DATA only — a carried
        // web code is never checked (no restoreWithCode) and no code-entry modal ever opens,
        // so code entry simply doesn't exist on iOS. An Apple buyer gets Pro back with
        // Restore Purchases; a web code keeps working in the browser it came from.
        const trimmed = capVersionsForFreeTier(); // no-op for a current Apple owner
        persistNow();
        buildEditor();
        let pro = false; try { pro = Billing.isPro(); } catch { pro = false; }
        if (!pro && (payload.proRestoreCode || trimmed)) {
          // Never trim (or set aside a Pro backup) silently — say what happened and point
          // at the one recovery path that exists on this platform.
          showVaultMessageModal(
            (trimmed
              ? "Your data imported. The free plan keeps your first saved version — the rest stay safe in your backup file, ready to import again once Pro is unlocked. "
              : "Your data imported. ")
            + (payload.proRestoreCode
              ? "Pro comes back with Restore Purchases on iPhone and iPad."
              : "Bought Pro before? It comes back with Restore Purchases on iPhone and iPad."));
        } else {
          status($("#editorMsg"), "Backup restored.", "ok");
        }
        return;
      }
      // Try a carried Pro restore code FIRST, so a genuine owner keeps every version.
      if (payload.proRestoreCode && !Billing.isPro()) {
        // Only a credential-shaped code earns a server check (see looksLikeRestoreCredential):
        // junk could only end "not entitled" or network-error, and the network-error branch
        // below keeps every version — a made-up code must not ride that to skip the free cap.
        if (!looksLikeRestoreCredential(payload.proRestoreCode)) {
          const trimmed = capVersionsForFreeTier();
          persistNow();
          buildEditor();
          showProRestoreFailedAfterImportModal(trimmed
            ? "Your data imported. The Pro code in this backup isn't in the right format, so the free plan kept your first saved version. The rest are still in your backup file — import it again after you restore Pro to bring them back. You can enter your restore code to try again."
            : "Your data imported and is safe. The Pro code in this backup isn't in the right format. You can enter your restore code to try again.");
          return;
        }
        let res;
        try { res = await Billing.restoreWithCode(payload.proRestoreCode); }
        catch { res = { ok: false }; }
        if (res && res.ok) {
          persistNow();
          refreshAfterProChange();
          status($("#editorMsg"), "Backup restored — Pro unlocked from your saved code.", "ok");
          return;
        }
        // The backup carried a Pro code but it didn't restore. Only a CONFIRMED "no active Pro"
        // (res.notEntitled — the server actually answered) applies the free-tier version cap, so
        // a hand-crafted backup can't retain extra versions — while a paying customer on a flaky
        // connection is never trimmed (see the couldn't-confirm branch below).
        if (res && res.notEntitled) {
          const trimmed = capVersionsForFreeTier();
          persistNow();
          buildEditor();
          showProRestoreFailedAfterImportModal(trimmed
            ? "Your data imported. That code doesn't have an active Pro purchase, so the free plan kept your first saved version. The rest are still in your backup file — import it again after you restore Pro to bring them back. You can enter your restore code to try again."
            : "Your data imported and is safe. The Pro code saved in this backup doesn't have an active Pro purchase. You can enter your restore code to try again.");
          return;
        }
        // Couldn't confirm either way (offline, server unreachable, or an unexpected error):
        // keep EVERY imported version — never trim data that may belong to a paying customer —
        // and say so plainly. (Saving NEW versions stays Pro-gated regardless.)
        persistNow();
        buildEditor();
        showProRestoreFailedAfterImportModal("Your data imported — nothing was removed. We couldn't confirm Pro just now. You can enter your restore code to try again in a moment.");
        return;
      }
      // Free tier (no code, or the code path above already returned): imports can't exceed
      // the free 1-version cap — but a trim is never silent (a paid-but-codeless backup
      // deserves to know where its versions went and how to get them back).
      const trimmed = capVersionsForFreeTier();
      persistNow();
      buildEditor();
      if (trimmed) {
        showProRestoreFailedAfterImportModal(
          "Your data imported. The free plan keeps your first saved version — the rest stay safe in your backup file. If you bought Pro, enter your restore code, then import this file again to bring them back.",
          "Backup restored");
        return;
      }
      status($("#editorMsg"), "Backup restored.", "ok");
    });
  };
  reader.readAsText(file);
}

// ── Boot ─────────────────────────────────────────────────────────────────
const scrollTop = () => window.scrollTo({ top: 0, behavior: "smooth" });
$("#logo").onclick = scrollTop;
$("#logo").addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); scrollTop(); }
});

// ── Theme toggle (light → dark → system). The actual theme application +
// persistence lives in theme.js (loaded early in <head> to avoid a flash);
// here we just wire the topbar button to it and reflect the current choice. ──
(function wireThemeToggle() {
  const btn = $("#themeToggle");
  const api = window.LocalResumeTheme;
  if (!btn || !api) return;
  const reflect = () => {
    const choice = api.get(); // "light" | "dark" | "system"
    btn.setAttribute("aria-label", `Switch theme (currently ${choice})`);
    btn.setAttribute("title", `Theme: ${choice}`);
  };
  reflect();
  btn.addEventListener("click", () => { api.cycle(); reflect(); });
})();

buildEditor();
// Boot entitlement check — ONLY when this browser might already own Pro
// (Billing.shouldCheckAtBoot() is false for a brand-new visitor, so fresh
// loads still make ZERO billing network calls). This recovers the "paid then
// closed the tab before the code was minted" case. On confirming Pro, re-render
// the gated UI and — if Pro but no restore code — surface the self-heal banner.
(async function bootProCheck() {
  try {
    if (Billing.shouldCheckAtBoot()) {
      const pro = await Billing.refreshProStatus();
      if (pro) refreshAfterProChange();
      // Detect a verified revocation (refund/expiry) vs. a still-valid owner and
      // handle the true→false transition kindly + non-destructively.
      reconcileProAccess();
    }
  } catch (e) { console.error("LocalResume: boot Pro check failed", e); }
  // Self-heal: Pro on this browser but no restore code → offer to create one.
  try { maybeShowSelfHealNag(); } catch (e) { console.error(e); }
})();
if (IS_NATIVE) {
  // iOS: no typed restore code — this becomes Apple's "Restore Purchases", re-syncing
  // this Apple Account's receipt with the App Store.
  const footerRestore = $("#footerRestoreLink");
  footerRestore.textContent = "Restore Purchases";
  footerRestore.onclick = async () => {
    const prev = footerRestore.textContent;
    footerRestore.disabled = true; footerRestore.textContent = "Restoring…";
    let res;
    try { res = await Billing.restorePurchases(); }
    catch (e) { console.error("LocalResume: restore threw", e); res = { ok: false }; }
    footerRestore.disabled = false; footerRestore.textContent = prev;
    if (res && res.ok) { refreshAfterProChange(); runPendingIntent(); showToast("Pro restored on this device."); }
    else { showToast("No previous purchase found for this Apple Account."); }
  };
} else {
  $("#footerRestoreLink").onclick = () => showRestoreEntryModal();
}

// License card surfaces: permanent footer link whenever a restore code exists,
// plus a boot-time nag banner until the user confirms they saved the card.
function updateLicenseFooterLink() {
  // iOS: no license card (no restore CODE) and Apple owns IAP refunds (Report a Problem),
  // so neither footer entry applies. Both #footerLicenseLink and #footerRefundLink start
  // hidden in index.html, so returning here simply leaves them hidden.
  if (IS_NATIVE) return;
  let isPro = false;
  try { isPro = Billing.isPro(); } catch { isPro = false; }
  const link = $("#footerLicenseLink");
  // Show the license link only for a current owner with a code — so on a
  // verified access-stop it hides cleanly even though the (now-invalid) code is
  // left in storage rather than aggressively purged.
  if (link) link.classList.toggle("hidden", !(isPro && Billing.getRestoreCode()));
  // Footer refund entry: visible to owners (isPro), href pre-filled with the
  // current restore code. Kept in sync here so it hides cleanly on access-stop.
  const refund = $("#footerRefundLink");
  if (refund) {
    refund.classList.toggle("hidden", !isPro);
    if (isPro) refund.href = buildRefundMailto();
  }
}
// Sidebar "Unlock Pro" front door. A quiet, low-pressure entry point to the
// existing one-time offer: it simply opens the real paywall (showProModal).
// OWNER STATE: hidden whenever the visitor already owns Pro, so an owner never
// sees an upsell again. Re-evaluated on every Pro-status change via
// refreshAfterProChange(). If isPro() throws we treat it as not-Pro (show the
// card) — the front door failing open is harmless; it only opens the paywall.
function updateUnlockProCard() {
  const card = $("#unlockProCard");
  if (!card) return;
  let isPro = false;
  try { isPro = Billing.isPro(); } catch { isPro = false; }
  card.classList.toggle("hidden", isPro);
}
// Wire the front door once (idempotent guard via dataset). Enter/Space come for
// free since it's a real <button>.
(function wireUnlockProCard() {
  const card = $("#unlockProCard");
  if (card && !card.dataset.wired) {
    card.dataset.wired = "1";
    card.addEventListener("click", () => { try { showProModal(); } catch (e) { console.error(e); } });
  }
  try { updateUnlockProCard(); } catch (e) { console.error(e); }
  // iOS: swap the card's "$12.99" for Apple's localized price once known (fallback stays).
  if (IS_NATIVE) { try { applyNativePriceToUnlockCard(); } catch (e) { console.error(e); } }
})();
function maybeShowSaveNag() {
  if (IS_NATIVE) return; // iOS has no restore CODE / license card — Apple restore covers cross-device
  const code = Billing.getRestoreCode();
  // Only nag to save the license card when this browser is ACTUALLY Pro — a stored
  // code alone isn't enough (a refunded/expired/hollow code leaves a stale code in
  // localStorage, and "Keep Pro safe" next to the Unlock-Pro paywall reads as broken).
  // isPro() is the last verified check; refreshAfterProChange() re-runs this post-boot
  // so a real owner still sees it (offline owners fail OPEN and keep it).
  let pro = false; try { pro = Billing.isPro(); } catch { pro = false; }
  let ack = null;
  try { ack = localStorage.getItem(CODE_ACK_KEY); } catch { /* treat as un-acked */ }
  if (!code || !pro || ack === "1" || $("#saveNagBanner")) return;
  const banner = el("div", "save-nag"); banner.id = "saveNagBanner";
  banner.appendChild(txt("span", "save-nag-text", "Keep Pro safe — save your license card so you can restore it anytime."));
  const viewBtn = txt("button", "save-nag-view", "View card"); viewBtn.type = "button";
  viewBtn.onclick = () => showLicenseCardModal();
  const closeBtn = txt("button", "save-nag-close", "×"); closeBtn.type = "button";
  closeBtn.setAttribute("aria-label", "Dismiss for now");
  closeBtn.onclick = () => banner.remove(); // this page load only — the ack flag is the real off switch
  banner.append(viewBtn, closeBtn);
  document.body.insertBefore(banner, document.body.firstChild);
}
// Self-heal banner: Pro on THIS browser but NO restore code yet (mint failed or
// the tab closed before minting). Offers to create the code so other devices can
// unlock too. Distinct from the save-nag, which assumes a code already exists.
function maybeShowSelfHealNag() {
  if (IS_NATIVE) return; // iOS mints no restore code — cross-device restore is via the Apple Account
  const banner = $("#selfHealBanner");
  const needsHeal = (() => { try { return Billing.isPro() && !Billing.getRestoreCode(); } catch { return false; } })();
  if (!needsHeal) { if (banner) banner.remove(); return; }
  if (banner) return; // already shown
  const b = el("div", "selfheal-nag"); b.id = "selfHealBanner";
  b.appendChild(txt("span", "selfheal-text", "You're Pro on this browser — create your restore code so you can unlock other devices too."));
  const createBtn = txt("button", "selfheal-btn", "Create code"); createBtn.type = "button";
  const msg = el("span"); msg.className = "selfheal-msg"; markLiveRegion(msg);
  createBtn.onclick = async () => {
    createBtn.disabled = true; createBtn.textContent = "Creating…";
    let res;
    try { res = await Billing.mintRestoreCode(); } catch { res = { ok: false, restoreCode: null }; }
    if (res && res.ok && res.restoreCode) {
      b.remove();
      showRestoreCodeModal(res.restoreCode);
      refreshAfterProChange();
    } else {
      createBtn.disabled = false; createBtn.textContent = "Create code";
      msg.textContent = " Couldn't create it just now — we'll offer again next visit.";
    }
  };
  b.append(createBtn, msg);
  document.body.insertBefore(b, document.body.firstChild);
}
$("#footerLicenseLink").onclick = () => showLicenseCardModal();
updateLicenseFooterLink();
maybeShowSaveNag();

// Data vault footer row.
$("#footerBackupLink").onclick = () => exportVault();
const vaultInput = $("#vaultFileInput");
$("#footerRestoreBackupLink").onclick = () => vaultInput.click();
vaultInput.addEventListener("change", () => {
  const f = vaultInput.files && vaultInput.files[0];
  vaultInput.value = ""; // allow re-picking the same file after a cancelled confirm
  if (f) importVault(f);
});

// ── Sidebar + hash router ───────────────────────────────────────────────
// A thin VIEW-SWITCH: buildEditor() still builds the whole app (form + preview
// + Score + Job-Match panels) into #editor exactly as before. After each build
// we RELOCATE the live Resume-Score panel and Job-Match panel nodes into their
// own route hosts — moving a node preserves its ids, classes, listeners and all
// billing/refresh hooks, so every existing function fires as today. The router
// only toggles which route <section> is visible via [hidden]; it never rebuilds
// the app or interpolates user data. CSP-safe: hashchange + imperative DOM only.
(function initRouter() {
  const ROUTES = {
    "editor": { section: "route-editor", nav: "navEditor", title: "Editor" },
    "score":  { section: "route-score",  nav: "navScore",  title: "Resume Score" },
    "match":  { section: "route-match",  nav: "navMatch",  title: "Job Match" },
  };
  const routeTitle = $("#routeTitle");

  // Relocate the Score + Job-Match panels out of the editor form column into
  // their route hosts. Called after every buildEditor(). The panels are the
  // ancestor .panel of the stable ids #healthResult / #jdResult.
  function mountRoutePanels() {
    const scoreHost = $("#scoreHost");
    const matchHost = $("#matchHost");
    if (!scoreHost || !matchHost) return;
    const healthResult = $("#healthResult");
    if (healthResult) {
      const panel = healthResult.closest(".panel");
      if (panel) {
        if (panel.parentNode !== scoreHost) { scoreHost.innerHTML = ""; scoreHost.appendChild(panel); }
        // The route head already says "Resume Score" — drop the panel's own copy.
        const sh = panel.querySelector(".panel-selfhead"); if (sh) sh.hidden = true;
      }
    }
    const jdResult = $("#jdResult");
    if (jdResult) {
      const panel = jdResult.closest(".panel");
      if (panel && panel.parentNode !== matchHost) { matchHost.innerHTML = ""; matchHost.appendChild(panel); }
    }
  }

  // Wrap buildEditor so relocation runs on every (re)build without touching the
  // builder itself. buildEditor is a hoisted, reassignable function binding, and
  // all internal callers reference this same binding, so the wrap always applies.
  const origBuildEditor = buildEditor;
  buildEditor = function () {
    origBuildEditor.apply(this, arguments);
    try { mountRoutePanels(); } catch (e) { console.error("LocalResume: route mount failed", e); }
  };

  function currentRouteKey() {
    const raw = (location.hash || "").replace(/^#\/?/, "").split(/[/?]/)[0].toLowerCase();
    return ROUTES[raw] ? raw : "editor";
  }

  function applyRoute() {
    const key = currentRouteKey();
    Object.keys(ROUTES).forEach((k) => {
      const r = ROUTES[k];
      const section = document.getElementById(r.section);
      const nav = document.getElementById(r.nav);
      const active = k === key;
      if (section) section.hidden = !active;
      if (nav) {
        nav.classList.toggle("active", active);
        if (active) nav.setAttribute("aria-current", "page");
        else nav.removeAttribute("aria-current");
      }
    });
    if (routeTitle) routeTitle.textContent = ROUTES[key].title;
    // Move focus to the newly shown region for keyboard/AT users, without
    // yanking the page around on the default editor load.
    const shown = document.getElementById(ROUTES[key].section);
    if (shown && location.hash) {
      window.scrollTo(0, 0); // start at the top of the newly shown section (e.g. the score ring), not partway down the last one
      try { shown.focus({ preventScroll: true }); } catch { shown.focus(); }
    }
  }

  window.addEventListener("hashchange", applyRoute);
  // Normalize a bare/legacy hash to the default route so deep-linking + the back
  // button behave, but don't clobber a valid incoming route.
  if (!ROUTES[currentRouteKey()] || !location.hash) {
    // leave as-is; applyRoute defaults to editor
  }
  mountRoutePanels();
  applyRoute();
})();


/* Offline support (progressive enhancement): register the service worker ONLY
   on the real https web deployment. Never in the Capacitor native shell
   (localhost) or local dev, where assets already load offline and a SW could
   interfere. Fails silently. */
(function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  var h = location.hostname;
  var webOK = location.protocol === "https:" && h !== "localhost" && h !== "127.0.0.1" && !h.endsWith(".local");
  if (!webOK) return;
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/sw.js").catch(function () {});
  });
})();

// ── QR deep-link restore (?restore=CODE) ───────────────────────────────────
// The license card's QR encodes https://localresumeapp.com/?restore=<code> so a
// phone camera scan opens the app and restores Pro in one step (a bare-text QR
// would just land the user in a web search). Handle the param once, then scrub
// it from the URL and history — the code is a secret and shouldn't linger there.
(async () => {
  let code = null;
  try { code = new URLSearchParams(location.search).get("restore"); } catch (e) {}
  if (!code || !code.trim()) return;
  try { history.replaceState(null, "", location.pathname + location.hash); } catch (e) {}
  const normalized = formatRestoreCode(code);
  let res;
  try { res = await Billing.restoreWithCode(normalized); }
  catch (e) { res = { ok: false }; }
  if (res && res.ok) {
    onRestoreSuccess();
  } else {
    // Couldn't restore from the scan (offline, refunded, or an odd code) — open
    // the restore modal prefilled so the user can see the code and retry.
    showRestoreEntryModal();
    const inp = document.querySelector(".restore-code-input");
    if (inp) inp.value = normalized || String(code).trim();
  }
})();
