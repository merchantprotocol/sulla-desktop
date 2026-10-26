#!/usr/bin/env bash

set -o errexit -o nounset -o pipefail

go install github.com/google/go-licenses@v1.6.0

# https://github.com/google/go-licenses/issues/244#issuecomment-1885198141
export GOTOOLCHAIN=local

ARGS=(
    "--include_tests"
    # We just copy the allowed licenses from the CNCF list:
    # https://github.com/cncf/foundation/blob/main/allowed-third-party-license-policy.md#approved-licenses-for-allowlist
    "--allowed_licenses=Apache-2.0,BSD-2-Clause,BSD-2-Clause-FreeBSD,BSD-3-Clause,MIT,ISC,Python-2.0,PostgreSQL,X11,Zlib"
    # skipping our own modules because we only have a LICENSE file in the root of the repo
    "--ignore=github.com/merchantprotocol/sulla-desktop"
    # CNCF has approved several exceptions for MPL-2 licensed modules, including those below
    # https://github.com/cncf/foundation/blob/1e80c35/license-exceptions/cncf-exceptions-2019-11-01.spdx
    "--ignore=github.com/hashicorp/hcl"
    "--ignore=github.com/hashicorp/errwrap"
    "--ignore=github.com/hashicorp/go-multierror"
)

for DIR in src/runtime-agent; do
    pushd "$DIR"
    "$(go env GOPATH)/bin/go-licenses" check "${ARGS[@]}" ./...
    popd >/dev/null
done
