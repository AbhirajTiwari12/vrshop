import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { heuristicInterpret, themeOf } from '../src/ai/assistant.js';
import { describeFilters, normalizeFilters } from '../src/inventory/filters.js';
import { matchesTheme } from '../src/inventory/inventory.js';
import type { Product } from '../src/types.js';

const product = (id: string, title: string, description = ''): Product => ({
  id, source: 'google_shopping', store: 'Walmart', title, category: 'bed', price: 199, currency: 'USD', priceText: '$199',
  imageUrl: '', images: [], productUrl: '', description, model: { status: 'none' },
});

const ctx = { filters: {}, visible: [], total: 0, priceRange: null, room: null, budget: null, cartTotal: 0, chat: [], stores: [], realFurniture: [] };

describe('themes', () => {
  it('keeps theme words in the filters and says them', () => {
    const f = normalizeFilters({ category: 'bed', theme: ['Race Car', 'racing', 'x'] });
    assert.deepEqual(f.theme?.slice(0, 2), ['race car', 'racing'], 'the requested words lead');
    assert.ok(f.theme?.includes('lightning mcqueen') && f.theme.includes('race track'), 'the rest of the Cars family follows');
    assert.equal(describeFilters(f), 'race car-themed beds');
  });

  it('matches a listing that shows any one of the theme terms', () => {
    const theme = ['lightning mcqueen', 'disney cars', 'race car', 'racing'];
    assert.ok(matchesTheme(product('t1', 'Delta Children Disney/Pixar Cars Lightning McQueen Toddler Bed'), theme));
    assert.ok(matchesTheme(product('t2', 'Twin Race Car Bed with LED Lights, Red'), theme));
    assert.ok(matchesTheme(product('t3', 'Kids Bed', 'Racing car design with spoiler'), theme));
    assert.ok(!matchesTheme(product('t4', 'MALM Bed frame, white'), theme));
    assert.ok(!matchesTheme(product('t5', 'Carson Upholstered Bed'), ['cars']), 'no partial-word matches');
  });

  it('recognizes common kids themes without an AI key', () => {
    assert.deepEqual(themeOf('design a cars themed room for my son')?.slice(0, 1), ['lightning mcqueen']);
    assert.deepEqual(themeOf('a dinosaur rug')?.[0], 'dinosaur');
    assert.equal(themeOf('a space saving desk'), undefined, '"space saving" is not a theme');
    const r = heuristicInterpret('show me race car beds', ctx);
    assert.equal(r.filters.category, 'bed');
    assert.ok(r.filters.theme?.includes('race car'));
    // A new kind of item starts fresh: the bed's theme doesn't stick to "now show me desks".
    const next = heuristicInterpret('now show me desks', { ...ctx, filters: r.filters });
    assert.equal(next.filters.theme, undefined);
  });
});

describe('themed results', () => {
  it('puts real retailers before resale marketplaces', async () => {
    const { preferRetailers } = await import('../src/session.js');
    const mk = (id: string, store: string) => ({ ...product(id, 'Disney Cars lamp'), store });
    const ps = [mk('a', 'eBay'), mk('b', 'Walmart'), mk('c', 'Poshmark'), mk('d', 'Target'), mk('e', 'Etsy - Seller'), mk('f', 'Wayfair')];
    assert.deepEqual(preferRetailers(ps).map((p) => p.id), ['b', 'd', 'e', 'f']);
    assert.deepEqual(preferRetailers(ps.slice(0, 3)).map((p) => p.id), ['b', 'a', 'c'], 'marketplaces fill in when retailers are few');
  });
});

describe('themed furniture rows', () => {
  it('drops plush toys and covers but keeps kids furniture', async () => {
    const { isAccessory, matchCategory } = await import('../src/catalog.js');
    assert.ok(isAccessory('Beanbag Plush From Disney Cars 2 Soft Pals Lighting Mcqueen', 'armchair'));
    assert.ok(isAccessory('Disney Cars Lightning McQueen Pillowbuddy', 'armchair'));
    assert.ok(isAccessory('Race Cars Children\'s Beanbag Cover', 'armchair'));
    assert.ok(!isAccessory('Delta Children Cars Cozee Buddy Flip-Out Kids Chair', 'armchair'));
    assert.equal(matchCategory('delta children cars cozee buddy flip-out kids chair'), 'armchair');
    assert.equal(matchCategory('delta children disney pixar cars kids table and chair set with storage'), 'dining_table');
    assert.equal(matchCategory('disney pixar cars toy box'), 'cabinet');
  });
});

describe('theme families', () => {
  it('matches the same Cars pieces whichever words the AI picked', async () => {
    const { expandTheme } = await import('../src/inventory/themes.js');
    const table = product('f1', "Delta Children Disney Pixar Cars Kids' Table and Chair Set with Storage");
    const rug = product('f2', 'Kids Race Track Play Rug Realistic Road Design Car Carpet');
    const lamp = product('f3', 'Little Lights Mini Red Race Car Lamp');
    for (const words of [['lightning mcqueen', 'disney cars'], ['race car'], ['disney cars', 'tow mater']]) {
      const theme = expandTheme(words)!;
      assert.ok([table, rug, lamp].every((p) => matchesTheme(p, theme)), `${words.join(', ')} -> ${theme.join(', ')}`);
    }
    assert.ok(!matchesTheme(product('f4', 'MALM Bed frame, white'), expandTheme(['race car'])!));
  });
});
