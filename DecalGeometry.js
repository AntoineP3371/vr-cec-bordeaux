/**
 * DecalGeometry - version "script classique" (sans modules ES) pour Three.js r128.
 * Adapte de three.js/examples/jsm/geometries/DecalGeometry.js (licence MIT).
 *
 * A quoi ca sert ici :
 * Un "decalque" est un morceau de surface decoupe directement dans la geometrie
 * d'une piece de la voiture, puis colle par dessus avec une texture (logo) ou
 * une couleur (tache de peinture). C'est la methode utilisee ici parce que le
 * modele 3D de la voiture n'a AUCUNE coordonnee UV : impossible de peindre sur
 * une texture classique. DecalGeometry, lui, fabrique ses propres UV.
 *
 * Attention : la geometrie produite est exprimee en coordonnees MONDE.
 * Le mesh cree doit donc etre ajoute sans transformation, puis rattache
 * au groupe voulu avec .attach() (qui conserve la position monde).
 */
(function () {
  'use strict';

  // Un sommet du decalque : position + normale.
  function DecalVertex(position, normal) {
    this.position = position;
    this.normal = normal;
  }

  DecalVertex.prototype.clone = function () {
    return new DecalVertex(this.position.clone(), this.normal.clone());
  };

  // NB : en Three.js r128 BufferGeometry est une classe ES6. Il faut donc
  // "extends" + "super()" : un THREE.BufferGeometry.call(this) leverait
  // l'erreur "Class constructor cannot be invoked without 'new'".
  class DecalGeometry extends THREE.BufferGeometry {

  /**
   * @param {THREE.Mesh}   mesh        La piece sur laquelle on colle
   * @param {THREE.Vector3} position   Point d'impact (monde)
   * @param {THREE.Euler}  orientation Orientation du projecteur
   * @param {THREE.Vector3} size       Taille de la boite de projection
   */
  constructor(mesh, position, orientation, size) {
    super();

    var vertices = [];
    var normals = [];
    var uvs = [];

    var plane = new THREE.Vector3();

    // Matrice du projecteur (la "boite" qui decoupe la surface)
    var projectorMatrix = new THREE.Matrix4();
    projectorMatrix.makeRotationFromEuler(orientation);
    projectorMatrix.setPosition(position);

    var projectorMatrixInverse = new THREE.Matrix4();
    projectorMatrixInverse.copy(projectorMatrix).invert();

    generate();

    this.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    this.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
    this.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));

    function generate() {
      var decalVertices = [];
      var vertex = new THREE.Vector3();
      var normal = new THREE.Vector3();

      var geometry = mesh.geometry;
      var positionAttribute = geometry.attributes.position;
      var normalAttribute = geometry.attributes.normal;
      var i;

      // Etape 1 : lister tous les triangles (3 DecalVertex consecutifs = 1 face)
      if (geometry.index !== null) {
        var index = geometry.index;
        for (i = 0; i < index.count; i++) {
          vertex.fromBufferAttribute(positionAttribute, index.getX(i));
          normal.fromBufferAttribute(normalAttribute, index.getX(i));
          pushDecalVertex(decalVertices, vertex, normal);
        }
      } else {
        for (i = 0; i < positionAttribute.count; i++) {
          vertex.fromBufferAttribute(positionAttribute, i);
          normal.fromBufferAttribute(normalAttribute, i);
          pushDecalVertex(decalVertices, vertex, normal);
        }
      }

      // Etape 2 : decouper contre les 6 faces de la boite de projection
      decalVertices = clipGeometry(decalVertices, plane.set(1, 0, 0));
      decalVertices = clipGeometry(decalVertices, plane.set(-1, 0, 0));
      decalVertices = clipGeometry(decalVertices, plane.set(0, 1, 0));
      decalVertices = clipGeometry(decalVertices, plane.set(0, -1, 0));
      decalVertices = clipGeometry(decalVertices, plane.set(0, 0, 1));
      decalVertices = clipGeometry(decalVertices, plane.set(0, 0, -1));

      // Etape 3 : UV (on est encore dans le repere du projecteur) puis retour au monde
      for (i = 0; i < decalVertices.length; i++) {
        var dv = decalVertices[i];
        uvs.push(0.5 + dv.position.x / size.x, 0.5 + dv.position.y / size.y);
        dv.position.applyMatrix4(projectorMatrix);
        vertices.push(dv.position.x, dv.position.y, dv.position.z);
        normals.push(dv.normal.x, dv.normal.y, dv.normal.z);
      }
    }

    function pushDecalVertex(decalVertices, vertex, normal) {
      vertex.applyMatrix4(mesh.matrixWorld);
      vertex.applyMatrix4(projectorMatrixInverse);
      normal.transformDirection(mesh.matrixWorld);
      decalVertices.push(new DecalVertex(vertex.clone(), normal.clone()));
    }

    function clipGeometry(inVertices, plane) {
      var outVertices = [];
      var s = 0.5 * Math.abs(size.dot(plane));

      for (var i = 0; i < inVertices.length; i += 3) {
        var nV1, nV2, nV3, nV4;

        var d1 = inVertices[i + 0].position.dot(plane) - s;
        var d2 = inVertices[i + 1].position.dot(plane) - s;
        var d3 = inVertices[i + 2].position.dot(plane) - s;

        var v1Out = d1 > 0;
        var v2Out = d2 > 0;
        var v3Out = d3 > 0;

        // Combien de sommets sortent de la boite ?
        var total = (v1Out ? 1 : 0) + (v2Out ? 1 : 0) + (v3Out ? 1 : 0);

        switch (total) {
          case 0:
            // Face entierement dedans : on la garde telle quelle
            outVertices.push(inVertices[i]);
            outVertices.push(inVertices[i + 1]);
            outVertices.push(inVertices[i + 2]);
            break;

          case 1:
            // Un sommet dehors : la face devient un quad (2 triangles)
            if (v1Out) {
              nV1 = inVertices[i + 1];
              nV2 = inVertices[i + 2];
              nV3 = clip(inVertices[i], nV1, plane, s);
              nV4 = clip(inVertices[i], nV2, plane, s);
            }

            if (v2Out) {
              nV1 = inVertices[i];
              nV2 = inVertices[i + 2];
              nV3 = clip(inVertices[i + 1], nV1, plane, s);
              nV4 = clip(inVertices[i + 1], nV2, plane, s);

              outVertices.push(nV3);
              outVertices.push(nV2.clone());
              outVertices.push(nV1.clone());

              outVertices.push(nV2.clone());
              outVertices.push(nV3.clone());
              outVertices.push(nV4);
              break;
            }

            if (v3Out) {
              nV1 = inVertices[i];
              nV2 = inVertices[i + 1];
              nV3 = clip(inVertices[i + 2], nV1, plane, s);
              nV4 = clip(inVertices[i + 2], nV2, plane, s);
            }

            outVertices.push(nV1.clone());
            outVertices.push(nV2.clone());
            outVertices.push(nV3);

            outVertices.push(nV4);
            outVertices.push(nV3.clone());
            outVertices.push(nV2.clone());
            break;

          case 2:
            // Deux sommets dehors : il reste un seul triangle
            if (!v1Out) {
              nV1 = inVertices[i].clone();
              nV2 = clip(nV1, inVertices[i + 1], plane, s);
              nV3 = clip(nV1, inVertices[i + 2], plane, s);
              outVertices.push(nV1, nV2, nV3);
            }
            if (!v2Out) {
              nV1 = inVertices[i + 1].clone();
              nV2 = clip(nV1, inVertices[i + 2], plane, s);
              nV3 = clip(nV1, inVertices[i], plane, s);
              outVertices.push(nV1, nV2, nV3);
            }
            if (!v3Out) {
              nV1 = inVertices[i + 2].clone();
              nV2 = clip(nV1, inVertices[i], plane, s);
              nV3 = clip(nV1, inVertices[i + 1], plane, s);
              outVertices.push(nV1, nV2, nV3);
            }
            break;

          case 3:
            // Face entierement dehors : on la jette
            break;
        }
      }

      return outVertices;
    }

    // Point d'intersection entre l'arete v0-v1 et le plan de decoupe
    function clip(v0, v1, p, s) {
      var d0 = v0.position.dot(p) - s;
      var d1 = v1.position.dot(p) - s;
      var s0 = d0 / (d0 - d1);

      return new DecalVertex(
        new THREE.Vector3(
          v0.position.x + s0 * (v1.position.x - v0.position.x),
          v0.position.y + s0 * (v1.position.y - v0.position.y),
          v0.position.z + s0 * (v1.position.z - v0.position.z)
        ),
        new THREE.Vector3(
          v0.normal.x + s0 * (v1.normal.x - v0.normal.x),
          v0.normal.y + s0 * (v1.normal.y - v0.normal.y),
          v0.normal.z + s0 * (v1.normal.z - v0.normal.z)
        )
      );
    }
  }
  }

  THREE.DecalGeometry = DecalGeometry;
  THREE.DecalVertex = DecalVertex;
})();
