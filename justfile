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
    rm -rf resources/cert-manager*
    rm -rf resources/darwin/_output
    rm -rf resources/darwin/images resources/darwin/whisper
    rm -rf resources/host/
    rm -rf resources/preload.js*
    rm -rf resources/rancher-dashboard/
    rm -rf resources/spin-operator*
    @echo "Cleanup complete. Run 'just build' for a fresh install."

# Clean all caches and generated files for a fresh install (WIPES VM AND IMAGES)
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
    rm -rf ~/Library/Logs/rancher-desktop
    rm -rf ~/.rd
    rm -rf resources/cert-manager*
    rm -rf resources/darwin/_output
    rm -rf resources/darwin/images resources/darwin/whisper
    rm -rf resources/host/
    rm -rf resources/preload.js*
    rm -rf resources/rancher-dashboard/
    rm -rf resources/spin-operator*
    @echo "Cleanup complete. Run 'just build' for a fresh install."

nvm:
    @nvm install 22.22
    @nvm use 22.22

# Install dependencies and build the application for production
install:
    yarn install --ignore-platform

# Download the latest published Sulla runtime (macOS VM) into resources/
runtime:
    ./scripts/fetch-sulla-runtime.sh

# Embed the service container images, whisper (model + whisper-cli) and the
# audio loopback driver in resources/darwin/ so the app downloads nothing after
# install. Only changed parts are downloaded. SULLA_BUNDLE_SKIP=all (or a
# comma list of images,whisper,audio) skips them for quick dev builds. The
# BlackHole installer is only embedded with SULLA_BUNDLE_BLACKHOLE=1 (license).
assets:
    node scripts/ts-wrapper.js scripts/fetch-bundled-assets.ts

build: runtime assets
    NODE_OPTIONS="--max-old-space-size=12288" yarn build

package: runtime
    yarn package
    
# Rebuild without wiping VM (preserves cached images)
rebuild: clean build

# Full rebuild - wipes everything including VM and cached images
rebuild-hard: clean-hard install build

build-mac: build
    #!/bin/sh
    set -e
    yarn package
    just verify-mac-signing
    echo "Mac app built and signed in dist/. Run 'just install-mac' to replace /Applications/Sulla Desktop.app."

# Install the built app to /Applications (without rebuilding).
# Never re-sign the copy: electron-builder already signed dist/ with the
# Developer ID, hardened runtime and packaging/entitlements.mac.plist. An
# ad-hoc re-sign pins macOS privacy grants (Screen Recording, Microphone)
# to that one build's hash, so every install silently loses them.
install-mac:
    #!/bin/sh
    set -e
    APP="dist/mac-arm64/Sulla Desktop.app"
    if [ ! -d "$APP" ]; then
        echo "No build found. Run 'just build-mac' first."
        exit 1
    fi
    # Refuse before touching the running app if the build isn't properly signed
    just verify-mac-signing "$APP"
    # Quit the running app and wait for it to fully exit
    osascript -e 'quit app "Sulla Desktop"' 2>/dev/null || true
    sleep 2
    # Force-kill any lingering processes
    pkill -f "Sulla Desktop" 2>/dev/null || true
    sleep 1
    # Remove old install (retry with sudo if permission denied)
    if [ -d "/Applications/Sulla Desktop.app" ]; then
        rm -rf "/Applications/Sulla Desktop.app" 2>/dev/null || \
            sudo rm -rf "/Applications/Sulla Desktop.app"
    fi
    # Copy using ditto (preserves symlinks, resource forks, HFS metadata)
    ditto "$APP" "/Applications/Sulla Desktop.app"
    xattr -rd com.apple.quarantine "/Applications/Sulla Desktop.app" 2>/dev/null || true
    just verify-mac-signing "/Applications/Sulla Desktop.app"
    echo "Installed to /Applications/Sulla Desktop.app"

# Check a Sulla Desktop.app is Developer ID signed (not ad-hoc) with hardened
# runtime and the mic entitlement, so macOS privacy grants survive updates.
verify-mac-signing app="dist/mac-arm64/Sulla Desktop.app":
    #!/bin/sh
    set -e
    APP="{{app}}"
    if ! codesign --verify --deep --strict "$APP" 2>/dev/null; then
        echo "✗ $APP: signature is missing or broken."
        exit 1
    fi
    INFO=$(codesign -dv --verbose=4 "$APP" 2>&1)
    TEAM=$(echo "$INFO" | sed -n 's/^TeamIdentifier=//p')
    if echo "$INFO" | grep -q '^Signature=adhoc' || [ -z "$TEAM" ] || [ "$TEAM" = "not set" ]; then
        echo "✗ $APP is ad-hoc signed. macOS will forget Screen Recording and"
        echo "  Microphone approvals on every install. Package with the"
        echo "  'Developer ID Application' certificate in the login keychain."
        exit 1
    fi
    if ! echo "$INFO" | grep -q 'flags=.*runtime'; then
        echo "✗ $APP: hardened runtime is off."
        exit 1
    fi
    if ! codesign -d --entitlements - "$APP" 2>/dev/null | grep -q 'com.apple.security.device.audio-input'; then
        echo "✗ $APP: missing the microphone entitlement."
        exit 1
    fi
    echo "✓ $APP signed by team $TEAM (hardened runtime, entitlements present)"

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
    yarn test pkg/sulla-desktop/agent/nodes/__tests__/ActivePlanManager.mock.test.ts

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

ping-memory:
    @echo "Pinging memory health endpoint..."
    resources/darwin/sulla-runtime/sulla-runtime exec -- \
    curl -s -m 5 http://localhost:30115/api/v2/heartbeat || echo "memory unreachable (timeout or 410)"

pg-conn:
     echo "Connecting to psql..." && \
     PGPASSWORD=sulla_dev_password psql -h localhost -p 30116 -U sulla -d sulla

# Login to Docker Hub inside the VM (bypasses rate limiting for image pulls)
docker-login:
    @echo "Logging into Docker Hub inside the VM..."
    @echo "This will store credentials in the VM and bypass Docker Hub rate limits."
    resources/darwin/sulla-runtime/sulla-runtime exec -- docker login

# Check Docker login status inside the VM
docker-status:
    @echo "Checking Docker login status..."
    resources/darwin/sulla-runtime/sulla-runtime exec -- docker info 2>/dev/null | grep -E "Username|Registry" || echo "Not logged in"

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
    yarn test pkg/sulla-desktop/agent/nodes/__tests__/ActivePlanManager.mock.test.ts --verbose

# Test with coverage report
test-coverage:
    @echo "📊 Running tests with coverage report..."
    yarn test --coverage pkg/sulla-desktop/agent/nodes/__tests__/ActivePlanManager.mock.test.ts

# Run InputHandlerNode mock tests
test:
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/SkillGraph.integration.test.ts --detectOpenHandles

# Run PlanRetrievalNode mock tests  
test-retrieval:
    @echo "📋 Running PlanRetrievalNode Mock Tests (intent classification, skill selection, rule-based detection)"
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/PlanRetrievalNode.mock.test.ts

# Run InputHandlerNode production tests (legitimate scenarios)
test-input-prod:
    @echo "🏭 Running InputHandlerNode Production Tests (real user scenarios, proper types)"
    @echo "Testing: injection detection, rate limiting, spam detection, summarization triggers"
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/InputHandlerNode.production.test.ts

# Run advanced InputHandler tests (real service integration)
test-advanced-input:
    @echo "🔥 Running Advanced InputHandler Tests"
    @echo "Testing: real ConversationSummaryService and ObservationalSummaryService integration"
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/InputHandler.advanced.test.ts

# Run single simple InputHandler test (start small)
test-simple-input:
    @echo "🧪 Running Single Simple InputHandler Test"
    @echo "Testing: basic message processing with minimal setup"
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/InputHandler.simple.test.ts

# Run single simple PlanRetrievalNode test (start small)
test-simple-plan:
    @echo "📋 Running Single Simple PlanRetrievalNode Test"
    @echo "Testing: basic intent classification with minimal setup"
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/PlanRetrievalNode.simple.test.ts

# Run advanced PlanRetrievalNode tests (adversarial scenarios)
test-advanced-plan:
    @echo "🔥 Running Advanced PlanRetrievalNode Tests"
    @echo "Testing: malformed responses, timeouts, massive content, concurrency"
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/PlanRetrievalNode.advanced.test.ts

# Run simple PlannerNode test (start small)
test-simple-planner:
    @echo "📅 Running Simple PlannerNode Test"
    @echo "Testing: basic plan generation with minimal setup"
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/PlannerNode.simple.test.ts

# Run simple SullaSettingsModel test (start small)
test-simple-settings:
    @echo "⚙️ Running Simple SullaSettingsModel Test"
    @echo "Testing: basic get/set operations with file fallback"
    npx jest pkg/sulla-desktop/agent/database/models/__tests__/SullaSettingsModel.simple.test.ts

# Run ReAct loop integration test
test-react-loop:
    @echo "🔄 Running ReAct Loop Integration Test"
    @echo "Testing: ReasoningNode → ActionNode → ReasoningNode cycle until goal achieved"
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/ReActLoop.simple.test.ts

# ============================================================================
# SKILLGRAPH TESTS
# ============================================================================

# Run SkillGraph core production test (focused validation without environment complexity)
test-skillgraph-core:
    @echo "🎯 Running SkillGraph CORE PRODUCTION Test"
    @echo "Testing: TypeScript compatibility, real state mutations, actual node execution"
    @echo "Purpose: Validate core functionality catches real production issues"
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/SkillGraph.core-production.test.ts --verbose

# Run SkillGraph retry scenarios test (validates retry logic with simulated failures)
test-skillgraph-retries:
    @echo "🔄 Running SkillGraph RETRY SCENARIOS Test"
    @echo "Testing: Planner retries (3 attempts), Reasoning retries (3 attempts), Critic verification"
    @echo "Purpose: Validate retry logic works when LLM responses fail initially"
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/SkillGraph.retry-scenarios.test.ts --verbose

# ============================================================================
# NODE TESTS
# ============================================================================

# Run all node tests in sequence
test-nodes:
    @echo "🧪 Running All Node Mock Tests (InputHandler → PlanRetrieval → ActivePlan)"
    @echo "Testing complete conversation flow..."
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/InputHandlerNode.mock.test.ts
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/PlanRetrievalNode.mock.test.ts
    npx jest pkg/sulla-desktop/agent/nodes/__tests__/ActivePlanManager.mock.test.ts

# Build whisper-cli from its pinned source (requires cmake); `just assets` runs this too.
build-whisper:
    bash scripts/build-whisper-cli.sh

# Build the macOS .app launcher (double-clickable icon, no packaging needed)
app:
    ./launcher/build-app.sh

# Watch pod events in real time (shows scheduling, image pulls, crashes)
show-compose-yaml:
    resources/darwin/sulla-runtime/sulla-runtime exec -- sudo cat /tmp/sulla-docker-compose.yml