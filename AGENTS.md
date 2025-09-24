# Repository Guidelines

## Project Structure & Module Organization
- `edge-function.js` holds the complete EdgeOne fetch handler: request validation, translation option parsing, upstream call, and OpenAI-style response shaping.
- `README.md` documents deployment, language mappings, and usage examples; align any updates with this source of truth.
- No build tooling or auxiliary scripts are committed; keep new assets under dedicated folders if you introduce them (for example `scripts/` or `tests/`).

## Build, Test, and Development Commands
- `node --watch edge-function.js` quickly checks syntax and runtime errors in a Node 18+ shell before deploying. The script will exit immediately, which is expected—the goal is catching parse errors.
- `curl -X POST https://<edgeone-endpoint>/v1/chat/completions \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"model":"doubao-seed-translation","messages":[{"role":"system","content":"{\\"target_language\\":\\"ja\\"}"},{"role":"user","content":"Hello"}],"stream":false}'`
  performs an end-to-end smoke test once the function is deployed.

## Coding Style & Naming Conventions
- Use 4-space indentation, trailing semicolons, and double quotes to match the existing module.
- Favor `const`/`let`, top-level configuration objects, and helper functions that keep the fetch handler concise.
- Functions and variables follow lowerCamelCase (e.g., `parseTranslationOptions`); constants use SCREAMING_SNAKE_CASE when exported broadly.
- Keep inline comments meaningful and sparse, mirroring the concise style already present.

## Testing Guidelines
- There is no automated test harness; rely on manual `curl` checks against staging and production endpoints.
- When adding parsing logic, craft targeted payloads (e.g., invalid JSON, oversized body) and confirm the corresponding error templates fire.
- Document any new manual test cases in the pull request description so reviewers can replay them.

## Commit & Pull Request Guidelines
- Follow Conventional Commits with optional emoji, as seen in history (`feat(readme): ✨ 更新文档...`). Prefer Chinese descriptions when user-facing behaviour changes.
- Group related edits into focused commits; mention the affected scope (`feat`, `fix`, `refactor`) and keep the subject under 72 characters.
- Pull requests should include: summary of changes, deployment impact, manual test evidence, and links to related issues.
- Request review before deploying to EdgeOne; merge only after at least one approval or explicit maintainer sign-off.

## Deployment Notes
- Update `CONFIG.DOUBAO_BASE_URL` only if the upstream Volcengine endpoint changes; avoid hardcoding tokens.
- EdgeOne enforces HTTPS—ensure endpoint URLs and documentation reflect that requirement, and verify Bearer token handling in staged environments.
