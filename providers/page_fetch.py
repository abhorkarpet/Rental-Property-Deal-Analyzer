"""Shared listing-page fetching and bot-challenge detection."""

from .base import HEADERS


# Text that only appears on a bot-challenge or error page, never on a listing.
_BLOCK_MARKERS = (
    "captcha",
    "access to this page has been denied",
    "awswafcookie",
    "unusual traffic",
    "are you a human",
    "press & hold",
)


def looks_like_listing_page(html: str | None) -> bool:
    """Is this the real listing page, or a challenge page wearing its status code?

    Redfin now answers automated requests with HTTP 202 and a ~2KB AWS WAF
    challenge that contains none of the usual block words. Checking the status
    code alone accepted that stub as the page, so extraction failed and the
    Playwright fallback — which works — was never reached. Require positive
    evidence of a listing instead of merely the absence of known block text.
    """
    if not html or len(html) < 20000:
        return False
    head = html[:5000].lower()
    if any(marker in head for marker in _BLOCK_MARKERS):
        return False
    # Both sites carry the listing in structured data; without it there is
    # nothing for the extractors to read anyway.
    return "application/ld+json" in html or "__NEXT_DATA__" in html
async def fetch_with_playwright(url: str) -> str:
    """Use a headless browser to fetch the page (bypasses bot detection)."""
    from playwright.async_api import async_playwright

    async with async_playwright() as p:
        browser = await p.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"],
        )
        context = await browser.new_context(
            user_agent=HEADERS["User-Agent"],
            viewport={"width": 1280, "height": 900},
            locale="en-US",
            timezone_id="America/New_York",
        )
        page = await context.new_page()

        # Remove webdriver flag to avoid bot detection
        await page.add_init_script("""
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        """)

        await page.goto(url, wait_until="domcontentloaded", timeout=30000)
        # Wait for JS to populate data (Zillow is heavily JS-rendered)
        await page.wait_for_timeout(3000)

        # Try scrolling to trigger lazy-loaded content
        await page.evaluate("window.scrollBy(0, 300)")
        await page.wait_for_timeout(1000)

        html = await page.content()
        await browser.close()
    return html
