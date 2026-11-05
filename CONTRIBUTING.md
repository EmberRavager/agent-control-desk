# Contributing to ACD

ACD is a personal open-source project for routing work to local agents and following their sessions. Contributions that make the existing workflow easier to use and verify are welcome.

## Run locally

Use Node.js 22.13.0 or later. Node.js 24 is used for desktop release builds.

```sh
npm ci
npm test
npm run build
npm run desktop
```

Install and configure the execution agent in its own application before connecting it to ACD. The supervisor model is configured separately in ACD.

## Keep a change focused

Describe the problem, the expected behavior, and how to reproduce it. Reuse the existing contracts, adapters, Store, and Task lifecycle. For bug fixes, include a regression test that reproduces the failure. For wording and other low-impact changes, a build or a rendered check is usually sufficient.

Run the affected tests and `npm run build` before opening a pull request. Explain any verification that could not be completed. New adapters need their own execution, result, failure, cancellation, resume, and permission evidence.

## Test without personal data

Normal tests use temporary profiles, fake model responses, and fake execution agents. They do not require API keys or a WeChat login. Real-model evaluations and native-account checks are separate, explicit activities.

For manual tests, select a dedicated data directory using `ACD_DATA_DIR`. All clients participating in that test must use the same directory. Restart the matching background service when changing profiles. A test profile does not migrate itself into the normal profile.

Do not attach personal conversation logs, databases, runtime descriptors, API keys, or WeChat login details to issues. Report version, platform, task status, and redacted reproduction steps instead.

## Supported release scope

Mac Apple Silicon test packages are the current verified build target. Windows and Mac Intel support require native validation before being listed as available downloads. Existing protocol tests do not establish readiness of a real account or a particular model.

See [development](docs/development.md), [routing](docs/routing.md), and [feature status](docs/product-status.md) for the current contracts and verification boundaries.

## License

ACD is distributed under the [MIT License](LICENSE). Contributions are made under the same license.
