#!/bin/sh
# Donne le dossier de données à l'utilisateur « node » (dossier partagé Synology
# monté depuis l'hôte), puis lance le serveur sans les droits root.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$ORBITE_DATA_DIR"
  chown -R node:node "$ORBITE_DATA_DIR" 2>/dev/null || true
  chmod 700 "$ORBITE_DATA_DIR" 2>/dev/null || true
  exec su-exec node "$@"
fi
exec "$@"
