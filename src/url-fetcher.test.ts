import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HttpError,
  SiteBlockedError,
  decodeHtmlEntities,
  extractJsonLd,
  extractMetaContent,
  extractOpenGraphImageUrl,
  makeHtmlFetcher,
} from './url-fetcher.js';
import { extractUrlFromCaption } from './recipe-extractor.js';

test('makeHtmlFetcher returns the direct response when it succeeds', async () => {
  const fetchHtml = makeHtmlFetcher({
    direct: async () => '<html>direct</html>',
    readerProxy: async () => {
      throw new Error('should not be called');
    },
  });
  assert.equal(await fetchHtml('https://example.com/'), '<html>direct</html>');
});

test('makeHtmlFetcher falls back to the reader proxy on a 403', async () => {
  const calls: string[] = [];
  const fetchHtml = makeHtmlFetcher({
    direct: async (url) => {
      calls.push(`direct ${url}`);
      throw new HttpError(403, url);
    },
    readerProxy: async (url) => {
      calls.push(`proxy ${url}`);
      return '<html>proxied</html>';
    },
  });
  assert.equal(await fetchHtml('https://www.thekitchn.com/x'), '<html>proxied</html>');
  assert.deepEqual(calls, ['direct https://www.thekitchn.com/x', 'proxy https://www.thekitchn.com/x']);
});

test('makeHtmlFetcher throws SiteBlockedError naming the host when both tiers fail', async () => {
  const fetchHtml = makeHtmlFetcher({
    direct: async (url) => {
      throw new HttpError(403, url);
    },
    readerProxy: async (url) => {
      throw new HttpError(403, `https://r.jina.ai/${url}`);
    },
  });
  await assert.rejects(fetchHtml('https://jenniabs.com/turkey-brine-recipe/'), (err: unknown) => {
    assert.ok(err instanceof SiteBlockedError);
    assert.equal(err.hostname, 'jenniabs.com');
    assert.equal(err.directStatus, 403);
    assert.match(err.message, /jenniabs\.com blocks automated requests \(HTTP 403 direct; reader proxy: HTTP 403\)/);
    return true;
  });
});

test('makeHtmlFetcher does not use the proxy for non-blocking failures', async () => {
  let proxyCalled = false;
  const fetchHtml = makeHtmlFetcher({
    direct: async (url) => {
      throw new HttpError(404, url);
    },
    readerProxy: async () => {
      proxyCalled = true;
      return '';
    },
  });
  await assert.rejects(fetchHtml('https://example.com/gone'), /HTTP 404/);
  assert.equal(proxyCalled, false);
});

test('decodeHtmlEntities handles named, decimal and hex entities', () => {
  assert.equal(
    decodeHtmlEntities('Mum&#x2019;s &amp; Dad&#39;s &#188; cup &quot;brine&quot; &#x1f525; &unknown;'),
    'Mum’s & Dad\'s ¼ cup "brine" 🔥 &unknown;',
  );
});

test('extractMetaContent handles either attribute order and name= tags', () => {
  const html = `<meta content="second" name="description"><meta property="og:title" content="first" />`;
  assert.equal(extractMetaContent(html, 'og:title'), 'first');
  assert.equal(extractMetaContent(html, 'description'), 'second');
  assert.equal(extractMetaContent(html, 'og:missing'), null);
});

test('extractOpenGraphImageUrl decodes entities in the URL', () => {
  const html = `<meta property="og:image" content="https://img.example/a.jpg?x=1&amp;y=2" />`;
  assert.equal(extractOpenGraphImageUrl(html), 'https://img.example/a.jpg?x=1&y=2');
});

test('extractJsonLd finds a Recipe inside @graph and in array @type', () => {
  const graph = `<script type="application/ld+json">{"@graph":[{"@type":"WebPage"},{"@type":"Recipe","name":"Stuffing"}]}</script>`;
  assert.equal(extractJsonLd(graph)?.name, 'Stuffing');
  const arrayType = `<script type="application/ld+json">{"@type":["Recipe","NewsArticle"],"name":"Carrots"}</script>`;
  assert.equal(extractJsonLd(arrayType)?.name, 'Carrots');
  assert.equal(extractJsonLd('<html></html>'), null);
});

test('extractUrlFromCaption skips social-network links and finds the recipe site', () => {
  assert.equal(
    extractUrlFromCaption('Full recipe: www.howsweeteats.com/2020/11/best-stuffing-recipe/. Follow https://www.instagram.com/me'),
    'https://www.howsweeteats.com/2020/11/best-stuffing-recipe/',
  );
  assert.equal(
    extractUrlFromCaption('Watch on https://www.facebook.com/watch/?v=1 and https://fb.watch/x/ then see https://jenniabs.com/turkey-brine-recipe/'),
    'https://jenniabs.com/turkey-brine-recipe/',
  );
  assert.equal(extractUrlFromCaption('No links here, just https://www.instagram.com/p/abc/'), null);
});
