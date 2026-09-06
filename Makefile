.PHONY: verify

verify:
	npm ci
	npm run format:check
	npm run lint
	npm run typecheck
	npm run test:coverage
	npm run build
	npm run demo:check
	npm audit --audit-level=high
	npm run hygiene
	npm run check:pins
