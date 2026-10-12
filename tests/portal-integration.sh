#!/usr/bin/env bash
# Build and exercise the native adapter on an isolated bus with no activatable
# services. The fixture cannot open the real browser or contact the user portal.
set -euo pipefail

if [[ "${1:-}" == --session || "${1:-}" == --electron-main ]]; then
    mode=$1
    runtime=$2
    addon=$3
    guard=$4
    test_dir=$5
    repo_dir=$6
    export QQ_PORTAL_TEST_PRIVATE_BUS=1
    fixture_pid=
    trap 'if [[ -n "$fixture_pid" ]]; then kill "$fixture_pid" 2>/dev/null || true; wait "$fixture_pid" 2>/dev/null || true; fi' EXIT

    run_client() {
        local scenario=$1
        shift
        timeout 20s env "$@" \
            ELECTRON_RUN_AS_NODE=1 \
            LD_PRELOAD="$guard" \
            QQ_PORTAL_TEST_ADDON="$addon" \
            QQ_PORTAL_TEST_SCENARIO="$scenario" \
            QQ_PORTAL_TEST_LOG="$test_dir/requests.jsonl" \
            QQ_PORTAL_TEST_FILE="$test_dir/file with spaces.txt" \
            QQ_PORTAL_TEST_FORK_GUARD_LOG="$test_dir/$scenario.guard.log" \
            "$runtime" "$repo_dir/tests/portal-integration-client.js"
    }

    if [[ "$mode" == --session ]]; then
        run_client missing-bus -u DBUS_SESSION_BUS_ADDRESS XDG_RUNTIME_DIR="$test_dir/no-bus"
        run_client autolaunch DBUS_SESSION_BUS_ADDRESS=autolaunch:
        run_client mixed-address DBUS_SESSION_BUS_ADDRESS="unix:path=$test_dir/no-bus/bus;autolaunch:"
        run_client unavailable
    fi
    python "$repo_dir/tests/fake-portal.py" \
        --ready-file "$test_dir/ready" --log-file "$test_dir/requests.jsonl" &
    fixture_pid=$!
    for ((i = 0; i < 100; ++i)); do
        [[ -f "$test_dir/ready" ]] && break
        kill -0 "$fixture_pid"
        sleep 0.02
    done
    [[ -f "$test_dir/ready" ]]
    if [[ "$mode" == --session ]]; then
        run_client available
    else
        mkdir -p "$test_dir/profile" "$test_dir/config" "$test_dir/cache"
        timeout 30s env -u ELECTRON_RUN_AS_NODE -u LD_PRELOAD -u DISPLAY -u WAYLAND_DISPLAY \
            XDG_CONFIG_HOME="$test_dir/config" XDG_CACHE_HOME="$test_dir/cache" \
            QQ_PORTAL_TEST_ADDON="$addon" \
            QQ_PORTAL_TEST_LOG="$test_dir/requests.jsonl" \
            QQ_PORTAL_TEST_PROFILE="$test_dir/profile" \
            "$runtime" --ozone-platform=headless --no-sandbox --disable-gpu \
            --user-data-dir="$test_dir/profile" "$repo_dir/tests/portal-integration-electron.js"
    fi
    exit
fi

repo_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
electron_binary=${ELECTRON_BINARY-/usr/lib/electron40/electron}
if [[ ! -x "$electron_binary" ]]; then
    if [[ ${ELECTRON_BINARY+x} ]]; then
        printf 'ELECTRON_BINARY is not executable: %s\n' "$electron_binary" >&2
        exit 1
    fi
    printf 'Electron 40 is not installed; skipping Electron integration checks\n'
    electron_binary=
fi
build_dir=$(mktemp -d "${TMPDIR:-/tmp}/qq-portal-test.XXXXXX")
trap 'rm -rf -- "$build_dir"' EXIT
read -r -a gio_cflags <<< "$(pkg-config --cflags gio-unix-2.0)"
read -r -a gio_libs <<< "$(pkg-config --libs gio-unix-2.0)"
"${CC:-cc}" -shared -fPIC -std=c11 -Wall -Wextra -Werror \
    -DQQ_PORTAL_TIMEOUT_MS=400 -I"${NODE_INCLUDE_DIR:-/usr/include/node}" \
    "${gio_cflags[@]}" "$repo_dir/portal-open-uri.c" \
    -o "$build_dir/portal-open-uri.node" "${gio_libs[@]}"
"${CC:-cc}" -shared -fPIC -std=c11 -D_GNU_SOURCE -Wall -Wextra -Werror \
    "$repo_dir/tests/portal-integration-fork-guard.c" \
    -o "$build_dir/fork-guard.so" -pthread

# Deliberately omit all servicedir/standard_session_servicedirs directives:
# "portal unavailable" must never activate the user's installed portal.
cat > "$build_dir/session.conf" <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=$build_dir</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow own="*"/>
    <allow send_destination="*"/>
    <allow receive_sender="*"/>
  </policy>
</busconfig>
EOF

run_session() {
    local runtime=$1
    local mode=$2
    local test_dir
    test_dir=$(mktemp -d "$build_dir/session.XXXXXX")
    mkdir "$test_dir/no-bus"
    printf 'portal integration fixture\n' > "$test_dir/file with spaces.txt"
    printf 'Testing portal adapter with %s (%s)\n' "$runtime" "$mode"
    dbus-run-session --config-file "$build_dir/session.conf" -- \
        bash "$repo_dir/tests/portal-integration.sh" "$mode" \
        "$runtime" "$build_dir/portal-open-uri.node" \
        "$build_dir/fork-guard.so" "$test_dir" "$repo_dir"
}

run_session "${NODE_BINARY:-/usr/bin/node}" --session
if [[ -n "$electron_binary" ]]; then
    run_session "$electron_binary" --session
    run_session "$electron_binary" --electron-main
fi
