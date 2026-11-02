# Muscu — suivi de perfs à la salle

Petite web app (PWA) pour iPhone : choisir son programme puis sa séance, noter séries / reps / poids,
voir ses perfs de la dernière fois, l'historique et les courbes de progression.
Tout est stocké **sur le téléphone** (IndexedDB), et l'app marche **sans réseau**.

## Programmes et séances

- Un **programme** (ex : PPL, Upper / Lower) contient des **séances** (ex : Push, Pull, Legs),
  et chaque séance contient une liste d'**exercices**.
- **Créer** : onglet Séance → *+ Nouveau programme* → donne-lui un nom → *+ Ajouter une séance*
  pour chaque séance.
- **Modifier** : ouvre le programme → *Modifier ce programme* → renomme-le, ajoute / modifie /
  supprime des séances, et change leur **ordre** avec les flèches ↑ ↓.
- **Le cycle** : les séances tournent dans l'ordre (ex : Push → Pull → Legs → Push…). En ouvrant
  le programme, l'app t'affiche en gros **la séance du jour** : celle qui suit la dernière que
  tu as faite. Si tu fais une autre séance à la place, le cycle reprend après celle-ci.
- **Changer de programme** : touche simplement un autre programme dans la liste. Le dernier utilisé
  est marqué *Actuel* et apparaît en premier.
- Tes perfs sont liées au **nom de l'exercice**, pas au programme : si tu passes de PPL à
  Upper / Lower, « Développé couché » garde son historique et sa courbe. Écris donc les noms
  d'exercices toujours de la même façon.
- Supprimer un programme ne supprime **jamais** ton historique.

## Bibliothèque d'exercices

- ~280 exercices, à chercher en français ou en anglais (« chest », « curl », « rdl »…).
- Bouton **i** (dans la recherche, la séance ou l'éditeur) : **fiche** avec la carte du corps
  (muscles principaux en rouge, secondaires en rouge clair).

## Volume (séries par muscle)

- Onglet **Volume** : nombre de séries par muscle sur la **semaine**, la **semaine passée**,
  le **dernier cycle** (les N dernières séances de ton programme) ou les **30 derniers jours**.
- **Séries** = le muscle est le principal de l'exercice. **Indirectes** = il travaille en soutien
  (ex : triceps au développé couché). Seules les séries cochées ✓ comptent.
- La carte du corps est plus rouge sur les muscles qui ont le plus travaillé.
- Les exercices perso (créés hors bibliothèque) ne sont pas comptés.

## Les fichiers

| Fichier | Rôle |
|---|---|
| `index.html` | La page (structure + barre d'onglets) |
| `style.css` | L'apparence (thème sombre, gros boutons) |
| `app.js` | Toute la logique : séances, saisie, historique, courbes, recherche, export/import |
| `exercises.js` | La bibliothèque d'exercices (nom, mots-clés) |
| `muscles.js` | La carte du corps et les muscles travaillés par exercice (sert aussi au Volume) |
| `sw.js` | Le *service worker* : garde l'app en mémoire pour le hors-ligne |
| `manifest.json` | Nom, icône, plein écran quand l'app est installée |
| `icons/` | Les icônes de l'app |

---

## 1. Tester sur ton Mac

1. Ouvre le **Terminal** et lance (dans le dossier de l'app) :
   ```bash
   cd ~/appli-muscu && ruby -run -e httpd . -p 8000
   ```
2. Ouvre **http://localhost:8000** dans Safari ou Chrome.
3. Pour voir la taille iPhone : dans Chrome, `Cmd + Option + I` puis l'icône téléphone ;
   dans Safari, menu *Développement > Passer en mode de conception adaptative*.
4. `Ctrl + C` dans le Terminal pour arrêter le serveur.

> Après une modification du code, recharge **deux fois** la page : la 1re fois,
> l'app affiche la version gardée en mémoire (c'est ce qui la fait marcher hors-ligne).

## 2. Mettre en ligne gratuitement (GitHub Pages)

1. Crée un compte sur **https://github.com** (gratuit).
2. En haut à droite : **+** → **New repository**.
   - Nom : `appli-muscu`
   - Laisse **Public** (obligatoire pour GitHub Pages gratuit — seul le *code* est public,
     tes données restent sur ton téléphone).
   - Clique **Create repository**.
3. Sur la page du dépôt, clique le lien **uploading an existing file**.
4. Dans le Finder, ouvre le dossier `appli-muscu`, sélectionne **tous les fichiers et le dossier
   `icons`**, et glisse-les dans la page GitHub. Clique **Commit changes**.
5. Va dans **Settings** → **Pages** (menu de gauche).
   - *Source* : **Deploy from a branch**
   - *Branch* : **main** et **/ (root)** → **Save**.
6. Attends 1 à 2 minutes, puis recharge la page *Pages* : l'adresse s'affiche, du type
   **`https://TON-PSEUDO.github.io/appli-muscu/`**. Ouvre-la pour vérifier.

## 3. Installer sur l'iPhone

1. Sur l'iPhone, ouvre l'adresse ci-dessus **dans Safari** (pas Chrome).
2. Touche le bouton **Partager** (carré avec flèche vers le haut).
3. Fais défiler et choisis **Sur l'écran d'accueil**.
4. Vérifie que **Ouvrir en tant qu'app web** est activé, puis **Ajouter**.
5. Lance l'app depuis l'icône 🏋️ : elle s'ouvre en plein écran.
6. **Test hors-ligne** : active le mode Avion et relance l'app → elle doit marcher.

⚠️ Utilise toujours l'**icône** de l'écran d'accueil : les données de l'app installée
sont séparées de celles de l'onglet Safari.

## 4. Sauvegarder tes données

*Réglages → Exporter mes données* ouvre la feuille de partage : choisis
**Enregistrer dans Fichiers** (iCloud Drive par exemple). Fais-le de temps en temps.
Si tu changes de téléphone ou supprimes l'app : *Réglages → Importer une sauvegarde*.
L'import **fusionne** (il n'efface rien).

## 5. Mettre à jour l'app plus tard

Remplace les fichiers modifiés sur GitHub (*Add file → Upload files*). Sur l'iPhone,
ouvre l'app avec du réseau, ferme-la complètement, rouvre-la : la nouvelle version est là.
Tes données ne sont pas touchées.
