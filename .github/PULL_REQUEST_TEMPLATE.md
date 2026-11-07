<!--
Start with one paragraph a non-engineer can follow: the problem and what changes for users.
Never include secrets, real keypairs, private RPC URLs or .env contents.
-->

## What changed

-

## How it was tested

<!-- Commands you ran and their results. Name the revision. Say what the evidence does not cover. -->

- [ ] `pnpm -r build && pnpm -r typecheck && pnpm -r test`
- [ ] Rust, if programs changed: `bash scripts/build-programs.sh && bash scripts/test-programs.sh`
- [ ] Circuits, if circuits changed: proving and verifying keys regenerated together on a development branch

## Risks

<!-- Authority, account layout, proof context, persistence or compatibility impact. Write "None known" if so. -->

## Checklist

- [ ] Conventional Commit messages (`feat:`, `fix:`, `docs:`, `test:`, `chore:`)
- [ ] Regression test added for any authorization, funds or persistence change
- [ ] Docs updated where behaviour changed
- [ ] No secrets, keys, private application source or brand assets
