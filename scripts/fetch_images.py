"""Download matched product photos from Open Food Facts (CC BY-SA) to images/products/."""
import json
import re
import time
import urllib.parse
import urllib.request
from urllib.error import HTTPError
from pathlib import Path
from urllib.parse import urlparse


ROOT = Path(__file__).resolve().parent.parent
CATALOGUE = ROOT / "catalog.json"
OUTPUT = ROOT / "images.json"
IMAGE_DIR = ROOT / "images" / "products"
USER_AGENT = "Rec-Swap-demo/1.0 (product image downloader)"
ALLOWED_IMAGE_HOSTS = {"images.openfoodfacts.org", "static.openfoodfacts.org"}
IMAGE_TYPES = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}
RETRYABLE_STATUS = {429, 500, 502, 503, 504}
PRODUCT_TYPES = (
    "yogurt", "yoghurt", "milk", "laban", "rice", "dates", "tea", "coffee",
    "water", "juice", "oat drink", "karak", "chai",
)
FLAVORS = {"apple", "orange", "mango", "blueberry", "strawberry", "vanilla"}
QUALIFIERS = {"full", "low", "lactose", "free"}
QUERY_NOISE = {
    "fresh", "natural", "yellow", "label", "instant", "arabic", "style", "sachets",
}
NEGATIONS = {"no", "without", "sans"}


def tokens(value):
    normalized = value.casefold().replace("lowfat", "low fat").replace(
        "lactosefree", "lactose free"
    ).replace("lacto", "lactose").replace("yoghurt", "yogurt").replace(
        "madjool", "medjool"
    )
    return re.findall(r"[a-z0-9]+", normalized)


def words(value):
    return set(tokens(value))


def search_results(terms):
    query = urllib.parse.urlencode({
        "search_terms": terms,
        "search_simple": 1,
        "action": "process",
        "json": 1,
        "page_size": 20,
        "fields": "product_name,brands,image_front_url",
    })
    request = urllib.request.Request(
        "https://world.openfoodfacts.org/cgi/search.pl?" + query,
        headers={"User-Agent": USER_AGENT},
    )
    with open_url(request) as response:
        return json.load(response).get("products", [])


def open_url(request):
    for attempt in range(3):
        try:
            return urllib.request.urlopen(request, timeout=20)
        except HTTPError as error:
            if error.code not in RETRYABLE_STATUS or attempt == 2:
                raise
            error.close()
            time.sleep(2 ** attempt)


def search_product(product):
    name_words = words(product["n"])
    brand_words = words(product["b"])
    product_types = [kind for kind in PRODUCT_TYPES if words(kind) <= name_words]
    meaningful_words = {
        word for word in name_words - brand_words - QUERY_NOISE
        if len(word) > 2 and not re.fullmatch(r"\d+(?:kg|g|ml|l|x\d+)?", word)
    }
    fallback_terms = " ".join([product["b"], *product_types])
    descriptive_terms = " ".join(sorted(meaningful_words | set(product_types)))
    queries = list(dict.fromkeys((product["n"], fallback_terms, descriptive_terms)))
    queries = [query for query in queries if query]
    last_error = None

    for query_index, terms in enumerate(queries):
        if query_index:
            time.sleep(1)
        try:
            results = search_results(terms)
        except HTTPError as error:
            if error.code not in RETRYABLE_STATUS:
                raise
            last_error = error
            continue
        candidates = []
        for match in results:
            match_brands = words(match.get("brands") or "")
            if not match.get("image_front_url"):
                continue

            match_words = words(match.get("product_name") or "")
            match_tokens = tokens(match.get("product_name") or "")
            if any(
                negation in match_tokens and token in match_tokens
                and match_tokens.index(negation) < match_tokens.index(token)
                for negation in NEGATIONS for token in meaningful_words
            ):
                continue
            if product_types and not any(words(kind) <= match_words for kind in product_types):
                continue
            if not (meaningful_words & QUALIFIERS) <= match_words:
                continue
            expected_flavors = meaningful_words & FLAVORS
            match_flavors = match_words & FLAVORS
            if match_flavors and not match_flavors <= expected_flavors:
                continue
            overlap = len(meaningful_words & match_words)
            score = overlap / max(1, len(meaningful_words))
            brand_matches = bool(brand_words and brand_words <= match_brands)
            if not brand_matches and score < 0.7:
                continue
            if score < 0.5:
                continue
            candidates.append((score + (0.25 if brand_matches else 0), match))

        if candidates:
            return max(candidates, key=lambda candidate: candidate[0])[1]
    if last_error:
        raise last_error
    return None


def download_image(url, product_id):
    parsed = urlparse(url)
    if parsed.scheme != "https" or parsed.hostname not in ALLOWED_IMAGE_HOSTS:
        raise ValueError(f"untrusted image URL: {url}")

    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with open_url(request) as response:
        content_type = response.headers.get_content_type().lower()
        extension = IMAGE_TYPES.get(content_type)
        if not extension:
            raise ValueError(f"unsupported image type {content_type!r}")
        image_data = response.read()

    if not image_data:
        raise ValueError("downloaded image is empty")

    filename = f"{product_id}{extension}"
    IMAGE_DIR.mkdir(parents=True, exist_ok=True)
    (IMAGE_DIR / filename).write_bytes(image_data)
    return f"images/products/{filename}"


def main():
    catalogue = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    images = {}
    if OUTPUT.exists():
        images.update(json.loads(OUTPUT.read_text(encoding="utf-8")))
    failures = 0
    downloaded = 0

    for index, product in enumerate(catalogue["products"]):
        image_path = ROOT / images.get(str(product["id"]), "")
        if (
            str(product["id"]) in images
            and image_path.is_file()
            and image_path.suffix.lower() in IMAGE_TYPES.values()
        ):
            continue
        if index:
            time.sleep(1)
        try:
            match = search_product(product)
            if not match:
                print("none", product["n"], "(no matching brand and photo in Open Food Facts)")
                continue
            images[str(product["id"])] = download_image(
                match["image_front_url"], product["id"]
            )
            downloaded += 1
            print("saved", product["n"], "->", match.get("product_name"))
        except Exception as error:
            failures += 1
            print("skip", product["n"], error)

    if not downloaded:
        raise RuntimeError(
            "No new product images were downloaded. Existing images.json was left unchanged; "
            "check the Open Food Facts service and try again."
        )

    OUTPUT.write_text(json.dumps(images, indent=1) + "\n", encoding="utf-8")
    print(f"Downloaded {downloaded} new image(s); {len(images)} image mapping(s) in {OUTPUT}.")
    if failures:
        print(f"{failures} product lookup(s) or download(s) failed.")


if __name__ == "__main__":
    main()
