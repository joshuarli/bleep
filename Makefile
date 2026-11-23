.PHONY: lint test clean

lint:
	pnpm run lint
	pnpm run typecheck

test:
	pnpm run test

clean:
	rm -rf node_modules
