# Rec-Swap

**An AI-assisted grocery alternative recommender for a Qatari online grocery experience.**

When a product is unavailable, Rec-Swap ranks in-stock alternatives for the shopper. The project is a working prototype and a proposal for how to evolve a transparent demo ranker into a measurable, production-minded recommendation system.

## What is implemented

- A customer experience for comparing and selecting substitute products.
- A manager view for exploring ranking behavior, policy rules and feedback.
- A Cloudflare Workers AI inference path using multilingual BGE-M3 text embeddings, combined with product attributes and demo shopping history.
- Deterministic candidate filters for the illustrative stock, price, heat and exclusion rules.
- A D1 feedback path for shared demo acceptance-by-position metrics.
- A local browser-side simulator for inspecting ranking behavior when the Cloudflare APIs are not available.

The catalogue, stock, shoppers and behavior are synthetic. The current server ranker is **not trained on Rec-Swap data**, the local simulator is not the deployed AI scorer, and image similarity is not yet part of the server ranking path.

## Cloudflare app

**Live app:** [Rec-Swap on Cloudflare Pages](https://rec-swap-34b.pages.dev/)

The repository is configured for Cloudflare Pages with Pages Functions, Workers AI and D1.

## Recommendation approach

The ranking is intentionally hybrid:

1. **Eligibility first:** remove unavailable or ineligible products using deterministic constraints.
2. **Semantic relevance:** compare source and candidate product text embeddings.
3. **Structured fit:** account for category, price, size and product tags.
4. **Personalization:** use shopper history to represent brand, tag, price and repeat-purchase preferences.
5. **Evaluation before learning:** measure the current baseline and validate each new signal before adding complexity.

### Should images be another similarity feature?

**Yes, as a complementary signal to test—not as an automatic source of truth.** Images can help distinguish package type, product form and visually similar variants, especially where text is sparse or inconsistent. They can also mislead: grocery packaging may change, images may be missing or outdated, and visually similar items can differ in ingredients, size, dietary suitability or price. Images must never replace structured attributes or hard safety constraints.

The proposed data path is to discover product image URLs and metadata from a product-data source such as the [Open Food Facts API](https://openfoodfacts.github.io/openfoodfacts-server/api/), using a reliable product identifier such as a barcode where possible. A separate hosted vision-embedding API, using a CLIP/SigLIP-style model, can produce image vectors. [Google SigLIP](https://huggingface.co/google/siglip-base-patch16-224) is one model worth benchmarking; the selected hosted API must return image feature vectors (not just image labels or text descriptions). Those vectors should be generated and refreshed as part of catalogue ingestion, validated and cached—not fetched and embedded on every shopper request. At ranking time, image cosine similarity can be evaluated as an optional score alongside text, attributes and history. The provider and model remain to be selected and benchmarked; the current implementation does not call an image-embedding API.

Open Food Facts data and images have reuse and attribution conditions; its product images are CC BY-SA and its database has ODbL terms. Review the source terms and any share-alike obligations before using or redistributing enriched catalogue data.

The detailed design and proposed next steps are in [`RECOMMENDATION_APPROACH.md`](RECOMMENDATION_APPROACH.md).

## Proposed next steps

1. Replace synthetic products, stock and shopper profiles with a documented, permissioned dataset or a clearly scoped public-data experiment.
2. Build a repeatable catalogue and event pipeline: validate product IDs and units, ingest stock snapshots, normalize text and attributes, track image provenance, and version features and labels.
3. Establish a trusted substitution-feedback label, including downstream cancellations, refunds and complaints; clicks alone are not training truth.
4. Create time-based train/validation/test splits and evaluate a transparent baseline using HR@K, NDCG@K, MRR, constraint violations, coverage and cold-start performance.
5. Run an image-signal ablation (text + attributes + history versus the same ranker plus images), including missing, low-quality and mismatched images and category-level results. Keep image weight at zero unless it improves reliable outcomes.
6. Train a lightweight ranker or tune modality weights only after the dataset and evaluation protocol are credible. Keep safety, inventory and eligibility rules deterministic and outside the learned model.
7. Version the data, feature pipeline and model; compare in shadow mode; then run a controlled experiment with rollback and monitoring for acceptance, refunds, complaints, fairness, latency and cost.

These are planned directions, not claims that the current demo has completed data collection, model training, image inference or a production experiment.

## Current prototype

`/#customer` opens the shopper experience; `/#manager` opens the manager experience. The recommendation design, current limitations, image proposal, evaluation plan and pipeline roadmap are documented in [`RECOMMENDATION_APPROACH.md`](RECOMMENDATION_APPROACH.md).