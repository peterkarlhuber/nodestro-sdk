.PHONY: install generate contract check test test-python test-typescript lint package

PYTHON ?= python
# The studio lock: the exact commits of the internal packages whose version ranges python/pyproject.toml declares
# (nodestro-api in the test extra). A URL or a local file; install copies it to a temporary file first.
LOCK ?= https://raw.githubusercontent.com/peterkarlhuber/nodestro-studio/master/platform/internal-server.txt

install:
	lock="$$(mktemp)" && \
	case "$(LOCK)" in http://*|https://*) curl -fsSL "$(LOCK)" -o "$$lock" ;; *) cp "$(LOCK)" "$$lock" ;; esac && \
	cd python && $(PYTHON) -m pip install "pip>=26.1" && $(PYTHON) -m pip install -c "$$lock" -e ".[dev,test]"
	cd typescript && npm ci

# Regenerates the types of both SDKs from openapi/nodestro-api.json (CI checks they are current).
generate:
	cd python && datamodel-codegen --input ../openapi/nodestro-api.json --input-file-type openapi \
		--output-model-type typing.TypedDict --output src/nodestro_client/models.py \
		--target-python-version 3.11 --use-standard-collections --use-union-operator --disable-timestamp
	cd typescript && npm run generate

# Copies the OpenAPI document of the installed (pinned) nodestro-api and regenerates the types.
contract:
	$(PYTHON) -m nodestro_api.openapi > openapi/nodestro-api.json
	$(MAKE) generate

lint:
	cd python && ruff check . ../scripts && ruff format --check . ../scripts && mypy
	cd typescript && npm run typecheck

test-python:
	cd python && pytest

test-typescript:
	cd typescript && NODESTRO_SDK_PYTHON=$(PYTHON) npm test

test: test-python test-typescript

# Packs @nodestro/client and compiles and runs a strict consumer project against the tarball.
package:
	scripts/check_typescript_package.sh

check: lint test
