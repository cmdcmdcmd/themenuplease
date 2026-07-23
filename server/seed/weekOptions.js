// Pour chaque jour et chaque repas : les 3 recettes proposées au choix.
// Les jours de semaine ne piochent que dans les recettes ≤30 min ;
// le week-end mélange 2 recettes "spéciales week-end" (plus longues) + 1 recette classique.

const DAYS = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const MEALS = ["petit-dej", "dejeuner", "diner"];

const weekOptions = {
  "petit-dej": {
    lundi: ["oeufs-brouilles-avocat", "porridge-choco-noisette", "yaourt-grec-granola"],
    mardi: ["porridge-choco-noisette", "yaourt-grec-granola", "tartine-avocat-oeuf-poche"],
    mercredi: ["yaourt-grec-granola", "tartine-avocat-oeuf-poche", "smoothie-bowl-proteine"],
    jeudi: ["tartine-avocat-oeuf-poche", "smoothie-bowl-proteine", "pain-perdu-sale"],
    vendredi: ["smoothie-bowl-proteine", "pain-perdu-sale", "oeufs-brouilles-avocat"],
    samedi: ["pain-perdu-sale", "oeufs-brouilles-avocat", "porridge-choco-noisette"],
    dimanche: ["oeufs-brouilles-avocat", "tartine-avocat-oeuf-poche", "pain-perdu-sale"],
  },
  dejeuner: {
    lundi: ["bol-poulet-cumin-legumes-rotis", "lentilles-corail-curry-epinards", "pates-completes-thon-tomates"],
    mardi: ["quinoa-pois-chiches-rotis", "wrap-dinde-houmous", "saumon-brocoli-riz"],
    mercredi: ["bol-texmex-haricots-rouges", "bol-poulet-cumin-legumes-rotis", "lentilles-corail-curry-epinards"],
    jeudi: ["pates-completes-thon-tomates", "quinoa-pois-chiches-rotis", "wrap-dinde-houmous"],
    vendredi: ["saumon-brocoli-riz", "bol-texmex-haricots-rouges", "bol-poulet-cumin-legumes-rotis"],
    samedi: ["bol-poulet-cumin-legumes-rotis", "curry-pois-chiches-patate-douce", "poulet-roti-legumes-racines"],
    dimanche: ["saumon-brocoli-riz", "curry-pois-chiches-patate-douce", "poulet-roti-legumes-racines"],
  },
  diner: {
    lundi: ["dinde-poivrons-riz-paprika", "soupe-lentilles-corail-carotte", "oeufs-poches-epinards-patate-douce"],
    mardi: ["saute-poulet-brocoli-nouilles-sesame", "cabillaud-brocoli-quinoa", "chili-sin-carne"],
    mercredi: ["crevettes-ail-courgettes-riz", "dinde-poivrons-riz-paprika", "soupe-lentilles-corail-carotte"],
    jeudi: ["oeufs-poches-epinards-patate-douce", "saute-poulet-brocoli-nouilles-sesame", "cabillaud-brocoli-quinoa"],
    vendredi: ["chili-sin-carne", "crevettes-ail-courgettes-riz", "dinde-poivrons-riz-paprika"],
    samedi: ["soupe-lentilles-corail-carotte", "papillote-saumon-herbes", "chili-con-carne-mijote"],
    dimanche: ["cabillaud-brocoli-quinoa", "papillote-saumon-herbes", "chili-con-carne-mijote"],
  },
};

module.exports = { DAYS, MEALS, weekOptions };
