# Contributing to OA Driverless Vision

Thanks for your interest in contributing! We welcome bug reports, documentation improvements, feature ideas, and pull requests.

This repository is a polyglot monorepo. Read the [repository map in the README](README.md#repository-map) first — where your change goes determines how you build and test it:

| Directory | Stack | Who owns it |
|---|---|---|
| [`dashboard/`](dashboard) | TypeScript, Cloudflare Workers, D1, R2 | This project |
| [`toolkit/`](toolkit) | Python (`bhutan_sim`), standard library only | This project |
| [`docs/`](docs) | Markdown | This project |
| [`carla/`](carla) | C++/Python, Unreal Engine 5.5 | **Vendored [CARLA](http://carla.org) upstream** |

> **Changes under `carla/` are special.** That directory is the upstream CARLA simulator vendored into this repo. Build and use it exactly as upstream documents in [`carla/README.md`](carla/README.md), and prefer sending general simulator fixes to [carla-simulator/carla](https://github.com/carla-simulator/carla) so everyone benefits. Open an issue here first if you think a change genuinely belongs in this fork.

> **This is not a public-road autonomous-driving service.** It is a validation, evaluation and safety-evidence platform. Contributions that touch safety rules, scoring, or evidence export should be conservative, well-tested, and documented.

## Before You Start

- Read the [README](README.md) and the platform docs: [pilot overview](docs/bhutan_pilot.md), [dashboard guide](docs/bhutan_dashboard.md), [fleet tooling survey](docs/bhutan_fleet_tools.md), [roadmap](docs/bhutan_roadmap.md).
- Search [existing issues](https://github.com/vtempest/driverless-ambitions/issues) and [pull requests](https://github.com/vtempest/driverless-ambitions/pulls) to avoid duplicating work.
- For substantial changes — new scenario templates, changes to the telemetry schema, safety rules, driving score, or the evidence-export format — open an issue first to discuss the problem, proposed approach, and scope.
- Be respectful and constructive in issues, reviews, and discussions.

## Reporting Bugs

Please open an issue using the [bug report template](.github/ISSUE_TEMPLATE/bug_report.md) and include:

- A clear, descriptive title
- What you expected to happen
- What actually happened
- Steps to reproduce the problem
- Minimal reproducible code or data, when possible — for a scenario or evaluation bug, the scenario ID (e.g. `bt-landslide-debris-01`) and the parameters used
- Relevant logs, error messages, screenshots, and environment details

Environment details should include the commit, operating system, and — depending on the component — `python --version`, `node --version`, `wrangler --version`, GPU and driver version, and the Unreal Engine / CARLA build you used.

**Never attach raw road footage, GNSS traces, or fleet logs containing faces, license plates, or identifiable locations to a public issue.** Reduce the reproduction to synthetic or already-anonymized data, or ask a maintainer for a private channel.

## Suggesting Features

Feature requests are welcome — use the [feature request template](.github/ISSUE_TEMPLATE/feature_request.md) and explain:

- The problem or use case
- Your proposed solution
- Alternatives you considered
- Any compatibility, performance, security, privacy, or maintenance tradeoffs

The platform is designed to be portable beyond Bhutan — to Nepal, India, Southeast Asia, Africa and Latin America. Proposals that generalize rather than hard-code a single region are much easier to accept.

Avoid starting a large implementation before maintainers have had a chance to comment on the proposal.

## Development Setup

The fastest way to get the project running is [`git0`](https://www.npmjs.com/package/git0) — it downloads the repo, detects the project type, installs dependencies, and opens your editor in one step:

```bash
npx git0 vtempest/driverless-ambitions
```

`git0` downloads a source snapshot without `.git` history, which makes it much faster than `git clone` on a repo this size and is ideal for trying the project out. Note that the vendored CARLA build in `carla/` expects a full checkout, so use a real clone if you're working there. To submit a pull request you also need a real git clone of your own fork:

1. Fork the repository and clone your fork.
2. Create a branch from `ue5-dev`.
3. Set up only the component you're changing — you do **not** need to build CARLA to work on the dashboard or the toolkit.
4. Run the tests for that component and confirm they pass.

```bash
git clone https://github.com/YOUR-USERNAME/driverless-ambitions.git
cd driverless-ambitions
git checkout -b feat/short-description
```

### Dashboard (`dashboard/`)

```bash
cd dashboard
npm ci
npm run dev                  # wrangler dev
npm run check                # typecheck + tests, what you should run before pushing
npm run db:migrate:local     # apply D1 migrations locally
```

### Toolkit (`toolkit/`)

`bhutan_sim` runs on the Python standard library; the requirements file only lists optional extras.

```bash
pip install -r toolkit/requirements.txt
cd toolkit
python -m unittest discover -s tests -v
```

If you add or change scenario templates, regenerate the library and export check the way CI does:

```bash
python scripts/generate_library.py --out /tmp/library.json
python scripts/export_scenario.py --scenario bt-landslide-debris-01 --out-dir /tmp/xosc
```

### CARLA (`carla/`)

Follow [`carla/README.md`](carla/README.md) exactly — it needs Unreal Engine 5.5 (`ue5-dev`), a CUDA-capable GPU, and the separately cloned `carla-content` repository.

## Making Changes

- Keep changes focused; avoid unrelated refactors in the same pull request.
- Do not mix a `carla/` change with a `dashboard/` or `toolkit/` change in one pull request — CI scopes those pipelines separately.
- Match the existing code style, naming conventions, and project architecture.
- Keep the toolkit dependency-free where possible: `bhutan_sim` deliberately runs on the standard library, with heavier integrations isolated in `adapters/`.
- Add or update tests for behavior changes and bug fixes. Safety rules, quality gates, and driving-score logic need deterministic tests with fixed inputs.
- Update documentation under `docs/` when behavior or configuration changes.
- Never commit secrets, credentials, Cloudflare API tokens, private keys, generated build output, `.wrangler/` state, large binary assets, road footage, or unanonymized telemetry.
- Write clear commit messages that describe the change.

## Testing

Before opening a pull request, run the checks for the component you touched — these mirror CI:

```bash
# Dashboard
cd dashboard && npm run typecheck && npm test

# Toolkit
cd toolkit && python -m unittest discover -s tests -v
```

If you cannot run a check — a CARLA build, for instance, needs specific hardware — state that clearly in the pull request and explain why.

## Pull Requests

When opening a pull request:

- Target the `ue5-dev` branch.
- Use a concise title that describes the user-visible change.
- Say which component you changed: `dashboard`, `toolkit`, `docs`, or `carla`.
- Explain what changed and why.
- Link related issues using `Fixes #123` or `Closes #123` when appropriate.
- Include test results and any manual verification steps.
- Include screenshots or recordings for dashboard changes, and sample output for scenario or evaluation changes.
- Call out any D1 migration, new environment variable, or new Cloudflare binding explicitly.
- Keep the pull request small enough to review effectively.
- Respond to review feedback constructively and update the branch as requested.

### Pull Request Template

```md
## Summary

- What does this change do?

## Component

- [ ] `dashboard/`
- [ ] `toolkit/`
- [ ] `docs/`
- [ ] `carla/` (explain why this belongs in the fork rather than upstream)

## Motivation

- What problem does it solve?

## Testing

- [ ] Tests added or updated
- [ ] `cd dashboard && npm run check` passes
- [ ] `cd toolkit && python -m unittest discover -s tests -v` passes
- [ ] Manual testing completed

## Deploy notes

- [ ] No new environment variables
- [ ] No new Cloudflare bindings
- [ ] No D1 migration

## Screenshots / Notes

- Add screenshots, sample scenario output, migration notes, or rollout considerations if relevant.
```

## Documentation

Documentation changes are valuable contributions. Please keep examples accurate, use clear language, and update the pages under [`docs/`](docs) when behavior or configuration changes.

## License

By contributing, you agree that your contributions will be licensed under the same license as this repository — see [LICENSE](LICENSE). Code under `carla/` remains under its upstream CARLA license.

## Questions

If you are unsure where to start, open a discussion or issue describing what you would like to work on. Maintainers can help identify an appropriate next step.
