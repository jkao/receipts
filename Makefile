SHELL := /bin/zsh
.DEFAULT_GOAL := help

APP_PATH := release/mac-arm64/Receipt Invoice.app
DEPS_STAMP := node_modules/.package-lock.json

.PHONY: help setup install run dev compile typecheck lint fmt fmt-check test coverage check package open-app audit

help:
	@printf '%s\n' \
		'Receipt Invoice commands' \
		'' \
		'  make setup      Install Node.js dependencies' \
		'  make run        Compile and run the production-mode app locally' \
		'  make dev        Run Electron + Vite with UI hot reload' \
		'  make compile    Type-check and build production assets' \
		'  make typecheck  Check TypeScript without emitting files' \
		'  make lint       Run Biome lint rules' \
		'  make fmt        Format source and configuration files' \
		'  make fmt-check  Verify source formatting without changes' \
		'  make test       Run the automated test suite once' \
		'  make coverage   Run tests with text, HTML, and LCOV coverage' \
		'  make check      Run lint, formatting, coverage, and production build' \
		'  make package    Build the unsigned macOS app bundle' \
		'  make open-app   Open the packaged Apple Silicon app' \
		'  make audit      Audit production dependencies'

$(DEPS_STAMP): package.json package-lock.json
	npm install

setup: $(DEPS_STAMP)

install: setup

compile: setup
	npm run build

run: compile
	npm run start

dev: setup
	npm run dev

typecheck: setup
	npm run typecheck

lint: setup
	npm run lint

fmt: setup
	npm run format

fmt-check: setup
	npm run format:check

test: setup
	npm test

coverage: setup
	npm run test:coverage

check: setup
	npm run check

package: setup
	npm run package:mac

open-app:
	open "$(APP_PATH)"

audit: setup
	npm audit --omit=dev
