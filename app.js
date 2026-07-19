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

// --- Repere de placement (cercle orange) ---
var preview = new THREE.Group();
preview.add(new THREE.Mesh(
  new THREE.RingGeometry(0.18, 0.21, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xff8800, side: THREE.DoubleSide })
));
preview.add(new THREE.Mesh(
  new THREE.RingGeometry(0.06, 0.08, 32).rotateX(-Math.PI / 2),
  new THREE.MeshBasicMaterial({ color: 0xff8800, side: THREE.DoubleSide })
));
preview.visible = false;
scene.add(preview);

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
    root.position.set(0, 0.02, -0.3);
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

    panneau.position.set(0, 0.5, -0.3);
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
      if (reticle.visible) {
        anchor.position.setFromMatrixPosition(reticle.matrix);
        anchor.quaternion.setFromRotationMatrix(reticle.matrix);
      } else {
        var ctrlPos = new THREE.Vector3();
        controllers[idx].getWorldPosition(ctrlPos);
        anchor.position.copy(ctrlPos);
      }
      anchor.visible = true;
      anchorPlaced   = true;
      reticle.visible = false;
      preview.visible = false;
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

    if (hitTestSource && refSpace) {
      var hits = frame.getHitTestResults(hitTestSource);
      if (hits.length > 0) {
        var pose = hits[0].getPose(refSpace);
        reticle.visible = true;
        reticle.matrix.fromArray(pose.transform.matrix);
        preview.visible = false;
      } else {
        reticle.visible = false;
      }
    }

    if (!reticle.visible) {
      var ctrlPos = new THREE.Vector3();
      controllers[0].getWorldPosition(ctrlPos);
      preview.position.copy(ctrlPos);
      preview.visible = true;
    }
  }

  if (anchorPlaced) {
    preview.visible = false;
    panneau.lookAt(camera.position);
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
