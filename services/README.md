# Off-chain services

GhostLink's reference services connect clients to the Solana programs. They carry availability, privacy, transaction-construction and operational responsibilities. On-chain checks do not make a service trustworthy in every respect, and reconstructing chain events does not reconstruct every off-chain request, notification acknowledgment or spending reservation.

## Status

These services implement the V2 authorization / PocketV3 protocol, with durable state, recovery and hosted-service controls. They are tested on disposable local validators. Each takes its deployment from the manifest named by `GHOSTLINK_DEPLOYMENT` ([deployments](../docs/DEPLOYMENTS.md)). Without one, the state initializers, the Actions service and every fee-paying path refuse the public devnet and mainnet genesis hashes; with one, they accept only that manifest's cluster and genesis, and never the built-in program IDs on a public cluster. They are not a drop-in upgrade for the preserved V1 devnet deployment described in the [devnet notes](../docs/DEVNET.md). Nothing here is approved for real funds.

| Service | Responsibility | Boundary to understand |
| --- | --- | --- |
| [Indexer](indexer/) | Rebuild trees and serve witness data/activity | Clients must verify roots against trusted chain state. Requests can reveal metadata; archival completeness is a separate requirement. |
| [Relayer](relayer/) | Submit supported operations and pay fees | Durable request identity, fee/rent accounting, authorization and uncertain outcomes matter. It must not receive the owner's identity secret. |
| [Solver](solver/) | Construct and submit supported atomic fills | Validate session authority, route instructions, fees and actual outcomes. A new route is not automatically safe or compatible. |
| [Actions](actions/) | Construct funding transactions | The funding wallet/client must independently validate destination, amount, instructions and total debit before signing. |
| [Watcher](watcher/) | Observe events, deliver alerts and optionally fund cranks | Delivery can be repeated; receivers need deduplication. Observation and fee history must survive restart. |
| [Shared](shared/) | Encodings, event decoding and transport helpers | Clients, programs and deployed account formats must agree. |
| [E2E](e2e/) | Disposable local-validator integration flow | Test fixtures do not certify production providers or real devices. |

## Development and operations

Start with the [setup guide](../docs/SETUP.md). Read each service's operations guide before configuring a hosted process:

- [Indexer](../docs/INDEXER-OPERATIONS.md)
- [Relayer](../docs/RELAYER-OPERATIONS.md)
- [Solver](../docs/SOLVER-OPERATIONS.md)
- [Watcher](../docs/WATCHER-OPERATIONS.md)
- [Actions](../docs/ACTIONS-OPERATIONS.md)
- [RPC](../docs/RPC-OPERATIONS.md) and [backup/restore](../docs/BACKUP-RESTORE.md)

Hosted entry points open only explicitly initialized, pinned existing state; JSON and in-memory state paths remain for local development and fixtures, not as a production recovery strategy. Do not delete or replace production state to bypass a startup error. Keep credentials, keys, databases, WAL files and backups outside source control, and independently reconcile uncertain history before resuming work. Each service has its own existing-state/identity requirements, restore restrictions, readiness and shutdown behavior; read each guide rather than applying one generic environment configuration.

See the [project status](../README.md#project-status) and the [mainnet readiness plan](../docs/MAINNET-READINESS.md) for outstanding release gates.
