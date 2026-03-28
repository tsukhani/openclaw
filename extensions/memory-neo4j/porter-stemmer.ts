/**
 * Porter stemmer for English — lightweight single-file implementation.
 * Based on Martin Porter's algorithm: https://tartarus.org/martin/PorterStemmer/
 *
 * Used by BM25 query expansion to generate morphological variants of query terms
 * (e.g. "preferred" → "prefer", "meetings" → "meet").
 */

const step2list: Record<string, string> = {
  ational: "ate",
  tional: "tion",
  enci: "ence",
  anci: "ance",
  izer: "ize",
  bli: "ble",
  alli: "al",
  entli: "ent",
  eli: "e",
  ousli: "ous",
  ization: "ize",
  ation: "ate",
  ator: "ate",
  alism: "al",
  iveness: "ive",
  fulness: "ful",
  ousness: "ous",
  aliti: "al",
  iviti: "ive",
  biliti: "ble",
  logi: "log",
};

const step3list: Record<string, string> = {
  icate: "ic",
  ative: "",
  alize: "al",
  iciti: "ic",
  ical: "ic",
  ful: "",
  ness: "",
};

const c = "[^aeiou]"; // consonant
const v = "[aeiouy]"; // vowel
const C = c + "[^aeiouy]*"; // consonant sequence
const V = v + "[aeiou]*"; // vowel sequence

const mgr0 = new RegExp("^(" + C + ")?" + V + C);
const meq1 = new RegExp("^(" + C + ")?" + V + C + "(" + V + ")?$");
const mgr1 = new RegExp("^(" + C + ")?" + V + C + V + C);
const s_v = new RegExp("^(" + C + ")?" + v);

/**
 * Stem a single English word using the Porter algorithm.
 * Returns the stemmed form (lowercase).
 */
export function porterStem(w: string): string {
  if (w.length < 3) return w;

  let stem: string;
  let suffix: string;
  let re: RegExp;
  let re2: RegExp;
  let re3: RegExp;
  let re4: RegExp;

  const firstch = w.charAt(0);
  if (firstch === "y") {
    w = firstch.toUpperCase() + w.slice(1);
  }

  // Step 1a
  re = /^(.+?)(ss|i)es$/;
  re2 = /^(.+?)([^s])s$/;
  if (re.test(w)) {
    w = w.replace(re, "$1$2");
  } else if (re2.test(w)) {
    w = w.replace(re2, "$1$2");
  }

  // Step 1b
  re = /^(.+?)eed$/;
  re2 = /^(.+?)(ed|ing)$/;
  if (re.test(w)) {
    const fp = re.exec(w)!;
    re = mgr0;
    if (re.test(fp[1])) {
      re = /.$/;
      w = w.replace(re, "");
    }
  } else if (re2.test(w)) {
    const fp = re2.exec(w)!;
    stem = fp[1];
    re2 = s_v;
    if (re2.test(stem)) {
      w = stem;
      re2 = /(at|bl|iz)$/;
      re3 = new RegExp("([^aeiouylsz])\\1$");
      re4 = new RegExp("^" + C + v + "[^aeiouwxy]$");
      if (re2.test(w)) {
        w = w + "e";
      } else if (re3.test(w)) {
        re = /.$/;
        w = w.replace(re, "");
      } else if (re4.test(w)) {
        w = w + "e";
      }
    }
  }

  // Step 1c
  re = /^(.+?)y$/;
  if (re.test(w)) {
    const fp = re.exec(w)!;
    stem = fp[1];
    re = s_v;
    if (re.test(stem)) {
      w = stem + "i";
    }
  }

  // Step 2
  re =
    /^(.+?)(ational|tional|enci|anci|izer|bli|alli|entli|eli|ousli|ization|ation|ator|alism|iveness|fulness|ousness|aliti|iviti|biliti|logi)$/;
  if (re.test(w)) {
    const fp = re.exec(w)!;
    stem = fp[1];
    suffix = fp[2];
    re = mgr0;
    if (re.test(stem)) {
      w = stem + step2list[suffix];
    }
  }

  // Step 3
  re = /^(.+?)(icate|ative|alize|iciti|ical|ful|ness)$/;
  if (re.test(w)) {
    const fp = re.exec(w)!;
    stem = fp[1];
    suffix = fp[2];
    re = mgr0;
    if (re.test(stem)) {
      w = stem + step3list[suffix];
    }
  }

  // Step 4
  re = /^(.+?)(al|ance|ence|er|ic|able|ible|ant|ement|ment|ent|ou|ism|ate|iti|ous|ive|ize)$/;
  re2 = /^(.+?)(s|t)(ion)$/;
  if (re.test(w)) {
    const fp = re.exec(w)!;
    stem = fp[1];
    re = mgr1;
    if (re.test(stem)) {
      w = stem;
    }
  } else if (re2.test(w)) {
    const fp = re2.exec(w)!;
    stem = fp[1] + fp[2];
    re2 = mgr1;
    if (re2.test(stem)) {
      w = stem;
    }
  }

  // Step 5
  re = /^(.+?)e$/;
  if (re.test(w)) {
    const fp = re.exec(w)!;
    stem = fp[1];
    re = mgr1;
    re2 = meq1;
    re3 = new RegExp("^" + C + v + "[^aeiouwxy]$");
    if (re.test(stem) || (re2.test(stem) && !re3.test(stem))) {
      w = stem;
    }
  }

  re = /ll$/;
  re2 = mgr1;
  if (re.test(w) && re2.test(w)) {
    re = /.$/;
    w = w.replace(re, "");
  }

  if (firstch === "y") {
    w = firstch.toLowerCase() + w.slice(1);
  }

  return w;
}

/**
 * Generate morphological variants of a word by stemming it and producing
 * common inflected forms from the stem.
 * Returns a deduplicated array including the original word.
 */
export function stemVariants(word: string): string[] {
  const lower = word.toLowerCase();
  const stem = porterStem(lower);
  const variants = new Set([word, lower]);

  // Only add the stem and its -s form — these are the two most useful variants
  // for BM25 matching (e.g. "preferred" → "prefer" → "prefers").
  // Generating full inflection sets (stem+ed, stem+ing, etc.) produces too many
  // spurious non-words from truncated stems (e.g. "microphon" → "microphoned").
  if (stem !== lower && stem.length >= 3) {
    variants.add(stem);
    variants.add(stem + "s");
    // Add -e variant only for stems that lost a trailing -e in stemming
    // (e.g. "scheduling" → "schedul" → "schedule")
    if (!stem.endsWith("e") && lower.includes(stem + "e")) {
      variants.add(stem + "e");
    }
  }

  return [...variants].filter((v) => v.length >= 3);
}
