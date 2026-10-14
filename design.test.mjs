// The user's "AI website tells" list, enforced as tests over everything in site/. If one of these fails, the design has
// drifted toward the look the user does not want, or the page would be blocked by its own Content Security Policy.
import test from 'node:test';
import assert from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./site/', import.meta.url));
const walk = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(root).filter((f) => ['.html', '.css', '.js', '.svg'].includes(extname(f)));
const of = (...exts) => files.filter((f) => exts.includes(extname(f)));
const lines = (list) => list.flatMap((f) => readFileSync(f, 'utf8').split('\n').map((text, i) => ({ f: relative(root, f), n: i + 1, text })));
const offenders = (list, re) => lines(list).filter((l) => re.test(l.text)).map((l) => `${l.f}:${l.n}: ${l.text.trim().slice(0, 90)}`);
const none = (found, why) => assert.deepEqual(found, [], why);

test('there are site files to check', () => assert.ok(files.length > 10));

test('no em dashes or en dashes in any copy', () => none(offenders(files, /[—–]/), 'dashes found'));
test('no emojis', () => none(offenders(of('.html', '.js', '.css', '.svg'), /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F2FF}]/u), 'emoji found'));
test('no gradients of any kind', () => none(offenders(of('.css', '.html', '.svg', '.js'), /(linear|radial|conic)-gradient|<(linear|radial)Gradient/i), 'gradient found'));
test('no shadows', () => none(offenders(of('.css', '.html', '.js'), /(box|text)-shadow|drop-shadow/i), 'shadow found'));
test('no pure white', () => none(offenders(of('.css', '.html', '.svg'), /#fff(fff)?\b|:\s*white\b|rgb\(255[ ,]+255[ ,]+255\)/i), 'pure white found'));
test('no banned fonts or icon libraries', () => none(offenders(files, /\b(Inter|Geist|Space Grotesk|lucide)\b/i), 'banned font or icon library'));
test('no backdrop blur or glass effects', () => none(offenders(of('.css'), /backdrop-filter|filter:\s*blur/i), 'glass effect found'));
test('corners stay small: nothing rounder than 8px except pills and circles', () => {
  const bad = lines(of('.css')).filter((l) => /border-radius:/.test(l.text)).filter((l) => {
    const v = /border-radius:\s*([^;]+);/.exec(l.text)?.[1] ?? '';
    return !/(var\(--r-[12]\)|999px|50%|2px|3px|4px|6px|8px|0)/.test(v);
  }).map((l) => `${l.f}:${l.n}: ${l.text.trim()}`);
  none(bad, 'rounded corners too large');
});
test('hover only changes colour: nothing moves, scales or animates on hover', () => {
  const css = of('.css').map((f) => readFileSync(f, 'utf8')).join('\n');
  const hovers = [...css.matchAll(/:hover[^{]*\{([^}]*)\}/g)].map((m) => m[1]);
  const bad = hovers.filter((body) => /transform|animation|translate|scale|rotate|filter|opacity/.test(body));
  none(bad, 'a hover rule does more than change colour');
});
test('no animated arrows or sparkle icons in the icon set', () => {
  const svg = readFileSync(join(root, 'assets', 'icons.svg'), 'utf8');
  assert.ok(!/<animate/i.test(svg) && !/sparkle|star/i.test(svg));
});

// the pages' Content Security Policy forbids inline script and inline style attributes
test('no inline scripts, inline event handlers or inline style attributes in pages', () => {
  none(offenders(of('.html'), /\sstyle=|\sonclick=|\sonsubmit=|\sonload=|\sonerror=|javascript:/i), 'inline code blocked by the CSP');
  const inlineScripts = lines(of('.html')).filter((l) => /<script(?![^>]*\ssrc=)[^>]*>/i.test(l.text)).map((l) => `${l.f}:${l.n}`);
  none(inlineScripts, 'inline <script> blocks');
});
test('nothing loads from another website', () => none(offenders(of('.html', '.css', '.js'), /(src|href|url\()\s*=?\s*["']?https?:\/\/(?!sandwich\.example|127\.0\.0\.1|github\.com\/cheakKk)/i), 'external resource'));

// content the pages are required to have
test('Terms and Privacy pages exist and are linked from the landing page', () => {
  const index = readFileSync(join(root, 'index.html'), 'utf8');
  assert.match(index, /href="\/terms"/);
  assert.match(index, /href="\/privacy"/);
  assert.ok(readFileSync(join(root, 'terms.html'), 'utf8').length > 500);
  assert.ok(readFileSync(join(root, 'privacy.html'), 'utf8').length > 500);
});
test('skeleton loaders exist for the loading states', () => {
  const css = readFileSync(join(root, 'assets', 'css', 'components.css'), 'utf8');
  assert.match(css, /\.skel\b/);
  assert.match(readFileSync(join(root, 'index.html'), 'utf8'), /class="skel/);
});
test('no three-feature-cards-in-a-row, no pricing tiers, no testimonials', () => {
  const landing = readFileSync(join(root, 'index.html'), 'utf8');
  assert.ok(!/testimonial|pricing|per month|\/mo\b/i.test(landing));
  assert.ok(!/repeat\(3,\s*minmax/.test(readFileSync(join(root, 'assets', 'css', 'landing.css'), 'utf8')), 'a three-column card grid');
});
