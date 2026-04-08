.PHONY: build test lint format clean deploy idl devnet help

PROGRAM_ID := 4bUHrDPuRcoYPU7UTLojXtxJsWoCj3HJbKX9oLnEnYy6
CLUSTER    := devnet

help:
	@echo "KIRITE Protocol — make targets"
	@echo "  build    - anchor build (compile on-chain program)"
	@echo "  test     - cargo test + sdk tests"
	@echo "  lint     - cargo clippy + sdk lint"
	@echo "  format   - cargo fmt + prettier"
	@echo "  idl      - regenerate IDL JSON"
	@echo "  devnet   - run devnet integration test"
	@echo "  deploy   - deploy program to $(CLUSTER)"
	@echo "  clean    - remove build artifacts"

build:
	anchor build

test:
	cargo test --all
	cd sdk && npm test

lint:
	cargo clippy --all-targets --all-features -- -D warnings
	cd sdk && npm run lint

format:
	cargo fmt --all
	cd sdk && npx prettier --write .

idl:
	anchor build
	cp target/idl/kirite.json programs/kirite/idl/kirite.json

devnet:
	npx tsx tests/test-devnet-e2e.ts

deploy:
	solana program deploy target/deploy/kirite.so --url $(CLUSTER)

clean:
	cargo clean
	rm -rf .anchor sdk/node_modules sdk/dist
