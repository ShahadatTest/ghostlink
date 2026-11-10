# What is open source?

GhostLink publishes its reusable technology under [Apache-2.0](LICENSE): protocol source, circuits, SDKs, reference services, tests and technical documentation, except explicitly marked material. The private hosted application and website are not part of that source release.

Apache-2.0 allows people to use, modify, redistribute and commercially build on the licensed code. Redistributors must follow its conditions, including the applicable license, attribution and modification notices. They are not generally required to publish their own modifications. The authoritative terms are in `LICENSE`; see also the [Apache licensing FAQ](https://www.apache.org/foundation/license-faq.html).

## Separate boundaries

| Material | Governing terms |
| --- | --- |
| Public technology and documentation text | Apache-2.0, unless a file states otherwise |
| The four JPEG screenshots in `docs/media/screenshots/` | [Separate image permission](docs/media/screenshots/LICENSE.md) |
| GhostLink name, logo and brand identifiers | [Brand policy](BRAND_POLICY.md) |
| Unpublished app, website and editable brand/design source | Not distributed; no license is granted here |
| Dependencies and third-party material | Their own licenses and notices |

The screenshots are newly published documentation assets. Their separate terms do not remove rights from code already released under Apache-2.0. `LICENSE` remains unchanged. A change to future distribution terms cannot simply revoke the existing Apache grant for copies already received under it.

## Third-party components under other licenses

Some dependencies are not Apache-2.0. The ones that matter most:

| Component | License | Where GhostLink uses it |
| --- | --- | --- |
| [snarkjs](https://github.com/iden3/snarkjs) and its libraries (ffjavascript, wasmcurves, wasmbuilder, r1csfile, fastfile, @iden3/binfileutils) | GPL-3.0 | Runtime dependency of `@ghostlink/verify` and `@ghostlink/prover-wasm`; circuit builds and tests |
| [circomlib](https://github.com/iden3/circomlib) | GPL-3.0 | Poseidon, comparator and bit-decomposition templates included by `circuits/*.circom` |

The licences above are the ones the installed packages declare in their own `package.json` and `COPYING` files (snarkjs 0.7.6, ffjavascript 0.3.1). GhostLink's Apache-2.0 grant covers GhostLink's own code and does not relicense these components. If you distribute a bundle that contains them, or circuit artifacts compiled from circomlib templates, check the GPL-3.0 obligations for your distribution.

### What this means for an app that uses the packages

GPL-3.0's source-sharing conditions are about distributing ("conveying") the code to others. In practice:

- **Checking proofs on your own server** (`@ghostlink/verify` in your backend) runs snarkjs there. It does not hand snarkjs to anyone.
- **Proving in the browser** (`@ghostlink/prover-wasm`) does: a web page's JavaScript is delivered to every visitor, so a site that ships the prover distributes snarkjs, and GPL-3.0's conditions apply to that snarkjs code.
- **Loading the prover as a separate worker file** (`createWorkerProver`) keeps snarkjs out of your page's own bundle, in a file that only the worker loads. That keeps the GPL-3.0 code a separable, identifiable file for which you can offer the corresponding source. It does not by itself settle what GPL-3.0 asks of your product as a whole.

This summary is not legal advice. If it matters for your product, ask a lawyer.

## Can we prohibit copying and still call the code open source?

No. Copying and modification rights are fundamental to the [Open Source Definition](https://opensource.org/osd). A code license that forbids commercial competitors or all copying would be a different, restricted source model.

GhostLink therefore distinguishes open-source technology from its private product and brand. The brand/image policies add no restriction to the Apache-licensed code. They also do not claim ownership of general ideas or prevent independent implementations. Section 6 of [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.html) addresses trademarks separately.
