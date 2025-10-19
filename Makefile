.PHONY: fmt lint test

GO_DIR := go

fmt:
	@echo "Running gofmt -s -w in $(GO_DIR)..."
	@cd $(GO_DIR) && gofmt -s -w .

lint:
	@cd $(GO_DIR) && fmt_out=$$(gofmt -s -l .); \
	if [ -n "$$fmt_out" ]; then \
	  echo "以下文件未经过 gofmt -s 格式化：" >&2; \
	  echo "$$fmt_out" >&2; \
	  echo "请运行: (cd $(GO_DIR) && gofmt -s -w .)" >&2; \
	  exit 1; \
	fi; \
	go vet ./...

test:
	@cd $(GO_DIR) && go test ./...
