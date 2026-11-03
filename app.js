'use strict';

/* =====================================================================
   Base de données locale (IndexedDB) — tout reste sur le téléphone
   ===================================================================== */
const DB_NAME = 'muscu';
const DB_VERSION = 4;
let db;

function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('programs')) d.createObjectStore('programs', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('templates')) d.createObjectStore('templates', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('workouts')) d.createObjectStore('workouts', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
      // Exercices perso avec leurs muscles choisis à la main (clé = nom sans accents ni majuscules)
      if (!d.objectStoreNames.contains('custom')) d.createObjectStore('custom', { keyPath: 'key' });
      // Poids de corps : une pesée par jour (clé = date AAAA-MM-JJ)
      if (!d.objectStoreNames.contains('bodyweight')) d.createObjectStore('bodyweight', { keyPath: 'date' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

const store = (name, mode = 'readonly') => db.transaction(name, mode).objectStore(name);
const wrap = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const dbAll = (s) => wrap(store(s).getAll());
const dbGet = (s, k) => wrap(store(s).get(k));
const dbPut = (s, v) => wrap(store(s, 'readwrite').put(v));
const dbDel = (s, k) => wrap(store(s, 'readwrite').delete(k));

/* =====================================================================
   Utilitaires
   ===================================================================== */
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const keyOf = (name) => norm(name.trim()); // insensible aux majuscules et aux accents
const num = (v) => {
  const n = parseFloat(String(v).replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : 0;
};
const fmtNum = (n) => String(Math.round(n * 100) / 100).replace('.', ',');
const fmtDate = (iso) => new Date(iso).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtShort = (iso) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'numeric' });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });

function fmtSet(s) {
  return s.weight > 0 ? `${s.reps} × ${fmtNum(s.weight)} kg` : `${s.reps} reps`;
}

// "3 séries de 10 × 40 kg" si toutes identiques, sinon "10 × 40 kg · 8 × 40 kg"
function fmtSets(sets) {
  if (!sets.length) return '';
  const same = sets.every((s) => s.reps === sets[0].reps && s.weight === sets[0].weight);
  if (same && sets.length > 1) return `${sets.length} séries de ${fmtSet(sets[0])}`;
  return sets.map(fmtSet).join(' · ');
}

/* ---------- Fenêtres de dialogue dans le style de l'app (à la place de prompt / confirm / alert) ---------- */
const $dialog = document.getElementById('dialog');

// input : null = pas de champ texte. Renvoie true/false, ou le texte saisi (null si annulé)
// multiline : grand champ sur plusieurs lignes (Entrée = retour à la ligne)
function openDialog({ title, message = '', input = null, okLabel = 'OK', cancelLabel = 'Annuler', danger = false, multiline = false, placeholder = '' }) {
  return new Promise((resolve) => {
    const field_ = multiline
      ? `<textarea class="dialog-input" rows="4" placeholder="${esc(placeholder)}">${esc(input)}</textarea>`
      : `<input class="dialog-input" value="${esc(input)}" placeholder="${esc(placeholder)}" autocomplete="off" enterkeyhint="done">`;
    $dialog.innerHTML = `
      <div class="dialog-card" role="dialog" aria-modal="true">
        ${title ? `<h2>${esc(title)}</h2>` : ''}
        ${message ? `<p>${esc(message).replace(/\n/g, '<br>')}</p>` : ''}
        ${input !== null ? field_ : ''}
        <div class="dialog-actions ${cancelLabel ? '' : 'single'}">
          ${cancelLabel ? `<button class="btn btn-secondary" data-dlg="cancel">${esc(cancelLabel)}</button>` : ''}
          <button class="btn ${danger ? 'btn-danger-solid' : 'btn-primary'}" data-dlg="ok">${esc(okLabel)}</button>
        </div>
      </div>`;
    $dialog.hidden = false;
    const field = $dialog.querySelector('.dialog-input');
    const done = (ok) => {
      const value = field ? field.value.trim() : '';
      $dialog.hidden = true;
      $dialog.innerHTML = '';
      resolve(input !== null ? (ok ? value : null) : ok);
    };
    $dialog.onclick = (e) => {
      const btn = e.target.closest('[data-dlg]');
      if (btn) done(btn.dataset.dlg === 'ok');
      else if (e.target === $dialog && cancelLabel) done(false);
    };
    if (field) {
      field.focus();
      if (!multiline) field.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); });
    }
  });
}
const askText = (title, value = '', okLabel = 'Valider') => openDialog({ title, input: value, okLabel });
const askConfirm = (title, message, okLabel = 'Confirmer', danger = false) => openDialog({ title, message, okLabel, danger });
const showMessage = (title, message) => openDialog({ title, message, cancelLabel: '' });

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

/* =====================================================================
   État de l'app
   ===================================================================== */
// Préférences réglables dans Réglages → Préférences (toutes activées par défaut)
const DEFAULT_PREFS = {
  feelings: true,      // pastilles de ressenti 🟢🟡🔴 + conseils 💡
  autoRest: true,      // chrono de repos lancé automatiquement après chaque série
  restSound: true,     // bip à la fin du repos
  sessionTimer: true,  // chrono de la séance dans le bandeau du haut
  autoCollapse: true,  // exercice terminé replié + écran qui passe au suivant
  defaultRest: 120,    // repos par défaut (secondes) quand rien n'est réglé pour l'exercice
  weightStep: 2.5,     // pas des boutons − / + du poids (kg)
};

const state = {
  tab: 'train',
  route: { name: 'programs' }, // écran affiché dans l'onglet Séance
  programs: [],
  templates: [],      // les séances, chacune rattachée à un programme (programId)
  workouts: [],       // triées de la plus récente à la plus ancienne
  draft: null,        // séance en cours (sauvegardée en continu)
  activeProgram: null,
  lastExport: null,
  custom: {},         // exercices perso : clé → { key, name, primary, secondary }
  restTimes: {},      // temps de repos choisi par exercice : clé → secondes
  notes: {},          // note par exercice (réglage machine…) : clé → texte
  brands: [],         // marques de machine ajoutées à la main
  prefs: {},          // préférences (Réglages) : voir DEFAULT_PREFS
  bodyweight: [],     // pesées, de la plus ancienne à la plus récente
  progressView: 'global',
  globalPeriod: 'cycle',   // Progrès → Global : 'cycle', une durée en jours ('14', '90'…), 'all' ou 'custom'
  globalFrom: null,        // date de départ choisie à la main (AAAA-MM-JJ) pour 'custom'
  globalMuscle: null,      // muscle ouvert pour voir le détail de ses exercices
  histMonth: `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`, // mois affiché (AAAA-MM)
  histDay: null,      // jour choisi dans le calendrier (AAAA-MM-JJ), null = tout le mois
  editWorkout: null,  // copie de la séance enregistrée en cours de modification
  progressExercise: null,
  progressMetric: 'weight',
  volumePeriod: 'week',
};

const byCreation = (a, b) => (a.createdAt || '').localeCompare(b.createdAt || '');
// Les séances d'un programme, dans l'ordre du cycle
const programTemplates = (programId) => state.templates
  .filter((t) => t.programId === programId)
  .sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || byCreation(a, b));

// Où en est le cycle : dernière séance faite dans ce programme, et celle qui vient après
// Le cycle avance par « tours » : un tour = chaque séance du programme faite une fois, dans n'importe quel ordre.
// La séance du jour = la première (dans l'ordre du programme) pas encore faite dans le tour en cours.
// Ex : Push → Pull → Legs → Bras ; si on fait Bras avant Legs, la suivante reste Legs.
function cycleInfo(tpls) {
  const ids = new Set(tpls.map((t) => t.id));
  const mine = state.workouts.filter((w) => ids.has(w.templateId)); // du plus récent au plus ancien
  const last = mine[0] || null;
  let round = new Set();
  for (const w of [...mine].reverse()) {
    // Séance déjà faite dans ce tour, ou tour complet : un nouveau tour commence
    if (round.has(w.templateId) || round.size === tpls.length) round = new Set();
    round.add(w.templateId);
  }
  if (round.size === tpls.length) round = new Set(); // tour terminé : on repart du début
  const next = tpls.find((t) => !round.has(t.id)) || null;
  const lastName = last ? (tpls.find((t) => t.id === last.templateId)?.name || last.templateName) : null;
  return { next, last, lastName, doneThisRound: round };
}

function fmtAgo(iso) {
  const midnight = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
  const days = Math.round((midnight(new Date()) - midnight(iso)) / 86400000);
  return days <= 0 ? "aujourd'hui" : days === 1 ? 'hier' : `il y a ${days} jours`;
}

// Séances sans programme (créées avant l'arrivée des programmes, ou importées d'une vieille sauvegarde)
async function adoptOrphanTemplates() {
  const orphans = (await dbAll('templates')).filter((t) => !t.programId);
  if (!orphans.length) return;
  const program = { id: uid(), name: 'Mon programme', createdAt: new Date().toISOString() };
  await dbPut('programs', program);
  for (const t of orphans) await dbPut('templates', { ...t, programId: program.id });
}

async function setActiveProgram(id) {
  state.activeProgram = id;
  await dbPut('meta', { key: 'activeProgram', value: id });
}

async function loadAll() {
  state.programs = (await dbAll('programs')).sort(byCreation);
  state.templates = (await dbAll('templates')).sort(byCreation);
  state.activeProgram = (await dbGet('meta', 'activeProgram'))?.value || null;
  state.workouts = (await dbAll('workouts')).sort((a, b) => b.date.localeCompare(a.date));
  state.draft = (await dbGet('meta', 'draft'))?.value || null;
  state.lastExport = (await dbGet('meta', 'lastExport'))?.value || null;
  state.custom = Object.fromEntries((await dbAll('custom')).map((c) => [c.key, c]));
  state.restTimes = (await dbGet('meta', 'restTimes'))?.value || {};
  state.notes = (await dbGet('meta', 'notes'))?.value || {};
  state.brands = (await dbGet('meta', 'brands'))?.value || [];
  state.prefs = { ...DEFAULT_PREFS, ...((await dbGet('meta', 'prefs'))?.value || {}) };
  state.bodyweight = (await dbAll('bodyweight')).sort((a, b) => a.date.localeCompare(b.date));
}

const saveDraft = () => (state.draft ? dbPut('meta', { key: 'draft', value: state.draft }) : dbDel('meta', 'draft'));

// Dernière fois qu'on a fait cet exercice (toutes séances confondues)
// Une « variante » = un exercice + la marque de la machine (ou rien = la machine par défaut).
// Chaque variante a son propre suivi : 45 kg sur une autre machine n'est pas une baisse par rapport à 60 kg.
const perfKey = (name, brand) => keyOf(name) + (brand ? `|${norm(brand.trim())}` : '');
const exPerfKey = (ex) => perfKey(ex.name, ex.brand);
const variantLabel = (name, brand) => (brand ? `${name} · ${brand}` : name);

function lastPerf(name, brand = null) {
  const k = perfKey(name, brand);
  for (const w of state.workouts) {
    const ex = w.exercises.find((e) => exPerfKey(e) === k);
    if (ex && ex.sets.length) return { date: w.date, sets: ex.sets, templateName: w.templateName };
  }
  return null;
}

// On pré-remplit avec la dernière perf : il suffit de cocher, ou d'ajuster
function initialSets(name, brand = null) {
  const last = lastPerf(name, brand);
  if (last) return last.sets.map((s) => ({ reps: s.reps, weight: s.weight, done: false }));
  return [0, 1, 2].map(() => ({ reps: 10, weight: 0, done: false }));
}

/* =====================================================================
   Écrans
   ===================================================================== */
const $app = document.getElementById('app');

function render() {
  document.querySelectorAll('.tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === state.tab);
    b.classList.toggle('live', b.dataset.tab === 'train' && !!state.draft);
  });
  const views = { train: viewTrain, history: viewHistory, progress: viewProgress, volume: viewVolume, settings: viewSettings };
  $app.innerHTML = views[state.tab]();
}

/* ---------- Séance : programmes → séances ---------- */
function viewTrain() {
  if (state.draft) return viewWorkout();
  const views = {
    programs: viewPrograms,
    program: viewProgram,
    editProgram: viewEditProgram,
    editTemplate: viewEditTemplate,
  };
  return views[state.route.name](state.route);
}

function findProgramOrReset(id) {
  const p = state.programs.find((x) => x.id === id);
  if (!p) state.route = { name: 'programs' };
  return p;
}

function viewPrograms() {
  // Le programme actuel en premier
  const list = [...state.programs].sort((a, b) => (b.id === state.activeProgram) - (a.id === state.activeProgram));
  const cards = list.map((p) => {
    const tpls = programTemplates(p.id);
    const active = p.id === state.activeProgram;
    const { next } = cycleInfo(tpls);
    return `
      <button class="big-card ${active ? 'suggested' : ''}" data-action="open-program" data-id="${p.id}">
        <span class="big-card-title">${esc(p.name)}${active ? '<span class="badge">Actuel</span>' : ''}</span>
        <span class="big-card-sub">${next ? `Prochaine séance : <strong class="accent">${esc(next.name)}</strong>` : 'Aucune séance pour l\'instant'}</span>
        <span class="big-card-list">${tpls.map((t) => esc(t.name)).join(' → ')}</span>
      </button>`;
  }).join('');

  return `
    <h1>Choisis ton programme</h1>
    ${cards || '<p class="muted">Aucun programme. Crée ton premier !</p>'}
    <button class="btn btn-secondary" data-action="new-program">+ Nouveau programme</button>
    <button class="btn btn-ghost" data-action="start-free">Séance libre (sans programme)</button>`;
}

function viewProgram({ id }) {
  const p = findProgramOrReset(id);
  if (!p) return viewPrograms();
  const tpls = programTemplates(p.id);
  if (!tpls.length) {
    return `
      <button class="back" data-action="go-programs">‹ Programmes</button>
      <h1>${esc(p.name)}</h1>
      <p class="muted">Ce programme n'a pas encore de séance.</p>
      <button class="btn btn-primary" data-action="edit-program" data-id="${p.id}">+ Créer mes séances</button>`;
  }

  const { next, last, lastName, doneThisRound } = cycleInfo(tpls);
  const doneToday = last && fmtAgo(last.date) === "aujourd'hui";

  const hero = `
    <section class="hero">
      <span class="hero-label">${doneToday ? 'Séance du jour faite ✅ · Prochaine' : "Aujourd'hui, c'est"}</span>
      <span class="hero-title">${esc(next.name)}</span>
      <span class="hero-sub">${last ? `Dernière séance : <strong>${esc(lastName)}</strong> (${fmtAgo(last.date)})` : 'Début du cycle'}</span>
      <span class="hero-list">${next.exercises.map(esc).join(' · ')}</span>
      <button class="btn btn-primary btn-xl" data-action="start" data-id="${next.id}">Commencer ${esc(next.name)}</button>
    </section>`;

  const steps = tpls.map((t, i) => {
    const isNext = t.id === next.id;
    const done = doneThisRound.has(t.id);
    const lastDone = state.workouts.find((w) => w.templateId === t.id);
    return `
      <button class="cycle-step ${isNext ? 'next' : ''} ${done ? 'done' : ''}" data-action="start" data-id="${t.id}">
        <span class="cycle-num">${done ? '✓' : i + 1}</span>
        <span class="cycle-name">${esc(t.name)}</span>
        ${isNext ? '<span class="badge">Aujourd\'hui</span>' : done && lastDone ? `<span class="tag">Faite ${fmtAgo(lastDone.date)}</span>` : ''}
      </button>`;
  }).join('');

  return `
    <button class="back" data-action="go-programs">‹ Programmes</button>
    <h1>${esc(p.name)}</h1>
    ${hero}
    <h3>Le cycle</h3>
    <div class="cycle">${steps}</div>
    <p class="muted small">Tu peux toucher n'importe quelle séance pour la faire aujourd'hui. Celles que tu sautes restent à faire dans ce tour du cycle (✓ = déjà faite).</p>
    <button class="btn btn-ghost" data-action="edit-program" data-id="${p.id}">✏️ Modifier ce programme</button>`;
}

function viewEditProgram({ id }) {
  const p = findProgramOrReset(id);
  if (!p) return viewPrograms();
  const tpls = programTemplates(p.id);

  const cards = tpls.map((t, i) => `
    <section class="card">
      <div class="ex-head">
        <h2>${i + 1}. ${esc(t.name)}</h2>
        <div class="move">
          <button class="icon-btn" data-action="move-template" data-id="${t.id}" data-dir="-1" aria-label="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="icon-btn" data-action="move-template" data-id="${t.id}" data-dir="1" aria-label="Descendre" ${i === tpls.length - 1 ? 'disabled' : ''}>↓</button>
        </div>
      </div>
      <p class="muted small">${t.exercises.length ? t.exercises.map(esc).join(' · ') : 'Aucun exercice'}</p>
      <div class="btn-row" style="margin-top:12px">
        <button class="btn btn-secondary" data-action="edit-template" data-id="${t.id}">Modifier</button>
        <button class="btn btn-ghost" data-action="delete-template" data-id="${t.id}">Supprimer</button>
      </div>
    </section>`).join('');

  return `
    <button class="back" data-action="open-program" data-id="${p.id}">‹ Terminé</button>
    <h1>Modifier le programme</h1>
    <section class="card">
      <label class="field"><span>Nom du programme</span>
        <input id="prog-name" data-id="${p.id}" value="${esc(p.name)}" autocomplete="off"></label>
    </section>
    <h3>Séances, dans l'ordre du cycle</h3>
    ${cards || '<p class="muted">Aucune séance. Ajoute ta première ci-dessous.</p>'}
    ${tpls.length > 1 ? '<p class="muted small">Utilise ↑ ↓ pour changer l\'ordre.</p>' : ''}
    <button class="btn btn-primary" data-action="new-template" data-id="${p.id}">+ Ajouter une séance</button>
    <button class="btn btn-danger" data-action="delete-program" data-id="${p.id}">Supprimer ce programme</button>`;
}

function viewEditTemplate(r) {
  const links = r.links || [];
  const rows = r.exercises.map((name, i) => `
    <div class="ex-row ${links[i] || links[i - 1] ? 'in-ss' : ''}">
      <span class="cycle-num">${i + 1}</span>
      <button class="ex-row-name" data-action="info" data-name="${esc(name)}">${esc(name)}</button>
      <button class="icon-btn" data-action="ex-move" data-i="${i}" data-dir="-1" aria-label="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="icon-btn" data-action="ex-move" data-i="${i}" data-dir="1" aria-label="Descendre" ${i === r.exercises.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="icon-btn" data-action="ex-remove" data-i="${i}" aria-label="Retirer">✕</button>
    </div>
    ${i < r.exercises.length - 1 ? linkButton(i, !!links[i], 'tpl-link') : ''}`).join('');

  return `
    <button class="back" data-action="edit-program" data-id="${r.programId}">‹ Annuler</button>
    <h1>${r.id ? 'Modifier la séance' : 'Nouvelle séance'}</h1>
    <section class="card">
      <label class="field"><span>Nom de la séance</span>
        <input id="ed-name" value="${esc(r.tplName)}" autocomplete="off"></label>
      <span class="field-label">Exercices, dans l'ordre</span>
      ${rows || '<p class="muted small">Aucun exercice pour l\'instant.</p>'}
      <button class="btn btn-secondary" data-action="pick-exercises">🔍 Ajouter des exercices</button>
    </section>
    <button class="btn btn-primary btn-xl" data-action="save-template">Enregistrer la séance</button>`;
}

// editing = true : stepper de l'écran « Modifier une séance enregistrée » (pas la séance en cours)
function stepper(field, value, label, editing = false) {
  const step = field === 'reps' ? 1 : state.prefs.weightStep || 2.5;
  const action = editing ? 'ew-step' : 'step';
  return `
    <div class="stepper">
      <span class="stepper-label">${label}</span>
      <div class="stepper-row">
        <button data-action="${action}" data-delta="-${step}" aria-label="Moins">−</button>
        <input ${editing ? 'data-ew-field' : 'data-field'}="${field}" inputmode="${field === 'reps' ? 'numeric' : 'decimal'}" value="${fmtNum(value)}" autocomplete="off" aria-label="${label}">
        <button data-action="${action}" data-delta="${step}" aria-label="Plus">+</button>
      </div>
    </div>`;
}

const isComplete = (ex) => ex.sets.length > 0 && ex.sets.every((s) => s.done);

// Valide une série : chrono de repos, et si l'exercice est fini il se replie et on passe au suivant
async function completeSet(ex, i, set) {
  set.done = true;
  const exs = state.draft.exercises;
  if (isComplete(ex)) ex.expanded = false;
  unlockAudio();
  const next = nextSetPosition(state.draft);
  // Superset : pas de repos tant qu'il reste l'exercice suivant du même tour
  const [, b] = groupOf(exs, i);
  const partnerNext = next && next.i > i && next.i <= b;
  if (!next) stopRest(); // pas de chrono après la toute dernière série
  else if (partnerNext) stopRest();
  else if (state.prefs.autoRest) startRest(ex.name);
  await saveDraft();
  render();
  if (!state.prefs.autoCollapse) return;
  // On amène l'écran sur la prochaine série si elle est sur un autre exercice
  if (!next) document.querySelector('[data-action=finish]')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  else if (next.i !== i) document.querySelector(`.exercise[data-ex="${next.i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

/* ---------- Ressenti d'une série : facile / moyen / dur (facultatif) ---------- */
const FEELS = [
  { id: 'easy', label: 'Facile', emoji: '🟢' },
  { id: 'ok', label: 'Moyen', emoji: '🟡' },
  { id: 'hard', label: 'Dur', emoji: '🔴' },
];
const feelEmoji = (id) => (state.prefs.feelings && (FEELS.find((f) => f.id === id) || {}).emoji) || '';

// Les 3 pastilles d'une série. En séance, en toucher une valide aussi la série.
function feelDots(set, action) {
  if (!state.prefs.feelings) return '';
  return `<span class="feels">${FEELS.map((f) =>
    `<button class="feel ${f.id} ${set.feel === f.id ? 'on' : ''}" data-action="${action}" data-feel="${f.id}" aria-label="${f.label}"></button>`).join('')}</span>`;
}

// Conseil pour aujourd'hui, d'après le ressenti de la dernière fois
function feelTip(sets) {
  if (!state.prefs.feelings) return '';
  const felt = sets.filter((s) => s.feel);
  if (!felt.length) return '';
  if (felt.every((s) => s.feel === 'easy')) return '<span class="feel-tip">💡 C\'était facile : essaie d\'augmenter le poids.</span>';
  if (felt.some((s) => s.feel === 'hard')) return '<span class="feel-tip">💡 C\'était dur : garde le même poids et vise plus de reps.</span>';
  return '';
}

// Prochaine série à faire : la 1re non cochée du 1er exercice pas terminé
/* ---------- Supersets : exercices consécutifs liés (linkNext = lié au suivant) ---------- */
// Indices [début, fin] du groupe de superset qui contient l'exercice i (début = fin si pas de superset)
function groupOf(exs, i) {
  let a = i;
  while (a > 0 && exs[a - 1].linkNext) a--;
  let b = i;
  while (b < exs.length - 1 && exs[b].linkNext) b++;
  return [a, b];
}

// Lettre de chaque superset (A, B…) ou null
function supersetLetters(exs) {
  const letters = [];
  let n = 0;
  exs.forEach((e, i) => {
    if (i > 0 && exs[i - 1].linkNext) letters[i] = letters[i - 1];
    else letters[i] = e.linkNext && i < exs.length - 1 ? String.fromCharCode(65 + n++) : null;
  });
  return letters;
}

// Bouton entre deux exercices pour les lier (ou délier) en superset
function linkButton(i, linked, action) {
  return `<button class="ss-between ${linked ? 'on' : ''}" data-action="${action}" data-i="${i}">
    ${linked ? '🔗 En superset avec le suivant · délier' : '🔗 Lier en superset'}</button>`;
}

// Prochaine série à faire. Dans un superset, on alterne : série 1 de A, série 1 de B, série 2 de A…
function nextSetPosition(d) {
  const exs = d.exercises;
  for (let i = 0; i < exs.length;) {
    const [a, b] = groupOf(exs, i);
    const rounds = Math.max(...exs.slice(a, b + 1).map((e) => e.sets.length));
    for (let j = 0; j < rounds; j++) {
      for (let k = a; k <= b; k++) {
        const s = exs[k].sets[j];
        if (s && !s.done) return { i: k, j };
      }
    }
    i = b + 1;
  }
  return null;
}

function viewWorkout() {
  const d = state.draft;
  const next = nextSetPosition(d);
  const total = d.exercises.reduce((a, ex) => a + ex.sets.length, 0);
  const doneCount = d.exercises.reduce((a, ex) => a + ex.sets.filter((s) => s.done).length, 0);

  const cards = d.exercises.map((ex, i) => {
    // Exercice terminé : replié sur une ligne (on peut le rouvrir)
    if (state.prefs.autoCollapse && isComplete(ex) && !ex.expanded) {
      return `
        <section class="card exercise collapsed" data-ex="${i}">
          <button class="ex-collapsed" data-action="expand-ex">
            <span class="ex-done-check">✓</span>
            <span class="ex-collapsed-text"><strong>${esc(ex.name)}</strong><span class="muted small">${esc(fmtSets(ex.sets))}</span></span>
            <span class="muted small">Modifier ›</span>
          </button>
        </section>`;
    }
    const last = lastPerf(ex.name, ex.brand);
    const note = noteFor(ex.name, ex.brand);
    const sets = ex.sets.map((s, j) => `
      <div class="set ${s.done ? 'done' : ''} ${next && next.i === i && next.j === j ? 'current' : ''}" data-set="${j}">
        <div class="set-top">
          <span class="set-num">Série ${j + 1}${ex.sets.length > 1 ? ' <button class="link remove-set" data-action="remove-set" aria-label="Retirer la série">✕</button>' : ''}
            ${last && last.sets[j] ? `<span class="set-prev">${feelEmoji(last.sets[j].feel)} avant : ${esc(fmtSet(last.sets[j]))}</span>` : ''}</span>
          ${feelDots(s, 'set-feel')}
          <button class="check" data-action="toggle-done" aria-label="Série faite">✓</button>
        </div>
        <div class="set-fields">
          ${stepper('reps', s.reps, 'Répétitions')}
          ${stepper('weight', s.weight, 'Poids (kg)')}
        </div>
      </div>`).join('');

    return `
      <section class="card exercise" data-ex="${i}">
        <div class="ex-head">
          <button class="ex-title" data-action="info" data-name="${esc(ex.name)}"><span>${esc(ex.name)}</span><span class="info-i">i</span></button>
          <div class="move">
            <button class="icon-btn" data-action="move-ex" data-dir="-1" aria-label="Monter l'exercice" ${i === 0 ? 'disabled' : ''}>↑</button>
            <button class="icon-btn" data-action="move-ex" data-dir="1" aria-label="Descendre l'exercice" ${i === d.exercises.length - 1 ? 'disabled' : ''}>↓</button>
            <button class="icon-btn" data-action="remove-ex" aria-label="Retirer l'exercice">✕</button>
          </div>
        </div>
        <button class="brand-chip ${ex.brand ? 'on' : ''}" data-action="pick-brand">🏷 Machine : <strong>${esc(ex.brand || 'Par défaut')}</strong> ▾</button>
        ${last
          ? `<div class="last">
              <strong>Dernière fois</strong> · ${fmtDate(last.date)}${last.templateName ? ` · ${esc(last.templateName)}` : ''}
              <span class="last-sets">${last.sets.map((s, j) => `<span>S${j + 1} <b>${esc(fmtSet(s))}</b> ${feelEmoji(s.feel)}</span>`).join('')}</span>
              ${feelTip(last.sets)}
            </div>`
          : `<p class="last first">${ex.brand ? `Première fois sur la machine ${esc(ex.brand)} 💪` : 'Première fois sur cet exercice 💪'}</p>`}
        ${ex.replaces ? `
          <p class="swap-note">⇄ À la place de <strong>${esc(ex.replaces)}</strong>
            <button class="link" data-action="unswap-ex">Remettre</button></p>` : ''}
        ${note ? `<button class="ex-note" data-action="edit-note" data-name="${esc(ex.name)}" data-brand="${esc(ex.brand || '')}">📝 ${esc(note)}</button>` : ''}
        <div class="ex-tools">
          <button class="rest-btn" data-action="rest-config">⏱ <strong>${fmtClock(restFor(ex.name))}</strong></button>
          <button class="rest-btn" data-action="swap-ex">⇄ Remplacer</button>
          <button class="rest-btn" data-action="edit-note" data-name="${esc(ex.name)}" data-brand="${esc(ex.brand || '')}">📝 Note</button>
        </div>
        ${sets}
        <button class="btn btn-secondary" data-action="add-set">+ Ajouter une série</button>
        ${state.prefs.autoCollapse && isComplete(ex) ? '<button class="link" data-action="collapse-ex">Replier ▴</button>' : ''}
      </section>`;
  });

  // Supersets : les exercices liés sont regroupés dans un cadre violet, avec un bouton 🔗 entre chaque exercice
  const letters = supersetLetters(d.exercises);
  const exercises = cards.map((html, i) => {
    const l = letters[i];
    const opens = l && (i === 0 || letters[i - 1] !== l);
    const closes = l && letters[i + 1] !== l;
    const link = i < cards.length - 1 ? linkButton(i, !!d.exercises[i].linkNext, 'link-ex') : '';
    // Le bouton entre deux exercices d'un même superset reste dans le cadre ; après le dernier, il est en dehors
    return `${opens ? `<div class="ss-group"><span class="ss-tag">🔗 Superset ${l} · enchaîne sans repos</span>` : ''}${html}${closes ? '</div>' : ''}${link}`;
  }).join('');

  return `
    <div class="wk-head">
      <div class="wk-title">
        <strong>${esc(d.templateName)}</strong>
        <span class="muted small">${doneCount}/${total} séries · ${state.prefs.sessionTimer
          ? `<span class="wk-elapsed" title="Commencée à ${fmtTime(d.startedAt)}">⏱ ${fmtElapsed(d.startedAt)}</span>`
          : `depuis ${fmtTime(d.startedAt)}`}</span>
        <div class="wk-progress"><span style="width:${total ? (doneCount / total) * 100 : 0}%"></span></div>
      </div>
      <button class="btn btn-primary wk-finish" data-action="finish">Terminer</button>
    </div>
    <p class="muted small">Coche ✓ chaque série terminée : la série à faire est encadrée en orange.</p>
    ${exercises}
    <button class="btn btn-secondary" data-action="add-ex">+ Ajouter un exercice</button>
    <button class="btn btn-primary btn-xl" data-action="finish">Terminer et enregistrer</button>
    <button class="btn btn-danger" data-action="cancel">Abandonner la séance</button>`;
}

/* ---------- Historique ---------- */
function viewHistory() {
  if (state.editWorkout) return viewEditWorkout();

  // Calendrier du mois : un point sur chaque jour d'entraînement
  const [y, m] = state.histMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const offset = (first.getDay() + 6) % 7; // la semaine commence le lundi
  const byDay = {};
  for (const w of state.workouts) (byDay[localDay(new Date(w.date))] ||= []).push(w);
  const today = localDay();
  const cells = [];
  for (let i = 0; i < offset; i++) cells.push('<span class="cal-day blank"></span>');
  for (let d = 1; d <= daysInMonth; d++) {
    const day = `${y}-${pad2(m)}-${pad2(d)}`;
    const cls = [byDay[day] ? 'has' : '', day === state.histDay ? 'sel' : '', day === today ? 'today' : ''].join(' ');
    cells.push(`<button class="cal-day ${cls}" data-action="hist-day" data-day="${day}">${d}</button>`);
  }
  const monthName = first.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

  // Séances affichées : le jour choisi, sinon tout le mois
  const shown = state.histDay
    ? byDay[state.histDay] || []
    : state.workouts.filter((w) => localDay(new Date(w.date)).startsWith(state.histMonth));
  const title = state.histDay
    ? `${fmtDate(dayToIso(state.histDay))} · <button class="link" data-action="hist-day" data-day="${state.histDay}">voir tout le mois</button>`
    : `${shown.length} séance(s) en ${first.toLocaleDateString('fr-FR', { month: 'long' })}`;

  const cards = shown.map((w) => `
    <section class="card">
      <div class="hist-head">
        <h2>${esc(w.templateName)}</h2>
        <span class="muted small">${w.programName ? esc(w.programName) + ' · ' : ''}${fmtDate(w.date)}</span>
      </div>
      ${w.exercises.map((e, k, all) => `<p class="hist-ex"><strong>${supersetLetters(all)[k] ? `<span class="ss-mini">🔗 ${supersetLetters(all)[k]}</span> ` : ''}${esc(variantLabel(e.name, e.brand))}${e.replaces ? ` <span class="muted small">⇄ à la place de ${esc(e.replaces)}</span>` : ''}</strong>${esc(fmtSets(e.sets))}</p>`).join('')}
      <div class="btn-row three" style="margin-top:12px">
        <button class="btn btn-secondary" data-action="recap-workout" data-id="${w.id}">📊 Bilan</button>
        <button class="btn btn-secondary" data-action="edit-workout" data-id="${w.id}">✏️ Modifier</button>
        <button class="btn btn-ghost" data-action="delete-workout" data-id="${w.id}">Supprimer</button>
      </div>
    </section>`).join('');

  return `
    <h1>Historique</h1>
    <section class="card">
      <div class="cal-head">
        <button class="icon-btn" data-action="hist-month" data-dir="-1" aria-label="Mois précédent">‹</button>
        <h2>${monthName}</h2>
        <button class="icon-btn" data-action="hist-month" data-dir="1" aria-label="Mois suivant">›</button>
      </div>
      <div class="cal-grid">
        ${['L', 'M', 'M', 'J', 'V', 'S', 'D'].map((d) => `<span class="cal-wd">${d}</span>`).join('')}
        ${cells.join('')}
      </div>
    </section>
    <p class="muted small">${title}</p>
    ${cards || emptyHistoryMessage()}
    ${addPastWorkoutButton()}`;
}

// Séance oubliée : on peut l'ajouter à la main sur le jour choisi (pas dans le futur)
function addPastWorkoutButton() {
  if (!state.histDay) {
    return '<p class="muted small" style="text-align:center">Tu as oublié d\'enregistrer une séance ? Touche le jour dans le calendrier pour l\'ajouter.</p>';
  }
  if (state.histDay > localDay()) return '';
  return `<button class="btn btn-ghost" data-action="add-past" data-day="${state.histDay}">+ Ajouter une séance ce jour-là</button>`;
}

// Choix de la séance à ajouter : celles de tes programmes, ou une séance libre
function openAddPastSheet(day) {
  const groups = state.programs.map((p) => {
    const tpls = programTemplates(p.id);
    if (!tpls.length) return '';
    return `
      <h3>${esc(p.name)}</h3>
      ${tpls.map((t) => `<button class="btn btn-secondary" data-sheet="add-past-pick" data-day="${day}" data-id="${t.id}">${esc(t.name)}</button>`).join('')}`;
  }).join('');
  $sheet.querySelector('.sheet-body').innerHTML = `
    <div class="sheet-head">
      <div><h2>Ajouter une séance</h2><span class="muted small">${fmtDate(dayToIso(day))}</span></div>
      <button class="icon-btn" data-sheet="close" aria-label="Fermer">✕</button>
    </div>
    <p class="small muted">Quelle séance as-tu faite ce jour-là ?</p>
    ${groups}
    <h3>Autre</h3>
    <button class="btn btn-ghost" data-sheet="add-past-pick" data-day="${day}" data-id="">Séance libre (sans programme)</button>`;
  $sheet.hidden = false;
}

function startPastWorkout(day, templateId) {
  const t = state.templates.find((x) => x.id === templateId);
  const program = t && state.programs.find((p) => p.id === t.programId);
  state.editWorkout = {
    id: uid(),
    isNew: true,
    day,
    date: `${day}T18:00:00`, // heure par défaut : 18 h
    programName: program ? program.name : null,
    templateId: t ? t.id : null,
    templateName: t ? t.name : 'Séance libre',
    // Pré-rempli avec ta dernière perf sur chaque exercice : il ne reste qu'à corriger
    exercises: t ? t.exercises.map((name) => ({ name, sets: initialSets(name).map(({ reps, weight }) => ({ reps, weight })) })) : [],
  };
  closeSheet();
  render();
  scrollTo(0, 0);
}

// Mois ou jour sans séance : on propose d'aller directement à la séance la plus récente avant
function emptyHistoryMessage() {
  const limit = state.histDay || `${state.histMonth}-01`;
  const prev = state.workouts.find((w) => localDay(new Date(w.date)) < limit);
  const text = state.histDay ? 'Aucune séance ce jour-là.' : 'Aucune séance ce mois-ci pour l\'instant.';
  return `
    <div class="empty-hist">
      <p class="muted">${text}</p>
      ${prev ? `<button class="btn btn-secondary" data-action="hist-goto" data-day="${localDay(new Date(prev.date))}">Voir la dernière séance (${fmtDate(prev.date)}) ›</button>` : ''}
    </div>`;
}

/* ---------- Modifier une séance déjà enregistrée ---------- */
function viewEditWorkout() {
  const w = state.editWorkout;
  const exercises = w.exercises.map((ex, i) => `
    <section class="card" data-ewx="${i}">
      <div class="ex-head">
        <span class="ex-title">${esc(ex.name)}</span>
        <button class="icon-btn" data-action="ew-remove-ex" aria-label="Retirer l'exercice">✕</button>
      </div>
      <button class="brand-chip ${ex.brand ? 'on' : ''}" data-action="ew-pick-brand">🏷 Machine : <strong>${esc(ex.brand || 'Par défaut')}</strong> ▾</button>
      ${ex.sets.map((s, j) => `
        <div class="set" data-ews="${j}">
          <div class="set-top">
            <span class="set-num">Série ${j + 1}</span>
            ${ex.sets.length > 1 ? '<button class="link" data-action="ew-remove-set">Retirer</button>' : ''}
            ${feelDots(s, 'ew-feel')}
          </div>
          <div class="set-fields">
            ${stepper('reps', s.reps, 'Répétitions', true)}
            ${stepper('weight', s.weight, 'Poids (kg)', true)}
          </div>
        </div>`).join('')}
      <button class="btn btn-secondary" data-action="ew-add-set">+ Ajouter une série</button>
    </section>`).join('');

  return `
    <button class="back" data-action="ew-cancel">‹ Annuler</button>
    <h1>${w.isNew ? 'Ajouter une séance' : 'Modifier la séance'}</h1>
    <section class="card">
      <p class="muted small" style="margin-top:0">${esc(w.templateName)}${w.programName ? ' · ' + esc(w.programName) : ''}</p>
      <label class="field"><span>Date de la séance</span>
        <input type="date" id="ew-date" value="${w.day}" max="${localDay()}"></label>
    </section>
    ${exercises || '<p class="muted">Plus aucun exercice dans cette séance.</p>'}
    <button class="btn btn-secondary" data-action="ew-add-ex">+ Ajouter un exercice</button>
    <button class="btn btn-primary btn-xl" data-action="ew-save">${w.isNew ? 'Enregistrer la séance' : 'Enregistrer les modifications'}</button>`;
}

async function saveEditedWorkout() {
  const w = state.editWorkout;
  const exercises = w.exercises.filter((e) => e.sets.length);
  if (!exercises.length) {
    return showMessage('Séance vide', w.isNew
      ? 'Ajoute au moins un exercice avec une série.'
      : 'Il n\'y a plus aucune série. Pour supprimer la séance, utilise « Supprimer » dans l\'historique.');
  }
  if (w.day > localDay()) return showMessage('Date dans le futur', 'Choisis une date d\'aujourd\'hui ou d\'avant.');
  // Nouvelle date : même heure qu'avant, au jour choisi
  const date = new Date(w.date);
  const [y, m, d] = w.day.split('-').map(Number);
  date.setFullYear(y, m - 1, d);
  const { day, isNew, ...saved } = { ...w, exercises, date: date.toISOString() };
  await dbPut('workouts', saved);
  const others = state.workouts.filter((x) => x.id !== saved.id);
  state.workouts = [...others, saved].sort((a, b) => b.date.localeCompare(a.date));
  state.editWorkout = null;
  state.histDay = day;
  state.histMonth = day.slice(0, 7);
  render();
  scrollTo(0, 0);
  toast(isNew ? 'Séance ajoutée ✅' : 'Séance modifiée ✅');
}

/* ---------- Progrès ---------- */
const METRICS = {
  weight: { label: 'Poids max', unit: 'kg', f: (sets) => Math.max(...sets.map((s) => s.weight)) },
  reps: { label: 'Reps totales', unit: 'reps', f: (sets) => sets.reduce((a, s) => a + s.reps, 0) },
  volume: { label: 'Volume', unit: 'kg', f: (sets) => sets.reduce((a, s) => a + s.reps * s.weight, 0) },
};

// Exercices déjà faits, une entrée par variante (exercice + machine), du plus récent au plus ancien
function exerciseVariants() {
  const map = new Map();
  for (const w of state.workouts) {
    for (const e of w.exercises) {
      const key = exPerfKey(e);
      if (!map.has(key)) map.set(key, { key, name: e.name, brand: e.brand || null, label: variantLabel(e.name, e.brand) });
    }
  }
  return [...map.values()];
}

function viewProgress() {
  const seg = [['global', 'Global'], ['exercises', 'Exercices'], ['bodyweight', 'Pesées']].map(([id, label]) =>
    `<button class="${id === state.progressView ? 'on' : ''}" data-action="progress-view" data-id="${id}">${label}</button>`).join('');
  const views = { global: viewGlobalProgress, exercises: viewExerciseProgress, bodyweight: viewBodyweight };
  return `
    <h1>Progrès</h1>
    <div class="seg">${seg}</div>
    ${views[state.progressView]()}`;
}

/* ---------- Progrès global : % de progression entre deux périodes ---------- */
// Force estimée d'une série (formule d'Epley) : 10 × 60 kg vaut plus que 8 × 60 kg
const estimatedMax = (s) => s.weight * (1 + s.reps / 30);
const fmtPct = (x) => {
  const v = Math.round(x * 1000) / 10 || 0; // évite « -0 »
  return `${v > 0 ? '+' : ''}${fmtNum(v)} %`;
};

// Meilleure performance de chaque exercice sur une liste de séances
function bestPerfs(workouts) {
  const map = {};
  for (const w of workouts) {
    for (const ex of w.exercises) {
      const p = (map[exPerfKey(ex)] ||= { name: ex.name, brand: ex.brand || null, max: 0, reps: 0, weighted: false });
      for (const s of ex.sets) {
        if (s.weight > 0) { p.weighted = true; p.max = Math.max(p.max, estimatedMax(s)); }
        p.reps = Math.max(p.reps, s.reps);
      }
    }
  }
  return map;
}

// Exercices faits dans les deux périodes, avec leur progression en %
function compareWorkouts(current, previous) {
  const now = bestPerfs(current);
  const before = bestPerfs(previous);
  const rows = [];
  for (const [k, a] of Object.entries(now)) {
    const b = before[k];
    if (!b) continue;
    const useWeight = a.weighted && b.weighted; // sinon (poids du corps) : on compare les reps
    const x = useWeight ? a.max : a.reps;
    const y = useWeight ? b.max : b.reps;
    if (!y) continue;
    rows.push({ name: variantLabel(a.name, a.brand), pct: (x - y) / y, muscles: (exerciseMuscles(a.name) || { primary: [] }).primary });
  }
  return rows;
}

// Durées proposées (en jours). « custom » = date de départ choisie à la main
// (tableau et pas objet : un objet range les clés numériques avant « cycle »)
const GLOBAL_PERIODS = [['cycle', 'Cycle'], ['14', '2 sem.'], ['30', '1 mois'], ['90', '3 mois'], ['180', '6 mois'], ['365', '1 an'], ['all', 'Tout'], ['custom', '📅 Date']];

// Progression sur une durée : pour chaque exercice, sa première séance de la période comparée à la plus récente
function compareOverSpan(workouts) {
  const sessions = {}; // exercice → ses perfs, de la plus ancienne à la plus récente
  for (const w of [...workouts].reverse()) {
    for (const ex of w.exercises) {
      const perf = bestPerfs([{ exercises: [ex] }])[exPerfKey(ex)];
      (sessions[exPerfKey(ex)] ||= []).push(perf);
    }
  }
  const rows = [];
  for (const list of Object.values(sessions)) {
    if (list.length < 2) continue;
    const first = list[0];
    const last = list[list.length - 1];
    const useWeight = first.weighted && last.weighted;
    const x = useWeight ? last.max : last.reps;
    const y = useWeight ? first.max : first.reps;
    if (!y) continue;
    rows.push({ name: variantLabel(last.name, last.brand), pct: (x - y) / y, muscles: (exerciseMuscles(last.name) || { primary: [] }).primary });
  }
  return rows;
}

// Séances à comparer selon la période choisie, et une phrase pour l'expliquer
function globalComparison(period) {
  if (period === 'cycle') {
    const lastTpl = state.workouts.length && state.templates.find((t) => t.id === state.workouts[0].templateId);
    const program = state.programs.find((p) => p.id === (state.activeProgram || (lastTpl && lastTpl.programId)));
    const tpls = program ? programTemplates(program.id) : [];
    if (!tpls.length) return { rows: [], desc: 'Choisis d\'abord un programme dans l\'onglet Séance.', hint: '' };
    const ids = new Set(tpls.map((t) => t.id));
    const list = state.workouts.filter((w) => ids.has(w.templateId));
    return {
      rows: compareWorkouts(list.slice(0, tpls.length), list.slice(tpls.length, tpls.length * 2)),
      desc: `Ton dernier cycle de ${esc(program.name)} comparé au précédent`,
      hint: 'Il faut avoir fait au moins 2 cycles.',
    };
  }
  let from = null;
  if (period === 'custom') {
    from = new Date(dayToIso(state.globalFrom));
    from.setHours(0, 0, 0, 0);
  } else if (period !== 'all') {
    from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - (+period - 1));
  }
  const workouts = from ? state.workouts.filter((w) => new Date(w.date) >= from) : state.workouts;
  return {
    rows: compareOverSpan(workouts),
    desc: `${from ? `Depuis le ${fmtDate(from.toISOString())}` : 'Depuis ta toute première séance'} : la première fois que tu as fait chaque exercice sur la période, comparée à la plus récente`,
    hint: 'Il faut avoir fait le même exercice au moins 2 fois sur la période.',
  };
}

function pctBar(pct, maxAbs) {
  const width = Math.min(100, (Math.abs(pct) / maxAbs) * 100);
  return `<div class="pct-bar"><span class="${pct >= 0 ? 'up' : 'down'}" style="width:${width}%"></span></div>`;
}

function viewGlobalProgress() {
  const chips = GLOBAL_PERIODS.map(([id, label]) =>
    `<button class="chip ${id === state.globalPeriod ? 'on' : ''}" data-action="global-period" data-id="${id}">${label}</button>`).join('');
  const datePicker = state.globalPeriod === 'custom' ? `
    <label class="field"><span>Voir mes progrès depuis le…</span>
      <input type="date" id="global-from" value="${state.globalFrom}" max="${localDay()}"></label>` : '';
  const { rows, desc, hint } = globalComparison(state.globalPeriod);
  const head = `<div class="chips-wrap">${chips}</div>${datePicker}<p class="muted small">${desc}</p>`;

  if (!rows.length) {
    return `${head}<div class="empty"><div class="big">📊</div>
      <p>Pas encore assez de séances pour comparer.<br>${hint}</p></div>`;
  }

  const mean = (list) => list.reduce((a, r) => a + r.pct, 0) / list.length;
  const overall = mean(rows);
  const cls = (x) => (x > 0.0005 ? 'up' : x < -0.0005 ? 'down' : '');
  const ups = rows.filter((r) => r.pct > 0.0005).length;
  const downs = rows.filter((r) => r.pct < -0.0005).length;

  const muscles = Object.keys(MUSCLE_LABELS)
    .map((m) => ({ m, list: rows.filter((r) => r.muscles.includes(m)) }))
    .filter((x) => x.list.length)
    .map((x) => ({ ...x, pct: mean(x.list) }))
    .sort((a, b) => b.pct - a.pct);
  const maxAbs = Math.max(...rows.map((r) => Math.abs(r.pct)), 0.01);

  const muscleRows = muscles.map(({ m, list, pct }) => {
    const open = state.globalMuscle === m;
    const detail = open ? `
      <div class="pct-detail">
        ${list.slice().sort((a, b) => b.pct - a.pct).map((r) => `
          <div class="pct-ex"><span>${esc(r.name)}</span><strong class="${cls(r.pct)}">${fmtPct(r.pct)}</strong></div>`).join('')}
      </div>` : '';
    return `
      <div class="pct-row ${open ? 'open' : ''}">
        <button class="pct-main" data-action="global-muscle" data-m="${m}">
          <span class="pct-name">${MUSCLE_LABELS[m]} <span class="muted small">· ${list.length} exo${list.length > 1 ? 's' : ''}</span></span>
          <strong class="${cls(pct)}">${fmtPct(pct)}</strong>
          <span class="pct-chevron">${open ? '▾' : '›'}</span>
        </button>
        ${pctBar(pct, maxAbs)}
        ${detail}
      </div>`;
  }).join('');

  return `
    ${head}
    <section class="card global-hero">
      <span class="stat-label">Progression moyenne</span>
      <span class="global-pct ${cls(overall)}">${fmtPct(overall)}</span>
      <span class="muted small">sur ${rows.length} exercice${rows.length > 1 ? 's' : ''} comparé${rows.length > 1 ? 's' : ''} · ${ups} en hausse · ${downs} en baisse</span>
    </section>
    <h3>Par muscle</h3>
    <p class="muted small">Touche un muscle pour voir le détail de ses exercices.</p>
    <section class="card">${muscleRows}</section>
    <p class="muted small">Calcul : pour chaque exercice, on compare ta meilleure série d'une période à l'autre, en combinant poids et répétitions (force estimée). Au poids du corps : le nombre de répétitions. Un muscle = la moyenne des exercices où il est le muscle principal.</p>`;
}

/* ---------- Poids de corps ---------- */
const pad2 = (n) => String(n).padStart(2, '0');
const localDay = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dayToIso = (day) => `${day}T12:00:00`; // midi : évite les décalages de fuseau horaire

function viewBodyweight() {
  const list = state.bodyweight;
  const today = localDay();
  const todayEntry = list.find((b) => b.date === today);
  const last = list[list.length - 1];
  const value = todayEntry ? todayEntry.weight : last ? last.weight : 70;

  // Variation sur 7 jours : par rapport à la dernière pesée d'il y a au moins 7 jours
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const ref7 = [...list].reverse().find((b) => b.date <= localDay(weekAgo));
  const diff = (a, b) => Math.round((a - b) * 10) / 10;
  const sign = (n) => (n > 0 ? '+' : '') + fmtNum(n);

  const stats = last ? `
    <div class="stats">
      <div class="stat"><div class="stat-value">${fmtNum(last.weight)}<span class="small"> kg</span></div><div class="stat-label">Actuel</div></div>
      <div class="stat"><div class="stat-value">${ref7 ? sign(diff(last.weight, ref7.weight)) : '–'}</div><div class="stat-label">Sur 7 jours</div></div>
      <div class="stat"><div class="stat-value">${list.length > 1 ? sign(diff(last.weight, list[0].weight)) : '–'}</div><div class="stat-label">Depuis le début</div></div>
    </div>` : '';

  const points = list.map((b) => ({ date: dayToIso(b.date), y: b.weight }));
  const rows = [...list].reverse().map((b) => `
    <div class="row">
      <span>${fmtDate(dayToIso(b.date))}</span>
      <span><strong>${fmtNum(b.weight)} kg</strong> <button class="link" data-action="bw-delete" data-date="${b.date}">suppr.</button></span>
    </div>`).join('');

  return `
    <section class="card">
      <span class="stepper-label">Poids du jour (${fmtDate(dayToIso(today))})</span>
      <div class="stepper-row bw-stepper">
        <button data-action="bw-step" data-delta="-0.1" aria-label="Moins 100 g">−</button>
        <input id="bw-input" inputmode="decimal" value="${fmtNum(value)}" autocomplete="off" aria-label="Poids en kg">
        <button data-action="bw-step" data-delta="0.1" aria-label="Plus 100 g">+</button>
      </div>
      <button class="btn btn-primary" data-action="bw-save">${todayEntry ? 'Mettre à jour la pesée du jour' : 'Enregistrer ma pesée'}</button>
    </section>
    ${stats}
    ${points.length > 1 ? `<section class="card">${chartSVG(points)}</section>` : list.length ? '<p class="muted small">Pèse-toi un autre jour pour voir la courbe.</p>' : ''}
    ${list.length ? `<h3>Toutes les pesées</h3><section class="card">${rows}</section>` : '<p class="muted small">Astuce : pèse-toi le matin à jeun, toujours dans les mêmes conditions.</p>'}`;
}

async function saveBodyweight() {
  const weight = num(document.getElementById('bw-input').value);
  if (weight < 20 || weight > 400) return showMessage('Poids invalide', 'Entre un poids valide, en kg.');
  const entry = { date: localDay(), weight };
  await dbPut('bodyweight', entry);
  state.bodyweight = [...state.bodyweight.filter((b) => b.date !== entry.date), entry].sort((a, b) => a.date.localeCompare(b.date));
  render();
  toast(`Pesée enregistrée : ${fmtNum(weight)} kg`);
}

function viewExerciseProgress() {
  const variants = exerciseVariants();
  if (!variants.length) {
    return `<div class="empty"><div class="big">📈</div><p>Termine ta première séance pour voir ta progression ici.</p></div>`;
  }
  // state.progressExercise = clé de variante (exercice + machine)
  if (!state.progressExercise || !variants.some((v) => v.key === state.progressExercise)) {
    state.progressExercise = variants[0].key;
  }
  const k = state.progressExercise;
  const entries = state.workouts
    .map((w) => ({ date: w.date, ex: w.exercises.find((e) => exPerfKey(e) === k) }))
    .filter((x) => x.ex && x.ex.sets.length)
    .reverse(); // de la plus ancienne à la plus récente

  const m = METRICS[state.progressMetric];
  const points = entries.map((e) => ({ date: e.date, y: Math.round(m.f(e.ex.sets) * 100) / 100 }));

  const record = Math.max(...entries.map((e) => METRICS.weight.f(e.ex.sets)));
  const diff = points.length > 1 ? points[points.length - 1].y - points[0].y : 0;

  const options = variants.map((v) => `<option value="${esc(v.key)}" ${v.key === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('');
  const seg = Object.entries(METRICS).map(([id, mm]) =>
    `<button class="${id === state.progressMetric ? 'on' : ''}" data-action="metric" data-id="${id}">${mm.label}</button>`).join('');

  const rows = entries.slice().reverse().map((e) =>
    `<div class="row"><span>${fmtDate(e.date)}</span><span>${esc(fmtSets(e.ex.sets))}</span></div>`).join('');

  return `
    <select class="select" data-action="pick-exercise" aria-label="Exercice">${options}</select>
    <div class="seg">${seg}</div>
    <div class="stats">
      <div class="stat"><div class="stat-value">${fmtNum(record)}<span class="small"> kg</span></div><div class="stat-label">Record poids</div></div>
      <div class="stat"><div class="stat-value">${entries.length}</div><div class="stat-label">Séances</div></div>
      <div class="stat"><div class="stat-value ${diff > 0 ? 'up' : ''}">${diff > 0 ? '+' : ''}${fmtNum(diff)}</div><div class="stat-label">${m.label} depuis le début</div></div>
    </div>
    <section class="card">
      ${points.length > 1 ? chartSVG(points) : '<p class="muted">Fais cet exercice au moins 2 fois pour voir la courbe.</p>'}
      ${state.progressMetric === 'volume' ? '<p class="muted small">Volume = répétitions × poids, additionné sur toutes les séries.</p>' : ''}
    </section>
    <h3>Toutes les séances</h3>
    <section class="card">${rows}</section>`;
}

function chartSVG(points) {
  const W = 340, H = 210, pl = 36, pr = 14, pt = 22, pb = 26;
  const ys = points.map((p) => p.y);
  let min = Math.min(...ys), max = Math.max(...ys);
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.12;
  min = Math.max(0, min - pad); max += pad;

  const x = (i) => pl + (i * (W - pl - pr)) / (points.length - 1);
  const y = (v) => pt + (H - pt - pb) * (1 - (v - min) / (max - min));

  // Petits écarts (ex : poids de corps) : graduations avec une décimale
  const tick = (v) => (max - min < 5 ? Math.round(v * 10) / 10 : Math.round(v));
  const grid = [0, 0.5, 1].map((t) => {
    const v = min + (max - min) * t;
    return `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/>
            <text class="axis" x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${fmtNum(tick(v))}</text>`;
  }).join('');

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - pb} L${pl},${H - pb} Z`;
  const showValues = points.length <= 12;
  // Une étiquette seulement quand la valeur change (sinon elles se chevauchent sur les paliers)
  const changed = (i) => i === 0 || points[i].y !== points[i - 1].y;
  const lastLabel = points.reduce((k, p, i) => (changed(i) ? i : k), 0);
  const dots = points.map((p, i) => `
    <circle class="dot" cx="${x(i)}" cy="${y(p.y)}" r="4"/>
    ${(showValues && changed(i)) || i === lastLabel ? `<text class="val" x="${x(i)}" y="${y(p.y) - 9}" text-anchor="${i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}">${fmtNum(p.y)}</text>` : ''}`).join('');

  const last = points.length - 1;
  const xLabels = `
    <text class="axis" x="${pl}" y="${H - 6}" text-anchor="start">${fmtShort(points[0].date)}</text>
    <text class="axis" x="${W - pr}" y="${H - 6}" text-anchor="end">${fmtShort(points[last].date)}</text>`;

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe de progression">
    ${grid}<path class="area" d="${area}"/><path class="line" d="${line}"/>${dots}${xLabels}</svg>`;
}

/* ---------- Volume : séries par muscle ---------- */
const VOLUME_PERIODS = { week: '7 jours', lastweek: 'Sem. passée', cycle: 'Cycle', month: '30 jours' };

function startOfWeek(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // lundi
  return d;
}

// Séances prises en compte pour la période choisie, et une phrase pour l'expliquer
function volumeWorkouts(period) {
  const between = (from, to) => state.workouts.filter((w) => new Date(w.date) >= from && (!to || new Date(w.date) < to));
  if (period === 'week') {
    // 7 derniers jours glissants (aujourd'hui compris) : jamais vide un lundi matin
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - 6);
    return { workouts: between(from, null), desc: 'Les 7 derniers jours' };
  }
  if (period === 'lastweek') {
    const to = startOfWeek(new Date());
    const from = new Date(to);
    from.setDate(from.getDate() - 7);
    const sunday = new Date(to - 1);
    return { workouts: between(from, to), desc: `Du ${fmtDate(from.toISOString())} au ${fmtDate(sunday.toISOString())}` };
  }
  if (period === 'month') {
    const from = new Date();
    from.setHours(0, 0, 0, 0);
    from.setDate(from.getDate() - 29);
    return { workouts: between(from, null), desc: 'Les 30 derniers jours' };
  }
  // Dernier cycle : les N dernières séances du programme actuel (N = nombre de séances du cycle)
  const lastTpl = state.workouts.length && state.templates.find((t) => t.id === state.workouts[0].templateId);
  const program = state.programs.find((p) => p.id === (state.activeProgram || (lastTpl && lastTpl.programId)));
  const tpls = program ? programTemplates(program.id) : [];
  if (!tpls.length) return { workouts: [], desc: 'Choisis d\'abord un programme dans l\'onglet Séance.' };
  const ids = new Set(tpls.map((t) => t.id));
  const workouts = state.workouts.filter((w) => ids.has(w.templateId)).slice(0, tpls.length);
  return { workouts, desc: `Les ${tpls.length} dernières séances de ${esc(program.name)} (${tpls.map((t) => esc(t.name)).join(' → ')})` };
}

// Séries directes (muscle principal) et indirectes (muscle secondaire) par muscle
function computeVolume(workouts) {
  const vol = {};
  const unknown = new Set();
  for (const w of workouts) {
    for (const ex of w.exercises) {
      const muscles = exerciseMuscles(ex.name);
      if (!muscles || !(muscles.primary.length + muscles.secondary.length)) { unknown.add(ex.name); continue; }
      const { primary, secondary } = muscles;
      for (const m of primary) (vol[m] ||= { direct: 0, indirect: 0 }).direct += ex.sets.length;
      for (const m of secondary) (vol[m] ||= { direct: 0, indirect: 0 }).indirect += ex.sets.length;
    }
  }
  return { vol, unknown };
}

function viewVolume() {
  const seg = Object.entries(VOLUME_PERIODS).map(([id, label]) =>
    `<button class="${id === state.volumePeriod ? 'on' : ''}" data-action="vol-period" data-id="${id}">${label}</button>`).join('');
  const { workouts, desc } = volumeWorkouts(state.volumePeriod);
  const head = `
    <h1>Volume</h1>
    <div class="seg four">${seg}</div>
    <p class="muted small">${desc} · ${workouts.length} séance(s)</p>`;

  if (!workouts.length) {
    return `${head}<div class="empty"><div class="big">💪</div><p>Aucune séance sur cette période.</p></div>`;
  }

  const { vol, unknown } = computeVolume(workouts);
  const muscles = Object.keys(MUSCLE_LABELS);
  const get = (m) => vol[m] || { direct: 0, indirect: 0 };
  const score = (m) => get(m).direct + get(m).indirect / 2;
  const maxScore = Math.max(...muscles.map(score)) || 1;
  const maxBar = Math.max(...muscles.map((m) => get(m).direct + get(m).indirect)) || 1;
  const intensity = Object.fromEntries(muscles.map((m) => [m, score(m) / maxScore]));

  const rows = muscles.slice().sort((a, b) => score(b) - score(a)).map((m) => {
    const { direct, indirect } = get(m);
    return `
      <div class="vol-row ${direct + indirect ? '' : 'zero'}">
        <div class="vol-top">
          <span class="vol-name">${MUSCLE_LABELS[m]}</span>
          <span><strong class="vol-num">${direct}</strong> série${direct > 1 ? 's' : ''}${indirect ? ` <span class="muted small">+ ${indirect} indirecte${indirect > 1 ? 's' : ''}</span>` : ''}</span>
        </div>
        <div class="vol-bar">
          <span class="vb-direct" style="width:${(direct / maxBar) * 100}%"></span><span class="vb-indirect" style="width:${(indirect / maxBar) * 100}%"></span>
        </div>
      </div>`;
  }).join('');

  return `
    ${head}
    <section class="card">
      <div class="sheet-maps">
        <figure>${bodyHeatSVG('front', intensity)}<figcaption>Devant</figcaption></figure>
        <figure>${bodyHeatSVG('back', intensity)}<figcaption>Derrière</figcaption></figure>
      </div>
      <p class="muted small" style="text-align:center">Plus c'est rouge, plus le muscle a travaillé</p>
    </section>
    <section class="card">${rows}</section>
    <p class="legend small"><i class="dot mp"></i><span><strong>Séries</strong> : le muscle est le principal de l'exercice</span></p>
    <p class="legend small"><i class="dot ms"></i><span><strong>Indirectes</strong> : il travaille en soutien (ex : triceps au développé couché)</span></p>
    <p class="muted small">Repère courant pour progresser : environ 10 à 20 séries par muscle et par semaine.</p>
    ${unknown.size ? `
      <h3>Non comptés</h3>
      <p class="muted small">Ces exercices perso n'ont pas encore de muscles. Touche-les pour les choisir :</p>
      <div class="chips-wrap">${[...unknown].map((n) => `<button class="chip" data-action="define-muscles" data-name="${esc(n)}">${esc(n)} ›</button>`).join('')}</div>` : ''}`;
}

/* ---------- Réglages ---------- */
/* ---------- Préférences (Réglages) ---------- */
const PREF_SWITCHES = [
  ['feelings', '🟢🟡🔴 Ressenti des séries', 'Les 3 pastilles sur chaque série, et les conseils 💡 à la séance suivante.'],
  ['autoRest', '⏱ Chrono de repos automatique', 'Se lance tout seul quand tu valides une série.'],
  ['restSound', '🔔 Bip de fin de repos', 'Sonne à la fin du chrono de repos (coupe le mode silencieux pour l\'entendre).'],
  ['sessionTimer', '⏱ Chrono de la séance', 'Le temps écoulé depuis le début, dans le bandeau du haut.'],
  ['autoCollapse', '↕️ Replier les exos terminés', 'Un exercice fini se replie et l\'écran passe tout seul au suivant.'],
];
const REST_CHOICES = [60, 90, 120, 150, 180];
const STEP_CHOICES = [1, 1.25, 2, 2.5, 5];

function viewPrefs() {
  const p = state.prefs;
  const switches = PREF_SWITCHES.map(([key, label, desc]) => `
    <button class="pref-row" data-action="toggle-pref" data-key="${key}" role="switch" aria-checked="${!!p[key]}">
      <span class="pref-text"><strong>${label}</strong><span class="muted small">${desc}</span></span>
      <span class="switch ${p[key] ? 'on' : ''}"><span></span></span>
    </button>`).join('');
  const chips = (key, values, fmt) => values.map((v) =>
    `<button class="chip ${p[key] === v ? 'on' : ''}" data-action="set-pref" data-key="${key}" data-value="${v}">${fmt(v)}</button>`).join('');
  return `
    <h3>Préférences</h3>
    <section class="card prefs">${switches}</section>
    <section class="card">
      <strong>Repos par défaut</strong>
      <p class="muted small">Pour les exercices où tu n'as pas réglé de temps de repos.</p>
      <div class="chips-wrap">${chips('defaultRest', REST_CHOICES, fmtClock)}</div>
      <strong>Pas des boutons − / + du poids</strong>
      <p class="muted small">De combien le poids change à chaque toucher.</p>
      <div class="chips-wrap">${chips('weightStep', STEP_CHOICES, (v) => `${fmtNum(v)} kg`)}</div>
    </section>`;
}

async function savePrefs() {
  await dbPut('meta', { key: 'prefs', value: state.prefs });
  render();
}

function viewSettings() {
  return `
    <h1>Réglages</h1>
    <p class="muted small">Pour gérer tes programmes et séances : onglet Séance → choisis un programme → « Modifier ce programme ».</p>

    ${viewPrefs()}

    <h3>Sauvegarde</h3>
    <section class="card">
      <p class="small">Tes données sont uniquement sur ce téléphone. Exporte-les de temps en temps (dans Fichiers ou iCloud) pour ne rien perdre.</p>
      <p class="muted small">Dernier export : ${state.lastExport ? fmtDate(state.lastExport) : 'jamais'}</p>
      <button class="btn btn-primary" data-action="export">Exporter mes données (JSON)</button>
      <label class="btn btn-secondary" for="import-file">Importer une sauvegarde</label>
      <input class="file-input" id="import-file" type="file" accept="application/json,.json">
    </section>
    <p class="muted small" style="text-align:center">${state.workouts.length} séance(s) enregistrée(s)</p>`;
}

/* =====================================================================
   Actions
   ===================================================================== */
async function startWorkout(template) {
  const exercises = template ? template.exercises : [];
  const program = template && state.programs.find((p) => p.id === template.programId);
  state.draft = {
    programName: program ? program.name : null,
    templateId: template ? template.id : null,
    templateName: template ? template.name : 'Séance libre',
    startedAt: new Date().toISOString(),
    // links[k] = l'exercice k est en superset avec le suivant (réglé dans le modèle de séance)
    exercises: exercises.map((name, k) => ({ name, sets: initialSets(name), ...(template && template.links && template.links[k] && k < exercises.length - 1 ? { linkNext: true } : {}) })),
  };
  await saveDraft();
  render();
  scrollTo(0, 0);
  keepScreenOn();
}

async function finishWorkout() {
  const d = state.draft;
  const exercises = d.exercises
    .map((e) => ({
      name: e.name,
      ...(e.brand ? { brand: e.brand } : {}), // marque de la machine (suivi séparé)
      ...(e.linkNext ? { linkNext: true } : {}), // en superset avec l'exercice suivant
      ...(e.replaces ? { replaces: e.replaces } : {}), // exercice remplacé ce jour-là (pour l'historique)
      sets: e.sets.filter((s) => s.done).map((s) => ({ reps: s.reps, weight: s.weight, ...(s.feel ? { feel: s.feel } : {}) })),
    }))
    .filter((e) => e.sets.length);
  const count = exercises.reduce((a, e) => a + e.sets.length, 0);

  if (!count) {
    if (await askConfirm('Aucune série cochée ✓', 'Abandonner la séance sans rien enregistrer ?', 'Abandonner', true)) await discardWorkout();
    return;
  }
  // Séries pas cochées : on prévient avant, pour ne rien perdre par oubli
  const pending = d.exercises
    .map((e) => ({ name: e.name, n: e.sets.filter((s) => !s.done).length }))
    .filter((e) => e.n);
  if (pending.length) {
    const nPending = pending.reduce((a, e) => a + e.n, 0);
    const list = pending.map((e) => `• ${e.name} : ${e.n} série${e.n > 1 ? 's' : ''}`).join('\n');
    const ok = await openDialog({
      title: `${nPending} série${nPending > 1 ? 's' : ''} pas cochée${nPending > 1 ? 's' : ''}`,
      message: `Elles ne seront pas enregistrées :\n${list}\n\nSi tu les as faites, reviens les cocher ✓.`,
      okLabel: 'Terminer quand même',
      cancelLabel: 'Revenir',
    });
    if (!ok) {
      const p = nextSetPosition(d);
      if (p) document.querySelector(`.exercise[data-ex="${p.i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
  } else if (!(await askConfirm('Terminer la séance ?', `${count} série(s) seront enregistrées. Bravo 💪`, 'Terminer'))) return;

  // Terminée le jour même : date = maintenant. Oubliée et terminée un autre jour : on garde le jour du début.
  const now = new Date();
  const sameDay = localDay(now) === localDay(new Date(d.startedAt));
  const workout = {
    id: uid(),
    date: sameDay ? now.toISOString() : d.startedAt,
    startedAt: d.startedAt,
    endedAt: sameDay ? now.toISOString() : null, // fin inconnue si la séance a été terminée plus tard
    programName: d.programName || null,
    templateId: d.templateId,
    templateName: d.templateName,
    exercises,
  };
  await dbPut('workouts', workout);
  state.workouts = [...state.workouts, workout].sort((a, b) => b.date.localeCompare(a.date));
  hideRest();
  state.draft = null;
  await saveDraft();
  render();
  scrollTo(0, 0);
  showRecap(workout);
  if (!sameDay) toast(`Enregistrée le ${fmtDate(workout.date)}, le jour où tu l'as commencée`);
}

/* ---------- Bilan de séance : évolution par rapport à la dernière fois ---------- */
// Meilleure série d'une liste : force estimée (poids × reps) si chargée, sinon nombre de reps
function bestOf(sets) {
  const weighted = sets.some((s) => s.weight > 0);
  let best = null;
  let value = 0;
  for (const s of sets) {
    const v = weighted ? estimatedMax(s) : s.reps;
    if (v > value) { value = v; best = s; }
  }
  return { weighted, value, set: best };
}

const tonnageOf = (w) => w.exercises.reduce((a, e) => a + e.sets.reduce((b, s) => b + s.reps * s.weight, 0), 0);
const setsOf = (w) => w.exercises.reduce((a, e) => a + e.sets.length, 0);

// before = séances plus anciennes que celle-ci, de la plus récente à la plus ancienne
function buildRecap(workout, before) {
  const exercises = workout.exercises.filter((e) => e.sets.length).map((ex) => {
    const key = exPerfKey(ex);
    const now = bestOf(ex.sets);
    const previous = before.flatMap((w) => w.exercises.filter((x) => exPerfKey(x) === key && x.sets.length));
    const prev = previous[0] ? bestOf(previous[0].sets) : null;
    const comparable = prev && prev.weighted === now.weighted && prev.value > 0;
    const bestEver = Math.max(0, ...previous.map((x) => bestOf(x.sets)).filter((b) => b.weighted === now.weighted).map((b) => b.value));
    return {
      label: variantLabel(ex.name, ex.brand),
      pct: comparable ? (now.value - prev.value) / prev.value : null,
      best: now.set,
      prevBest: comparable ? prev.set : null,
      isNew: !previous.length,
      record: previous.length > 0 && now.value > bestEver + 1e-9,
    };
  });
  const compared = exercises.filter((r) => r.pct !== null);
  const sameSession = workout.templateId ? before.find((w) => w.templateId === workout.templateId) : null;
  const minutes = workout.endedAt && workout.startedAt ? Math.round((new Date(workout.endedAt) - new Date(workout.startedAt)) / 60000) : null;
  return {
    exercises,
    avg: compared.length ? compared.reduce((a, r) => a + r.pct, 0) / compared.length : null,
    compared: compared.length,
    records: exercises.filter((r) => r.record).length,
    sets: setsOf(workout),
    reps: workout.exercises.reduce((a, e) => a + e.sets.reduce((b, s) => b + s.reps, 0), 0),
    tonnage: tonnageOf(workout),
    prevTonnage: sameSession ? tonnageOf(sameSession) : null,
    prevDate: sameSession ? sameSession.date : null,
    minutes: minutes !== null && minutes > 0 && minutes < 600 ? minutes : null,
  };
}

function showRecap(workout) {
  const before = state.workouts.filter((w) => w.id !== workout.id && w.date < workout.date);
  const r = buildRecap(workout, before);
  const cls = (x) => (x > 0.0005 ? 'up' : x < -0.0005 ? 'down' : '');
  const fmtDuration = (m) => (m >= 60 ? `${Math.floor(m / 60)} h ${pad2(m % 60)}` : `${m} min`);
  const tonnagePct = r.prevTonnage ? (r.tonnage - r.prevTonnage) / r.prevTonnage : null;

  const hero = r.avg !== null ? `
    <section class="card global-hero">
      <span class="stat-label">Évolution par rapport à la dernière fois</span>
      <span class="global-pct ${cls(r.avg)}">${fmtPct(r.avg)}</span>
      <span class="muted small">moyenne sur ${r.compared} exercice${r.compared > 1 ? 's' : ''}${r.records ? ` · 🏆 ${r.records} record${r.records > 1 ? 's' : ''}` : ''}</span>
    </section>` : `
    <section class="card global-hero">
      <span class="global-pct">🎉</span>
      <span class="muted small">Première fois sur ces exercices : à la prochaine séance, tu verras ton évolution ici.</span>
    </section>`;

  const rows = r.exercises.map((e) => `
    <div class="recap-row">
      <div class="recap-top">
        <span class="recap-name">${esc(e.label)}${e.record ? ' <span class="badge">🏆 Record</span>' : ''}</span>
        <strong class="${e.pct !== null ? cls(e.pct) : ''}">${e.pct !== null ? fmtPct(e.pct) : e.isNew ? 'nouveau' : '–'}</strong>
      </div>
      ${e.best ? `<span class="muted small">Meilleure série : <b>${esc(fmtSet(e.best))}</b>${e.prevBest ? ` · avant : ${esc(fmtSet(e.prevBest))}` : ''}</span>` : ''}
    </div>`).join('');

  $sheet.querySelector('.sheet-body').innerHTML = `
    <div class="sheet-head">
      <div><h2>${esc(workout.templateName)} 💪</h2><span class="muted small">${fmtDate(workout.date)}${workout.programName ? ' · ' + esc(workout.programName) : ''}</span></div>
      <button class="icon-btn" data-sheet="close" aria-label="Fermer">✕</button>
    </div>
    ${hero}
    <div class="stats recap-stats">
      ${r.minutes !== null ? `<div class="stat"><div class="stat-value">${fmtDuration(r.minutes)}</div><div class="stat-label">Durée</div></div>` : ''}
      <div class="stat"><div class="stat-value">${r.sets}</div><div class="stat-label">Séries · ${r.reps} reps</div></div>
      <div class="stat"><div class="stat-value">${Math.round(r.tonnage).toLocaleString('fr-FR')}<span class="small"> kg</span></div>
        <div class="stat-label">Tonnage${tonnagePct !== null ? ` <span class="${cls(tonnagePct)}">${fmtPct(tonnagePct)}</span>` : ''}</div></div>
    </div>
    ${r.prevDate ? `<p class="muted small">Tonnage comparé à ta séance ${esc(workout.templateName)} du ${fmtDate(r.prevDate)}</p>` : ''}
    <h3>Par exercice</h3>
    <section class="card">${rows}</section>
    <p class="muted small">Évolution = ta meilleure série comparée à la dernière fois sur le même exercice (et la même machine), poids et reps combinés.</p>
    <button class="btn btn-primary" data-sheet="close">Fermer</button>`;
  $sheet.hidden = false;
}

async function discardWorkout() {
  hideRest();
  state.draft = null;
  await saveDraft();
  render();
  scrollTo(0, 0);
}

async function exportData() {
  const data = {
    app: 'muscu',
    version: 2,
    exportedAt: new Date().toISOString(),
    programs: state.programs,
    templates: state.templates,
    workouts: state.workouts,
    custom: Object.values(state.custom),
    bodyweight: state.bodyweight,
    restTimes: state.restTimes,
    notes: state.notes,
    brands: state.brands,
    prefs: state.prefs,
  };
  const name = `muscu-${new Date().toISOString().slice(0, 10)}.json`;
  const file = new File([JSON.stringify(data, null, 2)], name, { type: 'application/json' });

  // Sur iPhone : la feuille de partage permet "Enregistrer dans Fichiers"
  if (navigator.maxTouchPoints > 0 && navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return markExported();
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  markExported();
}

async function markExported() {
  state.lastExport = new Date().toISOString();
  await dbPut('meta', { key: 'lastExport', value: state.lastExport });
  render();
  toast('Export terminé ✅');
}

function isValidBackup(data) {
  const okSet = (s) => s && Number.isFinite(s.reps) && Number.isFinite(s.weight);
  const okEx = (e) => e && typeof e.name === 'string' && Array.isArray(e.sets) && e.sets.every(okSet);
  return data && Array.isArray(data.templates) && Array.isArray(data.workouts)
    && (data.programs === undefined || (Array.isArray(data.programs) && data.programs.every((p) => p && p.id && typeof p.name === 'string')))
    && (data.bodyweight === undefined || (Array.isArray(data.bodyweight)
      && data.bodyweight.every((b) => b && /^\d{4}-\d{2}-\d{2}$/.test(b.date) && Number.isFinite(b.weight))))
    && (data.restTimes === undefined || (data.restTimes && typeof data.restTimes === 'object'))
    && (data.notes === undefined || (data.notes && typeof data.notes === 'object'))
    && (data.brands === undefined || (Array.isArray(data.brands) && data.brands.every((b) => typeof b === 'string')))
    && (data.prefs === undefined || (data.prefs && typeof data.prefs === 'object'))
    && (data.custom === undefined || (Array.isArray(data.custom) && data.custom.every((c) => c && typeof c.key === 'string'
      && typeof c.name === 'string' && Array.isArray(c.primary) && Array.isArray(c.secondary))))
    && data.templates.every((t) => t && t.id && typeof t.name === 'string' && Array.isArray(t.exercises))
    && data.workouts.every((w) => w && w.id && typeof w.date === 'string' && Array.isArray(w.exercises) && w.exercises.every(okEx));
}

async function importData(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return showMessage('Import impossible', 'Ce fichier n\'est pas un JSON valide.');
  }
  if (!isValidBackup(data)) {
    return showMessage('Import impossible', 'Ce fichier ne ressemble pas à une sauvegarde de l\'app Muscu.');
  }
  const programs = data.programs || [];
  const msg = `${data.workouts.length} séance(s) faite(s), ${programs.length} programme(s).\n\n`
    + 'Les données sont fusionnées : rien n\'est supprimé, les éléments déjà présents sont mis à jour.';
  if (!(await askConfirm('Importer cette sauvegarde ?', msg, 'Importer'))) return;

  const tx = db.transaction(['programs', 'templates', 'workouts', 'custom', 'bodyweight', 'meta'], 'readwrite');
  programs.forEach((p) => tx.objectStore('programs').put(p));
  (data.custom || []).forEach((c) => tx.objectStore('custom').put(c));
  (data.bodyweight || []).forEach((b) => tx.objectStore('bodyweight').put(b));
  if (data.restTimes) tx.objectStore('meta').put({ key: 'restTimes', value: { ...state.restTimes, ...data.restTimes } });
  if (data.notes) tx.objectStore('meta').put({ key: 'notes', value: { ...state.notes, ...data.notes } });
  if (data.brands) tx.objectStore('meta').put({ key: 'brands', value: [...new Set([...state.brands, ...data.brands])] });
  if (data.prefs) tx.objectStore('meta').put({ key: 'prefs', value: { ...state.prefs, ...data.prefs } });
  data.templates.forEach((t) => tx.objectStore('templates').put(t));
  data.workouts.forEach((w) => tx.objectStore('workouts').put(w));
  await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });

  await adoptOrphanTemplates();
  await loadAll();
  render();
  toast('Import terminé ✅');
}

function go(route) {
  state.route = route;
  render();
  scrollTo(0, 0);
}

async function createProgram() {
  const name = (await askText('Nom du programme', '', 'Créer') || '').trim();
  if (!name) return;
  const program = { id: uid(), name, createdAt: new Date().toISOString() };
  await dbPut('programs', program);
  state.programs.push(program);
  await setActiveProgram(program.id);
  go({ name: 'editProgram', id: program.id });
  toast('Programme créé');
}

async function renameProgram(id, value) {
  const name = value.trim();
  const p = state.programs.find((x) => x.id === id);
  if (!p || !name || name === p.name) return;
  p.name = name;
  await dbPut('programs', p);
  toast('Nom enregistré');
}

async function deleteProgram(id) {
  const p = state.programs.find((x) => x.id === id);
  if (!(await askConfirm('Supprimer le programme ?', `« ${p.name} » et ses séances seront supprimés.\nTon historique et tes courbes sont conservés.`, 'Supprimer', true))) return;
  for (const t of programTemplates(id)) await dbDel('templates', t.id);
  await dbDel('programs', id);
  state.templates = state.templates.filter((t) => t.programId !== id);
  state.programs = state.programs.filter((x) => x.id !== id);
  if (state.activeProgram === id) await setActiveProgram(null);
  go({ name: 'programs' });
}

async function saveTemplate() {
  const r = state.route;
  const name = r.tplName.trim();
  const exercises = r.exercises;
  if (!name) return showMessage('Il manque le nom', 'Donne un nom à la séance.');
  if (!exercises.length) return showMessage('Aucun exercice', 'Ajoute au moins un exercice à la séance.');

  const existing = state.templates.find((t) => t.id === r.id);
  const fresh = { id: uid(), programId: r.programId, order: programTemplates(r.programId).length, createdAt: new Date().toISOString() };
  const links = exercises.map((_, i) => !!(r.links && r.links[i]) && i < exercises.length - 1);
  const t = { ...(existing || fresh), name, exercises, links };
  await dbPut('templates', t);
  if (existing) Object.assign(existing, t);
  else state.templates.push(t);
  go({ name: 'editProgram', id: r.programId });
  toast('Séance enregistrée');
}

// Monte (dir = -1) ou descend (dir = 1) une séance dans l'ordre du cycle
async function moveTemplate(id, dir) {
  const t = state.templates.find((x) => x.id === id);
  const tpls = programTemplates(t.programId);
  const i = tpls.indexOf(t), j = i + dir;
  if (j < 0 || j >= tpls.length) return;
  [tpls[i], tpls[j]] = [tpls[j], tpls[i]];
  for (const [k, x] of tpls.entries()) {
    x.order = k;
    await dbPut('templates', x);
  }
  render();
}

/* =====================================================================
   Recherche d'exercices (bibliothèque + exercices perso déjà utilisés)
   ===================================================================== */
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const LIBRARY = EXERCISE_GROUPS.flatMap((g) => g.items.map((item) => {
  const [name, aliases = ''] = item.split('|');
  return { name, group: g.id, groupLabel: g.label, nameN: norm(name), hay: norm(`${name} ${aliases} ${g.label} ${g.keywords}`) };
}));
const findExercise = (name) => LIBRARY.find((e) => e.nameN === norm(name.trim())) || null;

// Muscles d'un exercice : bibliothèque, ou choisis à la main pour un exercice perso (null si inconnus)
// Muscles choisis à la main (exercice perso, ou correction d'un exercice de la bibliothèque) en priorité
function exerciseMuscles(name) {
  const c = state.custom[norm(name.trim())];
  if (c) return { primary: c.primary, secondary: c.secondary };
  const e = findExercise(name);
  return e ? musclesFor(e.group, e.nameN) : null;
}

function allExercises() {
  const known = new Set(LIBRARY.map((e) => e.nameN));
  const custom = new Map();
  for (const c of Object.values(state.custom)) {
    if (!known.has(c.key)) custom.set(c.key, { name: c.name, group: 'perso', groupLabel: 'Perso', nameN: c.key, hay: c.key });
  }
  const used = [...state.templates.flatMap((t) => t.exercises), ...state.workouts.flatMap((w) => w.exercises.map((e) => e.name))];
  for (const raw of used) {
    const name = raw.trim(), k = norm(name);
    if (!known.has(k) && !custom.has(k)) custom.set(k, { name, group: 'perso', groupLabel: 'Perso', nameN: k, hay: k });
  }
  return [...custom.values(), ...LIBRARY];
}

// Tous les mots tapés doivent être trouvés ; les noms qui commencent par la recherche passent devant
function searchExercises(query, group) {
  const q = norm(query.trim());
  const tokens = q.split(/\s+/).filter(Boolean);
  const list = allExercises().filter((e) => (!group || e.group === group) && tokens.every((t) => e.hay.includes(t)));
  if (!tokens.length) return list;
  const score = (e) => (e.nameN.startsWith(q) ? 0
    : e.nameN.split(/[\s(-]+/).some((w) => w.startsWith(tokens[0])) ? 1
    : e.nameN.includes(tokens[0]) ? 2 : 3);
  return list
    .map((e) => [score(e), e])
    .sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name, 'fr'))
    .map((x) => x[1]);
}

const picker = { query: '', group: '', selected: [], onDone: null, single: false };
const $picker = document.getElementById('picker');
const $pkSearch = $picker.querySelector('.picker-search');

// options.single : un seul toucher choisit l'exercice (pour « Remplacer »)
// options.title / options.group : titre de l'écran et muscle pré-sélectionné
function openPicker(onDone, options = {}) {
  Object.assign(picker, { query: '', group: options.group || '', selected: [], onDone, single: !!options.single });
  $picker.querySelector('.picker-head strong').textContent = options.title || 'Ajouter des exercices';
  $picker.querySelector('.picker-foot').hidden = picker.single;
  $pkSearch.value = '';
  $picker.hidden = false;
  document.body.style.overflow = 'hidden';
  renderPicker();
  // Pas de clavier automatique : il cacherait la liste. Il s'ouvre si on touche la barre de recherche.
  $picker.querySelector('.picker-list').scrollTop = 0;
}

function closePicker() {
  $picker.hidden = true;
  document.body.style.overflow = '';
}

function renderPicker() {
  const groups = [{ id: '', label: 'Tous' }, ...EXERCISE_GROUPS];
  if (allExercises().some((e) => e.group === 'perso')) groups.push({ id: 'perso', label: 'Perso' });
  $picker.querySelector('.chips').innerHTML = groups.map((g) =>
    `<button class="chip ${g.id === picker.group ? 'on' : ''}" data-pk="group" data-id="${g.id}">${esc(g.label)}</button>`).join('');

  const results = searchExercises(picker.query, picker.group);
  const typed = picker.query.trim();
  const exact = results.some((e) => e.nameN === norm(typed));
  const create = typed && !exact
    ? `<div class="pk-row"><button class="pk-main create" data-pk="create" data-name="${esc(typed)}"><span class="pk-check">+</span><span class="pk-name">Créer « ${esc(typed)} »<span class="pk-group">Exercice perso : tu choisis ses muscles</span></span></button></div>`
    : '';
  const rows = results.slice(0, 150).map((e) => `
    <div class="pk-row ${picker.selected.includes(e.name) ? 'on' : ''}">
      <button class="pk-main" data-pk="toggle" data-name="${esc(e.name)}">
        <span class="pk-check">✓</span>
        <span class="pk-name">${esc(e.name)}<span class="pk-group">${esc(e.groupLabel)}</span></span>
      </button>
      <button class="pk-info" data-pk="info" data-name="${esc(e.name)}" aria-label="Voir la fiche">i</button>
    </div>`).join('');
  $picker.querySelector('.picker-list').innerHTML = rows + create
    + (!rows && !create ? '<p class="muted" style="text-align:center;padding:30px 0">Aucun exercice trouvé</p>' : '');

  const done = $picker.querySelector('[data-pk=done]');
  const n = picker.selected.length;
  done.disabled = !n;
  done.textContent = n ? `Ajouter ${n} exercice${n > 1 ? 's' : ''}` : 'Touche un exercice pour le choisir';
}

$pkSearch.addEventListener('input', () => {
  picker.query = $pkSearch.value;
  renderPicker();
  $picker.querySelector('.picker-list').scrollTop = 0;
});

$picker.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-pk]');
  if (!btn) return;
  switch (btn.dataset.pk) {
    case 'cancel':
      return closePicker();
    case 'group':
      picker.group = btn.dataset.id;
      renderPicker();
      $picker.querySelector('.picker-list').scrollTop = 0;
      return;
    case 'toggle': {
      const name = btn.dataset.name;
      if (picker.single) {
        closePicker();
        return picker.onDone([name]);
      }
      const i = picker.selected.indexOf(name);
      if (i >= 0) picker.selected.splice(i, 1);
      else picker.selected.push(name);
      return renderPicker();
    }
    case 'create':
      return openMuscleEditor(btn.dataset.name, true, (name) => {
        if (picker.single) {
          closePicker();
          return picker.onDone([name]);
        }
        if (!picker.selected.includes(name)) picker.selected.push(name);
        // On vide la recherche pour pouvoir en chercher un autre
        picker.query = '';
        $pkSearch.value = '';
        renderPicker();
      });
    case 'info':
      return openSheet(btn.dataset.name);
    case 'done': {
      const names = picker.selected.slice();
      closePicker();
      return picker.onDone(names);
    }
  }
});

/* =====================================================================
   Fiche exercice : muscles travaillés
   ===================================================================== */
const $sheet = document.getElementById('sheet');

const muscleLabels = (list) => list.map((m) => MUSCLE_LABELS[m]).join(', ');

/* ---------- Marque de la machine (Hammer, Technogym…) ---------- */
const DEFAULT_BRANDS = ['Hammer Strength', 'Matrix', 'Technogym', 'Gym80', 'Life Fitness', 'Panatta', 'Cybex', 'Precor', 'Nautilus', 'Star Trac', 'Eleiko', 'Prime'];
let brandPick = { current: null, onPick: null };

// Toutes les marques proposées : la liste de base + celles que tu as ajoutées ou déjà utilisées
function allBrands() {
  const used = state.workouts.flatMap((w) => w.exercises.map((e) => e.brand)).filter(Boolean);
  const seen = new Map();
  for (const b of [...DEFAULT_BRANDS, ...(state.brands || []), ...used]) if (!seen.has(norm(b))) seen.set(norm(b), b);
  return [...seen.values()];
}

function openBrandSheet(current, onPick) {
  brandPick = { current: current || null, onPick };
  const opt = (brand, label) => `
    <button class="brand-opt ${(brand || null) === (current || null) ? 'on' : ''}" data-sheet="brand-pick" data-brand="${esc(brand || '')}">
      <span class="pk-check">✓</span><span>${label}</span>
    </button>`;
  $sheet.querySelector('.sheet-body').innerHTML = `
    <div class="sheet-head">
      <div><h2>Quelle machine ?</h2><span class="muted small">Chaque machine a son propre suivi de perfs</span></div>
      <button class="icon-btn" data-sheet="close" aria-label="Fermer">✕</button>
    </div>
    ${opt(null, '<strong>Par défaut</strong> <span class="muted small">· ta machine habituelle</span>')}
    ${allBrands().map((b) => opt(b, esc(b))).join('')}
    <button class="btn btn-ghost" data-sheet="brand-other">+ Autre marque…</button>`;
  $sheet.hidden = false;
}

async function addOtherBrand() {
  const name = (await askText('Nom de la marque ou de la machine', '', 'Ajouter') || '').trim();
  if (!name) return;
  const known = allBrands().find((b) => norm(b) === norm(name));
  const brand = known || name;
  if (!known) {
    state.brands = [...(state.brands || []), brand];
    await dbPut('meta', { key: 'brands', value: state.brands });
  }
  closeSheet();
  brandPick.onPick(brand);
}

/* ---------- Note par exercice (réglage de la machine, sensation…) ---------- */
// Une note par exercice ET par machine : le réglage du siège n'est pas le même d'une marque à l'autre
const noteFor = (name, brand = null) => state.notes[perfKey(name, brand)] || '';

async function editNote(name, brand = null) {
  const text = await openDialog({
    title: `Note : ${variantLabel(name, brand)}`,
    message: brand ? `Elle s'affichera quand tu fais cet exercice sur la machine ${brand}.` : 'Elle s\'affichera sur cet exercice à chaque séance.',
    input: noteFor(name, brand),
    multiline: true,
    placeholder: 'ex : siège cran 4, poignées position 2',
    okLabel: 'Enregistrer',
  });
  if (text === null) return false;
  if (text) state.notes[perfKey(name, brand)] = text;
  else delete state.notes[perfKey(name, brand)];
  await dbPut('meta', { key: 'notes', value: state.notes });
  toast(text ? 'Note enregistrée 📝' : 'Note supprimée');
  return true;
}

function openSheet(name) {
  const e = findExercise(name);
  const muscles = exerciseMuscles(name);
  const hasMuscles = muscles && muscles.primary.length + muscles.secondary.length > 0;

  const map = hasMuscles ? `
    <div class="sheet-maps">
      <figure>${bodySVG('front', muscles.primary, muscles.secondary)}<figcaption>Devant</figcaption></figure>
      <figure>${bodySVG('back', muscles.primary, muscles.secondary)}<figcaption>Derrière</figcaption></figure>
    </div>
    ${muscles.primary.length ? `<p class="legend"><i class="dot mp"></i><span><strong>Principal :</strong> ${muscleLabels(muscles.primary)}</span></p>` : ''}
    ${muscles.secondary.length ? `<p class="legend"><i class="dot ms"></i><span><strong>Secondaire :</strong> ${muscleLabels(muscles.secondary)}</span></p>` : ''}`
    : '<p class="muted">Pas encore de muscles pour cet exercice perso : il n\'est pas compté dans le Volume.</p>';

  $sheet.querySelector('.sheet-body').innerHTML = `
    <div class="sheet-head">
      <div><h2>${esc(name)}</h2><span class="muted small">${e ? esc(e.groupLabel) : 'Exercice perso'}</span></div>
      <button class="icon-btn" data-sheet="close" aria-label="Fermer">✕</button>
    </div>
    ${map}
    ${noteFor(name) ? `<p class="ex-note static">📝 ${esc(noteFor(name))}</p>` : ''}
    <button class="btn btn-secondary" data-sheet="edit-note" data-name="${esc(name)}">📝 ${noteFor(name) ? 'Modifier la note' : 'Ajouter une note'}</button>
    <button class="btn btn-secondary" data-sheet="edit-muscles" data-name="${esc(name)}">✏️ ${hasMuscles ? 'Modifier' : 'Choisir'} les muscles</button>
    ${e && state.custom[e.nameN] ? `
      <p class="muted small" style="text-align:center">Muscles modifiés par toi.</p>
      <button class="btn btn-ghost" data-sheet="reset-muscles" data-name="${esc(name)}">↺ Remettre les muscles d'origine</button>` : ''}`;
  $sheet.hidden = false;
}

function closeSheet() {
  $sheet.hidden = true;
}

/* ---------- Éditeur de muscles d'un exercice perso ---------- */
// On choisit un « pinceau » (principal / secondaire) puis on touche les muscles sur le bonhomme ou dans la liste
const cx = { name: '', isNew: false, mode: 'primary', primary: [], secondary: [], onSave: null };

function openMuscleEditor(name, isNew, onSave) {
  // On part des muscles actuels : ceux déjà choisis, sinon ceux de la bibliothèque
  const current = exerciseMuscles(name) || { primary: [], secondary: [] };
  Object.assign(cx, {
    name: name.trim(), isNew, mode: 'primary', onSave,
    primary: [...current.primary],
    secondary: [...current.secondary],
  });
  $sheet.querySelector('.sheet-body').innerHTML = `
    <div class="sheet-head">
      <div><h2>${isNew ? 'Nouvel exercice' : 'Muscles de l\'exercice'}</h2>${isNew ? '' : `<span class="muted small">${esc(cx.name)}</span>`}</div>
      <button class="icon-btn" data-sheet="close" aria-label="Fermer">✕</button>
    </div>
    ${isNew ? `<label class="field"><span>Nom de l'exercice</span><input id="cx-name" value="${esc(cx.name)}" autocomplete="off"></label>` : ''}
    <p class="small">Choisis la couleur, puis touche les muscles sur le bonhomme ou dans la liste. Touche à nouveau pour enlever.</p>
    <div class="seg two cx-mode"></div>
    <div class="sheet-maps cx-maps"></div>
    <div class="chips-wrap cx-chips"></div>
    <button class="btn btn-primary" data-sheet="cx-save">${isNew ? 'Créer l\'exercice' : 'Enregistrer'}</button>`;
  renderMuscleEditor();
  $sheet.hidden = false;
}

function renderMuscleEditor() {
  const body = $sheet.querySelector('.sheet-body');
  const state_ = (m) => (cx.primary.includes(m) ? 'p' : cx.secondary.includes(m) ? 's' : '');
  body.querySelector('.cx-mode').innerHTML = `
    <button class="${cx.mode === 'primary' ? 'on' : ''}" data-sheet="cx-mode" data-mode="primary"><i class="dot mp"></i> Principal</button>
    <button class="${cx.mode === 'secondary' ? 'on' : ''}" data-sheet="cx-mode" data-mode="secondary"><i class="dot ms"></i> Secondaire</button>`;
  body.querySelector('.cx-maps').innerHTML = `
    <figure>${bodySVG('front', cx.primary, cx.secondary)}<figcaption>Devant</figcaption></figure>
    <figure>${bodySVG('back', cx.primary, cx.secondary)}<figcaption>Derrière</figcaption></figure>`;
  body.querySelector('.cx-chips').innerHTML = Object.entries(MUSCLE_LABELS).map(([m, label]) =>
    `<button class="chip ${state_(m)}" data-sheet="cx-muscle" data-m="${m}">${label}</button>`).join('');
}

function toggleMuscle(m) {
  const other = cx.mode === 'primary' ? 'secondary' : 'primary';
  cx[other] = cx[other].filter((x) => x !== m);
  const list = cx[cx.mode];
  cx[cx.mode] = list.includes(m) ? list.filter((x) => x !== m) : [...list, m];
  renderMuscleEditor();
}

async function saveMuscleEditor() {
  const input = document.getElementById('cx-name');
  const name = (input ? input.value : cx.name).trim();
  if (!name) return showMessage('Il manque le nom', 'Donne un nom à l\'exercice.');
  if (cx.isNew && findExercise(name)) {
    // Il existe déjà dans la bibliothèque : on le prend tel quel
    closeSheet();
    return cx.onSave(findExercise(name).name);
  }
  if (!cx.primary.length && !cx.secondary.length
    && !(await askConfirm('Aucun muscle choisi', 'Cet exercice ne sera pas compté dans le Volume. Continuer quand même ?', 'Continuer'))) return;
  const rec = { key: norm(name), name, primary: cx.primary, secondary: cx.secondary, createdAt: new Date().toISOString() };
  await dbPut('custom', rec);
  state.custom[rec.key] = rec;
  closeSheet();
  toast(cx.isNew ? 'Exercice créé' : 'Muscles enregistrés');
  cx.onSave(name);
}

$sheet.addEventListener('click', async (e) => {
  if (e.target === $sheet) return closeSheet();
  // Toucher une zone du bonhomme dans l'éditeur
  const zone = e.target.closest('.cx-maps path[data-m]');
  if (zone) return toggleMuscle(zone.dataset.m);
  const btn = e.target.closest('[data-sheet]');
  if (!btn) return;
  switch (btn.dataset.sheet) {
    case 'close':
      return closeSheet();
    case 'edit-muscles':
      return openMuscleEditor(btn.dataset.name, false, (name) => {
        render();
        openSheet(name); // on revient sur la fiche pour voir le résultat
      });
    case 'reset-muscles': {
      const name = btn.dataset.name;
      if (!(await askConfirm('Remettre les muscles d\'origine ?', `« ${name} » reprendra les muscles prévus par l'app.`, 'Remettre'))) return;
      await dbDel('custom', norm(name.trim()));
      delete state.custom[norm(name.trim())];
      render();
      openSheet(name);
      return toast('Muscles d\'origine remis');
    }
    case 'cx-mode':
      cx.mode = btn.dataset.mode;
      return renderMuscleEditor();
    case 'cx-muscle':
      return toggleMuscle(btn.dataset.m);
    case 'cx-save':
      return saveMuscleEditor();
    case 'rest-step':
      restEdit.value = Math.min(600, Math.max(15, restEdit.value + +btn.dataset.delta));
      return renderRestSheet();
    case 'rest-preset':
      restEdit.value = +btn.dataset.s;
      return renderRestSheet();
    case 'rest-save':
      return saveRestSheet();
    case 'brand-pick':
      closeSheet();
      return brandPick.onPick(btn.dataset.brand || null);
    case 'brand-other':
      return addOtherBrand();
    case 'edit-note':
      if (await editNote(btn.dataset.name)) {
        openSheet(btn.dataset.name);
        render();
      }
      return;
    case 'add-past-pick':
      return startPastWorkout(btn.dataset.day, btn.dataset.id);
  }
});

/* =====================================================================
   Minuteur de repos : démarre tout seul quand on coche une série
   ===================================================================== */
const DEFAULT_REST = 120; // secondes, si rien n'est réglé pour l'exercice (modifiable dans Réglages)
const REST_PRESETS = [30, 45, 60, 90, 120, 150, 180, 240, 300];
const restFor = (name) => state.restTimes[keyOf(name)] ?? state.prefs.defaultRest ?? DEFAULT_REST;
const fmtClock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const $rest = document.getElementById('rest');
let restTick = null;
let audioCtx = null;

// Sur iPhone, le son doit être « débloqué » pendant un toucher : on le fait quand on coche la série
function unlockAudio() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* pas de son, tant pis */ }
}

function beep() {
  if (!state.prefs.restSound) return;
  if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [[0, 880], [0.25, 880], [0.5, 1320]].forEach(([delay, freq]) => {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, t + delay);
    gain.gain.exponentialRampToValueAtTime(0.5, t + delay + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + delay + 0.2);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(t + delay);
    osc.stop(t + delay + 0.22);
  });
}

function startRest(exName) {
  const total = restFor(exName);
  state.draft.rest = { exName, total, endAt: Date.now() + total * 1000 };
  saveDraft();
  runRest();
}

function runRest() {
  clearInterval(restTick);
  if (!state.draft || !state.draft.rest) return hideRest();
  $rest.hidden = false;
  $rest.classList.remove('done');
  document.body.classList.add('resting');
  updateRest();
  restTick = setInterval(updateRest, 250);
}

function updateRest() {
  const r = state.draft && state.draft.rest;
  if (!r) return hideRest();
  const left = Math.max(0, Math.ceil((r.endAt - Date.now()) / 1000));
  if (left === 0) return finishRest(Date.now() - r.endAt < 5000);
  $rest.querySelector('.rest-label').textContent = `Repos · ${r.exName}`;
  $rest.querySelector('.rest-time').textContent = fmtClock(left);
  $rest.querySelector('.rest-fill').style.width = `${Math.min(100, (1 - left / r.total) * 100)}%`;
}

// withSound = false si le repos s'est terminé pendant que l'app était fermée
function finishRest(withSound) {
  clearInterval(restTick);
  delete state.draft.rest;
  saveDraft();
  if (withSound) beep();
  $rest.classList.add('done');
  $rest.querySelector('.rest-label').textContent = 'Repos terminé';
  $rest.querySelector('.rest-time').textContent = 'C\'est reparti ! 💪';
  $rest.querySelector('.rest-fill').style.width = '100%';
  setTimeout(() => { if (!state.draft || !state.draft.rest) hideRest(); }, 4000);
}

function hideRest() {
  clearInterval(restTick);
  $rest.hidden = true;
  document.body.classList.remove('resting');
}

function stopRest() {
  if (state.draft && state.draft.rest) { delete state.draft.rest; saveDraft(); }
  hideRest();
}

$rest.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-rest]');
  const r = state.draft && state.draft.rest;
  if (!btn || !r) return hideRest();
  if (btn.dataset.rest === 'skip') return stopRest();
  const delta = btn.dataset.rest === 'plus' ? 15 : -15;
  r.endAt = Math.max(Date.now() + 1000, r.endAt + delta * 1000);
  r.total = Math.max(r.total + delta, 1);
  saveDraft();
  updateRest();
});

/* ---------- Réglage du temps de repos d'un exercice ---------- */
const restEdit = { name: '', value: DEFAULT_REST };

function openRestSheet(name) {
  Object.assign(restEdit, { name, value: restFor(name) });
  $sheet.querySelector('.sheet-body').innerHTML = `
    <div class="sheet-head">
      <div><h2>Temps de repos</h2><span class="muted small">${esc(name)}</span></div>
      <button class="icon-btn" data-sheet="close" aria-label="Fermer">✕</button>
    </div>
    <p class="small muted">Le chrono démarre tout seul quand tu coches ✓ une série de cet exercice. Ce réglage est gardé pour les prochaines séances.</p>
    <div class="rest-picker">
      <button class="icon-btn big" data-sheet="rest-step" data-delta="-15" aria-label="Moins 15 secondes">−</button>
      <span class="rest-value"></span>
      <button class="icon-btn big" data-sheet="rest-step" data-delta="15" aria-label="Plus 15 secondes">+</button>
    </div>
    <div class="chips-wrap rest-presets"></div>
    <button class="btn btn-primary" data-sheet="rest-save">Enregistrer</button>`;
  renderRestSheet();
  $sheet.hidden = false;
}

function renderRestSheet() {
  const body = $sheet.querySelector('.sheet-body');
  body.querySelector('.rest-value').textContent = fmtClock(restEdit.value);
  body.querySelector('.rest-presets').innerHTML = REST_PRESETS.map((s) =>
    `<button class="chip ${s === restEdit.value ? 'on' : ''}" data-sheet="rest-preset" data-s="${s}">${fmtClock(s)}</button>`).join('');
}

async function saveRestSheet() {
  state.restTimes[keyOf(restEdit.name)] = restEdit.value;
  await dbPut('meta', { key: 'restTimes', value: state.restTimes });
  closeSheet();
  render();
  toast(`Repos : ${fmtClock(restEdit.value)}`);
}

// Évite que l'écran se mette en veille pendant la séance (si l'iPhone le permet)
let wakeLock = null;
async function keepScreenOn() {
  if (!state.draft || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* pas grave */ }
}
document.addEventListener('visibilitychange', keepScreenOn);

/* ---------- Chrono de la séance (temps écoulé depuis le début), dans le bandeau du haut ---------- */
function fmtElapsed(startIso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(startIso)) / 1000));
  if (s >= 12 * 3600) return `depuis ${fmtTime(startIso)}`; // séance oubliée ouverte : pas de chrono géant
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(sec)}` : `${pad2(m)}:${pad2(sec)}`;
}

setInterval(() => {
  const el = document.querySelector('.wk-elapsed');
  if (el && state.draft) el.textContent = `⏱ ${fmtElapsed(state.draft.startedAt)}`;
}, 1000);

/* =====================================================================
   Événements
   ===================================================================== */
$app.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;

  // Contexte "séance en cours"
  const exEl = btn.closest('.exercise');
  const setEl = btn.closest('[data-set]');
  const ex = exEl && state.draft ? state.draft.exercises[+exEl.dataset.ex] : null;
  const set = ex && setEl ? ex.sets[+setEl.dataset.set] : null;

  // Contexte « modifier une séance enregistrée »
  const ewxEl = btn.closest('[data-ewx]');
  const ewEx = ewxEl && state.editWorkout ? state.editWorkout.exercises[+ewxEl.dataset.ewx] : null;
  const ewsEl = btn.closest('[data-ews]');
  const ewSet = ewEx && ewsEl ? ewEx.sets[+ewsEl.dataset.ews] : null;

  switch (action) {
    case 'start':
      return startWorkout(state.templates.find((t) => t.id === btn.dataset.id));
    case 'start-free':
      return startWorkout(null);

    case 'step': {
      const input = btn.closest('.stepper').querySelector('input');
      const v = Math.max(0, num(input.value) + parseFloat(btn.dataset.delta));
      setValue(exEl, +setEl.dataset.set, input.dataset.field, Math.round(v * 100) / 100);
      return saveDraft();
    }
    case 'toggle-done':
      if (set.done) {
        set.done = false;
        await saveDraft();
        return render();
      }
      return completeSet(ex, +exEl.dataset.ex, set);
    case 'set-feel': {
      // Toucher la pastille déjà choisie l'enlève ; sinon on note le ressenti ET on valide la série
      const feel = btn.dataset.feel;
      if (set.feel === feel) {
        delete set.feel;
        await saveDraft();
        return render();
      }
      set.feel = feel;
      if (set.done) {
        await saveDraft();
        return render();
      }
      return completeSet(ex, +exEl.dataset.ex, set);
    }
    case 'expand-ex':
      ex.expanded = true;
      await saveDraft();
      return render();
    case 'collapse-ex':
      ex.expanded = false;
      await saveDraft();
      return render();
    case 'rest-config':
      return openRestSheet(ex.name);
    case 'add-set': {
      const prev = ex.sets[ex.sets.length - 1] || { reps: 10, weight: 0 };
      ex.sets.push({ reps: prev.reps, weight: prev.weight, done: false });
      await saveDraft();
      return render();
    }
    case 'remove-set':
      ex.sets.splice(+setEl.dataset.set, 1);
      await saveDraft();
      return render();
    case 'edit-note':
      if (await editNote(btn.dataset.name, btn.dataset.brand || null)) render();
      return;
    case 'pick-brand': {
      const i = +exEl.dataset.ex;
      return openBrandSheet(ex.brand, async (brand) => {
        const target = state.draft.exercises[i];
        if ((target.brand || null) === brand) return;
        target.brand = brand || undefined;
        if (!brand) delete target.brand;
        // Rien de coché : on pré-remplit avec la dernière perf sur CETTE machine
        if (!target.sets.some((s) => s.done)) target.sets = initialSets(target.name, brand);
        await saveDraft();
        render();
        toast(brand ? `Machine : ${brand}` : 'Machine par défaut');
      });
    }
    case 'swap-ex': {
      const i = +exEl.dataset.ex;
      const original = ex.replaces || ex.name;
      return openPicker(async ([name]) => {
        const target = state.draft.exercises[i];
        if (target.sets.some((s) => s.done)
          && !(await askConfirm('Remplacer l\'exercice ?', `Tes séries déjà cochées sur « ${target.name} » ne seront pas gardées.`, 'Remplacer', true))) return;
        // Choisir l'exercice d'origine = revenir en arrière
        const back = keyOf(name) === keyOf(original);
        state.draft.exercises[i] = { name, sets: initialSets(name), ...(back ? {} : { replaces: original }) };
        await saveDraft();
        render();
        document.querySelector(`.exercise[data-ex="${i}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        toast(back ? `${name} remis` : `${original} → ${name}`);
      }, { single: true, title: `Remplacer ${original}`, group: (findExercise(original) || {}).group });
    }
    case 'unswap-ex': {
      if (ex.sets.some((s) => s.done)
        && !(await askConfirm(`Remettre ${ex.replaces} ?`, `Tes séries déjà cochées sur « ${ex.name} » ne seront pas gardées.`, 'Remettre', true))) return;
      const i = +exEl.dataset.ex;
      state.draft.exercises[i] = { name: ex.replaces, sets: initialSets(ex.replaces) };
      await saveDraft();
      return render();
    }
    case 'link-ex': {
      const e = state.draft.exercises[+btn.dataset.i];
      if (e.linkNext) delete e.linkNext; else e.linkNext = true;
      await saveDraft();
      return render();
    }
    case 'move-ex': {
      const list = state.draft.exercises, i = +exEl.dataset.ex, j = i + +btn.dataset.dir;
      if (j < 0 || j >= list.length) return;
      // Déplacer un exercice défait les supersets autour de lui (on les relie ensuite si besoin)
      for (const k of [i - 1, i, j - 1, j]) if (list[k]) delete list[k].linkNext;
      [list[i], list[j]] = [list[j], list[i]];
      await saveDraft();
      render();
      return document.querySelector(`.exercise[data-ex="${j}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    case 'remove-ex':
      if (!(await askConfirm('Retirer l\'exercice ?', `« ${ex.name} » sera retiré de la séance du jour.`, 'Retirer', true))) return;
      if (!ex.linkNext && state.draft.exercises[+exEl.dataset.ex - 1]) delete state.draft.exercises[+exEl.dataset.ex - 1].linkNext;
      state.draft.exercises.splice(+exEl.dataset.ex, 1);
      await saveDraft();
      return render();
    case 'add-ex':
      return openPicker(async (names) => {
        for (const name of names) state.draft.exercises.push({ name, sets: initialSets(name) });
        await saveDraft();
        render();
        document.querySelector('.exercise:last-of-type')?.scrollIntoView({ behavior: 'smooth' });
      });
    case 'finish':
      return finishWorkout();
    case 'cancel':
      if (await askConfirm('Abandonner la séance ?', 'Rien ne sera enregistré.', 'Abandonner', true)) return discardWorkout();
      return;

    case 'delete-workout':
      if (!(await askConfirm('Supprimer cette séance ?', 'Elle sera supprimée définitivement de l\'historique.', 'Supprimer', true))) return;
      await dbDel('workouts', btn.dataset.id);
      state.workouts = state.workouts.filter((w) => w.id !== btn.dataset.id);
      return render();

    case 'metric':
      state.progressMetric = btn.dataset.id;
      return render();
    case 'hist-month': {
      const [y, m] = state.histMonth.split('-').map(Number);
      const d = new Date(y, m - 1 + +btn.dataset.dir, 1);
      state.histMonth = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
      state.histDay = null;
      return render();
    }
    case 'add-past':
      return openAddPastSheet(btn.dataset.day);
    case 'hist-goto':
      state.histMonth = btn.dataset.day.slice(0, 7);
      state.histDay = btn.dataset.day;
      return render();
    case 'hist-day':
      state.histDay = state.histDay === btn.dataset.day ? null : btn.dataset.day;
      return render();

    case 'recap-workout':
      return showRecap(state.workouts.find((x) => x.id === btn.dataset.id));
    case 'edit-workout': {
      const w = state.workouts.find((x) => x.id === btn.dataset.id);
      state.editWorkout = { ...JSON.parse(JSON.stringify(w)), day: localDay(new Date(w.date)) };
      render();
      return scrollTo(0, 0);
    }
    case 'ew-cancel':
      state.editWorkout = null;
      return render();
    case 'ew-step': {
      const input = btn.closest('.stepper').querySelector('input');
      const v = Math.max(0, Math.round((num(input.value) + parseFloat(btn.dataset.delta)) * 100) / 100);
      ewSet[input.dataset.ewField] = v;
      input.value = fmtNum(v);
      return;
    }
    case 'ew-add-set': {
      const prev = ewEx.sets[ewEx.sets.length - 1] || { reps: 10, weight: 0 };
      ewEx.sets.push({ reps: prev.reps, weight: prev.weight });
      return render();
    }
    case 'ew-feel':
      if (ewSet.feel === btn.dataset.feel) delete ewSet.feel;
      else ewSet.feel = btn.dataset.feel;
      return render();
    case 'ew-remove-set':
      ewEx.sets.splice(+btn.closest('[data-ews]').dataset.ews, 1);
      return render();
    case 'ew-remove-ex':
      if (!(await askConfirm('Retirer l\'exercice ?', `« ${ewEx.name} » sera retiré de cette séance.`, 'Retirer', true))) return;
      state.editWorkout.exercises.splice(+btn.closest('[data-ewx]').dataset.ewx, 1);
      return render();
    case 'ew-add-ex':
      return openPicker((names) => {
        for (const name of names) {
          state.editWorkout.exercises.push({ name, sets: initialSets(name).map(({ reps, weight }) => ({ reps, weight })) });
        }
        render();
      });
    case 'ew-pick-brand':
      return openBrandSheet(ewEx.brand, (brand) => {
        if (brand) ewEx.brand = brand;
        else delete ewEx.brand;
        render();
      });
    case 'ew-save':
      return saveEditedWorkout();

    case 'global-period':
      state.globalPeriod = btn.dataset.id;
      state.globalMuscle = null;
      if (state.globalPeriod === 'custom' && !state.globalFrom) {
        // Par défaut : il y a 2 mois
        const d = new Date();
        d.setMonth(d.getMonth() - 2);
        state.globalFrom = localDay(d);
      }
      return render();
    case 'global-muscle':
      state.globalMuscle = state.globalMuscle === btn.dataset.m ? null : btn.dataset.m;
      return render();
    case 'toggle-pref': {
      const key = btn.dataset.key;
      state.prefs[key] = !state.prefs[key];
      if (key === 'autoRest' && !state.prefs.autoRest) stopRest();
      toast(state.prefs[key] ? 'Activé' : 'Désactivé');
      return savePrefs();
    }
    case 'set-pref':
      state.prefs[btn.dataset.key] = +btn.dataset.value;
      return savePrefs();
    case 'progress-view':
      state.progressView = btn.dataset.id;
      return render();
    case 'bw-step': {
      const input = document.getElementById('bw-input');
      input.value = fmtNum(Math.max(0, Math.round((num(input.value) + +btn.dataset.delta) * 10) / 10));
      return;
    }
    case 'bw-save':
      return saveBodyweight();
    case 'bw-delete':
      if (!(await askConfirm('Supprimer cette pesée ?', '', 'Supprimer', true))) return;
      await dbDel('bodyweight', btn.dataset.date);
      state.bodyweight = state.bodyweight.filter((b) => b.date !== btn.dataset.date);
      return render();
    case 'vol-period':
      state.volumePeriod = btn.dataset.id;
      return render();

    case 'go-programs':
      return go({ name: 'programs' });
    case 'open-program':
      await setActiveProgram(btn.dataset.id);
      return go({ name: 'program', id: btn.dataset.id });
    case 'new-program':
      return createProgram();
    case 'move-template':
      return moveTemplate(btn.dataset.id, +btn.dataset.dir);
    case 'edit-program':
      return go({ name: 'editProgram', id: btn.dataset.id });
    case 'delete-program':
      return deleteProgram(btn.dataset.id);

    case 'new-template':
      return go({ name: 'editTemplate', id: null, programId: btn.dataset.id, tplName: '', exercises: [] });
    case 'edit-template': {
      const t = state.templates.find((x) => x.id === btn.dataset.id);
      return go({ name: 'editTemplate', id: t.id, programId: t.programId, tplName: t.name, exercises: [...t.exercises], links: [...(t.links || [])] });
    }
    case 'info':
      return openSheet(btn.dataset.name);
    case 'define-muscles':
      return openMuscleEditor(btn.dataset.name, false, () => render());
    case 'pick-exercises':
      return openPicker((names) => {
        const r = state.route;
        r.exercises.push(...names.filter((n) => !r.exercises.some((x) => norm(x) === norm(n))));
        render();
      });
    case 'tpl-link': {
      const links = (state.route.links ||= []);
      links[+btn.dataset.i] = !links[+btn.dataset.i];
      return render();
    }
    case 'ex-move': {
      const list = state.route.exercises, i = +btn.dataset.i, j = i + +btn.dataset.dir;
      const links = (state.route.links ||= []);
      for (const k of [i - 1, i, j - 1, j]) links[k] = false; // déplacer défait les supersets autour
      [list[i], list[j]] = [list[j], list[i]];
      return render();
    }
    case 'ex-remove': {
      const i = +btn.dataset.i;
      const links = (state.route.links ||= []);
      if (!links[i]) links[i - 1] = false;
      links.splice(i, 1);
      state.route.exercises.splice(i, 1);
      return render();
    }
    case 'delete-template': {
      const t = state.templates.find((x) => x.id === btn.dataset.id);
      if (!(await askConfirm('Supprimer la séance ?', `« ${t.name} » sera retirée du programme.\nTon historique est conservé.`, 'Supprimer', true))) return;
      await dbDel('templates', t.id);
      state.templates = state.templates.filter((x) => x.id !== t.id);
      return render();
    }
    case 'save-template':
      return saveTemplate();
    case 'export':
      return exportData();
  }
});

// Change une valeur, et la recopie sur les séries suivantes pas encore cochées qui avaient la même valeur
// (ex : passer la série 1 de 20 à 25 kg passe aussi les séries 2 et 3 à 25 kg)
function setValue(exEl, setIndex, field, value) {
  const sets = state.draft.exercises[+exEl.dataset.ex].sets;
  const old = sets[setIndex][field];
  sets[setIndex][field] = value;
  const setEls = exEl.querySelectorAll('[data-set]');
  for (let k = setIndex + 1; k < sets.length; k++) {
    if (sets[k].done || sets[k][field] !== old) break;
    sets[k][field] = value;
    const other = setEls[k].querySelector(`input[data-field="${field}"]`);
    if (other !== document.activeElement) other.value = fmtNum(value);
  }
  const input = setEls[setIndex].querySelector(`input[data-field="${field}"]`);
  if (input !== document.activeElement) input.value = fmtNum(value);
}

// Saisie directe au clavier dans les champs reps / poids
$app.addEventListener('input', (e) => {
  const input = e.target;
  if (input.id === 'ed-name') state.route.tplName = input.value;
  if (!input.dataset.field || !state.draft) return;
  setValue(input.closest('.exercise'), +input.closest('[data-set]').dataset.set, input.dataset.field, num(input.value));
  saveDraft();
});

// Quand on tape dans un champ, on sélectionne tout pour remplacer la valeur directement
// Saisie au clavier dans l'écran « Modifier une séance enregistrée »
$app.addEventListener('input', (e) => {
  const w = state.editWorkout;
  if (!w) return;
  if (e.target.id === 'ew-date' && e.target.value) w.day = e.target.value;
  if (e.target.dataset.ewField) {
    const ex = w.exercises[+e.target.closest('[data-ewx]').dataset.ewx];
    ex.sets[+e.target.closest('[data-ews]').dataset.ews][e.target.dataset.ewField] = num(e.target.value);
  }
});

const isNumberField = (el) => el.dataset.field || el.dataset.ewField;
$app.addEventListener('focusin', (e) => {
  if (isNumberField(e.target)) setTimeout(() => e.target.setSelectionRange(0, e.target.value.length), 0);
});
$app.addEventListener('focusout', (e) => {
  if (isNumberField(e.target)) e.target.value = fmtNum(num(e.target.value));
});

$app.addEventListener('change', (e) => {
  if (e.target.dataset.action === 'pick-exercise') {
    state.progressExercise = e.target.value;
    render();
  } else if (e.target.id === 'global-from' && e.target.value) {
    state.globalFrom = e.target.value;
    state.globalMuscle = null;
    render();
  } else if (e.target.id === 'prog-name') {
    renameProgram(e.target.dataset.id, e.target.value);
  } else if (e.target.id === 'import-file' && e.target.files[0]) {
    importData(e.target.files[0]);
    e.target.value = '';
  }
});

document.querySelector('.tabbar').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (!tab) return;
  // Re-toucher l'onglet Séance quand on y est déjà ramène à la liste des programmes
  if (tab.dataset.tab === 'train' && state.tab === 'train') state.route = { name: 'programs' };
  state.tab = tab.dataset.tab;
  render();
  scrollTo(0, 0);
});

/* =====================================================================
   Démarrage
   ===================================================================== */
(async function init() {
  try {
    db = await openDB();
    await adoptOrphanTemplates();
    await loadAll();
    render();
    keepScreenOn();
    runRest(); // reprend le chrono si un repos était en cours
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (err) {
    $app.innerHTML = `<h1>Oups</h1><p>Impossible d'ouvrir la base de données : ${esc(err.message || err)}</p>`;
  }
  if ('serviceWorker' in navigator) {
    // Quand une nouvelle version de l'app vient d'être installée, on recharge pour l'afficher tout de suite
    // (la toute première installation n'est pas une mise à jour : on ne recharge pas)
    let hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      if (reloaded) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
