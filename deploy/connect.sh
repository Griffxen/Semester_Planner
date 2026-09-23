#!/bin/sh
# Example: PLANNER_SSH_TARGET=user@host PLANNER_SSH_KEY=/path/to/key ./deploy/connect.sh
set -eu
: "${PLANNER_SSH_TARGET:?Set PLANNER_SSH_TARGET=user@host}"
if [ -n "${PLANNER_SSH_KEY:-}" ]; then
    set -- -i "$PLANNER_SSH_KEY"
else
    set --
fi
exec ssh -N "$@" -o ExitOnForwardFailure=yes -o ServerAliveInterval=30 \
    -L "127.0.0.1:${PLANNER_LOCAL_PORT:-8766}:127.0.0.1:${PLANNER_REMOTE_PORT:-8765}" \
    "$PLANNER_SSH_TARGET"
