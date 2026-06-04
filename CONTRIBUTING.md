# Contributing to NEXAR

First off — thank you for your interest. NEXAR is my first production project 
and I'm genuinely excited to build it in the open. Contributions are welcome 
and appreciated.

---

## Before You Start

NEXAR is MIT licensed with one important note: **the brand, deployed contracts, 
and nexarip.online infrastructure remain mine**. By contributing, you agree your 
work is contributed under the same terms and that all IP rights are assigned to 
the project owner. You will be credited by name in the changelog and commits.

---

## What You Can Contribute

### ✅ Good areas for contributions

- **Dashboard UI** — new pages, better UX, mobile improvements
- **Bot commands** — new intents, better message formatting, edge cases
- **Tests** — unit tests, integration tests, E2E coverage
- **Multi-language support** — bot responses in other languages
- **Documentation** — clearer README sections, inline code comments
- **Bug fixes** — anything in the issue tracker marked `good first issue`
- **CDR condition implementations** — new access condition types

### ❌ Please don't submit PRs for

- Changes to deployed smart contracts — these are live on-chain
- Anything touching the Privy signing flow or private key handling
- Core CDR vault logic — too much can go wrong
- Changing the NEXAR brand, logo, or nexarip.online domain routing

If you're unsure whether something is in scope, open an issue first and ask.

---

## How to Contribute

**1. Open an issue first**

For anything beyond a small bug fix, open an issue before writing code. 
Describe what you want to build and why. This saves both of us time.

**2. Fork and branch**

```bash
git fork https://github.com/0xZaid10/nexar
git checkout -b feat/your-feature-name
```

**3. Set up locally**

```bash
nvm use 22
npm install
cp .env.example .env
# Fill in your own API keys — never commit real keys
npm run start:dev
```

**4. Make your changes**

- Keep PRs focused — one feature or fix per PR
- Follow the existing code style (TypeScript, ESM imports, tsx runtime)
- Add a comment if your change is non-obvious
- Test your change manually before submitting

**5. Submit a pull request**

- Clear title describing what changed
- Reference the issue number if applicable (`Closes #12`)
- Short description of what you did and why
- Screenshots or logs if it's a UI or bot change

---

## Code Style

```
Language:   TypeScript (strict)
Runtime:    Node.js 22 via tsx/esm
Formatting: no linter enforced yet — just match the surrounding code
Imports:    ESM only (import, not require)
Logging:    use createLogger() from src/core/logger.ts
Errors:     use NexarError from src/core/errors.ts
```

---

## Running Tests

```bash
npm run test          # unit tests
npm run test:e2e      # end-to-end (requires .env)
```

---

## Reporting Bugs

Open a GitHub issue with:

- What you expected to happen
- What actually happened
- Steps to reproduce
- Logs if available (remove any private keys or tokens)

---

## Security Issues

**Do not open a public issue for security vulnerabilities.**

If you find something that could affect live users or the deployed contracts, 
email me directly. I will respond within 48 hours and credit you in the fix.

---

## Recognition

Every contributor gets:
- Name in the commit history permanently
- Credit in the release changelog
- A mention if the contribution is significant

No financial compensation is offered at this stage, but that may change 
as the project grows.

---

## Questions

Open a GitHub Discussion or reach out on X: **@0xZaid10**

Thanks for building with me. In sha Allah this becomes something great.
