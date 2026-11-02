'use strict';

/* =====================================================================
   Base de données locale (IndexedDB) — tout reste sur le téléphone
   ===================================================================== */
const DB_NAME = 'muscu';
const DB_VERSION = 2;
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
const state = {
  tab: 'train',
  route: { name: 'programs' }, // écran affiché dans l'onglet Séance
  programs: [],
  templates: [],      // les séances, chacune rattachée à un programme (programId)
  workouts: [],       // triées de la plus récente à la plus ancienne
  draft: null,        // séance en cours (sauvegardée en continu)
  activeProgram: null,
  lastExport: null,
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
function cycleInfo(tpls) {
  const ids = new Set(tpls.map((t) => t.id));
  const last = state.workouts.find((w) => ids.has(w.templateId)) || null;
  const lastIndex = last ? tpls.findIndex((t) => t.id === last.templateId) : -1;
  const next = tpls.length ? tpls[(lastIndex + 1) % tpls.length] : null;
  const lastName = last ? (tpls[lastIndex]?.name || last.templateName) : null;
  return { next, last, lastName };
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
}

const saveDraft = () => (state.draft ? dbPut('meta', { key: 'draft', value: state.draft }) : dbDel('meta', 'draft'));

// Dernière fois qu'on a fait cet exercice (toutes séances confondues)
function lastPerf(name) {
  const k = keyOf(name);
  for (const w of state.workouts) {
    const ex = w.exercises.find((e) => keyOf(e.name) === k);
    if (ex && ex.sets.length) return { date: w.date, sets: ex.sets, templateName: w.templateName };
  }
  return null;
}

// On pré-remplit avec la dernière perf : il suffit de cocher, ou d'ajuster
function initialSets(name) {
  const last = lastPerf(name);
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

  const { next, last, lastName } = cycleInfo(tpls);
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
    const isLast = last && t.id === last.templateId;
    return `
      <button class="cycle-step ${isNext ? 'next' : ''}" data-action="start" data-id="${t.id}">
        <span class="cycle-num">${i + 1}</span>
        <span class="cycle-name">${esc(t.name)}</span>
        ${isNext ? '<span class="badge">Aujourd\'hui</span>' : isLast ? '<span class="tag">Faite ' + fmtAgo(last.date) + '</span>' : ''}
      </button>`;
  }).join('');

  return `
    <button class="back" data-action="go-programs">‹ Programmes</button>
    <h1>${esc(p.name)}</h1>
    ${hero}
    <h3>Le cycle</h3>
    <div class="cycle">${steps}</div>
    <p class="muted small">Tu peux toucher une autre séance pour la faire à la place : le cycle reprendra après celle-ci.</p>
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
  const rows = r.exercises.map((name, i) => `
    <div class="ex-row">
      <span class="cycle-num">${i + 1}</span>
      <button class="ex-row-name" data-action="info" data-name="${esc(name)}">${esc(name)}</button>
      <button class="icon-btn" data-action="ex-move" data-i="${i}" data-dir="-1" aria-label="Monter" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="icon-btn" data-action="ex-move" data-i="${i}" data-dir="1" aria-label="Descendre" ${i === r.exercises.length - 1 ? 'disabled' : ''}>↓</button>
      <button class="icon-btn" data-action="ex-remove" data-i="${i}" aria-label="Retirer">✕</button>
    </div>`).join('');

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

function stepper(field, value, label) {
  const step = field === 'reps' ? 1 : 2.5;
  return `
    <div class="stepper">
      <span class="stepper-label">${label}</span>
      <div class="stepper-row">
        <button data-action="step" data-delta="-${step}" aria-label="Moins">−</button>
        <input data-field="${field}" inputmode="${field === 'reps' ? 'numeric' : 'decimal'}" value="${fmtNum(value)}" autocomplete="off" aria-label="${label}">
        <button data-action="step" data-delta="${step}" aria-label="Plus">+</button>
      </div>
    </div>`;
}

function viewWorkout() {
  const d = state.draft;
  const exercises = d.exercises.map((ex, i) => {
    const last = lastPerf(ex.name);
    const sets = ex.sets.map((s, j) => `
      <div class="set ${s.done ? 'done' : ''}" data-set="${j}">
        <div class="set-top">
          <span class="set-num">Série ${j + 1}${last && last.sets[j] ? `<span class="set-prev">Dernière fois : ${esc(fmtSet(last.sets[j]))}</span>` : ''}</span>
          ${ex.sets.length > 1 ? '<button class="link" data-action="remove-set">Retirer</button>' : ''}
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
        ${last
          ? `<div class="last">
              <strong>Dernière fois</strong> · ${fmtDate(last.date)}${last.templateName ? ` · ${esc(last.templateName)}` : ''}
              <span class="last-sets">${last.sets.map((s, j) => `<span>S${j + 1} <b>${esc(fmtSet(s))}</b></span>`).join('')}</span>
            </div>`
          : '<p class="last first">Première fois sur cet exercice 💪</p>'}
        ${sets}
        <button class="btn btn-secondary" data-action="add-set">+ Ajouter une série</button>
      </section>`;
  }).join('');

  return `
    <h1>${esc(d.templateName)}</h1>
    <p class="muted small">Commencée à ${fmtTime(d.startedAt)} · coche ✓ chaque série terminée</p>
    ${exercises}
    <button class="btn btn-secondary" data-action="add-ex">+ Ajouter un exercice</button>
    <button class="btn btn-primary btn-xl" data-action="finish">Terminer et enregistrer</button>
    <button class="btn btn-danger" data-action="cancel">Abandonner la séance</button>`;
}

/* ---------- Historique ---------- */
function viewHistory() {
  if (!state.workouts.length) {
    return `<h1>Historique</h1><div class="empty"><div class="big">📅</div><p>Aucune séance enregistrée pour l'instant.</p></div>`;
  }
  const cards = state.workouts.map((w) => `
    <section class="card">
      <div class="hist-head">
        <h2>${esc(w.templateName)}</h2>
        <span class="muted small">${w.programName ? esc(w.programName) + ' · ' : ''}${fmtDate(w.date)}</span>
      </div>
      ${w.exercises.map((e) => `<p class="hist-ex"><strong>${esc(e.name)}</strong>${esc(fmtSets(e.sets))}</p>`).join('')}
      <button class="link" data-action="delete-workout" data-id="${w.id}">Supprimer cette séance</button>
    </section>`).join('');
  return `<h1>Historique</h1><p class="muted small">${state.workouts.length} séance(s)</p>${cards}`;
}

/* ---------- Progrès ---------- */
const METRICS = {
  weight: { label: 'Poids max', unit: 'kg', f: (sets) => Math.max(...sets.map((s) => s.weight)) },
  reps: { label: 'Reps totales', unit: 'reps', f: (sets) => sets.reduce((a, s) => a + s.reps, 0) },
  volume: { label: 'Volume', unit: 'kg', f: (sets) => sets.reduce((a, s) => a + s.reps * s.weight, 0) },
};

function exerciseNames() {
  const map = new Map();
  for (const w of state.workouts) {
    for (const e of w.exercises) if (!map.has(keyOf(e.name))) map.set(keyOf(e.name), e.name);
  }
  return [...map.values()];
}

function viewProgress() {
  const names = exerciseNames();
  if (!names.length) {
    return `<h1>Progrès</h1><div class="empty"><div class="big">📈</div><p>Termine ta première séance pour voir ta progression ici.</p></div>`;
  }
  if (!state.progressExercise || !names.some((n) => keyOf(n) === keyOf(state.progressExercise))) {
    state.progressExercise = names[0];
  }
  const k = keyOf(state.progressExercise);
  const entries = state.workouts
    .map((w) => ({ date: w.date, ex: w.exercises.find((e) => keyOf(e.name) === k) }))
    .filter((x) => x.ex && x.ex.sets.length)
    .reverse(); // de la plus ancienne à la plus récente

  const m = METRICS[state.progressMetric];
  const points = entries.map((e) => ({ date: e.date, y: Math.round(m.f(e.ex.sets) * 100) / 100 }));

  const record = Math.max(...entries.map((e) => METRICS.weight.f(e.ex.sets)));
  const diff = points.length > 1 ? points[points.length - 1].y - points[0].y : 0;

  const options = names.map((n) => `<option ${keyOf(n) === k ? 'selected' : ''}>${esc(n)}</option>`).join('');
  const seg = Object.entries(METRICS).map(([id, mm]) =>
    `<button class="${id === state.progressMetric ? 'on' : ''}" data-action="metric" data-id="${id}">${mm.label}</button>`).join('');

  const rows = entries.slice().reverse().map((e) =>
    `<div class="row"><span>${fmtDate(e.date)}</span><span>${esc(fmtSets(e.ex.sets))}</span></div>`).join('');

  return `
    <h1>Progrès</h1>
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

  const grid = [0, 0.5, 1].map((t) => {
    const v = min + (max - min) * t;
    return `<line class="grid" x1="${pl}" x2="${W - pr}" y1="${y(v)}" y2="${y(v)}"/>
            <text class="axis" x="${pl - 6}" y="${y(v) + 4}" text-anchor="end">${fmtNum(Math.round(v))}</text>`;
  }).join('');

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${H - pb} L${pl},${H - pb} Z`;
  const showValues = points.length <= 12;
  const dots = points.map((p, i) => `
    <circle class="dot" cx="${x(i)}" cy="${y(p.y)}" r="4"/>
    ${showValues || i === points.length - 1 ? `<text class="val" x="${x(i)}" y="${y(p.y) - 9}" text-anchor="middle">${fmtNum(p.y)}</text>` : ''}`).join('');

  const last = points.length - 1;
  const xLabels = `
    <text class="axis" x="${pl}" y="${H - 6}" text-anchor="start">${fmtShort(points[0].date)}</text>
    <text class="axis" x="${W - pr}" y="${H - 6}" text-anchor="end">${fmtShort(points[last].date)}</text>`;

  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Courbe de progression">
    ${grid}<path class="area" d="${area}"/><path class="line" d="${line}"/>${dots}${xLabels}</svg>`;
}

/* ---------- Volume : séries par muscle ---------- */
const VOLUME_PERIODS = { week: 'Semaine', lastweek: 'Sem. passée', cycle: 'Cycle', month: '30 jours' };

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
    return { workouts: between(startOfWeek(new Date()), null), desc: 'Depuis lundi' };
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
      const e = findExercise(ex.name);
      if (!e) { unknown.add(ex.name); continue; }
      const { primary, secondary } = musclesFor(e.group, e.nameN);
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
    ${unknown.size ? `<p class="muted small">Non comptés (exercices perso) : ${[...unknown].map(esc).join(', ')}</p>` : ''}`;
}

/* ---------- Réglages ---------- */
function viewSettings() {
  return `
    <h1>Réglages</h1>
    <p class="muted small">Pour gérer tes programmes et séances : onglet Séance → choisis un programme → « Modifier ce programme ».</p>

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
    exercises: exercises.map((name) => ({ name, sets: initialSets(name) })),
  };
  await saveDraft();
  render();
  scrollTo(0, 0);
  keepScreenOn();
}

async function finishWorkout() {
  const d = state.draft;
  const exercises = d.exercises
    .map((e) => ({ name: e.name, sets: e.sets.filter((s) => s.done).map((s) => ({ reps: s.reps, weight: s.weight })) }))
    .filter((e) => e.sets.length);
  const count = exercises.reduce((a, e) => a + e.sets.length, 0);

  if (!count) {
    if (confirm('Aucune série cochée ✓.\n\nAbandonner la séance sans rien enregistrer ?')) await discardWorkout();
    return;
  }
  if (!confirm(`Terminer la séance ?\n\n${count} série(s) cochée(s) seront enregistrées.`)) return;

  const workout = {
    id: uid(),
    date: new Date().toISOString(),
    startedAt: d.startedAt,
    programName: d.programName || null,
    templateId: d.templateId,
    templateName: d.templateName,
    exercises,
  };
  await dbPut('workouts', workout);
  state.workouts.unshift(workout);
  state.draft = null;
  await saveDraft();
  render();
  scrollTo(0, 0);
  toast('Séance enregistrée 💪');
}

async function discardWorkout() {
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
    && data.templates.every((t) => t && t.id && typeof t.name === 'string' && Array.isArray(t.exercises))
    && data.workouts.every((w) => w && w.id && typeof w.date === 'string' && Array.isArray(w.exercises) && w.exercises.every(okEx));
}

async function importData(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    alert("Ce fichier n'est pas un JSON valide.");
    return;
  }
  if (!isValidBackup(data)) {
    alert("Ce fichier ne ressemble pas à une sauvegarde de l'app Muscu.");
    return;
  }
  const programs = data.programs || [];
  const msg = `Importer cette sauvegarde ?\n\n${data.workouts.length} séance(s) faite(s), ${programs.length} programme(s).\n\n`
    + 'Les données sont fusionnées : rien n\'est supprimé, les éléments déjà présents sont mis à jour.';
  if (!confirm(msg)) return;

  const tx = db.transaction(['programs', 'templates', 'workouts'], 'readwrite');
  programs.forEach((p) => tx.objectStore('programs').put(p));
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
  const name = (prompt('Nom du programme :') || '').trim();
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
  if (!confirm(`Supprimer le programme « ${p.name} » et ses séances ?\n\nTon historique et tes courbes sont conservés.`)) return;
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
  if (!name) return alert('Donne un nom à la séance.');
  if (!exercises.length) return alert('Ajoute au moins un exercice.');

  const existing = state.templates.find((t) => t.id === r.id);
  const fresh = { id: uid(), programId: r.programId, order: programTemplates(r.programId).length, createdAt: new Date().toISOString() };
  const t = { ...(existing || fresh), name, exercises };
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

function allExercises() {
  const known = new Set(LIBRARY.map((e) => e.nameN));
  const custom = new Map();
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

const picker = { query: '', group: '', selected: [], onDone: null };
const $picker = document.getElementById('picker');
const $pkSearch = $picker.querySelector('.picker-search');

function openPicker(onDone) {
  Object.assign(picker, { query: '', group: '', selected: [], onDone });
  $pkSearch.value = '';
  $picker.hidden = false;
  document.body.style.overflow = 'hidden';
  renderPicker();
  $pkSearch.focus();
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
    ? `<div class="pk-row"><button class="pk-main create" data-pk="toggle" data-name="${esc(typed)}"><span class="pk-check">✓</span><span class="pk-name">+ Créer « ${esc(typed)} »</span></button></div>`
    : '';
  const rows = results.slice(0, 150).map((e) => `
    <div class="pk-row ${picker.selected.includes(e.name) ? 'on' : ''}">
      <button class="pk-main" data-pk="toggle" data-name="${esc(e.name)}">
        <span class="pk-check">✓</span>
        <span class="pk-name">${esc(e.name)}<span class="pk-group">${esc(e.groupLabel)}</span></span>
      </button>
      ${e.group !== 'perso' ? `<button class="pk-info" data-pk="info" data-name="${esc(e.name)}" aria-label="Voir la fiche">i</button>` : ''}
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
      const i = picker.selected.indexOf(name);
      if (i >= 0) picker.selected.splice(i, 1);
      else picker.selected.push(name);
      // Après avoir créé un exercice perso, on vide la recherche pour en chercher un autre
      if (btn.classList.contains('create')) { picker.query = ''; $pkSearch.value = ''; }
      return renderPicker();
    }
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

function openSheet(name) {
  const e = findExercise(name);
  const { primary, secondary } = e ? musclesFor(e.group, e.nameN) : { primary: [], secondary: [] };
  const labels = (list) => list.map((m) => MUSCLE_LABELS[m]).join(', ');

  const map = primary.length ? `
    <div class="sheet-maps">
      <figure>${bodySVG('front', primary, secondary)}<figcaption>Devant</figcaption></figure>
      <figure>${bodySVG('back', primary, secondary)}<figcaption>Derrière</figcaption></figure>
    </div>
    <p class="legend"><i class="dot mp"></i><span><strong>Principal :</strong> ${labels(primary)}</span></p>
    ${secondary.length ? `<p class="legend"><i class="dot ms"></i><span><strong>Secondaire :</strong> ${labels(secondary)}</span></p>` : ''}`
    : '<p class="muted">Exercice perso : pas de fiche détaillée.</p>';

  $sheet.querySelector('.sheet-body').innerHTML = `
    <div class="sheet-head">
      <div><h2>${esc(name)}</h2>${e ? `<span class="muted small">${esc(e.groupLabel)}</span>` : ''}</div>
      <button class="icon-btn" data-sheet="close" aria-label="Fermer">✕</button>
    </div>
    ${map}`;
  $sheet.hidden = false;
}

function closeSheet() {
  $sheet.hidden = true;
}

$sheet.addEventListener('click', (e) => {
  if (e.target === $sheet || e.target.closest('[data-sheet=close]')) closeSheet();
});

// Évite que l'écran se mette en veille pendant la séance (si l'iPhone le permet)
let wakeLock = null;
async function keepScreenOn() {
  if (!state.draft || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try { wakeLock = await navigator.wakeLock.request('screen'); } catch { /* pas grave */ }
}
document.addEventListener('visibilitychange', keepScreenOn);

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
      set.done = !set.done;
      setEl.classList.toggle('done', set.done);
      return saveDraft();
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
    case 'move-ex': {
      const list = state.draft.exercises, i = +exEl.dataset.ex, j = i + +btn.dataset.dir;
      if (j < 0 || j >= list.length) return;
      [list[i], list[j]] = [list[j], list[i]];
      await saveDraft();
      render();
      return document.querySelector(`.exercise[data-ex="${j}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
    case 'remove-ex':
      if (!confirm(`Retirer « ${ex.name} » de cette séance ?`)) return;
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
      if (confirm('Abandonner la séance en cours ?\n\nRien ne sera enregistré.')) return discardWorkout();
      return;

    case 'delete-workout':
      if (!confirm('Supprimer définitivement cette séance de l\'historique ?')) return;
      await dbDel('workouts', btn.dataset.id);
      state.workouts = state.workouts.filter((w) => w.id !== btn.dataset.id);
      return render();

    case 'metric':
      state.progressMetric = btn.dataset.id;
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
      return go({ name: 'editTemplate', id: t.id, programId: t.programId, tplName: t.name, exercises: [...t.exercises] });
    }
    case 'info':
      return openSheet(btn.dataset.name);
    case 'pick-exercises':
      return openPicker((names) => {
        const r = state.route;
        r.exercises.push(...names.filter((n) => !r.exercises.some((x) => norm(x) === norm(n))));
        render();
      });
    case 'ex-move': {
      const list = state.route.exercises, i = +btn.dataset.i, j = i + +btn.dataset.dir;
      [list[i], list[j]] = [list[j], list[i]];
      return render();
    }
    case 'ex-remove':
      state.route.exercises.splice(+btn.dataset.i, 1);
      return render();
    case 'delete-template': {
      const t = state.templates.find((x) => x.id === btn.dataset.id);
      if (!confirm(`Supprimer la séance « ${t.name} » ?\n\nTon historique est conservé.`)) return;
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
$app.addEventListener('focusin', (e) => {
  if (e.target.dataset.field) setTimeout(() => e.target.setSelectionRange(0, e.target.value.length), 0);
});
$app.addEventListener('focusout', (e) => {
  if (e.target.dataset.field) e.target.value = fmtNum(num(e.target.value));
});

$app.addEventListener('change', (e) => {
  if (e.target.dataset.action === 'pick-exercise') {
    state.progressExercise = e.target.value;
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
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
  } catch (err) {
    $app.innerHTML = `<h1>Oups</h1><p>Impossible d'ouvrir la base de données : ${esc(err.message || err)}</p>`;
  }
  if ('serviceWorker' in navigator) {
    // Quand une nouvelle version de l'app vient d'être installée, on recharge pour l'afficher tout de suite
    const hadController = !!navigator.serviceWorker.controller;
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController || reloaded) return;
      reloaded = true;
      location.reload();
    });
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
})();
