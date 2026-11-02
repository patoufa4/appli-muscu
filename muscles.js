'use strict';

// Carte du corps (devant / derrière) avec les muscles travaillés en rouge.
// Chaque vue est dessinée pour la moitié gauche puis recopiée en miroir.
// [muscle, tracé SVG] — muscle null = partie du corps non musculaire (tête, mains, genoux…)

const MUSCLE_LABELS = {
  chest: 'Pectoraux', front_delts: 'Épaules (avant)', side_delts: 'Épaules (côté)', rear_delts: 'Épaules (arrière)',
  traps: 'Trapèzes', lats: 'Dorsaux', lower_back: 'Lombaires', biceps: 'Biceps', triceps: 'Triceps',
  forearms: 'Avant-bras', abs: 'Abdos', obliques: 'Obliques', quads: 'Quadriceps', adductors: 'Adducteurs',
  hamstrings: 'Ischios', glutes: 'Fessiers', calves: 'Mollets',
};

const BODY_COMMON = [
  [null, 'M50 2.5 Q57.5 2.5 57.5 12 Q57.5 21.5 50 21.5 Z'],               // tête
  [null, 'M46 20 L50 20 L50 27 L44.5 27 Z'],                              // cou
  [null, 'M25.5 89.5 Q29 88.5 30.5 90 Q31 96 28.5 100.5 Q25 100 23.5 96 Z'], // main
  [null, 'M38 128.5 Q42 127 46 129 Q46.5 133 45 136 Q41 134.5 37.5 136.5 Q37 132 38 128.5 Z'], // genou
  [null, 'M41 166 L44 164.5 Q45.5 170 46 175 Q41 177.5 36.5 175.5 Q38 170 41 166 Z'],            // pied
  ['forearms', 'M26 67 Q30 69 33.5 66.5 Q33 78 30.5 88.5 L26.5 89 Q23.5 78 26 67 Z'],
];

const BODY_FRONT = [
  ['traps', 'M44.5 25 Q40 29 34 31 L44.5 31 Z'],
  ['side_delts', 'M34 31 Q26.5 31.5 24.5 40 Q24 45 25.5 48 Q27 40 31 35 Z'],
  ['front_delts', 'M34 31 Q37 32 38 35 L37 42 Q31 44 25.5 48 Q27 40 31 35 Z'],
  ['chest', 'M38.5 32 Q44 30.5 49.6 31.5 L49.6 47 Q45 50.5 40 49.5 Q36.5 48 37.5 43 Z'],
  ['biceps', 'M26 50 Q30 47.5 34.5 50 Q35 58 33.5 64 Q30 67.5 26.5 65 Q24.5 57 26 50 Z'],
  ['abs', 'M44 50.5 L49.4 50.8 L49.4 57.5 L44 57 Z'],
  ['abs', 'M43.8 58.5 L49.4 59 L49.4 66 L43.8 65.5 Z'],
  ['abs', 'M43.6 67 L49.4 67.5 L49.4 74.5 L43.6 74 Z'],
  ['abs', 'M43.6 75.5 L49.4 76 L49.4 88 Q45.5 86 43.6 81 Z'],
  ['obliques', 'M38 50.5 Q40.5 51 42.6 51.5 L42.4 80 Q39 77 37.5 70 Q36 60 38 50.5 Z'],
  ['quads', 'M37 83 Q42.5 85 47.5 91 Q48 106 46 122 Q43 127.5 39 126 Q34.5 112 35 97 Q35.5 88 37 83 Z'],
  ['adductors', 'M48 92 Q49.8 93 49.8 97 L49 110 L47 118 Q48.8 104 48 92 Z'],
  ['calves', 'M37.5 138 Q41 135.5 44.5 138 Q46 150 44 163 L41 165 Q37 152 37.5 138 Z'],
];

const BODY_BACK = [
  ['traps', 'M44.5 21 L50 20.5 L50 54 Q46 47 43 39 Q39 35 33.5 32 Q41 29.5 44.5 25 Z'],
  ['rear_delts', 'M33.5 32 Q26 32.5 24.5 41 Q24.5 45.5 25.8 48 Q28 40 36 36 Z'],
  ['triceps', 'M26 50 Q30.5 47 35 50 Q35.5 58 34 64 Q30 67.5 26.5 65 Q24 57 26 50 Z'],
  ['lats', 'M37 37.5 Q41 40 44 46 Q47 54 48.5 62 Q44 70 40 73 Q36 62 35.5 50 Q35.5 42 37 37.5 Z'],
  ['lower_back', 'M45.5 63 Q48 62 49.6 62 L49.6 82 Q46 82 42.5 79.5 Q43 70 45.5 63 Z'],
  ['glutes', 'M36.5 83 Q43 80 49.6 84 L49.6 100 Q44 105 38.5 103 Q34.5 95 36.5 83 Z'],
  ['hamstrings', 'M37.5 106 Q43 108.5 48 106 Q48.5 117 46.5 127 Q43 131 39.5 129.5 Q35.5 118 37.5 106 Z'],
  ['calves', 'M37.5 137 Q41.5 134 45.5 137 Q47.5 149 44.5 161 L41 163.5 Q36.5 151 37.5 137 Z'],
];

// attrs(muscle) donne les attributs SVG de chaque zone (classe, opacité…)
function bodyMapSVG(view, attrs) {
  const shapes = [...BODY_COMMON, ...(view === 'front' ? BODY_FRONT : BODY_BACK)];
  const half = shapes.map(([m, d]) => `<path ${m ? `${attrs(m)} data-m="${m}"` : 'class="mb"'} d="${d}"/>`).join('');
  return `<svg class="bodymap" viewBox="20 0 60 180" role="img" aria-label="${view === 'front' ? 'Devant' : 'Derrière'}">
    <g>${half}</g><g transform="translate(100 0) scale(-1 1)">${half}</g></svg>`;
}

// Fiche exercice : muscles principaux en rouge, secondaires en rouge clair
function bodySVG(view, primary, secondary) {
  return bodyMapSVG(view, (m) => `class="${primary.includes(m) ? 'mp' : secondary.includes(m) ? 'ms' : 'm0'}"`);
}

// Onglet Volume : plus un muscle a de séries, plus il est rouge (intensity : muscle → 0..1)
function bodyHeatSVG(view, intensity) {
  return bodyMapSVG(view, (m) => (intensity[m] > 0
    ? `class="mh" fill-opacity="${(0.2 + 0.8 * intensity[m]).toFixed(2)}"`
    : 'class="m0"'));
}

// Muscles travaillés : [groupe, mots du nom (sans accents), principaux, secondaires] — la première règle qui correspond gagne
const MUSCLE_RULES = [
  ['pecs', /ecarte|pec deck|crossover/, ['chest'], ['front_delts']],
  ['pecs', /pull-over/, ['chest', 'lats'], ['triceps']],
  ['pecs', /incline/, ['chest', 'front_delts'], ['triceps']],
  ['pecs', null, ['chest'], ['front_delts', 'triceps']],

  ['dos', /traction|tirage vertical|pull-over|muscle-up/, ['lats'], ['biceps', 'rear_delts']],
  ['dos', /souleve|rack pull/, ['lower_back', 'glutes', 'hamstrings'], ['traps', 'quads', 'forearms']],
  ['dos', /shrug/, ['traps'], ['forearms']],
  ['dos', /lombaire|superman/, ['lower_back'], ['glutes', 'hamstrings']],
  ['dos', null, ['lats', 'traps'], ['rear_delts', 'biceps']],

  ['epaules', /laterale/, ['side_delts'], ['traps']],
  ['epaules', /frontale/, ['front_delts'], ['chest']],
  ['epaules', /oiseau|reverse pec|face pull|rotation|cuban/, ['rear_delts'], ['traps']],
  ['epaules', /rowing menton|y raise/, ['side_delts', 'traps'], ['front_delts']],
  ['epaules', null, ['front_delts', 'side_delts'], ['triceps', 'traps']],

  ['biceps', /marteau|zottman/, ['biceps', 'forearms'], []],
  ['biceps', null, ['biceps'], ['forearms']],

  ['triceps', /dips|prise serree|jm|pompes/, ['triceps', 'chest'], ['front_delts']],
  ['triceps', null, ['triceps'], []],

  ['jambes', /leg curl|nordic|glute ham/, ['hamstrings'], ['calves', 'glutes']],
  ['jambes', /roumain|jambes tendues|unilateral|good morning/, ['hamstrings', 'glutes'], ['lower_back']],
  ['jambes', /sumo|trap bar/, ['glutes', 'quads', 'hamstrings'], ['lower_back', 'traps', 'adductors']],
  ['jambes', /adducteur/, ['adductors'], []],
  ['jambes', /leg extension|sissy|chaise/, ['quads'], []],
  ['jambes', null, ['quads', 'glutes'], ['adductors', 'hamstrings']],

  ['fessiers', /pull-through|hanche|reverse hyper/, ['glutes', 'hamstrings'], ['lower_back']],
  ['fessiers', null, ['glutes'], ['hamstrings']],

  ['mollets', null, ['calves'], []],

  ['abdos', /oblique|russian|woodchopper|laterale|rotation|gainage lateral|pallof/, ['obliques'], ['abs']],
  ['abdos', /copenhagen/, ['adductors', 'obliques'], ['abs']],
  ['abdos', /bird dog|superman/, ['lower_back', 'abs'], ['glutes']],
  ['abdos', null, ['abs'], ['obliques']],

  ['avant-bras', /farmer/, ['forearms', 'traps'], []],
  ['avant-bras', null, ['forearms'], []],

  ['cardio', /rameur/, ['lats', 'quads'], ['biceps', 'hamstrings']],
  ['cardio', /swing/, ['glutes', 'hamstrings'], ['lower_back']],
  ['cardio', /thruster|wall ball/, ['quads', 'front_delts'], ['glutes', 'triceps']],
  ['cardio', /battle/, ['front_delts', 'side_delts'], ['abs']],
  ['cardio', /epaule|arrache/, ['glutes', 'hamstrings', 'traps'], ['quads', 'front_delts']],
  ['cardio', /turkish/, ['obliques', 'front_delts'], ['glutes']],
  ['cardio', null, ['quads', 'calves'], ['glutes', 'hamstrings']],
];

function musclesFor(group, nameNorm) {
  const rule = MUSCLE_RULES.find(([g, re]) => g === group && (!re || re.test(nameNorm)));
  return rule ? { primary: rule[2], secondary: rule[3] } : { primary: [], secondary: [] };
}
