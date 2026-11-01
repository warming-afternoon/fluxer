#!/usr/bin/env sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Normalize the legacy tag before Compose interpolation. Nested required-variable
# expressions are eagerly evaluated by some supported Compose versions.
set -eu
FLUXER_PRODUCT_BUILD_TAG=${FLUXER_PRODUCT_BUILD_TAG:-${FLUXER_BCD_IMAGE_TAG:-}}
: "${FLUXER_PRODUCT_BUILD_TAG:?set FLUXER_PRODUCT_BUILD_TAG to an immutable product image tag}"
export FLUXER_PRODUCT_BUILD_TAG
exec docker compose "$@"
