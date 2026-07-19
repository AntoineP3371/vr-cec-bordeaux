window.addEventListener('load', function () {

// --- Refs DOM ---
var status  = document.getElementById('status');
var overlay = document.getElementById('overlay');
var canvas  = document.getElementById('c');

// --- Classement (localStorage) ---
var STORAGE_KEY = 'cec_bordeaux_classement';

function chargerScores() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch (e) { return []; }
}

function sauvegarderScore(nom, temps) {
  var scores = chargerScores();
  scores.push({ nom: nom, temps: temps });
  scores.sort(function (a, b) { return a.temps - b.temps; });
  localStorage.setItem(STORAGE_KEY, JSON.stringify(scores));
}

function effacerScores() {
  localStorage.removeItem(STORAGE_KEY);
}

function pad(n) { return n < 10 ? '0' + n : '' + n; }

function formatTemps(t) {
  var cs = Math.floor((t % 1000) / 10);
  var s  = Math.floor(t / 1000) % 60;
  var m  = Math.floor(t / 60000);
  return pad(m) + ':' + pad(s) + ':' + pad(cs);
}

function afficherClassement(dernierTemps) {
  var scores = chargerScores();
  var html = '<table><tr><th>#</th><th>Nom</th><th>Temps</th></tr>';
  if (scores.length === 0) {
    html += '<tr><td colspan="3" style="color:#aaa;text-align:center">Aucun score</td></tr>';
  } else {
    scores.forEach(function (s, i) {
      var cls = '';
      if (i === 0) cls = 'rang-or';
      else if (i === 1) cls = 'rang-ag';
      else if (i === 2) cls = 'rang-br';
      html += '<tr class="' + cls + '"><td>' + (i+1) + '</td><td>' + s.nom + '</td><td>' + formatTemps(s.temps) + '</td></tr>';
    });
  }
  html += '</table>';
  document.getElementById('tableau').innerHTML = html;

  var elRes = document.getElementById('resultat');
  if (dernierTemps !== undefined) {
    elRes.textContent = 'Votre temps : ' + formatTemps(dernierTemps);
  } else {
    elRes.textContent = '';
  }
}

// --- Gestion des ecrans ---
function montrerEcranNom() {
  document.getElementById('screen-nom').style.display = '';
  document.getElementById('screen-classement').style.display = 'none';
  overlay.style.display = 'flex';
}

function montrerEcranClassement(temps) {
  document.getElementById('screen-nom').style.display = 'none';
  document.getElementById('screen-classement').style.display = '';
  document.getElementById('raz-zone').style.display = 'none';
  document.getElementById('raz-erreur').textContent = '';
  afficherClassement(temps);
  overlay.style.display = 'flex';
}

// --- Etat de session ---
var playerName     = '';
var sessionComplete = false;
var piecesAssemblees = [];   // uuids des pieces snappees

// --- Verification Three.js ---
status.textContent = 'Three.js OK: ' + (typeof THREE !== 'undefined');

if (typeof THREE === 'undefined') {
  status.textContent = 'Erreur: Three.js non charge';
  return;
}

if (!navigator.xr) {
  status.textContent = 'WebXR non disponible';
} else {
  navigator.xr.isSessionSupported('immersive-ar').then(function (ok) {
    status.textContent = ok ? 'AR pret !' : 'AR non supporte';
    if (!ok) document.getElementById('btnCommencer').disabled = true;
  });
}

// --- Three.js renderer ---
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

// --- Chrono ---
var chrono = { debut: null, enMarche: false, cumul: 0 };
function demarrer() {
  if (chrono.enMarche || sessionComplete) return;
  chrono.enMarche = true; chrono.debut = performance.now();
}
function arreter() {
  if (!chrono.enMarche) return;
  chrono.cumul += performance.now() - chrono.debut;
  chrono.enMarche = false;
}
function razChrono() {
  if (sessionComplete) return;
  arreter(); chrono.cumul = 0; chrono.debut = null;
}
// Repasse en mode placement : le cercle orange reapparait,
// la prochaine gachette repose toute la voiture ailleurs.
function replacer() {
  if (sessionComplete) return;
  anchorPlaced = false;
  preview.visible = true;
}
function tempsActuel() {
  return chrono.cumul + (chrono.enMarche ? performance.now() - chrono.debut : 0);
}

// --- Panneau chrono 3D (canvas 2D -> texture) ---
// 3 boutons : DEMARRER | ARRETER | RAZ CHRONO
// Layout canvas 512x250 :
//   - ligne nom joueur : y=28
//   - temps (gros) : y=95
//   - 3 boutons : y=115 h=88
//     DEMARRER x=8   w=160
//     ARRETER  x=176 w=160
//     RAZ      x=344 w=160
// Correspondance locale : lp.x < -0.083 => DEMARRER | < 0.083 => ARRETER | sinon => RAZ

var pc  = document.createElement('canvas');
pc.width = 512; pc.height = 310;
var ctx = pc.getContext('2d');
var tex = new THREE.CanvasTexture(pc);

function rr(c, x, y, w, h, r) {
  c.beginPath();
  c.moveTo(x+r,y); c.lineTo(x+w-r,y); c.quadraticCurveTo(x+w,y,x+w,y+r);
  c.lineTo(x+w,y+h-r); c.quadraticCurveTo(x+w,y+h,x+w-r,y+h);
  c.lineTo(x+r,y+h); c.quadraticCurveTo(x,y+h,x,y+h-r);
  c.lineTo(x,y+r); c.quadraticCurveTo(x,y,x+r,y); c.closePath();
}

function dessiner() {
  ctx.clearRect(0, 0, 512, 310);

  if (sessionComplete) {
    // Fond festif
    ctx.fillStyle = 'rgba(10,45,20,0.95)'; rr(ctx,0,0,512,310,20); ctx.fill();
    ctx.fillStyle = '#ffd700'; ctx.font = 'bold 46px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('BRAVO ' + (playerName || '').toUpperCase() + ' !', 256, 78);
    ctx.fillStyle = '#fff'; ctx.font = '24px sans-serif';
    ctx.fillText('tu as mis', 256, 128);
    ctx.fillStyle = '#27ae60'; ctx.font = 'bold 64px monospace';
    ctx.fillText(formatTemps(chrono.cumul), 256, 205);
    ctx.fillStyle = '#aaa'; ctx.font = '17px sans-serif';
    ctx.fillText('Retour au classement...', 256, 268);
  } else {
    // Fond normal
    ctx.fillStyle = 'rgba(20,20,20,0.93)'; rr(ctx,0,0,512,310,20); ctx.fill();

    // Nom du joueur
    ctx.fillStyle = '#aaa'; ctx.font = '16px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(playerName || '', 256, 28);

    // Temps
    ctx.fillStyle = '#fff'; ctx.font = 'bold 60px monospace';
    ctx.fillText(formatTemps(tempsActuel()), 256, 92);

    // --- Rangee 1 : DEMARRER | ARRETER | RAZ CHRONO (y=112 h=78) ---
    // Bouton DEMARRER (gauche)
    ctx.fillStyle = chrono.enMarche ? '#444' : '#27ae60';
    rr(ctx, 8, 112, 160, 78, 10); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 17px sans-serif';
    ctx.fillText('DEMARRER', 88, 157);

    // Bouton ARRETER (centre)
    ctx.fillStyle = chrono.enMarche ? '#c0392b' : '#444';
    rr(ctx, 176, 112, 160, 78, 10); ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.fillText('ARRETER', 256, 157);

    // Bouton RAZ CHRONO (droite)
    ctx.fillStyle = '#333';
    rr(ctx, 344, 112, 160, 78, 10); ctx.fill();
    ctx.fillStyle = '#aaa';
    ctx.fillText('RAZ', 424, 145);
    ctx.fillText('CHRONO', 424, 168);

    // --- Rangee 2 : REPLACER LA VOITURE (y=206 h=88) ---
    ctx.fillStyle = anchorPlaced ? '#2c5aa0' : '#ff8800';
    rr(ctx, 8, 206, 496, 88, 10); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = 'bold 22px sans-serif';
    ctx.fillText(anchorPlaced ? 'REPLACER LA VOITURE' : 'VISEZ ET APPUYEZ', 256, 258);
  }

  tex.needsUpdate = true;
}

var PANNEAU_H = 0.3027; // 0.5 * 310/512
var panneau = new THREE.Mesh(
  new THREE.PlaneGeometry(0.5, PANNEAU_H),
  new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
);
scene.add(panneau);

// --- Ancrage sur la table ---
var anchor      = new THREE.Group();
anchor.visible  = false;
scene.add(anchor);
var anchorPlaced = false;

// --- Viseur hit-test (anneau vert) ---
var reticle = new THREE.Mesh(
  new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0x27ae60 })
);
reticle.matrixAutoUpdate = false;
reticle.visible = false;
scene.add(reticle);

// --- Repere de placement (cercle orange = emprise voiture + pieces) ---
var preview = new THREE.Group();
// Grand cercle : emprise ou les pieces se dispersent (~0.4 m)
preview.add(new THREE.Mesh(
  new THREE.RingGeometry(0.42, 0.45, 48).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xff8800, side: THREE.DoubleSide, transparent: true, opacity: 0.9 })
));
// Cercle moyen : emprise de la voiture au centre
preview.add(new THREE.Mesh(
  new THREE.RingGeometry(0.16, 0.18, 40).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xffbb44, side: THREE.DoubleSide, transparent: true, opacity: 0.8 })
));
// Point central
preview.add(new THREE.Mesh(
  new THREE.RingGeometry(0.02, 0.05, 24).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xff8800, side: THREE.DoubleSide })
));
preview.visible = false;
scene.add(preview);

// ===================== DEMONSTRATION (tutoriel) =====================
var demoEnCours      = false;
var demoDejaProposee = false;
var demoMode         = 'propose';   // 'propose' | 'run' | 'fin'
var demoCaption      = '';
var demoT0           = 0;
var demoPhase        = -1;
var demoManette      = null;
var demoPiece        = null;
var demoDepart       = new THREE.Vector3();
var demoCible        = new THREE.Vector3();
var demoQuat         = new THREE.Quaternion();

// Textes des etapes (ASCII pour Wolvic) : legende courte + narration vocale
var demoCaps = [
  'La sphere blanche sert a attraper les pieces',
  'On approche la sphere de la piece',
  'GRIP (gachette laterale) : on attrape',
  'On deplace vers le cercle vert',
  'On relache le GRIP : aimantation'
];
var demoNarr = [
  'Voici la manette. La petite sphere blanche au bout sert a attraper les pieces.',
  'On approche la sphere blanche de la piece a poser.',
  'On appuie sur la gachette laterale, appelee grip, pour attraper la piece. Le bouton devient vert.',
  'On deplace la piece jusqu a son emplacement, indique par le cercle vert.',
  'On relache le grip, et la piece s aimante toute seule au bon endroit.'
];

// Synthese vocale (fr). Sans effet si non supportee par le navigateur.
function parler(txt) {
  try {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    var u = new SpeechSynthesisUtterance(txt);
    u.lang = 'fr-FR'; u.rate = 0.95; u.pitch = 1;
    window.speechSynthesis.speak(u);
  } catch (e) {}
}
function stopParole() { try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {} }

// Panneau de la demo (canvas 2D -> texture)
var dpc = document.createElement('canvas');
dpc.width = 512; dpc.height = 256;
var dpx = dpc.getContext('2d');
var dptex = new THREE.CanvasTexture(dpc);
var demoPrompt = new THREE.Mesh(
  new THREE.PlaneGeometry(0.4, 0.2),
  new THREE.MeshBasicMaterial({ map: dptex, transparent: true, depthWrite: false, side: THREE.DoubleSide })
);
demoPrompt.visible = false;
scene.add(demoPrompt);

// Halo d'attention (attire l'oeil sur l'element a observer)
var demoHalo = new THREE.Mesh(
  new THREE.RingGeometry(0.05, 0.078, 40),
  new THREE.MeshBasicMaterial({ color: 0xffee00, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false })
);
demoHalo.renderOrder = 999; demoHalo.visible = false;
scene.add(demoHalo);

// Marqueur vert de l'emplacement cible
var demoCibleMark = new THREE.Mesh(
  new THREE.RingGeometry(0.045, 0.065, 40),
  new THREE.MeshBasicMaterial({ color: 0x00e676, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthTest: false })
);
demoCibleMark.renderOrder = 998; demoCibleMark.visible = false;
scene.add(demoCibleMark);

// Etiquette de texte flottante, placee juste a cote de l'element observe
var dlc = document.createElement('canvas');
dlc.width = 512; dlc.height = 170;
var dlx = dlc.getContext('2d');
var dltex = new THREE.CanvasTexture(dlc);
var demoLabel = new THREE.Mesh(
  new THREE.PlaneGeometry(0.34, 0.113),
  new THREE.MeshBasicMaterial({ map: dltex, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide })
);
demoLabel.renderOrder = 1000; demoLabel.visible = false;
scene.add(demoLabel);

function dessinerDemoLabel(txt) {
  dlx.clearRect(0, 0, 512, 170);
  dlx.fillStyle = 'rgba(15,15,28,0.92)'; rr(dlx, 0, 0, 512, 170, 20); dlx.fill();
  dlx.strokeStyle = '#ffee00'; dlx.lineWidth = 4; rr(dlx, 2, 2, 508, 166, 20); dlx.stroke();
  dlx.fillStyle = '#fff'; dlx.font = 'bold 32px sans-serif'; dlx.textAlign = 'center';
  wrapText(dlx, txt, 256, 68, 466, 40);
  dltex.needsUpdate = true;
}

function wrapText(c, texte, x, y, maxW, lh) {
  var mots = texte.split(' '); var ligne = ''; var yy = y;
  for (var i = 0; i < mots.length; i++) {
    var test = ligne + mots[i] + ' ';
    if (c.measureText(test).width > maxW && i > 0) {
      c.fillText(ligne, x, yy); ligne = mots[i] + ' '; yy += lh;
    } else { ligne = test; }
  }
  c.fillText(ligne, x, yy);
}

function dessinerDemoPrompt() {
  dpx.clearRect(0, 0, 512, 256);
  dpx.fillStyle = 'rgba(15,15,28,0.95)'; rr(dpx, 0, 0, 512, 256, 18); dpx.fill();
  dpx.textAlign = 'center';
  if (demoMode === 'propose' || demoMode === 'fin') {
    var estFin = (demoMode === 'fin');
    dpx.fillStyle = '#4aa3df'; dpx.font = 'bold 30px sans-serif';
    dpx.fillText('DEMONSTRATION', 256, 52);
    dpx.fillStyle = '#ddd'; dpx.font = '19px sans-serif';
    dpx.fillText(estFin ? 'Rejouer la demonstration ?' : 'Voir comment poser une piece ?', 256, 88);
    dpx.fillStyle = '#27ae60'; rr(dpx, 40, 110, 180, 90, 12); dpx.fill();
    dpx.fillStyle = '#fff'; dpx.font = 'bold 26px sans-serif';
    dpx.fillText(estFin ? 'REVOIR' : 'OUI', 130, 165);
    dpx.fillStyle = '#555'; rr(dpx, 292, 110, 180, 90, 12); dpx.fill();
    dpx.fillStyle = '#fff';
    dpx.fillText(estFin ? 'FERMER' : 'NON', 382, 165);
  } else {
    dpx.fillStyle = '#4aa3df'; dpx.font = 'bold 22px sans-serif';
    dpx.fillText('DEMONSTRATION', 256, 42);
    dpx.fillStyle = '#fff'; dpx.font = 'bold 24px sans-serif';
    wrapText(dpx, demoCaption, 256, 96, 470, 32);
    dpx.fillStyle = '#888'; dpx.font = '14px sans-serif';
    dpx.fillText('(touche ce panneau pour passer)', 256, 234);
  }
  dptex.needsUpdate = true;
}

// Manette virtuelle stylisee (style Quest) : grip + gachette + sphere blanche
function creerDemoManette() {
  var g = new THREE.Group();
  var matCorps = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.6 });
  var corps = new THREE.Mesh(new THREE.CylinderGeometry(0.016, 0.021, 0.085, 20), matCorps);
  corps.position.set(0, -0.02, 0.01);
  g.add(corps);
  var tete = new THREE.Mesh(new THREE.SphereGeometry(0.03, 20, 16), matCorps);
  tete.position.set(0, 0.03, 0.0);
  g.add(tete);
  var anneau = new THREE.Mesh(new THREE.TorusGeometry(0.035, 0.006, 10, 24), matCorps);
  anneau.position.set(0, 0.055, 0.0); anneau.rotation.x = Math.PI / 2;
  g.add(anneau);
  var trig = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.014, 0.01),
    new THREE.MeshStandardMaterial({ color: 0x888888 }));
  trig.position.set(0, 0.01, 0.03);
  g.add(trig);
  var grip = new THREE.Mesh(new THREE.BoxGeometry(0.012, 0.03, 0.028),
    new THREE.MeshStandardMaterial({ color: 0x888888, emissive: 0x000000 }));
  grip.position.set(0.021, -0.01, 0.0);
  g.add(grip);
  // Sphere blanche au bout : le point qui attrape les pieces
  var tip = new THREE.Mesh(new THREE.SphereGeometry(0.02, 18, 18),
    new THREE.MeshBasicMaterial({ color: 0xffffff }));
  tip.position.set(0, 0.0, 0.06);
  g.add(tip);
  g.userData.grip = grip; g.userData.trigger = trig; g.userData.tip = tip;
  g.rotation.x = 0.5;
  return g;
}

function setGripDemo(on) {
  if (!demoManette) return;
  var grip = demoManette.userData.grip;
  grip.material.color.setHex(on ? 0x00e676 : 0x888888);
  if (grip.material.emissive) grip.material.emissive.setHex(on ? 0x00c853 : 0x000000);
}

function nettoyerDemoObjets() {
  if (demoPiece)   { anchor.remove(demoPiece);   demoPiece = null; }
  if (demoManette) { anchor.remove(demoManette); demoManette = null; }
  demoHalo.visible = false;
  demoCibleMark.visible = false;
  demoLabel.visible = false;
}

function startDemo() {
  if (!pieceData.length) return;
  nettoyerDemoObjets();
  stopParole();
  demoDejaProposee = true;
  demoEnCours = true; demoMode = 'run'; demoT0 = performance.now(); demoPhase = 0;
  var pd = pieceData[0];
  demoDepart.copy(pd.objet.position);
  demoCible.copy(pd.posCible);
  demoQuat.copy(pd.quatCible);
  demoPiece = pd.objet.clone(true);
  demoPiece.position.copy(demoDepart);
  demoPiece.quaternion.identity();
  demoPiece.traverse(function (d) {
    if (d.isMesh && !Array.isArray(d.material)) {
      d.material = d.material.clone();
      if (d.material.emissive) d.material.emissive.setHex(0x553300);
    }
  });
  anchor.add(demoPiece);
  demoManette = creerDemoManette();
  anchor.add(demoManette);
  // Le panneau propose/fin est masque pendant l'animation
  demoPrompt.visible = false;
  demoCaption = demoCaps[0];
  dessinerDemoLabel(demoCaps[0]);
  parler(demoNarr[0]); // sans effet si le navigateur n'a pas de voix (Wolvic)
}

// Fin de l'animation : on montre le panneau REVOIR / FERMER
function finDemoAnim(parle) {
  demoEnCours = false; demoMode = 'fin';
  nettoyerDemoObjets();
  stopParole();
  if (parle) parler('Voila, c est termine. A toi de jouer !');
  demoCaption = 'Rejouer la demonstration ?';
  demoPrompt.visible = true;
}

// Fermeture complete de la demo
function fermerDemo() {
  demoEnCours = false; demoMode = 'propose';
  demoPrompt.visible = false;
  nettoyerDemoObjets();
  stopParole();
}

function majDemo() {
  var t = (performance.now() - demoT0) / 1000;
  var off  = new THREE.Vector3(0.03, 0.07, 0.03);
  var cP   = demoDepart.clone().add(off);   // manette au niveau de la piece
  var cT   = demoCible.clone().add(off);     // manette a l'emplacement
  var cDep = demoDepart.clone().add(new THREE.Vector3(0.3, 0.22, 0.16)); // depart
  function ss(a) { a = Math.max(0, Math.min(1, a)); return a * a * (3 - 2 * a); }

  // Decoupage temporel (rythme lent, ~17.5 s)
  var ph;
  if      (t < 3.5)  ph = 0;   // intro : la sphere blanche
  else if (t < 7.0)  ph = 1;   // approche
  else if (t < 10.0) ph = 2;   // saisie (grip)
  else if (t < 14.5) ph = 3;   // deplacement
  else if (t < 17.5) ph = 4;   // relache -> aimantation
  else               ph = 5;   // fin

  if (ph === 5) { finDemoAnim(true); return; }

  var focusLocal = new THREE.Vector3();
  if (ph === 0) {
    demoManette.position.copy(cDep);
    demoPiece.position.copy(demoDepart);
    setGripDemo(false);
    focusLocal.copy(cDep).add(new THREE.Vector3(0, 0, 0.06)); // la sphere blanche
  } else if (ph === 1) {
    demoManette.position.lerpVectors(cDep, cP, ss((t - 3.5) / 3.5));
    demoPiece.position.copy(demoDepart);
    setGripDemo(false);
    focusLocal.copy(demoDepart);
  } else if (ph === 2) {
    demoManette.position.copy(cP);
    demoPiece.position.copy(demoDepart);
    setGripDemo(true);
    focusLocal.copy(cP).add(new THREE.Vector3(0.021, -0.01, 0)); // le grip
  } else if (ph === 3) {
    var k = ss((t - 10.0) / 4.5);
    demoManette.position.lerpVectors(cP, cT, k);
    demoPiece.position.lerpVectors(demoDepart, demoCible, k);
    setGripDemo(true);
    focusLocal.copy(demoCible);
  } else if (ph === 4) {
    demoManette.position.copy(cT);
    demoPiece.position.copy(demoCible);
    demoPiece.quaternion.copy(demoQuat);
    setGripDemo(false);
    focusLocal.copy(demoCible);
  }

  // Changement de phase -> legende (texte pres de l'element) + narration
  if (ph !== demoPhase) {
    demoPhase = ph;
    demoCaption = demoCaps[ph];
    dessinerDemoLabel(demoCaps[ph]);
    parler(demoNarr[ph]);
  }

  // Sphere blanche pulsante en intro et a la saisie
  var tip = demoManette.userData.tip;
  if (tip) tip.scale.setScalar((ph === 0 || ph === 2) ? (1 + 0.4 * Math.sin(t * 8)) : 1);

  // Halo d'attention (billboard, pulsant) sur l'element a observer
  var camW = new THREE.Vector3(); camera.getWorldPosition(camW);
  var fw = anchor.localToWorld(focusLocal.clone());
  demoHalo.position.copy(fw); demoHalo.lookAt(camW);
  demoHalo.scale.setScalar(1 + 0.28 * Math.sin(t * 7));
  demoHalo.visible = true;

  // Etiquette de texte juste a cote de l'element (legerement au-dessus, vers la camera)
  var versCam = camW.clone().sub(fw).normalize();
  demoLabel.position.copy(fw).addScaledVector(versCam, 0.09);
  demoLabel.position.y += 0.16;
  demoLabel.lookAt(camW);
  demoLabel.visible = true;

  // Cercle vert de l'emplacement pendant deplacement et aimantation
  if (ph === 3 || ph === 4) {
    var tw = anchor.localToWorld(demoCible.clone());
    demoCibleMark.position.copy(tw); demoCibleMark.lookAt(camW);
    demoCibleMark.scale.setScalar(1 + 0.18 * Math.sin(t * 5));
    demoCibleMark.visible = true;
  } else {
    demoCibleMark.visible = false;
  }
}
// =================== FIN DEMONSTRATION ===================

var hitTestSource          = null;
var hitTestSourceRequested = false;

// --- Donnees des pieces ---
var pieceData  = [];
var grabbables = [];

var matFantome = new THREE.MeshBasicMaterial({
  color: 0x00e5ff, transparent: true, opacity: 0.35, depthWrite: false
});

// --- Feu d'artifice (particules) ---
var carCentre  = new THREE.Vector3();  // centre de la voiture (local a anchor)
var feux       = [];                    // gerbes actives
var feuxActif  = false;                 // sequence de lancement en cours

// Cree une gerbe de particules a partir d'un point monde
function creerGerbe(origine) {
  var N   = 140;
  var geo = new THREE.BufferGeometry();
  var pos = new Float32Array(N * 3);
  var col = new Float32Array(N * 3);
  var vel = [];
  var teinte = new THREE.Color().setHSL(Math.random(), 1, 0.6);
  for (var i = 0; i < N; i++) {
    pos[i*3] = origine.x; pos[i*3+1] = origine.y; pos[i*3+2] = origine.z;
    var theta = Math.random() * Math.PI * 2;
    var phi   = Math.acos(2 * Math.random() - 1);
    var vit   = 0.5 + Math.random() * 0.6;
    vel.push(new THREE.Vector3(
      Math.sin(phi) * Math.cos(theta) * vit,
      Math.cos(phi) * vit,
      Math.sin(phi) * Math.sin(theta) * vit
    ));
    col[i*3] = teinte.r; col[i*3+1] = teinte.g; col[i*3+2] = teinte.b;
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color',    new THREE.BufferAttribute(col, 3));
  var mat = new THREE.PointsMaterial({
    size: 0.025, vertexColors: true, transparent: true, opacity: 1,
    blending: THREE.AdditiveBlending, depthWrite: false
  });
  var pts = new THREE.Points(geo, mat);
  scene.add(pts);
  feux.push({ pts: pts, vel: vel, age: 0, ttl: 1.8 });
}

// Lance une sequence de gerbes depuis le dessus de la voiture
function lancerFeuxArtifice() {
  if (feuxActif) return;
  feuxActif = true;
  var origine = anchor.localToWorld(carCentre.clone());
  origine.y += 0.15;
  for (var b = 0; b < 8; b++) {
    (function (delai) {
      setTimeout(function () {
        var o = origine.clone();
        o.x += (Math.random() - 0.5) * 0.5;
        o.y += Math.random() * 0.35;
        o.z += (Math.random() - 0.5) * 0.5;
        creerGerbe(o);
      }, delai);
    })(b * 500);
  }
}

// Met a jour les particules (dt en secondes)
function majFeux(dt) {
  for (var i = feux.length - 1; i >= 0; i--) {
    var f = feux[i];
    f.age += dt;
    var p = f.pts.geometry.attributes.position.array;
    for (var j = 0; j < f.vel.length; j++) {
      f.vel[j].y -= 0.7 * dt; // gravite
      p[j*3]   += f.vel[j].x * dt;
      p[j*3+1] += f.vel[j].y * dt;
      p[j*3+2] += f.vel[j].z * dt;
    }
    f.pts.geometry.attributes.position.needsUpdate = true;
    f.pts.material.opacity = Math.max(0, 1 - f.age / f.ttl);
    if (f.age >= f.ttl) {
      scene.remove(f.pts);
      f.pts.geometry.dispose();
      f.pts.material.dispose();
      feux.splice(i, 1);
    }
  }
}

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
    ajusterTaille(root, 0.3);
    anchor.add(root);
    root.position.set(0, 0.02, 0);
    root.updateMatrixWorld(true);

    var carRoot = root;
    while (carRoot.children.length === 1) carRoot = carRoot.children[0];

    var pieces = carRoot.children.slice();

    pieces.forEach(function (piece) {
      var fantome = piece.clone(true);
      fantome.position.copy(piece.position);
      fantome.quaternion.copy(piece.quaternion);
      fantome.scale.copy(piece.scale);
      carRoot.add(fantome);
      anchor.attach(fantome);
      fantome.traverse(function (d) {
        if (d.isMesh) { d.material = matFantome; d.renderOrder = -1; }
      });
      anchor.attach(piece);
      pieceData.push({
        objet:    piece,
        posCible: piece.position.clone(),
        quatCible: piece.quaternion.clone()
      });
    });

    // Centroide des positions assemblees (memorise pour le feu d'artifice)
    var centroid = new THREE.Vector3();
    pieceData.forEach(function (pd) { centroid.add(pd.posCible); });
    centroid.divideScalar(pieceData.length);
    carCentre.copy(centroid);

    // Disperser les pieces en cercle
    var n = pieceData.length;
    pieceData.forEach(function (pd, i) {
      var angle = (i / n) * Math.PI * 2;
      pd.objet.position.set(
        centroid.x + Math.cos(angle) * 0.4,
        centroid.y,
        centroid.z + Math.sin(angle) * 0.4
      );
      pd.objet.quaternion.identity();
    });

    grabbables = pieceData.map(function (pd) { return pd.objet; });

    panneau.position.set(0, 0.5, 0);
    anchor.add(panneau);

  }, undefined, function (e) {
    document.getElementById('errbox').textContent = 'Erreur GLB: ' + e;
  });
}

// --- Manettes ---
var controllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
var grabs = [{ objet: null }, { objet: null }];
var v = new THREE.Vector3();
var SEUIL_GRAB     = 0.05;
var SEUIL_POSITION = 0.06;

controllers.forEach(function (ctrl, idx) {
  scene.add(ctrl);
  ctrl.add(new THREE.Mesh(
    new THREE.SphereGeometry(0.015, 8, 8),
    new THREE.MeshBasicMaterial({ color: 0xffffff })
  ));

  ctrl.addEventListener('squeezestart', function () {
    if (!anchorPlaced || sessionComplete) return;
    var p = new THREE.Vector3();
    controllers[idx].getWorldPosition(p);
    for (var k = 0; k < grabbables.length; k++) {
      v.setFromMatrixPosition(grabbables[k].matrixWorld);
      if (p.distanceTo(v) < SEUIL_GRAB) {
        grabs[idx].objet = grabbables[k];
        controllers[idx].attach(grabbables[k]);
        // Retirer du suivi des pieces snappees si on la deplace
        var uid = grabbables[k].uuid;
        var idx2 = piecesAssemblees.indexOf(uid);
        if (idx2 >= 0) piecesAssemblees.splice(idx2, 1);
        return;
      }
    }
  });

  ctrl.addEventListener('squeezeend', function () {
    var objet = grabs[idx].objet;
    if (!objet) return;
    anchor.attach(objet);
    var pd = null;
    for (var k = 0; k < pieceData.length; k++) {
      if (pieceData[k].objet === objet) { pd = pieceData[k]; break; }
    }
    if (pd) {
      var distPos = objet.position.distanceTo(pd.posCible);
      if (distPos < SEUIL_POSITION) {
        objet.position.copy(pd.posCible);
        objet.quaternion.copy(pd.quatCible);
        // Enregistrer piece snappee
        if (piecesAssemblees.indexOf(objet.uuid) < 0) {
          piecesAssemblees.push(objet.uuid);
        }
        // Verifier si toutes les pieces sont assemblees
        if (piecesAssemblees.length === pieceData.length && !sessionComplete) {
          sessionComplete = true;
          arreter();
          var tFinal = chrono.cumul;
          sauvegarderScore(playerName, tFinal);
          lancerFeuxArtifice();
          // Fermer la session AR apres le feu d'artifice (6 s)
          setTimeout(function () {
            var sess = renderer.xr.getSession();
            if (sess) { try { sess.end(); } catch (e2) {} }
          }, 6000);
        }
      }
    }
    grabs[idx].objet = null;
  });

  ctrl.addEventListener('selectstart', function () {
    // Placement de l'ancre (1er appui)
    if (!anchorPlaced) {
      // La voiture suit deja la cible dans la boucle : on verrouille juste ici
      anchor.visible  = true;
      anchorPlaced    = true;
      reticle.visible = false;
      preview.visible = false;
      // Proposer la demonstration une fois la voiture posee
      if (!demoDejaProposee && pieceData.length) {
        demoMode = 'propose';
        demoPrompt.visible = true;
      }
      return;
    }

    // Pendant l'animation de demo : n'importe quel appui passe a l'ecran REVOIR / FERMER
    if (demoEnCours) { finDemoAnim(false); return; }

    // Interaction avec le panneau de demonstration (propose / fin)
    if (demoPrompt.visible) {
      var pw = new THREE.Vector3(); demoPrompt.getWorldPosition(pw);
      var pcc = new THREE.Vector3(); controllers[idx].getWorldPosition(pcc);
      if (pcc.distanceTo(pw) < 0.45) {
        var lpd = demoPrompt.worldToLocal(pcc.clone());
        var dcx = (lpd.x + 0.2) / 0.4 * 512;
        var dcy = (0.1 - lpd.y) / 0.2 * 256;
        var gauche = (dcx >= 40  && dcx <= 220 && dcy >= 110 && dcy <= 200); // OUI / REVOIR
        var droite = (dcx >= 292 && dcx <= 472 && dcy >= 110 && dcy <= 200); // NON / FERMER
        if (gauche) {
          startDemo();
        } else if (droite) {
          demoDejaProposee = true;
          fermerDemo();
        }
      }
      return;
    }

    // Interaction avec le panneau chrono
    if (sessionComplete) return;
    var p = new THREE.Vector3();
    controllers[idx].getWorldPosition(p);
    var pp = new THREE.Vector3();
    panneau.getWorldPosition(pp);
    if (p.distanceTo(pp) > 0.45) return;

    // Convertir la position locale en pixels du canvas (512 x 310)
    var lp = panneau.worldToLocal(p.clone());
    var cx = (lp.x + 0.25) / 0.5 * 512;
    var cy = (PANNEAU_H / 2 - lp.y) / PANNEAU_H * 310;
    function dans(x, y, w, h) { return cx >= x && cx <= x + w && cy >= y && cy <= y + h; }

    if (dans(8, 112, 160, 78)) {
      demarrer();
    } else if (dans(176, 112, 160, 78)) {
      arreter();
    } else if (dans(344, 112, 160, 78)) {
      razChrono();
    } else if (dans(8, 206, 496, 88)) {
      replacer();
    }
  });
});

// --- Boucle de rendu ---
renderer.setAnimationLoop(function (time, frame) {
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

    // Determiner la position cible (hit-test si dispo, sinon manette droite)
    var cible   = new THREE.Vector3();
    var surTable = false;
    if (hitTestSource && refSpace) {
      var hits = frame.getHitTestResults(hitTestSource);
      if (hits.length > 0) {
        var pose = hits[0].getPose(refSpace);
        reticle.matrix.fromArray(pose.transform.matrix);
        cible.setFromMatrixPosition(reticle.matrix);
        surTable = true;
      }
    }
    if (!surTable) {
      controllers[0].getWorldPosition(cible);
    }

    // Le cercle orange marque la cible
    reticle.visible = false;
    preview.position.copy(cible);
    preview.visible = true;

    // Apercu LIVE : la voiture fantome + les pieces suivent la cible
    if (pieceData.length) {
      anchor.position.copy(cible);
      if (surTable) anchor.quaternion.setFromRotationMatrix(reticle.matrix);
      anchor.visible = true;
    }
  }

  if (anchorPlaced) {
    preview.visible = false;
  }

  // Le panneau compteur fait toujours face au regard (perpendiculaire a l'axe de vue),
  // pendant le placement comme apres, tant que la voiture est visible
  if (anchor.visible && panneau.parent) {
    var camPos = new THREE.Vector3();
    camera.getWorldPosition(camPos);
    panneau.lookAt(camPos);
  }

  // Demonstration : animation (texte pres des elements) tant qu'elle tourne
  if (demoEnCours) majDemo();

  // Panneau propose / fin (REVOIR / FERMER), au-dessus de la voiture, face au regard
  if (demoPrompt.visible) {
    var od = new THREE.Vector3(0, 0.75, 0);
    anchor.localToWorld(od);
    demoPrompt.position.copy(od);
    var camPos2 = new THREE.Vector3();
    camera.getWorldPosition(camPos2);
    demoPrompt.lookAt(camPos2);
    dessinerDemoPrompt();
  }

  // Feu d'artifice : dt en secondes, borne pour eviter les sauts
  var dt = lastTime ? (time - lastTime) / 1000 : 0;
  lastTime = time;
  if (dt > 0.1) dt = 0.1;
  if (feux.length) majFeux(dt);

  dessiner();
  renderer.render(scene, camera);
});
var lastTime = 0;

// --- Bouton "Entrer en AR" ---
document.getElementById('btnCommencer').addEventListener('click', function () {
  var nom = document.getElementById('inputNom').value.trim();
  if (!nom) { status.textContent = 'Entrez votre nom !'; return; }

  playerName       = nom;
  sessionComplete  = false;
  piecesAssemblees = [];
  razChrono();

  // Vider l'ancre et reinitialiser
  while (anchor.children.length) anchor.remove(anchor.children[0]);
  pieceData  = [];
  grabbables = [];
  anchorPlaced    = false;
  anchor.visible  = false;
  hitTestSourceRequested = false;
  hitTestSource = null;
  reticle.visible = false;
  preview.visible = false;

  // Reinitialiser la demonstration
  demoEnCours      = false;
  demoDejaProposee = false;
  demoMode         = 'propose';
  demoPhase        = -1;
  demoPrompt.visible    = false;
  demoHalo.visible      = false;
  demoCibleMark.visible = false;
  demoLabel.visible     = false;
  demoManette = null;
  demoPiece   = null;
  stopParole();

  // Reinitialiser le feu d'artifice
  feuxActif = false;
  for (var fi = feux.length - 1; fi >= 0; fi--) {
    scene.remove(feux[fi].pts);
    feux[fi].pts.geometry.dispose();
    feux[fi].pts.material.dispose();
  }
  feux = [];

  navigator.xr.requestSession('immersive-ar', {
    optionalFeatures: ['hit-test', 'local-floor', 'local']
  }).then(function (session) {
    status.textContent = 'Session creee !';
    renderer.xr.setSession(session).then(function () {
      overlay.style.display = 'none';
      chargerVoiture();

      session.addEventListener('end', function () {
        stopParole();
        if (sessionComplete) {
          montrerEcranClassement(chrono.cumul);
        } else {
          montrerEcranNom();
        }
      });
    }).catch(function (e2) {
      status.textContent = 'Erreur setSession: ' + e2.message;
    });
  }).catch(function (e) {
    status.textContent = 'Erreur AR: ' + e.message;
  });
});

// --- Bouton "Nouvelle session" ---
document.getElementById('btnNouvelle').addEventListener('click', function () {
  document.getElementById('inputNom').value = '';
  montrerEcranNom();
});

// --- Bouton "Effacer classement" ---
document.getElementById('btnRAZ').addEventListener('click', function () {
  var zone = document.getElementById('raz-zone');
  zone.style.display = zone.style.display === 'flex' ? 'none' : 'flex';
  document.getElementById('raz-erreur').textContent = '';
  document.getElementById('inputCode').value = '';
});

// --- Validation du code RAZ ---
document.getElementById('btnCodeOK').addEventListener('click', function () {
  var code = document.getElementById('inputCode').value;
  if (code === '1234') {
    effacerScores();
    afficherClassement();
    document.getElementById('raz-zone').style.display = 'none';
  } else {
    document.getElementById('raz-erreur').textContent = 'Code incorrect';
    document.getElementById('inputCode').value = '';
  }
});

// --- Affichage initial ---
montrerEcranNom();

}); // fin window.addEventListener('load', ...)
