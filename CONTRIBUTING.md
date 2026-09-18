# Contributing

Contributions are welcome through GitHub pull requests.

## Workflow

1. Fork the repository.
2. Branch from the current `main`.
3. Keep changes focused and preserve the existing safety model.
4. Add or update tests for behavior changes.
5. Run the release checks before opening a pull request.
6. Include verification evidence in the pull request.

## Verification

```bash
npm install --no-audit --no-fund
npm run release:check
```

## Security and safety

Do not commit API keys, RFC tokens, cookies, personal data, private infrastructure information, or other secrets.

Do not weaken confirmation gates, fresh preflight checks, persistent attempt ownership, verification-before-accounting, eligibility fail-closed behavior, or payroll safety in order to make a test pass.

Security concerns should follow `SECURITY.md`, not a public issue.

## Generated userscript

When source changes affect the bundled userscript, run `npm run build` and commit the resulting `dist/Torn Company Training Manager.user.js`. CI verifies that generated output is current and does not write back to `main`.
