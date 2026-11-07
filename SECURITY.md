# Security policy

GhostLink is experimental software for local development and test networks. Its development proving keys come from a single-party setup, the code has not had an independent security audit, and nothing here is approved for real funds. Read the [threat model](docs/THREAT-MODEL.md) for the known limitations before you report.

## Reporting a vulnerability

Report vulnerabilities privately. Never use a public issue, pull request or discussion.

1. Use [private vulnerability reporting](https://github.com/Ghostlink-Labs/ghostlink/security/advisories/new) in this repository's Security tab when it is available.
2. If it is not, open an issue titled **"Private security contact request"** with no details, and a maintainer will arrange a private channel.

Include the affected revision, the component, expected and observed behaviour, and a minimal reproduction on a local validator with disposable keys. Never include live secrets. Do not test against other people's deployments, pockets or funds.

## Scope

- The `main` branch: programs, circuits, SDKs, verifier, reference services and scripts. Report against the latest commit.
- The hosted devnet demonstration at app.ghostlink.software is operated separately and runs an earlier protocol version with test tokens. Report problems with it the same way, and do not disrupt shared infrastructure or other users.

There is no security response SLA and no bug bounty yet.
