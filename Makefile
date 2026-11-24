# Repository-wide test and check commands.
#
# Each component (agent/, shell/, and later ones) owns a Makefile in its own
# directory with `test` and `check` targets. These root targets run those
# targets for every component directory that exists, and do nothing for one
# that does not exist yet. Pass COMPONENTS=agent to run a single component.

KNOWN_COMPONENTS := agent shell
COMPONENTS ?= $(foreach c,$(KNOWN_COMPONENTS),$(if $(wildcard $(c)/Makefile),$(c)))

.PHONY: test check secret-scan hooks

test:
	@$(if $(strip $(COMPONENTS)),,echo "test: no component directories yet, nothing to run")
	@set -e; for c in $(COMPONENTS); do echo "== $$c: test"; $(MAKE) -C $$c test; done

check:
	@$(if $(strip $(COMPONENTS)),,echo "check: no component directories yet, nothing to run")
	@set -e; for c in $(COMPONENTS); do echo "== $$c: check"; $(MAKE) -C $$c check; done

# Scan the history reachable from HEAD and the working tree for secrets.
# HEAD only: other branches in the clone are scanned by their own runs.
secret-scan:
	gitleaks git --log-opts=HEAD --redact --verbose .
	gitleaks dir --redact --verbose .

# Point git at the repository's hooks (the gitleaks pre-commit hook).
hooks:
	git config core.hooksPath .githooks
