# Rec-Swap Recommendation Approach

## 1. Purpose and scope

Rec-Swap recommends replacements when a grocery item is unavailable. Given an unavailable source product, a shopper profile and the current catalogue, it ranks suitable in-stock alternatives and returns up to three suggestions.

The deployed recommendation path is **inference-based**, not a trained Rec-Swap model. Cloudflare Workers AI runs the multilingual `@cf/baai/bge-m3` text-embedding model. Rec-Swap compares product embeddings and combines that semantic signal with product attributes and the shopper's demo purchase history. The weights are configuration, not learned model parameters.

The app also has a browser-side ranker for the manager's scenario inspector and for local development without Cloudflare Pages Functions. That simulator uses TF-IDF-style text similarity and a color/packaging proxy as a toy visual feature. It is not an image model, does not call an image API and is separate from the deployed AI inference path.

The intended product direction is a **hybrid recommender**: deterministic eligibility and safety rules first, followed by a ranker that combines semantic text, product attributes, behavioral personalization and—if evaluation supports it—visual similarity. This is a proposed evolution, not a description of features already deployed.

## 2. Recommendation request and response

The customer app sends a same-origin request to `POST /api/recommendations` with:

```json
{
  "itemId": 1,
  "userIndex": 0,
  "weights": { "t": 0.55, "a": 0.25, "h": 0.2 },
  "context": {
    "temp": 34,
    "hour": 14,
    "rules": { "heat": true, "price": true, "stock": true }
  }
}
```

`itemId` identifies the unavailable product, and `userIndex` selects one of the sample shoppers. The context and shopper profiles in this repository are demo data. A successful response contains up to three product IDs, scores, short reasons and the model identifier:

```json
{
  "items": [
    { "id": 3, "score": 0.82, "reason": "AI-matched product description" }
  ],
  "model": "@cf/baai/bge-m3"
}
```

The client maps returned IDs to its catalogue entries for display. If the Pages Function route is absent (as with a plain static local server), the UI shows the local demo recommendations instead. If inference fails in a deployed environment, it reports that it is showing the local fallback rather than describing the fallback as AI.

## 3. End-to-end ranking flow

### Step 1: Validate the request

The Pages Function checks the request origin, JSON content type, payload size, integer product ID and valid demo user index. It returns a clear error for malformed requests, unknown products, missing configuration or unavailable inference.

### Step 2: Build the eligible candidate set

Before ranking, the function removes:

- The unavailable source product itself.
- Products outside the source product's aisle.
- Out-of-stock items.
- Items below the minimum stock threshold when the low-stock rule is enabled.
- Items over the configured price-shock threshold when that rule is enabled.
- Chilled dairy alternatives in the configured high-temperature delivery window when the heat guard is enabled.
- Products carrying an exclusion tag in the selected demo shopper profile.

This is deterministic filtering. The embedding model does not decide whether a product is safe or eligible. The remaining filters and the illustrative exclusions must not be treated as production dietary or allergy safeguards: real deployment needs authoritative catalogue, ingredient/allergen, inventory and shopper-preference data, with constraints enforced by trusted server-side services.

### Step 3: Create text representations and embed

Each eligible product and the source product are represented by a short string combining its name, description and tags:

```text
Product name. Product description. tag1, tag2, tag3
```

The function sends the source and candidates in one batch to Workers AI using `@cf/baai/bge-m3`, a multilingual text-embedding model. It checks that the response contains a finite, consistent-length vector for every input. A model error or malformed result is returned as an inference error; it is not silently reclassified as a successful AI result.

Embeddings are computed on the recommendation request in this demo. For a larger catalogue, the next design step is to precompute and version catalogue embeddings, then refresh them when product text changes. Shopper-specific product history should not be embedded into catalogue vectors.

### Proposed image signal: add only after an ablation

Images are a reasonable additional modality to investigate. They can contribute visual evidence about package type, product form or near-duplicate variants when descriptions are incomplete. They can also encode irrelevant visual cues (brand artwork, background, image style), be stale after a package redesign, or be absent entirely. A photo cannot reliably establish ingredients, allergens, product size or availability. Therefore:

- Treat image similarity as a **soft relevance feature**, never as an eligibility or safety rule.
- Keep text and structured attributes as the reliable fallback when an image is missing, low quality or mismatched.
- Do not launch with a fixed assumption that image similarity improves recommendations; run an offline ablation and inspect the impact by category and image-quality cohort.
- Give the image signal a zero weight if it does not improve ranking quality without worsening constraint violations, coverage or subgroup outcomes.

#### Proposed online image-data and embedding path

The proposed image path uses an online product-data API and a separate hosted vision-embedding API; neither is currently integrated into the recommendation endpoint.

1. **Resolve the product.** During catalogue ingestion, look up image metadata by a stable identifier (preferably GTIN/barcode) using a product-data source such as [Open Food Facts](https://openfoodfacts.github.io/openfoodfacts-server/api/). Keep the source product ID, image URL, retrieval time, license/attribution metadata and a confidence or match status. Do not fuzzy-match an image to a product without review.
2. **Review rights and data quality.** Validate that the image is the correct product and useful pack shot; detect missing, tiny, duplicate or obviously mismatched images. Open Food Facts publishes database and image reuse conditions: its images are under CC BY-SA, while database terms include ODbL/DbCL conditions. Review the current terms, attribution and share-alike obligations before reuse or redistribution.
3. **Create vectors offline or at ingestion.** Send reviewed images to a separately selected hosted image-embedding API based on a model such as CLIP or SigLIP. [Google SigLIP](https://huggingface.co/google/siglip-base-patch16-224) is one candidate to benchmark, not a decided production model. Confirm the chosen hosted API actually exposes image feature vectors; a classification endpoint that returns labels or image-text scores alone is not interchangeable with an image-embedding endpoint. Store the model/version, vector, image source and checksum alongside product metadata. Cache the result and regenerate it only when the image or model version changes. Avoid calling the product-image lookup API and vision model serially on every customer request; that path would add latency, cost, rate-limit exposure and availability dependencies.
4. **Score image relevance.** For source product \(q\) and candidate \(c\), define \(f_i(q,c)\) as cosine similarity between their normalized image embeddings. Normalize/calibrate it against the other signals on held-out data; raw cosine values from different encoders are not automatically comparable with text or attribute scores.
5. **Fuse conditionally.** Add the image score only when both products have valid vectors, and renormalize the remaining modality weights when one is absent:

\[
s(q,c,u)=
\frac{w_t f_t+w_i f_i+w_a f_a+w_h f_h}
     {w_t+w_i+w_a+w_h}
\]

Here \(w_i\) is a candidate weight to tune and validate, not a preselected production setting. If either image is missing or invalid, omit \(w_i f_i\) and renormalize over the available signals. Keep image coverage visible in monitoring so missingness is not hidden.

6. **Test incremental value.** Compare text + attributes + history with the same system plus image similarity, using the same time-based data split and candidate eligibility rules. Report overall and category-level HR@K/NDCG@K/MRR, image coverage, latency/cost, constraint violations and relevant subgroup results. Inspect false matches caused by packaging, visually similar but semantically different products, different pack sizes and stale product shots.

The implementation could use any hosted image-embedding provider that supports the selected model and an operationally acceptable API contract. Provider selection should consider image size limits, batch support, latency, data retention, regional processing, cost, model versioning and licensing. Do not imply that BGE-M3 is an image encoder: in the current path it embeds text only.

### Step 4: Calculate recommendation signals

For each eligible candidate \(c\), relative to source product \(q\) and demo shopper \(u\), the server computes:

- **Text relevance \(f_t\):** cosine similarity between the source and candidate BGE-M3 embeddings, clamped at zero.
- **Attribute relevance \(f_a\):** a weighted combination of same category, price similarity, size similarity and tag overlap.
- **History relevance \(f_h\):** a weighted combination of brand affinity, overlap with tags in the shopper's history, price fit against same-aisle purchases and whether the candidate itself appeared in history.

The current attribute score is:

\[
f_a(q,c) = 0.40\,I(\mathrm{category}_q=\mathrm{category}_c)
           + 0.30\,\mathrm{priceFit}(q,c)
           + 0.20\,\mathrm{sizeFit}(q,c)
           + 0.10\,\mathrm{tagOverlap}(q,c)
\]

Price and size fit use a normalized absolute difference:

\[
\mathrm{fit}(x,y)=\max\left(0,1-\frac{|x-y|}{\max(x,y)}\right)
\]

The current history score uses the following demo weighting:

\[
f_h(c,u)=0.30\,\mathrm{brandAffinity}
         +0.30\,\mathrm{tagAffinity}
         +0.20\,\mathrm{priceFit}
         +0.20\,\mathrm{repurchase}
\]

The weighted signals are normalized by the sum of weights:

\[
s(q,c,u)=\frac{w_t f_t+w_a f_a+w_h f_h}{w_t+w_a+w_h}
\]

The default production-path weights sent by the customer view are \(w_t=0.55\), \(w_a=0.25\), and \(w_h=0.20\). The server accepts only finite weights between zero and one and otherwise uses those defaults. If all accepted weights are zero, the score is zero for all candidates and the deterministic tie order is used.

### Step 5: Rank and explain

Candidates are sorted by descending combined score. The function returns the top three and attaches a short reason based on the strongest weighted signal: AI-matched description, similar product details, or match to shopping history. These are concise signal labels, not a natural-language model-generated explanation.

The client re-applies its local deterministic policy rules to the returned candidates before rendering them. This is an additional guard for the demo UI; production safety and eligibility decisions must be implemented and tested in authoritative server-side logic rather than relying on the browser.

## 4. Current system boundaries

| Capability | Current demo behavior | Production requirement |
|---|---|---|
| Text understanding | BGE-M3 text embeddings from Workers AI | Monitor model/version changes; test Arabic and English product text on representative data |
| Product attributes | Hand-weighted category, price, size and tags | Validate catalogue schemas, units, currencies and feature freshness |
| Personalization | Four synthetic shopper profiles and item histories | Authenticated identity, consent, privacy controls and real behavioral features |
| Availability | Static stock values in `catalog.json` | Authoritative, zone-aware, real-time inventory |
| Dietary constraints | Demo exclusion tags | Verified ingredient/allergen data and hard server-side constraints |
| Training | No Rec-Swap training | Train only after collecting suitable, consented labels and defining offline evaluation |
| Manager analytics | Local simulator plus shared D1 position counts | Authenticated manager access, retention controls and monitored analytics pipeline |
| Images | Optional product photos; local color/pack proxy in simulator | Product-data API lookup plus a separately selected hosted vision-embedding API, offline vector cache, rights review and ablation evaluation |

The current recommendations are a technical demonstration, not evidence that the system improves customer outcomes. Synthetic shopper profiles and item attributes can make the example easy to explore but cannot establish real-world relevance, safety or business value. Image data and an image inference API are a proposed next experiment, not current app functionality.

## 5. Feedback and evaluation

The customer UI records whether a shopper selected or skipped a recommendation and its displayed position. In the Cloudflare deployment, `POST /api/feedback` writes the demo user index, source product ID, candidate product ID, outcome and position to D1. `GET /api/feedback` aggregates acceptance by position for the manager view. The local browser log remains separate.

These click events are **not model training**. They are a starting point for measurement. Before using them as labels, define how to handle position bias, repeated views, cancelled orders, later refunds, complaints, delayed outcomes and the distinction between a view and a deliberate choice. Minimize retained personal data and set access and retention controls.

Evaluation should proceed in stages:

1. **Offline ranking:** use representative, consented substitution outcomes; split by time to avoid leakage; report HR@K, NDCG@K and MRR.
2. **Constraint checks:** measure violations separately and require zero violations for hard constraints in the evaluated test set.
3. **Robustness:** test cold-start shoppers, sparse histories, missing product text, unusual pack sizes, multilingual text and inventory changes.
4. **Shadow mode:** compute suggestions without showing them and compare to the current process.
5. **Controlled rollout:** use a limited experiment and monitor acceptance, order fill, refunds, complaints, latency, cost and subgroup outcomes.

The small synthetic catalogue is not sufficient for meaningful offline or online performance claims.

## 6. Data and training pipeline roadmap

Training a Rec-Swap model is downstream of building a trustworthy pipeline. The pipeline should make each recommendation traceable to the catalogue snapshot, inventory state, feature/model versions and the eventual shopper outcome. A proposed sequence is:

1. **Catalogue ingestion:** ingest product identifiers, names, multilingual descriptions, units, price, category, dietary/ingredient metadata and stock from approved sources. Validate schemas, normalize units and currency, track provenance and reject invalid records rather than silently substituting defaults.
2. **Image enrichment (optional, evaluated):** use a product-data API such as Open Food Facts to resolve images by stable product identifiers. Preserve attribution/license metadata, validate matches and quality, then call a versioned hosted CLIP/SigLIP-style image-embedding API in batch. Cache vectors and checksums in a catalogue feature store; avoid live third-party image and embedding calls in the customer ranking request.
3. **Event collection:** capture the source item, eligible candidates shown, position, model and feature versions, inventory snapshot, acceptance/skip and later outcomes. Minimize personal identifiers; establish consent, access, retention and deletion rules. The present D1 event is a demo signal and not a complete training record.
4. **Dataset generation:** join recommendation impressions to order outcomes and label accepted substitutions carefully. Separate positive, explicit negative and ambiguous/no-response events; account for position bias, repeated impressions, cancellation, refunds and complaints.
5. **Reproducible features and splits:** materialize versioned text/image embeddings and structured/history features. Use time-based train/validation/test splits, document leakage controls, and evaluate cold-start shoppers/products.
6. **Offline training and evaluation:** compare a transparent baseline with a learned pairwise/listwise ranker or learned signal weights. Run image-modality ablation, calibrate/normalize signals, report ranking, coverage, robustness, subgroup and zero-hard-constraint-violation metrics.
7. **Model release:** version the dataset, feature definitions, encoder/ranker versions, training code and evaluation report. Keep the deterministic eligibility layer separate from ranking and maintain rollback to the known baseline.
8. **Operational validation:** run in shadow mode, compare outcomes, then use a controlled rollout. Monitor data freshness, image coverage, model drift, latency, inference cost, feedback quality, acceptance, refunds, complaints and constraints.

Training is intentionally out of scope for the current implementation. A future trained ranker should not treat all clicks as positive labels:

The first learned component could be modest: tune weights or train a small pairwise/listwise ranker over text relevance, optional image similarity, attributes, price change and shopper-history features. Do not fine-tune a large multimodal model before a baseline, labels and evaluation demonstrate that the complexity is justified. Keep allergens, dietary constraints and stock eligibility outside the learned scoring function.

The BGE-M3 embedding model is supplied by Cloudflare; this project does not fine-tune or train it.

## 7. Current runtime components

- **Static customer and manager application:** presents recommendations and the local simulator.
- **Pages Functions:** handle the server-side recommendation and feedback API routes.
- **Workers AI binding (`AI`):** runs BGE-M3 inference in `functions/api/recommendations.js`.
- **D1 binding (`DB`):** stores demo feedback using `migrations/0001_feedback.sql`.
- **Catalogue (`catalog.json`):** supplies sample products and synthetic user profiles. Replace it with a trusted catalogue service before production.

## 8. What this prototype demonstrates and what remains

The work so far demonstrates a problem formulation, a functioning end-to-end demo, a hybrid inference design, deterministic candidate filters, feedback capture and an explicit distinction between current behavior and future work. It is not presented as a trained recommender or a production-validated product.

The most valuable next contribution is to turn the prototype into a reproducible experiment:

- Build a permissioned data and feature pipeline.
- Define trustworthy outcome labels.
- Establish baselines and offline metrics.
- Test the incremental value of image embeddings.
- Train a small ranking model only when the evidence supports it.
- Validate it in shadow mode before any controlled release.

See `README.md` for the concise project summary and proposed work.
