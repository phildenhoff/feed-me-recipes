import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractFacebookPost, isFacebookUrl } from './facebook.js';

const REEL_HTML = `<!DOCTYPE html><html><head>
<meta property="og:type" content="video.other" />
<meta property="og:title" content="88K views &#xb7; 1.2K reactions | THAI BBQ CHICKEN &amp; COCONUT LIME RICE &#x1f525; Mum&#x2019;s recipe.  Ingredients &#x2022; 1 tbsp fish sauce &#x2022; &#xbc; cup water   Method 1. Marinade | Fit Foodie Lulu" />
<meta property="og:description" content="THAI BBQ CHICKEN &amp; COCONUT LIME RICE &#x1f525; Mum&#x2019;s recipe..." />
<meta property="og:image" content="https://scontent.example/v/t51.82787-15/photo.jpg?_nc_cat=1&amp;oe=6ADAC542" />
</head><body></body></html>`;

test('isFacebookUrl recognises share links and short domains', () => {
  assert.equal(isFacebookUrl('https://www.facebook.com/share/r/19sWskKfAs/?mibextid=wwXIfr'), true);
  assert.equal(isFacebookUrl('https://fb.watch/abc123/'), true);
  assert.equal(isFacebookUrl('https://m.facebook.com/reel/1663307438728839/'), true);
  assert.equal(isFacebookUrl('https://www.instagram.com/p/ABC/'), false);
  assert.equal(isFacebookUrl('https://notfacebook.com/x'), false);
  assert.equal(isFacebookUrl('not a url'), false);
});

test('extractFacebookPost reads the full caption from og:title', () => {
  const post = extractFacebookPost(REEL_HTML);
  assert.ok(post);
  assert.equal(
    post.caption,
    'THAI BBQ CHICKEN & COCONUT LIME RICE 🔥 Mum’s recipe.  Ingredients • 1 tbsp fish sauce • ¼ cup water   Method 1. Marinade',
  );
  assert.equal(post.authorName, 'Fit Foodie Lulu');
  assert.equal(
    post.imageUrl,
    'https://scontent.example/v/t51.82787-15/photo.jpg?_nc_cat=1&oe=6ADAC542',
  );
});

test('extractFacebookPost keeps pipes that are part of the caption', () => {
  const html = `<meta property="og:title" content="12 likes | Soup | Salad | Dessert night! Recipe: 2 cups stock | Jane Cook" />`;
  const post = extractFacebookPost(html);
  assert.ok(post);
  assert.equal(post.caption, 'Soup | Salad | Dessert night! Recipe: 2 cups stock');
  assert.equal(post.authorName, 'Jane Cook');
});

test('extractFacebookPost returns null on a login wall', () => {
  assert.equal(extractFacebookPost('<meta property="og:title" content="Facebook" />'), null);
  assert.equal(
    extractFacebookPost('<meta property="og:title" content="Log in or sign up to view" />'),
    null,
  );
  assert.equal(extractFacebookPost('<html><body>nothing</body></html>'), null);
});
