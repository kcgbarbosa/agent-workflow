# The gate runs `make check` on each pull request, and `make check-docs` on one that changes only `*.md` files and `docs/`.
.PHONY: check check-docs hooks root root-deps gate loop loop-deps switchboard switchboard-deps

check: hooks root gate loop switchboard

# The root tests check the docs and the skills. The loop docs test checks loop.md against the loop.toml keys.
check-docs: hooks root
	cd loop && npx vitest run tests/docs.test.ts

# Every check of `lefthook.yml`, on all files. It fails when a check fails or when a formatter changed a file.
hooks: root-deps loop-deps switchboard-deps
	lefthook run pre-commit --all-files --no-stage-fixed --no-auto-install
	git diff --exit-code

# The repo checks: the docs, the skills, the install script, and the pull request scripts.
root: root-deps
	npx vitest run

root-deps:
	npm ci --prefer-offline --no-audit --no-fund --silent

# The gate's Python scripts, which run on the runner's Python 3.12.
gate:
	uv run --no-project --python 3.12 --with pytest --with pyyaml pytest tests

# The TypeScript loop. `mise.toml` pins its Node.
loop: loop-deps
	cd loop && npx tsc && npx vitest run

loop-deps:
	cd loop && npm ci --prefer-offline --no-audit --no-fund --silent

# The switchboard in TypeScript, and the Python one that the live unit runs until the cutover.
# `uv lock --check` fails on a stale lock, which `uv run` would rewrite.
switchboard: switchboard-deps
	cd $@ && npx tsc && npx vitest run
	cd $@ && uv lock --check && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest

switchboard-deps:
	cd switchboard && npm ci --prefer-offline --no-audit --no-fund --silent
