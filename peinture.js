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
// anchor    : pose sur la table
//   carGroup : rotation libre de la voiture (grip)
//     carRoot + decalques
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
var equipe     = '';
var mode       = 'remplir';   // 'remplir' | 'pinceau' | 'logo' | 'gomme'
var couleurIdx = 2;
var logoIdx    = 0;
var tailleIdx  = 1;           // 0 = petit, 1 = moyen, 2 = grand
var rotationLogo = 0;         // orientation du sticker, pilotee au joystick

var PALETTE = [
  0xffffff, 0x111111, 0xc0392b, 0xe74c3c, 0xe67e22, 0xf1c40f,
  0x2ecc71, 0x16a085, 0x3498db, 0x2c3e8f, 0x9b59b6, 0xe84393
];

var LOGOS = [
  { nom: 'CEC', fichier: 'logo-cec.png', ratio: 842 / 595 },
  { nom: 'GMP', fichier: 'logo-gmp.png', ratio: 3827 / 2362 }
];

var TAILLES      = ['P', 'M', 'G'];
// Ecart volontairement large entre les 3 crans pour que la difference saute aux yeux
var TAILLE_SPRAY = [0.008, 0.020, 0.045];   // voiture = 0.30 m de long
var TAILLE_LOGO  = [0.025, 0.050, 0.090];

function couleurCourante() { return PALETTE[couleurIdx]; }

// ============================================================================
//  DIFFUSION VERS L'ECRAN SPECTATEUR
//  Mode "broadcast" de Supabase Realtime : rien n'est ecrit en base de donnees.
//  Canal DISTINCT de celui du jeu d'assemblage (vr-cec-live) pour ne pas
//  melanger les deux activites. Tout est enrobe de try/catch : si la diffusion
//  echoue, l'appli de peinture continue de fonctionner normalement.
// ============================================================================
var SB_URL  = 'https://ggmlfbxppgeivfvlxxrj.supabase.co';
var SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImdnbWxmYnhwcGdlaXZmdmx4eHJqIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzNDY5NTIsImV4cCI6MjA5NzkyMjk1Mn0.HvPE2ewB8gFgVzj-xAb1YBxFfn8hTEwOwQLDfF1vgT0';
var CANAL_DECO = 'vr-cec-deco';

var canalLive = null;
var canalPret = false;
var SID = Math.random().toString(36).slice(2, 10);
var messagePhoto = '';        // texte temporaire affiche sur le bouton PHOTO
var opSeq = 0;                // numero unique par operation de decoration

function nb(v) { return Math.round(v * 100000) / 100000; }

function initDiffusion() {
  try {
    if (typeof supabase === 'undefined') return;
    var client = supabase.createClient(SB_URL, SB_ANON);
    canalLive = client.channel(CANAL_DECO);
    // Un spectateur qui arrive demande l'etat courant : on lui envoie l'instantane
    canalLive.on('broadcast', { event: 'join' }, function () {
      if (carPret) envoyer('snap', construireSnap());
    });
    canalLive.subscribe(function (statut) {
      canalPret = (statut === 'SUBSCRIBED');
      if (canalPret) diffuserPresence(true);
      majPanneau();
    });
  } catch (e) { canalLive = null; canalPret = false; }
}

function envoyer(evenement, donnees) {
  try {
    if (!canalLive || !canalPret) return false;
    canalLive.send({ type: 'broadcast', event: evenement, payload: donnees });
    return true;
  } catch (e) { return false; }
}

// ---- Capture de la voiture telle que l'utilisateur la voit --------------
// En session AR, le rendu part vers l'affichage du casque : on ne peut pas
// relire le canvas. On refait donc une passe de rendu dans une cible hors
// ecran, avec une camera placee exactement a la pose de la tete.
var teteMatrice = new THREE.Matrix4();
var teteConnue  = false;
var camPhoto    = new THREE.PerspectiveCamera(60, 4 / 3, 0.01, 20);

function capturer(largeur, hauteur, qualite) {
  if (!teteConnue || !carPret) return null;
  try {
    // On masque les elements d'interface : seule la voiture doit etre sur la photo
    var etats = [panneau.visible, curseur.visible, preview.visible];
    panneau.visible = curseur.visible = preview.visible = false;
    var apercuVisible = apercu ? apercu.visible : false;
    if (apercu) apercu.visible = false;
    controllers.forEach(function (c) { if (c.userData.ligne) c.userData.ligne.visible = false; });

    camPhoto.aspect = largeur / hauteur;
    camPhoto.updateProjectionMatrix();
    camPhoto.matrix.copy(teteMatrice);
    camPhoto.matrix.decompose(camPhoto.position, camPhoto.quaternion, camPhoto.scale);
    camPhoto.updateMatrixWorld(true);

    var rt = new THREE.WebGLRenderTarget(largeur, hauteur);
    var xrEtait = renderer.xr.enabled;
    var fondEtait = renderer.getClearColor(new THREE.Color());
    var alphaEtait = renderer.getClearAlpha();

    // xr.enabled = false : sinon le moteur remplace notre camera par celle du casque
    renderer.xr.enabled = false;
    renderer.setRenderTarget(rt);
    renderer.setClearColor(0x162032, 1);   // fond neutre (le passthrough n'est pas capturable)
    renderer.clear();
    renderer.render(scene, camPhoto);
    renderer.setRenderTarget(null);
    renderer.setClearColor(fondEtait, alphaEtait);
    renderer.xr.enabled = xrEtait;

    var buf = new Uint8Array(largeur * hauteur * 4);
    renderer.readRenderTargetPixels(rt, 0, 0, largeur, hauteur, buf);
    rt.dispose();

    // Retablit l'interface
    panneau.visible = etats[0]; curseur.visible = etats[1]; preview.visible = etats[2];
    if (apercu) apercu.visible = apercuVisible;
    controllers.forEach(function (c) { if (c.userData.ligne) c.userData.ligne.visible = true; });

    // WebGL rend l'image a l'envers : on la retourne en la recopiant
    var cv = document.createElement('canvas');
    cv.width = largeur; cv.height = hauteur;
    var c2 = cv.getContext('2d');
    var img = c2.createImageData(largeur, hauteur);
    for (var y = 0; y < hauteur; y++) {
      var src = (hauteur - 1 - y) * largeur * 4;
      img.data.set(buf.subarray(src, src + largeur * 4), y * largeur * 4);
    }
    c2.putImageData(img, 0, 0);
    return cv.toDataURL('image/jpeg', qualite);
  } catch (e) {
    return null;
  }
}

// ---- Vue en direct : on diffuse les DONNEES de decoration (comme le jeu
// d'assemblage), pas une image du casque. L'ecran spectateur reconstruit la
// voiture en 3D avec le meme modele. Trois messages :
//   'pres'  ~5 fois/s : presence + rotation de la voiture (fluidite)
//   'add'   a chaque action : une operation a rejouer
//   'del'   annulation / gomme : operations a retirer
//   'clr'   tout effacer
//   'snap'  etat complet, envoye a un spectateur qui vient d'arriver
var dernierePres = 0;
function diffuserPresence(force) {
  var t = performance.now();
  if (!force && t - dernierePres < 200) return;
  dernierePres = t;
  envoyer('pres', {
    sid: SID, equipe: equipe,
    rotY: carGroup.rotation.y, nb: actions.length, ts: Date.now()
  });
}

function diffuserAjout(id, op)  { envoyer('add', { sid: SID, equipe: equipe, id: id, op: op }); }
function diffuserRetrait(ids)   { envoyer('del', { sid: SID, ids: ids }); }
function diffuserClear()        { envoyer('clr', { sid: SID, equipe: equipe }); }

// Etat complet : les couleurs de pieces modifiees + tous les decalques visibles.
// On lit l'etat REEL (et non la pile d'actions) pour que la gomme soit
// correctement reflechie.
function construireSnap() {
  var fills = [];
  pieces.forEach(function (o, pi) {
    var orig = o.userData.couleursOrigine || [];
    if (Array.isArray(o.material)) {
      o.material.forEach(function (m, mi) {
        if (m.color.getHex() !== orig[mi]) fills.push({ p: pi, mi: mi, c: m.color.getHex() });
      });
    } else if (o.material.color.getHex() !== orig[0]) {
      fills.push({ p: pi, mi: 0, c: o.material.color.getHex() });
    }
  });
  var decals = [];
  carGroup.children.forEach(function (o) {
    if (o.userData && o.userData.decal && o.userData.payload) {
      decals.push({ id: o.userData.opId, op: o.userData.payload });
    }
  });
  return { sid: SID, equipe: equipe, rotY: carGroup.rotation.y, fills: fills, decals: decals };
}

// Photo definitive, ajoutee a la galerie du spectateur
function prendrePhoto() {
  var img = capturer(512, 384, 0.6);
  if (!img) { messagePhoto = 'PHOTO IMPOSSIBLE'; }
  else if (envoyer('photo', { sid: SID, equipe: equipe, img: img, ts: Date.now() })) {
    messagePhoto = 'PHOTO ENVOYEE !';
  } else {
    messagePhoto = 'SPECTATEUR HORS LIGNE';
  }
  majPanneau();
  setTimeout(function () { messagePhoto = ''; majPanneau(); }, 2200);
}

// ============================================================================
//  PANNEAU DE COMMANDE (canvas 2D -> texture)
//  Les zones sont declarees UNE SEULE FOIS et servent a la fois au dessin
//  et a la detection du clic : impossible qu'ils se desynchronisent.
// ============================================================================
var PW = 512, PH = 584;
var PLANE_W = 0.55, PLANE_H = PLANE_W * PH / PW;

var Z = {
  remplir: { x: 8,   y: 36,  w: 118, h: 56 },
  pinceau: { x: 134, y: 36,  w: 118, h: 56 },
  logo:    { x: 260, y: 36,  w: 118, h: 56 },
  gomme:   { x: 386, y: 36,  w: 118, h: 56 },

  // Trois boutons de taille distincts (et non un bouton qui fait defiler :
  // on voit d'un coup d'oeil le cran actif)
  tailleP: { x: 8,   y: 234, w: 160, h: 52 },
  tailleM: { x: 176, y: 234, w: 160, h: 52 },
  tailleG: { x: 344, y: 234, w: 160, h: 52 },

  logo0:   { x: 8,   y: 310, w: 246, h: 54 },
  logo1:   { x: 262, y: 310, w: 242, h: 54 },

  annuler: { x: 8,   y: 378, w: 160, h: 52 },
  refaire: { x: 176, y: 378, w: 160, h: 52 },
  effacer: { x: 344, y: 378, w: 160, h: 52 },

  photo:   { x: 8,   y: 440, w: 496, h: 52 },

  replacer:{ x: 8,   y: 500, w: 246, h: 52 },
  quitter: { x: 262, y: 500, w: 242, h: 52 }
};

function zoneCouleur(i) {
  return { x: 8 + (i % 6) * 84, y: (i < 6 ? 116 : 164), w: 76, h: 44 };
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

function bouton(z, fond, texte, actif, couleurTexte) {
  ctx.fillStyle = fond;
  rr(ctx, z.x, z.y, z.w, z.h, 10); ctx.fill();
  if (actif) {
    ctx.strokeStyle = '#ffee00'; ctx.lineWidth = 4;
    rr(ctx, z.x + 2, z.y + 2, z.w - 4, z.h - 4, 9); ctx.stroke();
  }
  ctx.fillStyle = couleurTexte || '#fff';
  ctx.textAlign = 'center';
  ctx.fillText(texte, z.x + z.w / 2, z.y + z.h / 2 + 6);
}

// Le panneau ne change que lorsqu'on appuie sur un bouton. On evite donc de le
// redessiner et de le renvoyer a la carte graphique a chaque image (~90 fois/s).
var panneauSale = true;
function majPanneau() { panneauSale = true; }

function dessinerPanneau() {
  panneauSale = false;
  ctx.clearRect(0, 0, PW, PH);
  ctx.fillStyle = 'rgba(20,20,20,0.94)'; rr(ctx, 0, 0, PW, PH, 20); ctx.fill();

  ctx.fillStyle = '#4aa3df'; ctx.font = 'bold 22px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(equipe ? equipe.toUpperCase() : 'DECORATION', PW / 2, 26);

  // --- Outils ---
  ctx.font = 'bold 16px sans-serif';
  bouton(Z.remplir, mode === 'remplir' ? '#2c5aa0' : '#333', 'REMPLIR', mode === 'remplir');
  bouton(Z.pinceau, mode === 'pinceau' ? '#2c5aa0' : '#333', 'PINCEAU', mode === 'pinceau');
  bouton(Z.logo,    mode === 'logo'    ? '#2c5aa0' : '#333', 'LOGO',    mode === 'logo');
  bouton(Z.gomme,   mode === 'gomme'   ? '#8e2b2b' : '#333', 'GOMME',   mode === 'gomme');

  // --- Palette ---
  ctx.fillStyle = '#888'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('COULEUR', 10, 110);
  for (var i = 0; i < PALETTE.length; i++) {
    var z = zoneCouleur(i);
    ctx.fillStyle = hex(PALETTE[i]);
    rr(ctx, z.x, z.y, z.w, z.h, 8); ctx.fill();
    ctx.strokeStyle = (i === couleurIdx) ? '#ffee00' : '#666';
    ctx.lineWidth  = (i === couleurIdx) ? 5 : 1;
    rr(ctx, z.x, z.y, z.w, z.h, 8); ctx.stroke();
  }

  // --- Taille ---
  ctx.fillStyle = '#888'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('TAILLE', 10, 228);
  ctx.font = 'bold 18px sans-serif';
  bouton(Z.tailleP, tailleIdx === 0 ? '#2c5aa0' : '#333', 'PETIT',  tailleIdx === 0);
  bouton(Z.tailleM, tailleIdx === 1 ? '#2c5aa0' : '#333', 'MOYEN',  tailleIdx === 1);
  bouton(Z.tailleG, tailleIdx === 2 ? '#2c5aa0' : '#333', 'GRAND',  tailleIdx === 2);

  // --- Logos ---
  ctx.fillStyle = '#888'; ctx.font = '14px sans-serif'; ctx.textAlign = 'left';
  ctx.fillText('LOGO A COLLER  (joystick = tourner)', 10, 304);
  ctx.font = 'bold 18px sans-serif';
  bouton(Z.logo0, logoIdx === 0 ? '#2c5aa0' : '#333', LOGOS[0].nom, mode === 'logo' && logoIdx === 0);
  bouton(Z.logo1, logoIdx === 1 ? '#2c5aa0' : '#333', LOGOS[1].nom, mode === 'logo' && logoIdx === 1);

  // --- Actions ---
  ctx.font = 'bold 15px sans-serif';
  bouton(Z.annuler, actions.length ? '#444' : '#262626', 'ANNULER', false,
         actions.length ? '#fff' : '#666');
  bouton(Z.refaire, refaire.length ? '#444' : '#262626', 'RETABLIR', false,
         refaire.length ? '#fff' : '#666');
  bouton(Z.effacer, '#8e2b2b', 'TOUT EFFACER', false);

  // Bouton PHOTO : envoie la voiture telle que tu la vois vers l'ecran spectateur
  ctx.font = 'bold 19px sans-serif';
  bouton(Z.photo, messagePhoto ? '#1e7a3a' : '#27ae60',
         messagePhoto || 'PHOTO  ->  ECRAN SPECTATEUR', false);

  ctx.font = 'bold 16px sans-serif';
  bouton(Z.replacer, anchorPlaced ? '#2c5aa0' : '#ff8800',
         anchorPlaced ? 'REPLACER LA VOITURE' : 'VISEZ ET APPUYEZ', false);
  bouton(Z.quitter, '#8e2b2b', 'QUITTER', false);

  // Ligne d'info
  ctx.fillStyle = '#777'; ctx.font = '14px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText(actions.length + ' action(s)' +
               (refaire.length ? '  -  ' + refaire.length + ' a retablir' : '') +
               (canalPret ? '   -   spectateur connecte' : '   -   spectateur hors ligne'),
               PW / 2, 572);

  tex.needsUpdate = true;
}

var panneau = new THREE.Mesh(
  new THREE.PlaneGeometry(PLANE_W, PLANE_H),
  new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
);
panneau.position.set(0, 0.5, 0);
panneau.visible = false;
anchor.add(panneau);

function zoneTouchee(uv) {
  var cx = uv.x * PW;
  var cy = (1 - uv.y) * PH;
  function dans(z) { return cx >= z.x && cx <= z.x + z.w && cy >= z.y && cy <= z.y + z.h; }
  for (var cle in Z) { if (dans(Z[cle])) return cle; }
  for (var i = 0; i < PALETTE.length; i++) { if (dans(zoneCouleur(i))) return 'couleur' + i; }
  return null;
}

// ============================================================================
//  VISEUR DE PLACEMENT
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
var pieces = [];
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

    // ATTENTION : tout le recentrage se fait TANT QUE root n'a PAS de parent.
    // Box3.setFromObject renvoie des coordonnees MONDE : si root etait deja
    // rattache a l'ancre (posee a 1 ou 2 m dans la piece), on soustrairait un
    // decalage monde a une position locale et la voiture partirait hors de vue.
    ajusterTaille(root, 0.30);
    root.updateMatrixWorld(true);
    var box = new THREE.Box3().setFromObject(root);
    var centre = new THREE.Vector3();
    box.getCenter(centre);
    root.position.sub(centre);
    root.position.y += (centre.y - box.min.y) + 0.01;

    carGroup.add(root);

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
    majPanneau();
  }, undefined, function (e) {
    errbox.textContent = 'Erreur GLB: ' + e;
  });
}

// ============================================================================
//  DECALQUES (peinture au pinceau + logos)
// ============================================================================
var ordreDecal = 0;

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

var orienteur = new THREE.Object3D();

// Fabrique la geometrie d'un decalque (coordonnees MONDE) sans creer de mesh.
function geoDecal(inter, taille, rotation) {
  var mesh = inter.object;
  if (!mesh.isMesh || !inter.face) return null;

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
  // Rien n'a ete decoupe (on a vise le bord) : inutile de garder une geometrie vide
  if (!geo.attributes.position || geo.attributes.position.count === 0) {
    geo.dispose();
    return null;
  }
  return geo;
}

// Parametres compacts permettant a l'ecran spectateur de recreer le MEME
// decalque : indice de piece + point + ORIENTATION COMPLETE (quaternion)
// exprimes dans le repere de la voiture (donc independants de sa rotation) +
// taille. On stocke le quaternion et non "normale + rotation" : l'orientation
// du motif autour de la normale depend sinon du "haut" du monde, et le decalque
// serait vrille differemment sur une voiture tournee autrement.
var _qInv = new THREE.Quaternion();
var _qW   = new THREE.Quaternion();
var _orP  = new THREE.Object3D();   // reproduit le projecteur pour lire son orientation
function paramsDecal(inter, tailleVec, rotation) {
  var mesh = inter.object;
  var pi = pieces.indexOf(mesh);
  var lp = carGroup.worldToLocal(inter.point.clone());

  // Orientation monde du projecteur, exactement comme dans geoDecal
  var n = inter.face.normal.clone().transformDirection(mesh.matrixWorld);
  _orP.position.copy(inter.point);
  _orP.lookAt(inter.point.clone().add(n));
  _orP.rotateZ(rotation || 0);
  _qW.copy(_orP.quaternion);                 // sans parent : monde = local

  // Passage dans le repere de la voiture
  carGroup.getWorldQuaternion(_qInv).invert();
  var qL = _qInv.multiply(_qW);

  return [pi, nb(lp.x), nb(lp.y), nb(lp.z),
          nb(qL.x), nb(qL.y), nb(qL.z), nb(qL.w),
          nb(tailleVec.x), nb(tailleVec.y), nb(tailleVec.z)];
}

// Fusionne plusieurs geometries de decalques en une seule.
// Toutes sont en coordonnees MONDE, donc concatener les attributs suffit.
// C'est ce qui permet qu'un trace de 300 taches ne coute qu'UN seul appel de
// rendu au lieu de 300 - et donc que la peinture ne soit plus jamais effacee.
function fusionner(geos) {
  var total = 0, i;
  for (i = 0; i < geos.length; i++) total += geos[i].attributes.position.count;

  var pos = new Float32Array(total * 3);
  var nor = new Float32Array(total * 3);
  var uv  = new Float32Array(total * 2);
  var o3 = 0, o2 = 0;

  for (i = 0; i < geos.length; i++) {
    var g = geos[i];
    pos.set(g.attributes.position.array, o3);
    nor.set(g.attributes.normal.array,   o3);
    uv.set(g.attributes.uv.array,        o2);
    o3 += g.attributes.position.count * 3;
    o2 += g.attributes.position.count * 2;
  }

  var out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal',   new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv',       new THREE.BufferAttribute(uv,  2));
  return out;
}

// Cree le mesh d'un ensemble de geometries fusionnees et le rattache a la voiture.
// La fusion RECOPIE toujours les donnees : les geometries sources peuvent donc
// etre liberees sans risque, y compris quand il n'y en a qu'une seule.
function poserMesh(geos, materiau) {
  if (!geos.length) return null;
  var geo = fusionner(geos);
  geos.forEach(function (g) { g.dispose(); });

  var m = new THREE.Mesh(geo, materiau);
  m.renderOrder = ++ordreDecal;
  m.userData.decal = true;

  // La geometrie est en coordonnees MONDE : on ajoute a la scene sans
  // transformation, puis .attach() la rattache a la voiture en conservant
  // sa position, pour qu'elle suive les rotations et deplacements.
  scene.add(m);
  carGroup.attach(m);

  geo.computeBoundingSphere();
  var c = geo.boundingSphere.center.clone();
  m.updateMatrixWorld(true);
  m.userData.centre = c.applyMatrix4(m.matrix);
  m.userData.rayon  = geo.boundingSphere.radius;
  return m;
}

// ============================================================================
//  HISTORIQUE : ANNULER / RETABLIR
//  Une "action" = un trace complet, un sticker, un remplissage ou un coup de
//  gomme. Le plafond ne porte QUE sur la memoire d'annulation : les meshes
//  eux-memes ne sont jamais supprimes, donc la peinture ne disparait jamais.
// ============================================================================
var actions   = [];    // pile des actions annulables
var refaire   = [];    // pile des actions retablissables
var MAX_HISTORIQUE = 200;

// Meshes temporaires affiches pendant le trace (retour visuel immediat),
// remplaces par un unique mesh fusionne quand on relache la gachette.
var provisoires    = [];
var traceAffichees = 0;

function nettoyerProvisoires() {
  provisoires.forEach(function (m) { carGroup.remove(m); });
  provisoires.length = 0;
  traceAffichees = 0;
}

function empiler(action) {
  actions.push(action);
  if (actions.length > MAX_HISTORIQUE) actions.shift();  // on oublie, on ne supprime pas
  refaire.length = 0;    // une nouvelle action invalide la pile "retablir"
  majPanneau();
}

function appliquerCouleur(a, versApres) {
  var cible = versApres ? a.apres : a.avant;
  if (Array.isArray(a.mesh.material)) a.mesh.material[a.idx].color.setHex(cible);
  else a.mesh.material.color.setHex(cible);
}

function annuler() {
  if (!actions.length) return;
  var a = actions.pop();

  if (a.type === 'peinture') {
    carGroup.remove(a.mesh);
    diffuserRetrait([a.opId]);
  } else if (a.type === 'couleur') {
    appliquerCouleur(a, false);
    diffuserRetrait([a.opId]);            // le spectateur revient a la couleur d'avant
  } else if (a.type === 'gomme') {
    a.meshes.forEach(function (m) { carGroup.add(m); });
    a.meshes.forEach(function (m) { diffuserAjout(m.userData.opId, m.userData.payload); });
  }

  refaire.push(a);
  majPanneau();
}

function retablir() {
  if (!refaire.length) return;
  var a = refaire.pop();

  if (a.type === 'peinture') {
    carGroup.add(a.mesh);
    diffuserAjout(a.opId, a.payload);
  } else if (a.type === 'couleur') {
    appliquerCouleur(a, true);
    diffuserAjout(a.opId, a.payload);
  } else if (a.type === 'gomme') {
    a.meshes.forEach(function (m) { carGroup.remove(m); });
    diffuserRetrait(a.removedIds);
  }

  actions.push(a);
  majPanneau();
}

function toutEffacer() {
  // Retire tous les decalques (tout ce qui n'est pas une piece de la voiture)
  nettoyerProvisoires();
  for (var i = carGroup.children.length - 1; i >= 0; i--) {
    var o = carGroup.children[i];
    if (o.userData && o.userData.decal) {
      carGroup.remove(o);
      if (o.geometry) o.geometry.dispose();
    }
  }
  pieces.forEach(function (o) {
    var orig = o.userData.couleursOrigine;
    if (!orig) return;
    if (Array.isArray(o.material)) o.material.forEach(function (m, i) { m.color.setHex(orig[i]); });
    else o.material.color.setHex(orig[0]);
  });
  actions.length = 0;
  refaire.length = 0;
  majPanneau();
  diffuserClear();
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
  raycaster.far = 3;
  return raycaster;
}

var curseur = new THREE.Mesh(
  new THREE.RingGeometry(0.4, 0.5, 28),
  new THREE.MeshBasicMaterial({ color: 0xffee00, side: THREE.DoubleSide,
                                transparent: true, opacity: 0.9, depthTest: false })
);
curseur.renderOrder = 9999;
curseur.visible = false;
scene.add(curseur);

// Apercu du sticker avant de le coller : un decalque translucide recalcule
// seulement quand on bouge assez ou qu'on tourne le joystick.
var apercu = null;
var apercuPos = new THREE.Vector3();
var apercuRot = -999;
var apercuValide = false;

var matApercuCache = {};
function matApercu(i) {
  if (!matApercuCache[i]) {
    var base = matLogo(i);
    matApercuCache[i] = new THREE.MeshBasicMaterial({
      map: base.map, transparent: true, opacity: 0.55,
      depthTest: false, depthWrite: false
    });
  }
  return matApercuCache[i];
}

function effacerApercu() {
  if (apercu) { carGroup.remove(apercu); apercu.geometry.dispose(); apercu = null; }
  apercuValide = false;
}

function majApercu(inter) {
  var L = TAILLE_LOGO[tailleIdx];
  // Profondeur juste suffisante pour mordre dans la carrosserie courbe, sans
  // traverser toute la voiture (ce qui collerait aussi le logo en dessous).
  var prof = Math.max(L * 0.5, 0.025);
  var taille = new THREE.Vector3(L * LOGOS[logoIdx].ratio, L, prof);

  var geo = geoDecal(inter, taille, rotationLogo);
  effacerApercu();
  if (!geo) return;

  apercu = new THREE.Mesh(geo, matApercu(logoIdx));
  apercu.renderOrder = 10000;
  scene.add(apercu);
  carGroup.attach(apercu);
  apercuPos.copy(inter.point);
  apercuRot = rotationLogo;
  apercuValide = true;
}

controllers.forEach(function (ctrl, idx) {
  scene.add(ctrl);
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
var peintureEnCours = -1;
var dernierDab      = new THREE.Vector3();
var aDejaDab        = false;
var traceGeos       = [];    // geometries accumulees pendant le trace courant
var traceParams     = [];    // parametres correspondants (pour le spectateur)
var traceMat        = null;
var gommeLot        = [];    // decalques effaces pendant le coup de gomme courant

function replacer() {
  anchorPlaced = false;
  preview.visible = true;
  majPanneau();
}

function quitterAR() {
  try {
    var s = renderer.xr.getSession();
    if (s) s.end();
  } catch (e) {}
}

function remplirPiece(inter) {
  var o = inter.object;
  if (!o.isMesh) return;
  var idx = 0, avant;
  if (Array.isArray(o.material)) {
    idx = (inter.face && inter.face.materialIndex) || 0;
    if (!o.material[idx]) return;
    avant = o.material[idx].color.getHex();
  } else {
    avant = o.material.color.getHex();
  }
  var apres = couleurCourante();
  if (avant === apres) return;

  var a = { type: 'couleur', mesh: o, idx: idx, avant: avant, apres: apres };
  appliquerCouleur(a, true);
  a.opId = ++opSeq;
  a.payload = { k: 'f', p: pieces.indexOf(o), mi: idx, c: apres, c0: avant };
  empiler(a);
  diffuserAjout(a.opId, a.payload);
}

// Efface les decalques proches du point vise (les meshes sont conserves pour
// pouvoir annuler le coup de gomme)
function gommer(inter) {
  var p = carGroup.worldToLocal(inter.point.clone());
  var rayon = TAILLE_SPRAY[tailleIdx] * 1.8;
  for (var i = carGroup.children.length - 1; i >= 0; i--) {
    var o = carGroup.children[i];
    if (!o.userData || !o.userData.decal || o.userData.centre === undefined) continue;
    if (o.userData.centre.distanceTo(p) < rayon + (o.userData.rayon || 0)) {
      carGroup.remove(o);
      gommeLot.push(o);
    }
  }
}

function actionPanneau(cle) {
  if (cle === null) return;
  majPanneau();

  if (cle.indexOf('couleur') === 0) {
    couleurIdx = parseInt(cle.slice(7), 10);
    if (mode === 'logo' || mode === 'gomme') mode = 'remplir';
    effacerApercu();
    return;
  }

  switch (cle) {
    case 'remplir': case 'pinceau': case 'gomme': mode = cle; effacerApercu(); break;
    case 'logo':  mode = 'logo'; break;
    case 'logo0': logoIdx = 0; mode = 'logo'; effacerApercu(); break;
    case 'logo1': logoIdx = 1; mode = 'logo'; effacerApercu(); break;
    case 'tailleP': tailleIdx = 0; effacerApercu(); break;
    case 'tailleM': tailleIdx = 1; effacerApercu(); break;
    case 'tailleG': tailleIdx = 2; effacerApercu(); break;
    case 'annuler': annuler(); break;
    case 'refaire': retablir(); break;
    case 'effacer': toutEffacer(); break;
    case 'photo':   prendrePhoto(); break;
    case 'replacer': replacer(); break;
    case 'quitter':  quitterAR(); break;
  }
}

// Une tache de peinture pendant un trace
function ajouterDab(inter) {
  var s = TAILLE_SPRAY[tailleIdx];
  var sz = new THREE.Vector3(s, s, s);
  var rot = Math.random() * Math.PI * 2;
  var geo = geoDecal(inter, sz, rot);
  if (geo) {
    traceGeos.push(geo);
    traceParams.push(paramsDecal(inter, sz, rot));   // meme rot que la geometrie
  }
}

controllers.forEach(function (ctrl, idx) {

  ctrl.addEventListener('selectstart', function () {
    if (!anchorPlaced) {
      anchor.visible  = true;
      anchorPlaced    = true;
      preview.visible = false;
      majPanneau();
      return;
    }
    if (!carPret) return;

    var ray = rayonDe(controllers[idx]);

    var hitsP = ray.intersectObject(panneau, false);
    if (hitsP.length && hitsP[0].uv) {
      actionPanneau(zoneTouchee(hitsP[0].uv));
      return;
    }

    var hits = ray.intersectObjects(pieces, false);
    if (!hits.length) return;

    if (mode === 'remplir') {
      remplirPiece(hits[0]);

    } else if (mode === 'logo') {
      // On colle l'apercu tel qu'il est affiche
      var L = TAILLE_LOGO[tailleIdx];
      var prof = Math.max(L * 0.5, 0.025);
      var szL = new THREE.Vector3(L * LOGOS[logoIdx].ratio, L, prof);
      var geo = geoDecal(hits[0], szL, rotationLogo);
      if (geo) {
        var params = paramsDecal(hits[0], szL, rotationLogo);
        var m = poserMesh([geo], matLogo(logoIdx));
        if (m) {
          m.userData.opId = ++opSeq;
          m.userData.payload = { k: 'l', li: logoIdx, d: [params] };
          empiler({ type: 'peinture', mesh: m, opId: m.userData.opId, payload: m.userData.payload });
          diffuserAjout(m.userData.opId, m.userData.payload);
        }
      }

    } else if (mode === 'pinceau') {
      traceGeos = [];
      traceParams = [];
      traceMat  = matSpray(couleurCourante());
      ajouterDab(hits[0]);
      peintureEnCours = idx;
      dernierDab.copy(hits[0].point);
      aDejaDab = true;

    } else if (mode === 'gomme') {
      gommeLot = [];
      gommer(hits[0]);
      peintureEnCours = idx;
      dernierDab.copy(hits[0].point);
      aDejaDab = true;
    }
  });

  ctrl.addEventListener('selectend', function () {
    if (peintureEnCours !== idx) return;
    peintureEnCours = -1;
    aDejaDab = false;

    if (mode === 'pinceau' && traceGeos.length) {
      // On retire d'abord les meshes provisoires : ils partagent les geometries
      // que poserMesh va fusionner puis liberer.
      nettoyerProvisoires();
      // Tout le trace devient UN seul mesh : 1 appel de rendu, 1 seule annulation
      var m = poserMesh(traceGeos, traceMat);
      var params = traceParams;
      traceGeos = []; traceParams = [];
      if (m) {
        m.userData.opId = ++opSeq;
        m.userData.payload = { k: 'p', c: couleurCourante(), d: params };
        empiler({ type: 'peinture', mesh: m, opId: m.userData.opId, payload: m.userData.payload });
        diffuserAjout(m.userData.opId, m.userData.payload);
      }
    } else if (mode === 'gomme' && gommeLot.length) {
      var ids = gommeLot.map(function (g) { return g.userData.opId; });
      empiler({ type: 'gomme', meshes: gommeLot, removedIds: ids });
      diffuserRetrait(ids);
      gommeLot = [];
    }
  });

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

// Lit l'axe horizontal du joystick (Quest : axes[2]). Sert a tourner le sticker.
function joystickX() {
  try {
    var s = renderer.xr.getSession();
    if (!s) return 0;
    var srcs = s.inputSources;
    for (var i = 0; i < srcs.length; i++) {
      var gp = srcs[i].gamepad;
      if (!gp || !gp.axes) continue;
      var v = (gp.axes.length >= 4) ? gp.axes[2] : gp.axes[0];
      if (Math.abs(v) > 0.15) return v;    // zone morte
    }
  } catch (e) {}
  return 0;
}

// ============================================================================
//  BOUCLE DE RENDU
// ============================================================================
var pTmp = new THREE.Vector3();
var lastTime = 0;

renderer.setAnimationLoop(function (time, frame) {

  var dt = lastTime ? Math.min((time - lastTime) / 1000, 0.1) : 0;
  lastTime = time;

  // Pose de la tete : sert a prendre la photo sous l'angle exact du joueur
  if (frame) {
    try {
      var rs = renderer.xr.getReferenceSpace();
      var vpose = rs ? frame.getViewerPose(rs) : null;
      if (vpose) { teteMatrice.fromArray(vpose.transform.matrix); teteConnue = true; }
    } catch (e) {}
  }

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

  // --- Joystick : orientation du sticker ---
  if (mode === 'logo') {
    var jx = joystickX();
    if (jx) rotationLogo += jx * dt * 2.5;
  }

  // --- Le panneau fait toujours face au regard ---
  if (anchor.visible && panneau.visible) {
    camera.getWorldPosition(pTmp);
    panneau.lookAt(pTmp);
  }

  // --- Visee : longueur du rayon, curseur, apercu, trace continu ---
  curseur.visible = false;
  var apercuAJour = false;

  for (var i = 0; i < 2; i++) {
    var ctrl = controllers[i];
    if (!ctrl.userData.ligne) continue;
    var longueur = 1.5;

    if (anchorPlaced && carPret) {
      var ray = rayonDe(ctrl);
      var hp = ray.intersectObject(panneau, false);
      var hv = ray.intersectObjects(pieces, false);

      var dP = hp.length ? hp[0].distance : Infinity;
      var dV = hv.length ? hv[0].distance : Infinity;
      longueur = Math.min(dP, dV, 1.5);

      if (dV < dP) {
        // Apercu du sticker (recalcule seulement si on a bouge ou tourne)
        if (mode === 'logo') {
          var bouge = !apercuValide || hv[0].point.distanceTo(apercuPos) > 0.003;
          var tourne = Math.abs(rotationLogo - apercuRot) > 0.02;
          if (bouge || tourne) majApercu(hv[0]);
          apercuAJour = true;
        } else {
          var t = TAILLE_SPRAY[tailleIdx];
          if (mode === 'gomme')   t = TAILLE_SPRAY[tailleIdx] * 1.8;
          if (mode === 'remplir') t = 0.012;
          curseur.position.copy(hv[0].point);
          var nn = hv[0].face.normal.clone();
          nn.transformDirection(hv[0].object.matrixWorld);
          curseur.lookAt(hv[0].point.clone().add(nn));
          curseur.scale.setScalar(t);
          curseur.material.color.setHex(mode === 'gomme' ? 0xff4444 : couleurCourante());
          curseur.visible = true;
        }
      }

      // Trace continu : nouvelle tache seulement si on a assez bouge
      if (peintureEnCours === i && hv.length) {
        var pas = TAILLE_SPRAY[tailleIdx] * 0.4;
        if (!aDejaDab || hv[0].point.distanceTo(dernierDab) > pas) {
          if (mode === 'pinceau')    ajouterDab(hv[0]);
          else if (mode === 'gomme') gommer(hv[0]);
          dernierDab.copy(hv[0].point);
          aDejaDab = true;
        }
      }
    }
    ctrl.userData.ligne.scale.z = longueur;
  }

  // Le sticker n'est plus vise : on retire l'apercu
  if (!apercuAJour && apercu) effacerApercu();

  // Retour visuel immediat pendant le trace : chaque nouvelle tache est
  // affichee telle quelle, en attendant la fusion au relachement.
  if (peintureEnCours >= 0 && mode === 'pinceau' && traceGeos.length > traceAffichees) {
    for (var k = traceAffichees; k < traceGeos.length; k++) {
      var mm = new THREE.Mesh(traceGeos[k], traceMat);
      mm.renderOrder = ++ordreDecal;
      scene.add(mm);
      carGroup.attach(mm);
      provisoires.push(mm);
    }
    traceAffichees = traceGeos.length;
  }

  if (panneauSale) dessinerPanneau();
  renderer.render(scene, camera);

  // Presence + rotation vers l'ecran spectateur (~5 fois/s)
  if (anchorPlaced && carPret) diffuserPresence(false);
});

// ============================================================================
//  ENTREE EN AR
// ============================================================================
document.getElementById('btnCommencer').addEventListener('click', function () {

  var nom = (document.getElementById('inputEquipe').value || '').trim();
  if (!nom) { status.textContent = 'Entrez le nom de votre equipe !'; return; }
  equipe = nom;

  toutEffacer();
  effacerApercu();
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
  rotationLogo = 0;
  traceGeos = [];
  traceParams = [];
  provisoires = [];
  traceAffichees = 0;
  majPanneau();
  // Nouvelle session : on annonce l'equipe et on repart d'une voiture vierge
  diffuserClear();
  diffuserPresence(true);

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

// --- Connexion a l'ecran spectateur ---
initDiffusion();

}); // fin window.addEventListener('load', ...)
