# CI-friendly entry points. `make check` is what CI runs: lint, template-doc drift, tests.
# Tests need Postgres reachable at TEST_DATABASE_URL (default: pos:pos@localhost:5460/del_test, a SUPERUSER/owner login: the
# suite creates the non-owner app role del_test_app itself, see docs/RLS.md). Run ONE test process at a time.
UV ?= uv
export ENV ?= development

.PHONY: help install lint fmt-check test check migrate run docs audit

help:
	@grep -E '^[a-z-]+:.*##' $(MAKEFILE_LIST) | sed 's/:.*##/ -/'

install:  ## sync dependencies from the lockfile
	$(UV) sync --frozen

lint:  ## ruff
	$(UV) run ruff check .

test:  ## full suite (schema rebuilt via Alembic, fake POS + mock/fake-transport WhatsApp, no network)
	$(UV) run pytest -q

docs:  ## regenerate docs/WHATSAPP_TEMPLATES.md from the template registry
	$(UV) run python scripts/gen_template_doc.py

check: lint test  ## lint + tests (the template doc is checked by a test)

migrate:  ## alembic upgrade head (ADMIN_DATABASE_URL = owner login; DATABASE_URL = app role)
	$(UV) run alembic upgrade head

run:  ## dev server on :8130
	$(UV) run uvicorn app.main:app --port 8130

audit:  ## dependency advisories against the locked set
	$(UV) export --frozen --no-hashes --no-emit-project > /tmp/delivery-requirements.txt
	uvx pip-audit -r /tmp/delivery-requirements.txt --disable-pip
