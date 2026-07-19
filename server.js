// Mini serveur web local (sans aucune dépendance à installer).
// Sert les fichiers de ce dossier sur http://localhost:8080
// Lancé automatiquement par serveur.bat.

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = 8080;
const DOSSIER = __dirname; // le dossier où se trouve ce fichier

// Types de fichiers (pour que le navigateur comprenne les .glb, .js, etc.)
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
};

const serveur = http.createServer((req, res) => {
  // On enlève les paramètres d'URL et on évite de sortir du dossier.
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";

  const fichier = path.join(DOSSIER, path.normalize(urlPath));
  if (!fichier.startsWith(DOSSIER)) {
    res.writeHead(403);
    return res.end("Accès refusé");
  }

  fs.readFile(fichier, (err, contenu) => {
    if (err) {
      res.writeHead(404);
      return res.end("Fichier introuvable : " + urlPath);
    }
    const ext = path.extname(fichier).toLowerCase();
    res.writeHead(200, {
      "Content-Type": TYPES[ext] || "application/octet-stream",
      "Cache-Control": "no-store, no-cache, must-revalidate",
    });
    res.end(contenu);
  });
});

serveur.listen(PORT, "0.0.0.0", () => {
  console.log("Serveur local demarre sur http://localhost:" + PORT);
  console.log("Dossier servi : " + DOSSIER);
});
