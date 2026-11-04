# The gate runs `make check` on each pull request, and `make check-docs` on one that changes only `*.md` files and `docs/`.
.PHONY: check check-docs hooks root root-deps gate switchboard switchboard-deps runner runner-deps

check: hooks root gate switchboard runner

# The root tests check the docs and the skills.
check-docs: hooks root

# Every check of `lefthook.yml`, on all files. It fails when a check fails or when a formatter changed a file.
hooks: root-deps switchboard-deps runner-deps
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

# The switchboard. `switchboard.service` in machines runs it from the main checkout.
switchboard: switchboard-deps
	cd $@ && npx tsc && npx vitest run

switchboard-deps:
	cd switchboard && npm ci --prefer-offline --no-audit --no-fund --silent

# The T3 runner. `mise.toml` pins its Node.
runner: runner-deps
	cd $@ && npx tsc && npx vitest run

runner-deps:
	cd runner && npm ci --prefer-offline --no-audit --no-fund --silent
