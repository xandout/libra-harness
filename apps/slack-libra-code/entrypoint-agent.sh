#!/bin/bash
set -e

# Target workspace directory
export LC_CWD="${LC_CWD:-/home/node/workspace}"
export LIBRA_HOME="${LIBRA_HOME:-${LC_CWD}/.libra}"
mkdir -p "${LC_CWD}" "${LIBRA_HOME}"

# Source workspace .env if present
if [ -f "${LC_CWD}/.env" ]; then
  source "${LC_CWD}/.env"
fi

exec "$@"
