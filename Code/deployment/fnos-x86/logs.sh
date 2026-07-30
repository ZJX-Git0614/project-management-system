#!/bin/sh
set -eu
cd "$(dirname "$0")"
docker compose logs --follow --tail=200 pms postgres
