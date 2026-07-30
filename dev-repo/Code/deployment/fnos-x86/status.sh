#!/bin/sh
set -eu
cd "$(dirname "$0")"
docker compose ps
printf '\nRecent application logs:\n'
docker compose logs --tail=40 pms
