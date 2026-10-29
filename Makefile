# The gate runs `make check` on each pull request, and `make check-docs` on one that changes only `*.md` files and `docs/`.
.PHONY: check check-docs root loop switchboard shellcheck

check: root loop switchboard shellcheck

# The root tests check the docs, the skills, and the gate scripts, which run on the runner's Python 3.12. The loop docs test checks loop.md against the loop.toml keys.
check-docs: root
	cd loop && uv run pytest tests/test_docs.py

root:
	uv run --no-project --python 3.12 --with pytest pytest tests

# `uv lock --check` fails on a stale lock, which `uv run` would rewrite.
loop switchboard:
	cd $@ && uv lock --check && uv run ruff check . && uv run ruff format --check . && uv run mypy && uv run pytest

# Through uvx, so no host or runner needs a shellcheck install.
shellcheck:
	uvx --from shellcheck-py shellcheck install.sh .github/scripts/*.sh skills/setup-repo/gate.sh
