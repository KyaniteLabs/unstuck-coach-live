# Repository Separation

This repository is the dedicated home for the live Unstuck Coach product.

## Product Boundary

- This repo owns the public Unstuck landing page, live chat demo, coach contract,
  and live-demo deployment assets.
- This repo does not own Dev Learning Archaeologist.
- This repo does not own Innerscape.
- This repo does not host or claim the combined Innerscape plus Unstuck product.

## Extraction Source

The initial history was extracted from the `EF-COACH/` subtree of the old
Skool competition workspace repository at `origin/main`.

The optional local Innerscape bridge branch was intentionally not included in
this live-product extraction.

## Release Boundary

Live Unstuck can remain deployed at `https://unstuck.kyanitelabs.tech/`.

Innerscape remains a separate local/open-source product with Unstuck built in.
Do not deploy the combined Innerscape plus Unstuck app from this repository.
