# Sulla Desktop Development Commands

# Default command: show help and list all available commands
default:
    @echo "╔════════════════════════════════════════════════════════════════╗"
    @echo "║           Sulla Desktop - Development Commands                 ╚"
    @echo "╚════════════════════════════════════════════════════════════════╝"
    @echo ""
    @just --list --unsorted

# Clean build artifacts only (preserves VM and cached images)
clean:
    @echo "Cleaning up for fresh install (preserves VM and cached images)..."
    rm -rf node_modules
    rm -rf .yarn/cache
    rm -rf .yarn/install-state.gz
    rm -rf dist
    rm -rf ~/Library/Preferences/rancher-desktop
    rm -rf ~/Library/Caches/rancher-desktop
    rm -rf ~/Library/Logs/rancher-desktop
    rm -rf ~/.rd
    rm -rf ~/.kube/config
    rm -rf resources/cert-manager*
    rm -rf resources/darwin/lima
    rm -rf resources/darwin/_output
    rm -f resources/darwin/alpine-lima-*.iso
    rm -rf resources/host/
    rm -rf resources/preload.js*
    rm -rf resources/rancher-dashboard/
    rm -rf resources/rdx-proxy.tar
    rm -rf resources/spin-operator*
    rm -rf resources/win32/
    @echo "Cleanup complete. Run 'just build' for a fresh install."

# Clean all caches and generated files for a fresh install (WIPES VM AND IMAGES)
#rm -rf ~/.lima # This wipes the images too
clean-hard:
    @echo "Cleaning up for fresh install (this will wipe VM and cached images)..."
    rm -rf node_modules
    rm -rf .yarn/cache
    rm -rf .yarn/install-state.gz
    rm -rf dist
    rm -rf ~/Library/Application\ Support/rancher-desktop
    rm -rf ~/Library/Application\ Support/sulla-desktop
    rm -rf ~/Library/Preferences/rancher-desktop
    rm -rf ~/Library/Caches/rancher-desktop
    rm -rf ~/Library/Caches/lima
    rm -rf ~/Library/Logs/rancher-desktop
    rm -rf ~/.rd
    rm -rf ~/.kube/config
    rm -rf resources/cert-manager*
    rm -rf resources/darwin/lima
    rm -rf resources/darwin/_output
    rm -f  resources/darwin/alpine-lima-*.iso
    rm -rf resources/host/
    rm -rf resources/preload.js*
    rm -rf resources/rancher-dashboard/
    rm -rf resources/rdx-proxy.tar
    rm -rf resources/spin-operator*
    rm -rf resources/win32/
    @echo "Cleanup complete. Run 'just build' for a fresh install."

nvm:
    @nvm install 22.22
    @nvm use 22.22

# Install dependencies and build the application for production
install:
    yarn install --ignore-platform

build:
    NODE_OPTIONS="--max-old-space-size=12288" yarn build

package:
    yarn package
    
# Rebuild without wiping VM (preserves cached images)
rebuild: clean build

# Full rebuild - wipes everything including VM and cached images
rebuild-hard: clean-hard install build

build-mac:
    yarn package
    @echo "DMG built in dist/"

# Open the DMG so you can drag Sulla Desktop into Applications
install-mac:
    #!/bin/sh
    set -e
    dmg=$(ls -t dist/*.dmg 2>/dev/null | head -1)
    if [ -z "$dmg" ]; then
        echo "No DMG found in dist/. Run 'just build-mac' first."
        exit 1
    fi
    echo "Opening $dmg ..."
    open "$dmg"

# Stop Sulla Desktop, remove from Applications, and eject the DMG
uninstall-mac:
    #!/bin/sh
    set -e
    # Quit the .app bundle if running
    osascript -e 'quit app "Sulla Desktop"' 2>/dev/null || true
    sleep 1
    # Remove from Applications
    if [ -d "/Applications/Sulla Desktop.app" ]; then
        rm -rf "/Applications/Sulla Desktop.app"
        echo "Removed Sulla Desktop from /Applications."
    else
        echo "Sulla Desktop not found in /Applications."
    fi
    # Eject any mounted Sulla Desktop DMGs
    for vol in /Volumes/Sulla*Desktop*; do
        if [ -d "$vol" ]; then
            hdiutil detach "$vol" 2>/dev/null && echo "Ejected $vol" || true
        fi
    done
    echo "Uninstall complete."

# Dev mode (foreground)
dev:
    NODE_NO_WARNINGS=1 yarn dev

# Start after build (detached, logs to ~/sulla/logs/)
start:
    NODE_NO_WARNINGS=1 yarn start

# ============================================================================
# DEVELOPMENT & BUILD COMMANDS
# ============================================================================

# Test commands for Active Plan Management system
test-install:
    @echo "Installing test dependencies..."
    yarn add --dev jest @types/jest ts-jest
    @echo "Creating Jest config if it doesn't exist..."
    [ -f jest.config.js ] || echo 'module.exports = { preset: "ts-jest", testEnvironment: "node", testMatch: ["**/__tests__/**/*.test.ts"] };' > jest.config.js

# Run Active Plan Management mock tests (no server needed)
test-plans:
    @echo "🧪 Running Active Plan Management Mock Tests (no server required)"
    @echo "Tests use mocked dependencies - completely isolated"
    yarn test pkg/rancher-desktop/agent/nodes/__tests__/ActivePlanManager.mock.test.ts

# Run all tests
test-all:
    @echo "🧪 Running all tests..."
    yarn test

# Run tests in watch mode for development
test-watch:
    @echo "🧪 Running tests in watch mode..."
    yarn test --watch

# Stop gracefully (SIGTERM → force if needed)
stop:
    #!/usr/bin/env bash
    PID_FILE="$HOME/sulla/logs/sulla-desktop.pid"
    if [ ! -f "$PID_FILE" ]; then
        echo "No PID file found. Not running."
        exit 0
    fi
    PID=$(cat "$PID_FILE")
    if ! kill -0 "$PID" 2>/dev/null; then
        echo "Process $PID not running. Cleaning up stale PID file."
        rm -f "$PID_FILE"
        exit 0
    fi
    echo "Stopping Sulla Desktop (PID $PID)..."
    kill -TERM "$PID" 2>/dev/null || true
    for i in {1..15}; do
        if ! kill -0 "$PID" 2>/dev/null; then
            echo "Stopped."
            rm -f "$PID_FILE"
            exit 0
        fi
        sleep 1
    done
    kill -9 "$PID" 2>/dev/null || true
    rm -f "$PID_FILE"
    echo "Force stopped."

# Restart the development server (use --hard to wipe VM and images)
restart hard="":
    #!/usr/bin/env bash
    just stop
    if [ "{{hard}}" = "--hard" ] || [ "{{hard}}" = "hard" ]; then
        echo "Hard restart: full rebuild (wiping VM and images)..."
        just rebuild-hard
    fi
    if [ "{{hard}}" = "--build" ] || [ "{{hard}}" = "build" ]; then
        echo "Building the system"
        just build
    fi
    just start

pods:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    sudo k3s kubectl get pods -n sulla

apply-yaml:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    sudo k3s kubectl apply -f /Users/jonathonbyrdziak/Sites/sulla/sulla-desktop/pkg/rancher-desktop/assets/sulla-deployments.yaml -n sulla

ping-memory:
    @echo "Pinging memory health endpoint..."
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    curl -s -m 5 http://localhost:30115/api/v2/heartbeat || echo "memory unreachable (timeout or 410)"

# Port-forward PostgreSQL to localhost:5432 for external access (e.g., pgAdmin, DBeaver)
# Connection: host=localhost, port=5432, user=sulla, password=sulla_dev_password, database=sulla
pg-forward:
    @echo "Port-forwarding PostgreSQL to localhost:5432..."
    @echo "Connect with: host=localhost, port=5432, user=sulla, password=sulla_dev_password, database=sulla"
    @echo "Press Ctrl+C to stop"
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    sudo k3s kubectl port-forward -n sulla svc/postgres 30116:30116 --address=0.0.0.0

pg-connect:
    @echo "Starting port-forward in background (auto-stops on exit)..."
    @trap 'kill 0' EXIT; \
     just pg-forward & \
        sleep 3 && \
        echo "Connecting to psql..." && \
        PGPASSWORD=sulla_dev_password psql -h localhost -p 30116 -U sulla -d sulla

pg-conn:
     echo "Connecting to psql..." && \
     PGPASSWORD=sulla_dev_password psql -h localhost -p 30116 -U sulla -d sulla

# Port-forward Redis to localhost:6379 for external access
redis:
    @echo "Port-forwarding Redis to localhost:6379..."
    @echo "Press Ctrl+C to stop"
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    sudo k3s kubectl port-forward -n sulla svc/redis 6379:6379 --address=0.0.0.0

# Query PostgreSQL conversations table (summary)
pg-conversations:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    sudo k3s kubectl exec -n sulla deploy/postgres -- \
    psql -U sulla -c "SELECT thread_id, jsonb_array_length(messages) as msg_count, updated_at FROM conversations ORDER BY updated_at DESC LIMIT 10;"

# Query PostgreSQL conversations with full messages
pg-messages thread_id="":
    #!/usr/bin/env bash
    if [ -z "{{thread_id}}" ]; then
        echo "Usage: just pg-messages <thread_id>"
        echo "Get thread IDs with: just pg-conversations"
        exit 1
    fi
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    sudo k3s kubectl exec -n sulla deploy/postgres -- \
    psql -U sulla -c "SELECT jsonb_pretty(messages) FROM conversations WHERE thread_id = '{{thread_id}}';"

# Login to Docker Hub inside the VM (bypasses rate limiting for image pulls)
docker-login:
    @echo "Logging into Docker Hub inside the VM..."
    @echo "This will store credentials in the VM and bypass Docker Hub rate limits."
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- docker login

# Check Docker login status inside the VM
docker-status:
    @echo "Checking Docker login status..."
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- docker info 2>/dev/null | grep -E "Username|Registry" || echo "Not logged in"

# Query PostgreSQL calendar_events table
pg-events:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    sudo k3s kubectl exec -n sulla deploy/postgres -- \
    psql -U sulla -c "SELECT id, title, start_time, end_time, location, description FROM calendar_events ORDER BY start_time;"

get-lima-config:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl list --json 2>/dev/null || echo '[]' | jq -c 'if . == [] then "No instances found" else .[] | {name, status, dir, sshLocalPort} end'

lima-logs:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 sudo cat /var/log/messages | tail -50

check-ws:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 sudo nerdctl --address /var/run/docker/containerd/containerd.sock ps | grep rd-ws-server

logs image:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    sudo k3s kubectl logs -n sulla deployment/{{image}} -f

kill-pod image:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    sudo k3s kubectl delete pod -n sulla -l app={{image}} --force --grace-period=0

watch-pod image:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    sudo k3s kubectl get pods -n sulla -l app={{image}} -w

describe image:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    sudo k3s kubectl describe pod -n sulla {{image}}

describe-default image:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    sudo k3s kubectl describe pod -n kube-system {{image}}

monitor:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    resources/darwin/lima/bin/limactl shell 0 -- \
    sudo k3s kubectl get pods -n kube-system -w

nerd:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- bash ./wait-k8s-ready.sh

k3s-health:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- curl -kfsS --unix-socket /run/k3s/server.sock https://localhost:6444/healthz

pull-ollama:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- \
    sudo nerdctl --address /var/run/docker/containerd/containerd.sock --namespace k8s.io pull ollama/ollama:latest

stop-k8s:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl stop 0 

chat-ping:
    curl http://localhost:3000/health
    
chat:
    curl -X POST http://localhost:3000/v1/chat/completions \
    -H "Content-Type: application/json" \
    -d '{"model": "sulla", "messages": [{"role": "user", "content": "Test message"}]}'

# ============================================================================
# SPECIALIZED TESTS
# ============================================================================

# Test the 3-strike plan takeover system with detailed output
test-takeover:
    @echo "🎯 Testing 3-Strike Plan Takeover System"
    @echo "Running detailed mock scenarios:"
    @echo "  ✅ Strike 1: Healthy plans (< 60s) - should stop flow"
    @echo "  ⚠️ Strike 2: Unhealthy plans (60-120s) - should pause"
    @echo "  💀 Strike 3: Stale plans (>120s) - should takeover"
    @echo ""
    yarn test pkg/rancher-desktop/agent/nodes/__tests__/ActivePlanManager.mock.test.ts --verbose

# Test with coverage report
test-coverage:
    @echo "📊 Running tests with coverage report..."
    yarn test --coverage pkg/rancher-desktop/agent/nodes/__tests__/ActivePlanManager.mock.test.ts

# Run InputHandlerNode mock tests
test:
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/SkillGraph.integration.test.ts --detectOpenHandles

# Run PlanRetrievalNode mock tests  
test-retrieval:
    @echo "📋 Running PlanRetrievalNode Mock Tests (intent classification, skill selection, rule-based detection)"
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/PlanRetrievalNode.mock.test.ts

# Run InputHandlerNode production tests (legitimate scenarios)
test-input-prod:
    @echo "🏭 Running InputHandlerNode Production Tests (real user scenarios, proper types)"
    @echo "Testing: injection detection, rate limiting, spam detection, summarization triggers"
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/InputHandlerNode.production.test.ts

# Run advanced InputHandler tests (real service integration)
test-advanced-input:
    @echo "🔥 Running Advanced InputHandler Tests"
    @echo "Testing: real ConversationSummaryService and ObservationalSummaryService integration"
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/InputHandler.advanced.test.ts

# Run single simple InputHandler test (start small)
test-simple-input:
    @echo "🧪 Running Single Simple InputHandler Test"
    @echo "Testing: basic message processing with minimal setup"
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/InputHandler.simple.test.ts

# Run single simple PlanRetrievalNode test (start small)
test-simple-plan:
    @echo "📋 Running Single Simple PlanRetrievalNode Test"
    @echo "Testing: basic intent classification with minimal setup"
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/PlanRetrievalNode.simple.test.ts

# Run advanced PlanRetrievalNode tests (adversarial scenarios)
test-advanced-plan:
    @echo "🔥 Running Advanced PlanRetrievalNode Tests"
    @echo "Testing: malformed responses, timeouts, massive content, concurrency"
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/PlanRetrievalNode.advanced.test.ts

# Run simple PlannerNode test (start small)
test-simple-planner:
    @echo "📅 Running Simple PlannerNode Test"
    @echo "Testing: basic plan generation with minimal setup"
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/PlannerNode.simple.test.ts

# Run simple SullaSettingsModel test (start small)
test-simple-settings:
    @echo "⚙️ Running Simple SullaSettingsModel Test"
    @echo "Testing: basic get/set operations with file fallback"
    npx jest pkg/rancher-desktop/agent/database/models/__tests__/SullaSettingsModel.simple.test.ts

# Run ReAct loop integration test
test-react-loop:
    @echo "🔄 Running ReAct Loop Integration Test"
    @echo "Testing: ReasoningNode → ActionNode → ReasoningNode cycle until goal achieved"
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/ReActLoop.simple.test.ts

# ============================================================================
# SKILLGRAPH TESTS
# ============================================================================

# Run SkillGraph core production test (focused validation without environment complexity)
test-skillgraph-core:
    @echo "🎯 Running SkillGraph CORE PRODUCTION Test"
    @echo "Testing: TypeScript compatibility, real state mutations, actual node execution"
    @echo "Purpose: Validate core functionality catches real production issues"
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/SkillGraph.core-production.test.ts --verbose

# Run SkillGraph retry scenarios test (validates retry logic with simulated failures)
test-skillgraph-retries:
    @echo "🔄 Running SkillGraph RETRY SCENARIOS Test"
    @echo "Testing: Planner retries (3 attempts), Reasoning retries (3 attempts), Critic verification"
    @echo "Purpose: Validate retry logic works when LLM responses fail initially"
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/SkillGraph.retry-scenarios.test.ts --verbose

# ============================================================================
# NODE TESTS
# ============================================================================

# Run all node tests in sequence
test-nodes:
    @echo "🧪 Running All Node Mock Tests (InputHandler → PlanRetrieval → ActivePlan)"
    @echo "Testing complete conversation flow..."
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/InputHandlerNode.mock.test.ts
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/PlanRetrievalNode.mock.test.ts
    npx jest pkg/rancher-desktop/agent/nodes/__tests__/ActivePlanManager.mock.test.ts

# ============================================================================
# KUBERNETES & LIMA COMMANDS
# ============================================================================

limactl:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl list

nodes:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- sudo k3s kubectl get nodes

kubectl:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    sudo k3s kubectl help

# Watch pod events in real time (shows scheduling, image pulls, crashes)
watch-events:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- sudo k3s kubectl get events -A --watch

# Quick check: is API server responding?
k3s-ready:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- sudo k3s kubectl get --raw=/readyz || echo "API not ready"

fix-flannel:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- sudo rm -rf /run/flannel /var/lib/cni/flannel
    limactl shell 0 -- sudo /etc/init.d/k3s restart
    echo "Watching k3s logs for flannel..."
    limactl shell 0 -- sudo tail -f /var/log/k3s.log | grep -i flannel

k3s-restart:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- sudo systemctl restart k3s

flannel-logs:
    limactl shell 0 -- sudo tail -f /var/log/k3s.log | grep -i flannel

# Tail live k3s server logs inside Lima VM (most useful for startup hangs)
k3s-logs:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- sudo tail -f /var/log/k3s.log

# Tail k3s agent logs (if using agent mode, less common in single-node)
k3s-agent-logs:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- sudo journalctl -u k3s-agent -f

# Show last 100 lines of k3s logs + follow
k3s-tail:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- sudo journalctl -u k3s -n 100 -f

# Check if k3s process is even running inside VM
k3s-status:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- sudo systemctl status k3s


# Build whisper-cli from source (requires cmake). Builds a static binary with Metal acceleration.
build-whisper:
    #!/usr/bin/env bash
    set -e
    VERSION="v1.8.4"
    ARCH=$(uname -m)  # arm64 or x86_64
    DEST="resources/darwin/bin/whisper-cli"
    TMP=$(mktemp -d)
    trap "rm -rf $TMP" EXIT

    echo "Building whisper-cli $VERSION for darwin-$ARCH..."
    git clone --depth 1 --branch "$VERSION" https://github.com/ggml-org/whisper.cpp.git "$TMP"
    cmake -B "$TMP/build" -S "$TMP" \
        -DCMAKE_BUILD_TYPE=Release \
        -DBUILD_SHARED_LIBS=OFF \
        -DWHISPER_BUILD_TESTS=OFF \
        -DWHISPER_BUILD_EXAMPLES=ON \
        -DGGML_METAL=ON
    cmake --build "$TMP/build" --config Release -j$(sysctl -n hw.ncpu) -- whisper-cli

    mkdir -p resources/darwin/bin
    cp "$TMP/build/bin/whisper-cli" "$DEST"
    chmod +x "$DEST"
    echo "Built: $DEST ($(du -h "$DEST" | cut -f1))"

# Upload pre-built whisper-cli to a GitHub release so `just build` can download it.
# Run after `just build-whisper` on each architecture (arm64 and x86_64).
upload-whisper:
    #!/usr/bin/env bash
    set -e
    VERSION="v1.8.4"
    ARCH=$(uname -m)
    SRC="resources/darwin/bin/whisper-cli"
    TAG="whisper-cli-$VERSION"
    ASSET="whisper-cli-darwin-$ARCH"

    if [ ! -f "$SRC" ]; then
        echo "No binary at $SRC. Run 'just build-whisper' first."
        exit 1
    fi

    # Create the release tag if it doesn't exist yet
    gh release view "$TAG" &>/dev/null || \
        gh release create "$TAG" --title "whisper-cli $VERSION" --notes "Pre-built whisper-cli static binaries (Metal + Accelerate)."

    # Upload (overwrite if re-running)
    cp "$SRC" "/tmp/$ASSET"
    gh release upload "$TAG" "/tmp/$ASSET" --clobber
    rm "/tmp/$ASSET"
    echo "Uploaded $ASSET to release $TAG"

# Build the macOS .app launcher (double-clickable icon, no packaging needed)
app:
    ./launcher/build-app.sh

# Watch pod events in real time (shows scheduling, image pulls, crashes)
show-compose-yaml:
    LIMA_HOME=~/Library/Application\ Support/rancher-desktop/lima \
    limactl shell 0 -- sudo cat /tmp/sulla-docker-compose.yml