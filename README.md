# Menu, s'il te plaît 🍽️

Planificateur de repas TDAH-friendly : tu choisis un plat parmi 3 options pour
chaque repas de la semaine (petit-déj, déjeuner, dîner), tu règles le nombre
de personnes, et l'appli génère la liste de courses groupée par rayon.
Les recettes suivent le rééquilibrage "bol Maju" (1/2 légumes, 1/4 protéines,
1/4 féculents) et prennent ≤ 30 min en semaine (un peu plus le week-end).

C'est une PWA installable (utilisable hors-ligne pour l'interface), avec un
petit backend Node/Express et une base SQLite embarquée (module natif
`node:sqlite`, aucune dépendance à compiler).

## Lancer en local

Prérequis : Node.js **22.5+** (le module `node:sqlite` est intégré à Node,
pas besoin d'installer de base de données à part).

```bash
npm install
npm start
```

Puis ouvrir http://localhost:3000 — la base SQLite se crée automatiquement
dans `data/menu.sqlite` au premier lancement (ignorée par git).

En développement, `npm run dev` relance le serveur automatiquement à chaque
modification (`node --watch`).

## Comment ça marche

- **Ma semaine** : pour chaque jour × repas, 3 recettes sont proposées.
  Tape sur un repas pour choisir, régler le nombre de personnes, et (pour
  le dîner) cocher "+1 part pour demain midi" si tu veux cuisiner en double
  pour le lendemain.
- **Courses** : bouton "Actualiser la liste" pour regénérer les quantités à
  partir du plan de la semaine, regroupées par rayon (Fruits & légumes,
  Viandes/poissons/œufs, Crèmerie, Épicerie, Surgelés, Épices, Boulangerie).
  Les cases cochées sont mémorisées sur l'appareil (localStorage).
- **Recette** : accessible depuis le picker ("Voir la recette") ou d'un tap
  sur l'icône 📖 dans le planning — ingrédients recalculés pour le nombre de
  personnes choisi, étapes courtes, épices mises en avant.

## Structure du projet

```
server/
  index.js         → serveur Express + routes API (/api/week, /api/plan, /api/shopping-list, /api/recipes/:id)
  db.js            → schéma SQLite + seed automatique au premier démarrage
  seed/recipes.js  → contenu des 24 recettes (ingrédients, étapes, tags TDAH)
  seed/weekOptions.js → les 3 options proposées par jour/repas
public/
  index.html, css/style.css, js/app.js → PWA (vanilla JS, pas de build)
  manifest.webmanifest, sw.js, icons/, fonts/ → PWA offline (polices auto-hébergées)
scripts/make-icons.js → génère les icônes PNG (encodeur PNG maison, zéro dépendance)
```

## Modifier le contenu (recettes, options de la semaine)

- Ajouter/éditer une recette : `server/seed/recipes.js`.
- Changer quelles 3 recettes sont proposées un jour donné : `server/seed/weekOptions.js`.
- Après modification, supprimer `data/menu.sqlite` pour forcer un re-seed au
  prochain démarrage (le plan de la semaine en cours sera réinitialisé).

## Déploiement sur Hostinger

Ce projet est pensé pour tourner tel quel sur un hébergement qui supporte
Node.js (Hostinger Business propose "Setup Node.js App" dans hPanel, sous
Avancé, sur les plans qui l'incluent — sinon il faudra passer par un VPS
Hostinger, où Node.js s'installe librement).

Étapes générales :

1. Vérifier dans hPanel → Avancé si "Node.js" est disponible sur ton plan.
   Si oui : créer une appli Node.js pointant sur ce dossier, fichier de
   démarrage `server/index.js`, port fourni par Hostinger via la variable
   d'env `PORT` (déjà géré dans `server/index.js`).
2. Uploader le projet (sans `node_modules/` ni `data/`), puis `npm install`
   depuis le terminal Node.js d'hPanel.
3. Le dossier `data/` sera recréé automatiquement avec la base SQLite au
   premier lancement — s'assurer que le dossier du projet est bien
   accessible en écriture.
4. Démarrer l'appli depuis hPanel ; elle écoute sur `process.env.PORT`.

Si le plan Hostinger ne propose pas Node.js, il faudra soit passer sur un
VPS Hostinger, soit adapter le backend en PHP + MySQL (l'architecture API
REST actuelle — `/api/week`, `/api/plan`, `/api/shopping-list`,
`/api/recipes/:id` — se porte assez directement, seul `server/` serait à
réécrire, `public/` restant identique).

## Notes / choix assumés pour cette V1

- Usage solo, pas d'authentification.
- Un seul plan "semaine" actif (pas d'historique de semaines passées).
- Les cases cochées de la liste de courses vivent en local (localStorage),
  pas en base — simple à faire évoluer si besoin plus tard (multi-appareil).
