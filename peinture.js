window.addEventListener('load', function () {

// ============================================================================
//  DECO CEC BORDEAUX - peinture et stickers sur la voiture, en realite augmentee
//
//  Principe technique important :
//  Le modele 3D (export STEP) n'a AUCUNE coordonnee UV et aucune texture.
//  Impossible donc de peindre sur une texture classique. On utilise deux
//  mecanismes complementaires :
//    - REMPLIR : on change la couleur du materiau de la piece visee.
//    - PINCEAU / LOGO : on colle des "decalques" (DecalGeometry), des morceaux
//      de surface redecoupes dans la piece, qui fabriquent leurs propres UV.
// ============================================================================

var status  = document.getElementById('status');
var overlay = document.getElementById('overlay');
var canvas  = document.getElementById('c');
var errbox  = document.getElementById('errbox');

// --- Verifications de depart ---
if (typeof THREE === 'undefined') {
  status.textContent = 'Erreur: Three.js non charge';
  return;
}
status.textContent = 'Three.js OK';

if (!navigator.xr) {
  status.textContent = 'WebXR non disponible';
} else {
  navigator.xr.isSessionSupported('immersive-ar').then(function (ok) {
    status.textContent = ok ? 'AR pret !' : 'AR non supporte';
    if (!ok) document.getElementById('btnCommencer').disabled = true;
  });
}

// --- Renderer / scene ---
var gl = canvas.getContext('webgl2', { xrCompatible: true }) ||
         canvas.getContext('webgl',  { xrCompatible: true });
var renderer = new THREE.WebGLRenderer({ canvas: canvas, context: gl, alpha: true, antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.xr.enabled = true;
renderer.xr.setReferenceSpaceType('local');

var scene  = new THREE.Scene();
var camera = new THREE.PerspectiveCamera(70, window.innerWidth / window.innerHeight, 0.01, 20);

scene.add(new THREE.AmbientLight(0xffffff, 1.5));
var dir = new THREE.DirectionalLight(0xffffff, 1);
dir.position.set(1, 2, 1);
scene.add(dir);

// --- Hierarchie ---
// anchor    : pose sur la table (position + orientation du hit-test)
//   carGroup : rotation libre de la voiture par l'utilisateur (grip)
//     carRoot  : le modele charge
//     decalques
//   panneau  : le menu flottant (ne tourne pas avec la voiture)
var anchor = new THREE.Group();
anchor.visible = false;
scene.add(anchor);
var anchorPlaced = false;

var carGroup = new THREE.Group();
anchor.add(carGroup);

// ============================================================================
//  ETAT DE L'OUTIL
// ============================================================================
var mode      = 'remplir';   // 'remplir' | 'pinceau' | 'logo' | 'gomme'
var couleurIdx = 2;          // index dans PALETTE
var logoIdx    = 0;          // index dans LOGOS
var tailleIdx  = 1;          // 0 = petit, 1 = moyen, 2 = grand

var PALETTE = [
  0xffffff, 0x111111, 0xc0392b, 0xe74c3c, 0xe67e22, 0xf1c40f,
  0x2ecc71, 0x16a085, 0x3498db, 0x2c3e8f, 0x9b59b6, 0xe84393
];

var LOGOS = [
  { nom: 'CEC', fichier: 'logo-cec.png', ratio: 842 / 595 },
  { nom: 'GMP', fichier: 'logo-gmp.png', ratio: 3827 / 2362 }
];

var TAILLES     = ['P', 'M', 'G'];
var TAILLE_SPRAY = [0.010, 0.020, 0.036];  // metres (voiture = 0.30 m de long)
var TAILLE_LOGO  = [0.030, 0.050, 0.080];

function couleurCourante() { return PALETTE[couleurIdx]; }

// ============================================================================
//  PANNEAU DE COMMANDE (canvas 2D -> texture)
//  Les zones sont declarees UNE SEULE FOIS et servent a la fois au dessin
//  et a la detection du clic : impossible qu'ils se desynchronisent.
// ============================================================================
var PW = 512, PH = 430;                 // taille du canvas
var PLANE_W = 0.5, PLANE_H = PLANE_W * PH / PW;

var Z = {
  remplir: { x: 8,   y: 40,  w: 118, h: 60 },
  pinceau: { x: 134, y: 40,  w: 118, h: 60 },
  logo:    { x: 260, y: 40,  w: 118, h: 60 },
  gomme:   { x: 386, y: 40,  w: 118, h: 60 },

  logo0:   { x: 8,   y: 248, w: 246, h: 58 },
  logo1:   { x: 262, y: 248, w: 242, h: 58 },

  annuler: { x: 8,   y: 316, w: 160, h: 50 },
  effacer: { x: 176, y: 316, w: 160, h: 50 },
  taille:  { x: 344, y: 316, w: 160, h: 50 },

  replacer:{ x: 8,   y: 372, w: 246, h: 50 },
  quitter: { x: 262, y: 372, w: 242, h: 50 }
};

// Les 12 pastilles de couleur : 6 par ligne
function zoneCouleur(i) {
  return { x: 8 + (i % 6) * 84, y: (i < 6 ? 126 : 178), w: 76, h: 46 };
}

var pc  = document.createElement('canvas');
pc.width = PW; pc.height = PH;
var ctx = pc.getContext('2d');
var tex = new THREE.CanvasTexture(pc);

function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x+r,y); c.lineTo(x+w-r,y); c.quadraticCurveTo(x+w,y,x+w,y+r);
  c.lineTo(x+w,y+h-r); c.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  c.lineTo(x+r,y+h); c.quadraticCurveTo(x,y+h,x,y+h-r);
  c.lineTo(x,y+r); c.quadraticCurveTo(x,y,x+r,y); c.closePath();
}

function hex(n) { return '#' + ('000000' + n.toString(16)).slice(-6); }

// Dessine un bouton rectangulaire avec un libelle centre
function bouton(z, fond, texte, actif, couleurTexte) {
  ctx.fillStyle = fond;
  rr(ctx, z.x, z.y, z.w, z.h, 10); ctx.fill();
  if (actif) {
    ctx.strokeStyle = '#ffee00'; ctx.lineWidth = 4;
    rr(ctx, z.x + 2, z.y + 2, z.w - 4, z.h - 4, 9); ctx.stroke();
  }
  ctx.fillStyle = couleurTexte || '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(texte, z.x + z.w / 2, z.y + z.h / 2 + 7);
}

// Le panneau ne change que lorsqu'on appuie sur un bouton. On evite donc de le
// redessiner et de le renvoyer a la carte graphique a chaque image (~90 fois/s).
var panneauSale = true;
function majPanneau() { panneauSale = true; }

function dessinerPanneau() {
  panneauSale = false;
  ctx.clearRect(0, 0, PW, PH);
  ctx.fillStyle = 'rgba(20,20,20,0.94)'; rr(ctx, 0, 0, PW, PH, 20); ctx.fill();

  // Titre
  ctx.fillStyle = '#4aa3df'; ctx.font = 'bold 22px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('DECORATION', PW / 2, 28);

  // --- Outils ---
  ctx.font = 'bold 16px sans-serif';
  bouton(Z.remplir, mode === 'remplir' ? '#2c5aa0' : '#333', 'REMPLIR', mode === 'remplir');
  bouton(Z.pinceau, mode === 'pinceau' ? '#2c5aa0' : '#333', 'PINCEAU', mode === 'pinceau');
  bouton(Z.logo,    mode === 'logo'    ? '#2c5aa0' : '#333', 'LOGO',    mode === 'logo');
  bouton(Z.gomme,   mode === 'gomme'   ? '#8e2b2b' : '#333', 'GOMME',   mode === 'gomme');

  // --- Palette de couleurs ---
  ctx.fillStyle = '#888'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('COULEUR', 10, 118);
  for (var i = 0; i < PALETTE.length; i++) {
    var z = zoneCouleur(i);
    ctx.fillStyle = hex(PALETTE[i]);
    rr(ctx, z.x, z.y, z.w, z.h, 8); ctx.fill();
    // Contour clair pour que le noir et le blanc restent visibles
    ctx.strokeStyle = (i === couleurIdx) ? '#ffee00' : '#666';
    ctx.lineWidth  = (i === couleurIdx) ? 5 : 1;
    rr(ctx, z.x, z.y, z.w, z.h, 8); ctx.stroke();
  }

  // --- Logos ---
  ctx.fillStyle = '#888'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('LOGO A COLLER', 10, 240);
  ctx.font = 'bold 18px sans-serif';
  bouton(Z.logo0, logoIdx === 0 ? '#2c5aa0' : '#333', LOGOS[0].nom, mode === 'logo' && logoIdx === 0);
  bouton(Z.logo1, logoIdx === 1 ? '#2c5aa0' : '#333', LOGOS[1].nom, mode === 'logo' && logoIdx === 1);

  // --- Actions ---
  ctx.font = 'bold 15px sans-serif';
  bouton(Z.annuler, '#444', 'ANNULER', false);
  bouton(Z.effacer, '#8e2b2b', 'TOUT EFFACER', false);
  bouton(Z.taille,  '#444', 'TAILLE : ' + TAILLES[tailleIdx], false);

  ctx.font = 'bold 16px sans-serif';
  bouton(Z.replacer, anchorPlaced ? '#2c5aa0' : '#ff8800',
         anchorPlaced ? 'REPLACER LA VOITURE' : 'VISEZ ET APPUYEZ', false);
  bouton(Z.quitter, '#8e2b2b', 'QUITTER', false);

  tex.needsUpdate = true;
}

var panneau = new THREE.Mesh(
  new THREE.PlaneGeometry(PLANE_W, PLANE_H),
  new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
);
panneau.position.set(0, 0.45, 0);
panneau.visible = false;
anchor.add(panneau);

// Renvoie l'identifiant de la zone touchee a partir des coordonnees UV du plan
function zoneTouchee(uv) {
  var cx = uv.x * PW;
  var cy = (1 - uv.y) * PH;
  function dans(z) { return cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h; }

  for (var cle in Z) { if (dans(Z[cle])) return cle; }
  for (var i = 0; i < PALETTE.length; i++) { if (dans(zoneCouleur(i))) return 'couleur' + i; }
  return null;
}

// ============================================================================
//  VISEUR DE PLACEMENT (avant de poser la voiture)
// ============================================================================
var reticleMatrix = new THREE.Matrix4();

var preview = new THREE.Group();
preview.add(new THREE.Mesh(
  new THREE.RingGeometry(0.17, 0.19, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xff8800, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
));
preview.add(new THREE.Mesh(
  new THREE.RingGeometry(0.02, 0.05, 24).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xff8800, side: THREE.DoubleSide })
));
preview.visible = false;
scene.add(preview);

var hitTestSource = null;
var hitTestSourceRequested = false;

// ============================================================================
//  CHARGEMENT DE LA VOITURE
// ============================================================================
var pieces = [];   // toutes les pieces peignables (THREE.Mesh)
var carPret = false;

function ajusterTaille(objet, tailleCible) {
  var box = new THREE.Box3().setFromObject(objet);
  var taille = new THREE.Vector3();
  box.getSize(taille);
  var maxDim = Math.max(taille.x, taille.y, taille.z);
  if (maxDim > 0) objet.scale.setScalar(tailleCible / maxDim);
}

var loader = new THREE.GLTFLoader();

function chargerVoiture() {
  loader.load('Voiture_CEC_Bordeaux.glb', function (gltf) {
    var root = gltf.scene;
    ajusterTaille(root, 0.30);
    carGroup.add(root);

    // Recentrer la voiture sur l'ancre et la poser sur la table
    root.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(root);
    var centre = new THREE.Vector3();
    box.getCenter(centre);
    root.position.sub(centre);            // centre horizontalement
    root.position.y += (centre.y - box.min.y) + 0.01;  // pose le bas sur la table

    // IMPORTANT : le materiau n0 est partage entre la carrosserie et le bloc
    // propulseur. Sans clonage, colorier la carrosserie colorierait aussi le
    // moteur. On donne donc a chaque piece son propre materiau.
    root.traverse(function (o) {
      if (!o.isMesh) return;
      if (Array.isArray(o.material)) {
        o.material = o.material.map(function (m) { return m.clone(); });
        o.userData.couleursOrigine = o.material.map(function (m) { return m.color.getHex(); });
      } else {
        o.material = o.material.clone();
        o.userData.couleursOrigine = [o.material.color.getHex()];
      }
      pieces.push(o);
    });

    carGroup.updateMatrixWorld(true);
    carPret = true;
    panneau.visible = true;
  }, undefined, function (e) {
    errbox.textContent = 'Erreur GLB: ' + e;
  });
}

// ============================================================================
//  DECALQUES (peinture au pinceau + logos)
// ============================================================================
var decals     = [];         // pile des decalques poses (pour ANNULER)
var MAX_DECALS = 400;        // au-dela, on supprime les plus anciens
var ordreDecal = 0;

// Texture du pinceau : un rond flou blanc, teinte ensuite par la couleur choisie.
function creerTextureSpray() {
  var c = document.createElement('canvas');
  c.width = c.height = 64;
  var g = c.getContext('2d');
  var grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0.00, 'rgba(255,255,255,1)');
  grad.addColorStop(0.55, 'rgba(255,255,255,0.95)');
  grad.addColorStop(1.00, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}
var texSpray = creerTextureSpray();

// Un materiau par couleur (partage entre tous les decalques de cette couleur)
var matSprayCache = {};
function matSpray(couleur) {
  if (!matSprayCache[couleur]) {
    matSprayCache[couleur] = new THREE.MeshStandardMaterial({
      map: texSpray, color: couleur, roughness: 0.55, metalness: 0,
      transparent: true, depthTest: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    });
  }
  return matSprayCache[couleur];
}

// Un materiau par logo
var texLoader = new THREE.TextureLoader();
var matLogoCache = {};
function matLogo(i) {
  if (!matLogoCache[i]) {
    var t = texLoader.load(LOGOS[i].fichier);
    t.anisotropy = 4;
    matLogoCache[i] = new THREE.MeshStandardMaterial({
      map: t, roughness: 0.5, metalness: 0,
      transparent: true, depthTest: true, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    });
  }
  return matLogoCache[i];
}

var orienteur = new THREE.Object3D();   // sert a calculer l'orientation du decalque

/**
 * Colle un decalque sur la piece visee.
 * @param {Object} inter  resultat de raycaster.intersectObjects
 * @param {THREE.Material} materiau
 * @param {THREE.Vector3}  taille  dimensions de la boite de projection
 * @param {number} rotation  rotation du sticker autour de sa normale (radians)
 */
function collerDecal(inter, materiau, taille, rotation) {
  var mesh = inter.object;
  if (!mesh.isMesh || !inter.face) return null;

  // Orientation : le decalque regarde dans le sens de la normale de la surface
  var n = inter.face.normal.clone();
  n.transformDirection(mesh.matrixWorld);

  orienteur.position.copy(inter.point);
  orienteur.lookAt(inter.point.clone().add(n));
  orienteur.rotateZ(rotation || 0);

  var geo;
  try {
    geo = new THREE.DecalGeometry(mesh, inter.point, orienteur.rotation, taille);
  } catch (e) {
    return null;
  }
  // Rien n'a ete decoupe (on a vise le bord) : inutile de creer un mesh vide
  if (!geo.attributes.position || geo.attributes.position.count === 0) {
    geo.dispose();
    return null;
  }

  var m = new THREE.Mesh(geo, materiau);
  m.renderOrder = ++ordreDecal;

  // La geometrie est en coordonnees MONDE : on ajoute a la scene sans
  // transformation, puis .attach() la rattache a la voiture en conservant
  // sa position, pour qu'elle suive les rotations et deplacements.
  scene.add(m);
  carGroup.attach(m);

  // Memorise le centre (repere carGroup) pour la gomme
  geo.computeBoundingSphere();
  var c = geo.boundingSphere.center.clone();
  m.updateMatrixWorld(true);
  m.userData.centre = c.applyMatrix4(m.matrix);

  decals.push(m);
  if (decals.length > MAX_DECALS) supprimerDecal(decals.shift());
  return m;
}

function supprimerDecal(m) {
  if (!m) return;
  carGroup.remove(m);
  if (m.geometry) m.geometry.dispose();   // le materiau est partage : on le garde
}

function annulerDernier() {
  if (!decals.length) return;
  supprimerDecal(decals.pop());
}

function toutEffacer() {
  while (decals.length) supprimerDecal(decals.pop());
  // Remet aussi les couleurs d'origine
  pieces.forEach(function (o) {
    var orig = o.userData.couleursOrigine;
    if (!orig) return;
    if (Array.isArray(o.material)) {
      o.material.forEach(function (m, i) { m.color.setHex(orig[i]); });
    } else {
      o.material.color.setHex(orig[0]);
    }
  });
}

// Efface les decalques proches du point vise
function gommer(inter) {
  var p = carGroup.worldToLocal(inter.point.clone());
  var rayon = TAILLE_SPRAY[tailleIdx] * 1.8;
  for (var i = decals.length - 1; i >= 0; i--) {
    if (decals[i].userData.centre && decals[i].userData.centre.distanceTo(p) < rayon) {
      supprimerDecal(decals[i]);
      decals.splice(i, 1);
    }
  }
}

// ============================================================================
//  MANETTES : rayon de visee
// ============================================================================
var controllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
var raycaster   = new THREE.Raycaster();
var tempMatrix  = new THREE.Matrix4();

function rayonDe(ctrl) {
  tempMatrix.identity().extractRotation(ctrl.matrixWorld);
  raycaster.ray.origin.setFromMatrixPosition(ctrl.matrixWorld);
  raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix);
  raycaster.far = 3;   // evite de peindre une voiture visee depuis l'autre bout de la piece
  return raycaster;
}

// Curseur circulaire pose sur la surface visee (montre la taille du pinceau)
var curseur = new THREE.Mesh(
  new THREE.RingGeometry(0.4, 0.5, 28),
  new THREE.MeshBasicMaterial({ color: 0xffee00, side: THREE.DoubleSide,
                                transparent: true, opacity: 0.9, depthTest: false })
);
curseur.renderOrder = 9999;
curseur.visible = false;
scene.add(curseur);

controllers.forEach(function (ctrl, idx) {
  scene.add(ctrl);
  // Le rayon de visee
  var geoL = new THREE.BufferGeometry().setFromPoints(
    [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1)]);
  var ligne = new THREE.Line(geoL, new THREE.LineBasicMaterial({
    color: 0xffffff, transparent: true, opacity: 0.7 }));
  ligne.scale.z = 1.5;
  ctrl.add(ligne);
  ctrl.userData.ligne = ligne;
});

// ============================================================================
//  ACTIONS
// ============================================================================
var peintureEnCours = -1;              // index de la manette qui peint
var dernierDab      = new THREE.Vector3();
var aDejaDab        = false;

function replacer() {
  anchorPlaced = false;
  preview.visible = true;
  majPanneau();   // le bouton redevient "VISEZ ET APPUYEZ"
}

function quitterAR() {
  try {
    var s = renderer.xr.getSession();
    if (s) s.end();
  } catch (e) {}
}

// Applique la couleur courante a la piece visee
function remplirPiece(inter) {
  var o = inter.object;
  if (!o.isMesh) return;
  if (Array.isArray(o.material)) {
    // Modele multi-materiaux : on ne colore que le sous-groupe touche
    var mi = (inter.face && inter.face.materialIndex) || 0;
    if (o.material[mi]) o.material[mi].color.setHex(couleurCourante());
  } else {
    o.material.color.setHex(couleurCourante());
  }
}

// Traite l'appui sur un bouton du panneau
function actionPanneau(cle) {
  if (cle === null) return;
  majPanneau();   // un bouton a ete presse : le panneau doit etre redessine

  if (cle.indexOf('couleur') === 0) {
    couleurIdx = parseInt(cle.slice(7), 10);
    // Choisir une couleur en mode LOGO ou GOMME bascule vers la peinture
    if (mode === 'logo' || mode === 'gomme') mode = 'remplir';
    return;
  }

  switch (cle) {
    case 'remplir': case 'pinceau': case 'gomme': mode = cle; break;
    case 'logo':  mode = 'logo'; break;
    case 'logo0': logoIdx = 0; mode = 'logo'; break;
    case 'logo1': logoIdx = 1; mode = 'logo'; break;
    case 'annuler': annulerDernier(); break;
    case 'effacer': toutEffacer(); break;
    case 'taille':  tailleIdx = (tailleIdx + 1) % TAILLES.length; break;
    case 'replacer': replacer(); break;
    case 'quitter':  quitterAR(); break;
  }
}

// Une action de decoration sur la voiture (un appui, ou un point du trace)
function agirSurVoiture(inter) {
  if (mode === 'remplir') {
    remplirPiece(inter);
  } else if (mode === 'pinceau') {
    var s = TAILLE_SPRAY[tailleIdx];
    collerDecal(inter, matSpray(couleurCourante()),
                new THREE.Vector3(s, s, s), Math.random() * Math.PI * 2);
  } else if (mode === 'logo') {
    var L = TAILLE_LOGO[tailleIdx];
    // On respecte les proportions du logo, et une profondeur suffisante
    // pour bien mordre dans la carrosserie courbe.
    collerDecal(inter, matLogo(logoIdx),
                new THREE.Vector3(L * LOGOS[logoIdx].ratio, L, Math.max(L, 0.05)), 0);
  } else if (mode === 'gomme') {
    gommer(inter);
  }
}

controllers.forEach(function (ctrl, idx) {

  ctrl.addEventListener('selectstart', function () {
    // 1er appui : poser la voiture sur la table
    if (!anchorPlaced) {
      anchor.visible = true;
      anchorPlaced   = true;
      preview.visible = false;
      majPanneau();   // le bouton devient "REPLACER LA VOITURE"
      return;
    }
    if (!carPret) return;

    var ray = rayonDe(controllers[idx]);

    // Le panneau est prioritaire sur la voiture
    var hitsP = ray.intersectObject(panneau, false);
    if (hitsP.length && hitsP[0].uv) {
      actionPanneau(zoneTouchee(hitsP[0].uv));
      return;
    }

    // Sinon : on decore la voiture
    var hits = ray.intersectObjects(pieces, false);
    if (!hits.length) return;

    agirSurVoiture(hits[0]);

    // En mode pinceau/gomme, on continue tant que la gachette est tenue
    if (mode === 'pinceau' || mode === 'gomme') {
      peintureEnCours = idx;
      dernierDab.copy(hits[0].point);
      aDejaDab = true;
    }
  });

  ctrl.addEventListener('selectend', function () {
    if (peintureEnCours === idx) {
      peintureEnCours = -1;
      aDejaDab = false;
    }
  });

  // Gachette laterale (grip) : faire tourner la voiture
  ctrl.addEventListener('squeezestart', function () {
    if (!anchorPlaced) return;
    rotationManette = idx;
    var p = new THREE.Vector3();
    controllers[idx].getWorldPosition(p);
    rotationDernierX = p.x;
  });

  ctrl.addEventListener('squeezeend', function () {
    if (rotationManette === idx) rotationManette = -1;
  });
});

var rotationManette  = -1;
var rotationDernierX = 0;

// ============================================================================
//  BOUCLE DE RENDU
// ============================================================================
var pTmp = new THREE.Vector3();

renderer.setAnimationLoop(function (time, frame) {

  // --- Phase de placement : hit-test sur la table ---
  if (frame && !anchorPlaced) {
    var session  = renderer.xr.getSession();
    var refSpace = renderer.xr.getReferenceSpace();

    if (!hitTestSourceRequested) {
      hitTestSourceRequested = true;
      try {
        session.requestReferenceSpace('viewer').then(function (viewerSpace) {
          session.requestHitTestSource({ space: viewerSpace }).then(function (source) {
            hitTestSource = source;
          }).catch(function () {});
        }).catch(function () {});
      } catch (e) {}
      session.addEventListener('end', function () {
        hitTestSourceRequested = false;
        hitTestSource = null;
      });
    }

    var cible = new THREE.Vector3();
    var surTable = false;
    if (hitTestSource && refSpace) {
      var hits = frame.getHitTestResults(hitTestSource);
      if (hits.length > 0) {
        var pose = hits[0].getPose(refSpace);
        reticleMatrix.fromArray(pose.transform.matrix);
        cible.setFromMatrixPosition(reticleMatrix);
        surTable = true;
      }
    }
    if (!surTable) controllers[0].getWorldPosition(cible);

    preview.position.copy(cible);
    preview.visible = true;

    anchor.position.copy(cible);
    if (surTable) anchor.quaternion.setFromRotationMatrix(reticleMatrix);
    if (carPret) anchor.visible = true;
  }

  if (anchorPlaced) preview.visible = false;

  // --- Rotation de la voiture au grip ---
  if (rotationManette >= 0 && anchorPlaced) {
    controllers[rotationManette].getWorldPosition(pTmp);
    carGroup.rotation.y += (pTmp.x - rotationDernierX) * 6;
    rotationDernierX = pTmp.x;
  }

  // --- Le panneau fait toujours face au regard ---
  if (anchor.visible && panneau.visible) {
    camera.getWorldPosition(pTmp);
    panneau.lookAt(pTmp);
  }

  // --- Visee : longueur du rayon, curseur, peinture continue ---
  curseur.visible = false;
  for (var i = 0; i < 2; i++) {
    var ctrl = controllers[i];
    if (!ctrl.userData.ligne) continue;
    var longueur = 1.5;

    if (anchorPlaced && carPret) {
      var ray = rayonDe(ctrl);
      var hp = ray.intersectObject(panneau, false);
      var hv = ray.intersectObjects(pieces, false);

      // Le plus proche des deux determine la longueur du rayon
      var dP = hp.length ? hp[0].distance : Infinity;
      var dV = hv.length ? hv[0].distance : Infinity;
      longueur = Math.min(dP, dV, 1.5);

      // Curseur sur la voiture (si la voiture est plus proche que le panneau)
      if (dV < dP) {
        var t = (mode === 'logo') ? TAILLE_LOGO[tailleIdx] : TAILLE_SPRAY[tailleIdx];
        if (mode === 'gomme')   t = TAILLE_SPRAY[tailleIdx] * 1.8;
        if (mode === 'remplir') t = 0.012;   // simple point de visee
        curseur.position.copy(hv[0].point);
        var nn = hv[0].face.normal.clone();
        nn.transformDirection(hv[0].object.matrixWorld);
        curseur.lookAt(hv[0].point.clone().add(nn));
        curseur.scale.setScalar(t);
        curseur.material.color.setHex(mode === 'gomme' ? 0xff4444 : couleurCourante());
        curseur.visible = true;
      }

      // Trace continu : nouvelle tache seulement si on a assez bouge
      if (peintureEnCours === i && hv.length) {
        var pas = TAILLE_SPRAY[tailleIdx] * 0.4;
        if (!aDejaDab || hv[0].point.distanceTo(dernierDab) > pas) {
          agirSurVoiture(hv[0]);
          dernierDab.copy(hv[0].point);
          aDejaDab = true;
        }
      }
    }
    ctrl.userData.ligne.scale.z = longueur;
  }

  if (panneauSale) dessinerPanneau();
  renderer.render(scene, camera);
});

// ============================================================================
//  ENTREE EN AR
// ============================================================================
document.getElementById('btnCommencer').addEventListener('click', function () {

  // Remise a zero complete
  toutEffacer();
  while (carGroup.children.length) carGroup.remove(carGroup.children[0]);
  pieces = [];
  carPret = false;
  carGroup.rotation.set(0, 0, 0);
  anchorPlaced = false;
  anchor.visible = false;
  panneau.visible = false;
  preview.visible = false;
  hitTestSourceRequested = false;
  hitTestSource = null;
  mode = 'remplir';
  peintureEnCours = -1;
  rotationManette = -1;
  majPanneau();

  navigator.xr.requestSession('immersive-ar', {
    optionalFeatures: ['hit-test', 'local-floor', 'local']
  }).then(function (session) {
    renderer.xr.setSession(session).then(function () {
      overlay.style.display = 'none';
      chargerVoiture();

      session.addEventListener('end', function () {
        overlay.style.display = 'flex';
      });
    }).catch(function (e2) {
      status.textContent = 'Erreur setSession: ' + e2.message;
    });
  }).catch(function (e) {
    status.textContent = 'Erreur AR: ' + e.message;
  });
});

}); // fin window.addEventListener('load', ...)
