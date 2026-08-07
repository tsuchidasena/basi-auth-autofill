# project (monsoon config)
language: js
package_manager: pnpm
default_branch: main
branch_model: feature-branch
docs_lang: ja
check:
  lint: pnpm lint
  typecheck: -
  test: pnpm test
  build: -
opt_in:
  release_note: on
