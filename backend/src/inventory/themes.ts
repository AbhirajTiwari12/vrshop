// Theme families: the words products carrying a theme use in their titles. A request's theme terms vary from run to
// run ("lightning mcqueen" one time, "race car" the next); expanding them to their family keeps matching stable, so
// the same race-track rug and Delta Children table set count as "Cars" whichever words the AI picked.

export const THEME_FAMILIES: { match: RegExp; terms: string[] }[] = [
  { match: /\b(lightning mc ?queen|mcqueen|disney ?\/? ?pixar cars|disney cars|pixar cars|cars (themed|theme|movie)|race ?cars?|racing|race ?tracks?|speedway)\b/, terms: ['lightning mcqueen', 'disney cars', 'pixar cars', 'race car', 'racing', 'race track', 'speedway'] },
  { match: /\b(dinosaurs?|dino|t-?rex|jurassic)\b/, terms: ['dinosaur', 'dino', 't-rex', 'jurassic'] },
  { match: /\b(outer space|space themed|rockets?|astronauts?|planets?|galaxy|solar system)\b/, terms: ['outer space', 'rocket', 'astronaut', 'planet', 'galaxy', 'solar system'] },
  { match: /\bunicorns?\b/, terms: ['unicorn'] },
  { match: /\bprincess(es)?\b/, terms: ['princess'] },
  { match: /\bmermaids?\b/, terms: ['mermaid'] },
  { match: /\b(jungle|safari)\b/, terms: ['jungle', 'safari'] },
  { match: /\b(ocean|under ?the ?sea|sharks?|whales?)\b/, terms: ['ocean', 'under the sea', 'shark', 'whale'] },
  { match: /\b(super ?heroes?|marvel|spider-?man|batman|avengers)\b/, terms: ['superhero', 'marvel', 'spider-man', 'batman', 'avengers'] },
  { match: /\bpaw patrol\b/, terms: ['paw patrol'] },
  { match: /\b(trains?|railway)\b/, terms: ['train', 'railway'] },
  { match: /\b(construction|dump trucks?|excavators?)\b/, terms: ['construction', 'dump truck', 'excavator'] },
  { match: /\b(soccer|football|basketball|baseball|sports themed)\b/, terms: ['soccer', 'football', 'basketball', 'baseball', 'sports'] },
];

/** The family of a phrase ("design a cars themed room"), if it names a known theme. */
export const themeFamily = (text: string) => THEME_FAMILIES.find((f) => f.match.test(text.toLowerCase()))?.terms;

/** The requested terms first (they lead headings), then the rest of each family they belong to. */
export function expandTheme(terms: string[] | undefined): string[] | undefined {
  if (!terms?.length) return undefined;
  const out = [...terms];
  for (const t of terms) for (const extra of themeFamily(t) ?? []) if (!out.includes(extra)) out.push(extra);
  return out.slice(0, 12);
}
