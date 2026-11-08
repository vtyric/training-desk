#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if [ ! -f .env ]; then
    echo 'Missing .env. Create it from .env.example and configure passwords and public URLs.' >&2
    exit 1
fi
if [ ! -f images.env ]; then
    echo 'Missing images.env from the release bundle.' >&2
    exit 1
fi
compose() {
    docker compose --env-file .env --env-file images.env -f compose.yaml "$@"
}
compose config --quiet
compose --profile ops pull
compose up -d --no-build --wait --wait-timeout 180 postgres ldap
compose run --rm --no-deps migrate
compose up -d --no-build --no-deps --wait --wait-timeout 240 identity
compose --profile ops run --rm --no-deps provision
compose up -d --no-build --no-deps --wait --wait-timeout 120 service-desk
compose ps
