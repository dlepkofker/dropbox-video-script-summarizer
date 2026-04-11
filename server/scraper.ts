import * as cheerio from 'cheerio';
import {createHash} from 'node:crypto';

const SITEMAP_URL = 'https://loyalpawrenting.pet/sitemap-1.xml';
const USER_AGENT = 'LoyalPawrentingBot/1.0';
const RATE_LIMIT_MS = 500;

// Exclude non-post pages discovered in the sitemap
const EXCLUDED_URLS = new Set([
    'https://loyalpawrenting.pet/',
    'https://loyalpawrenting.pet/blogs/',
    'https://loyalpawrenting.pet/about/',
]);

// Blog posts live at https://loyalpawrenting.pet/[slug]/ (NOT under /blogs/[slug]/)
// Verified against live sitemap-1.xml on 2026-04-11
const POST_URL_PATTERN = /^https:\/\/loyalpawrenting\.pet\/[^/]+\/$/;

async function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export function hashContent(body: string): string {
    return createHash('sha256').update(body, 'utf8').digest('hex');
}

export async function crawlBlogUrls(): Promise<string[]> {
    const res = await fetch(SITEMAP_URL, {
        headers: {'User-Agent': USER_AGENT},
    });
    if (!res.ok) throw new Error(`Sitemap fetch failed: ${res.status} ${res.statusText}`);
    const xml = await res.text();

    // Extract <loc> elements from WordPress sitemap XML
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
    const postUrls = urls.filter((url) => POST_URL_PATTERN.test(url) && !EXCLUDED_URLS.has(url));

    console.log(`[crawl] Found ${postUrls.length} post URLs`);
    return postUrls;
}

export async function scrapePost(url: string): Promise<{title: string; body: string; urlHash: string}> {
    await delay(RATE_LIMIT_MS);

    const res = await fetch(url, {headers: {'User-Agent': USER_AGENT}});
    if (!res.ok) throw new Error(`Fetch failed for ${url}: ${res.status} ${res.statusText}`);
    const html = await res.text();

    const $ = cheerio.load(html);

    const title = $('.entry-title').first().text().trim();

    // Remove noise elements before extracting body text
    // Verified: Astra theme structure — loyalpawrenting.pet uses standard Astra class names
    $('.entry-content .ast-single-related-posts-container').remove();
    $('.entry-content .comments-area').remove();

    // Normalize whitespace consistently so hash is stable across runs (Pitfall 6)
    const body = $('.entry-content').text().replace(/\s+/g, ' ').trim();

    if (!title) throw new Error(`No title found at ${url} — check .entry-title selector`);
    if (!body) throw new Error(`No body found at ${url} — check .entry-content selector`);

    const urlHash = hashContent(body);
    return {title, body, urlHash};
}
