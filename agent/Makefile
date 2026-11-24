# agent/: the Python release unit. Every install comes from uv.lock, which
# pins each dependency to an exact version with its hashes.

.PHONY: test check

# Fails when pyproject.toml and uv.lock disagree, then installs from the lock.
check:
	uv lock --check
	uv sync --locked

test: check
	uv run --locked pytest
