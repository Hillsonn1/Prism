'use strict';
// Merchant name normalization: turns raw bank descriptors like
// "SQ *BLUE BOTTLE COFFEE 0142 BROOKLYN NY" into "Blue Bottle Coffee".
// The rules were tuned against real US and Israeli statements; the order of
// the replacements matters.

function toTitleCase(str) {
  return str
    .toLowerCase()
    .replace(/(?:^|[\s\-\/&\*])(\w)/g, m => m.toUpperCase());
}

// Known abbreviations that regex title-casing can't fix
const MERCHANT_ABBR = new Map([
  ['wholefds', 'Whole Foods'],
  ['wholefood', 'Whole Foods'],
  ['amzn mktp', 'Amazon'],
  ['amzn', 'Amazon'],
  ['amz', 'Amazon'],
  ['wal-mart', 'Walmart'],
  ['wal mart', 'Walmart'],
  ['mcdonalds', "McDonald's"],
  ['cvs/pharmacy', 'CVS Pharmacy'],
  ['cvs phrmcy', 'CVS Pharmacy'],
  ['cvs pharm', 'CVS Pharmacy'],
  ['walgreens pharmacy', 'Walgreens'],
  ['usps po', 'USPS'],
  ['usps postal', 'USPS'],
  ['apple.com/bill', 'Apple'],
  ['apple/bill', 'Apple'],
  ['itunes.com/bill', 'Apple'],
  ['google *google storage', 'Google Storage'],
  ['google *youtube', 'YouTube'],
  ['google *google one', 'Google One'],
  ['pp*', 'PayPal'],
  ['uber *trip', 'Uber'],
  ['uber*trip', 'Uber'],
  ['uber* trip', 'Uber'],
  ['uber *eats', 'Uber Eats'],
  ['uber*eats', 'Uber Eats'],
  ['uber* eats', 'Uber Eats'],
  ['uber eats', 'Uber Eats'],
  ['uber one', 'Uber One'],
  ['lyft *ride', 'Lyft'],
  ['lyft*ride', 'Lyft'],
  ['mta*nyct', 'MTA NYC Transit'],
  ['mta *nyct', 'MTA NYC Transit'],
  ['openai *chatgpt', 'ChatGPT'],
  ['openai*chatgpt', 'ChatGPT'],
  ['openai', 'OpenAI'],
  ['krispy', 'Krispy Kreme'],
  ['krispykreme', 'Krispy Kreme'],
  ['amazon mktpl', 'Amazon'],
  ['amazon mark', 'Amazon'],
  ['amazon reta', 'Amazon'],
  ['amazon.com', 'Amazon'],
  ['lululemon athletica', 'Lululemon'],
  ['lululemon', 'Lululemon'],
  ['ouraring', 'Oura Ring'],
  ['nytimes', 'New York Times'],
  ['verizon wrls', 'Verizon Wireless'],
  ['verizon wireless', 'Verizon Wireless'],
  ['etsy etsy', 'Etsy'],
  ['d j*wsj', 'Wall Street Journal'],
  ['wsj-emea', 'Wall Street Journal'],
  ['wsj.com', 'Wall Street Journal'],
  ['smartecarte', 'Smartecarte'],
  ['amex fine hotels', 'Amex Fine Hotels & Resorts'],
]);

const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
]);

// City names sorted longest-first so longer names match before shorter subsets
// (e.g. "SANFRANCISCO" matched before "FRANCISCO")
const KNOWN_CITIES = [
  'LONGISLANDCITY','SANFRANCISCO','JACKSONVILLE','INDIANAPOLIS','FORTWORTH',
  'SANANTONIO','CENTERREACH','ALBUQUERQUE','PORTSMOUTH','SCOTTSDALE',
  'MINNEAPOLIS','PITTSBURGH','BRENTWOOD','SACRAMENTO','LOUISVILLE',
  'BIRMINGHAM','HAUPPAUGE','HENDERSON','HUNTINGTON','CINCINNATI',
  'WASHINGTON','NASHVILLE','CENTERPORT','BRIDGEPORT','CENTERLINE',
  'FRESHMEADOWS','PROVIDENCE','MILWAUKEE','BALTIMORE','CHARLOTTE',
  'CAMBRIDGE','CLEVELAND','HEMPSTEAD','HICKSVILLE','COMMACK',
  'RICHMOND','SMITHTOWN','WESTBURY','AIRMONT','NANUET','SUFFERN',
  'PORTLAND','CHANDLER','MEMPHIS','ORLANDO','PHOENIX','HOUSTON','SEATTLE',
  'HARTFORD','STAMFORD','WATERBURY','GREENWICH','NORWALK','RALEIGH',
  'MINEOLA','PATCHOGUE','BAYSHORE','BABYLON','MANHASSET','MEADOWS',
  'SYOSSET','ROSLYN','ASTORIA','BAYSIDE','CORONA','ELMHURST','JACKSON',
  'FLUSHING','JAMAICA','YONKERS','BROOKLYN','HOBOKEN','NEWARK','TRENTON',
  'RIDGEWOOD','SUNNYSIDE','WOODSIDE','MASPETH','QUEENS','BRONX','FRESH',
  'BOSTON','CHICAGO','DALLAS','DENVER','ATLANTA','MIAMI','TAMPA',
  'TUCSON','FRESNO','ANAHEIM','GLENDALE','GILBERT','TEMPE','CHANDLER',
  'LASVEGAS','SANDIEGO','SANJOSE','LOSANGELES','ELPASO','BUFFALO',
  'OMAHA','WICHITA','TULSA','RENO','BOISE','NORFOLK','AURORA',
  'COLUMBUS','AUSTIN','PLANO','GARLAND','IRVINE','OXNARD',
  'WORCESTER','LOWELL','QUINCY','LEXINGTON','NEWTON',
].sort((a, b) => b.length - a.length);

// Israeli city names (sorted longest-first) — no state code in Israeli bank data.
// Includes full compound names AND the standalone second-parts of two-word cities
// so that split cases like "YESHRISHON LEZION" are caught (last word = second-part).
const ISRAELI_CITIES = [
  // Full compound city names
  'RISHONLEZIYYON','RISHONLEZION','JUERUSALEM','YERUSHALAYIM',
  'PETAHTIQWA','PETAHTIKVA','PETAHIKVA',
  'KIRYATMOTZKIN','KIRYATBIALIK','KIRYATSHMONA','KIRYATGAT','KIRYATATA',
  'RAMATASHARON','MAALEADUMIM','ROSHHAAYIN','ROSHAAYIN',
  // Bnei Brak — full concat forms covering BNI/BNEI/BNEY/BNAI × BRAK/BRAQ/BARAQ
  'BNEIBRAK','BNEYBRAK','BNAIBRAK','BNIBRAK',
  'BNEIBRAQ','BNEYBRAQ','BNAIBRAQ','BNIBRAQ',
  'BNEIBARAQ','BNEYBARAQ','BNAIBARAQ','BNIBARAQ',
  'ORYEHUDA','GIVATSHMUIL','BEERSHEBA','BEERSHEVA','KFARSABA','RAMATGAN',
  'GIVATAYIM','HERZLIYA','KEISARYA','CAESAREA','TIBERIAS','NAZARETH',
  'ASHKELON','REHOVOT','NAHARIYA','RAANANA','KARMIEL','HADERA','BATYAM',
  'NETANYA','ASHDOD','TELAVIV','JERUSALEM','HOLON','RAMLA','EILAT','AKKO',
  'HAIFA','PETAH','TIKVA','TIQVA','TIQWA',
  // Second-parts of two-word cities (standalone last-word detection).
  // When one of these appears as the final word, the matching first-part was
  // merged into the preceding merchant word (see ISRAELI_CITY_SECOND_PARTS below).
  'LEZIYYON','LEZION','SHEMESH',
  // Bnei Brak second-parts (BRAK/BRAQ/BARAQ — not BREAK, which is an English word)
  'BARAQ','BRAK','BRAQ',
].sort((a, b) => b.length - a.length);

// Maps each "second word" of a two-word Israeli city to its possible "first words".
// Used for the secondary cleanup pass when the second word is stripped as a standalone
// last word (e.g. "YESHRISHON LEZION" → strip "LEZION" → strip "RISHON" from "YESHRISHON").
const ISRAELI_CITY_SECOND_PARTS = new Map([
  ['LEZION',   ['RISHON']],
  ['LEZIYYON', ['RISHON']],
  ['SHEMESH',  ['BET', 'BEIT']],
  ['TIKVA',    ['PETAH']],
  ['TIQVA',    ['PETAH']],
  ['TIQWA',    ['PETAH']],
  // Bnei Brak — first-parts for BRAK/BRAQ/BARAQ second-words
  ['BRAK',     ['BNEI', 'BNEY', 'BNAI', 'BNI']],
  ['BRAQ',     ['BNEI', 'BNEY', 'BNAI', 'BNI']],
  ['BARAQ',    ['BNEI', 'BNEY', 'BNAI', 'BNI']],
]);

function quickNormalizeName(merchant) {
  let s = merchant.trim();

  // Payment processor / wallet prefixes (order matters — longer first)
  s = s.replace(/^APLPAY\s+/i, '');
  s = s.replace(/^(SQ|TST|GMF|MC|PY|PYD|WW|SP|APL|IN|DRI|WU|PP|NYX|OTTER|TOAST|CLOVER|D\s*J)\s*\*\s*/i, '');
  s = s.replace(/^(PAYPAL|VENMO|ZELLE|STRIPE|SQUARE)\s*\*\s*/i, '');
  // Repeated-brand prefix: "Google *Google One" → "Google One", "Ebay *Ebay Checkout" → "Ebay Checkout"
  s = s.replace(/^(\w+)\s+\*\1\b\s*/i, '$1 ').trim();

  // Long embedded reference/phone numbers in last word (e.g. "KEVA1800800199HOL")
  s = s.replace(/\d{7,}\w{0,4}\s*$/, '');
  // US phone at end of string, with optional lowercase/uppercase state code and trailing noise
  // ("WEB CHAVER424-242-8371NJ", "GOOGLE ONE855-836-3987ca -")
  s = s.replace(/\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}[A-Za-z]{0,2}[\s\-.,*]*$/gi, '');
  // Phone directly concatenated to a word with no preceding space ("One855-836-3987ca -")
  // Replace starting from the letter that precedes the digits so the word prefix is kept.
  s = s.replace(/([A-Za-z])\d{3}[-.\s]?\d{3}[-.\s]?\d{4}[A-Za-z]{0,2}[\s\-.,*]*$/, '$1');
  // US phone numbers mid-string (global, with word boundary): "(877)263-9300" or "800-568-7625"
  s = s.replace(/\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b\s*/g, ' ');
  // International / Israeli phone: "03 5202323" or "5202323tel" or "5202323 tel"
  s = s.replace(/\s+\d{6,10}\s*(tel|fax|phone)?\s*$/gi, '');
  s = s.replace(/\s+\d{2,3}\s+\d{6,8}\s*(tel|fax|phone)?\s*$/gi, '');
  // Trailing 2-digit area code directly concatenated to merchant word ("MECUHEDET03" → "MECUHEDET")
  // Only when digits follow a letter (not standalone digits like "Route 66" or "Highway 99")
  s = s.replace(/[A-Za-z]\d{2}\s*$/, m => m[0]);
  // Multi-segment reference/transaction codes: "C 18-13827-63987" or "O*25-14041-09950"
  // Replace with a space so adjacent words don't accidentally merge.
  s = s.replace(/\s+[A-Z]\s*\*?\s*\d{2,}(?:-\d{3,}){2,}\b/gi, ' ');
  // Standalone multi-segment numbers without a letter prefix
  s = s.replace(/\s+\d{2,}(?:-\d{3,}){2,}\b/g, '');

  // Trailing city + state with spaces (e.g. "Starbucks Flushing NY" or "McDonald's New York NY")
  // Require 4+ char city words to avoid stripping short abbreviations like "APP NY"
  s = s.replace(/\s+(?:[A-Z][a-zA-Z'-]{3,14}\s+){0,2}([A-Z]{2})\s*$/, (match, state) =>
    US_STATES.has(state) ? '' : match
  );

  // Trailing dates embedded by the bank ("MCDONALD'S 04/15" or "CHEVRON 2024-03-01")
  s = s.replace(/\s+\d{1,2}\/\d{1,2}\/?\d{0,4}\s*$/, '');
  s = s.replace(/\s+[A-Za-z]{3,9}\.?\s+\d{1,2},?\s+\d{4}\s*$/, '');

  // Concatenated city+state glued to merchant word with no space
  // e.g. "RALPH'S COFFEEMANHASSETNY" → "RALPH'S COFFEE"
  //      "URBAN PRESSFLUSHINGNY"    → "URBAN PRESS"
  let _cityWasStripped = false;
  s = s.replace(/(\S+)$/, lastWord => {
    const upper = lastWord.toUpperCase();
    if (upper.length < 7) return lastWord;
    const state = upper.slice(-2);
    if (!US_STATES.has(state)) return lastWord;
    const cityPart = upper.slice(0, -2);
    for (const city of KNOWN_CITIES) {
      if (cityPart.endsWith(city)) {
        _cityWasStripped = true;
        return lastWord.slice(0, cityPart.length - city.length);
      }
      if (cityPart === city) { _cityWasStripped = true; return ''; }
    }
    return lastWord;
  });
  s = s.trim();

  // Two-word US city split: "san Joseca" → prevWord="san", cityPart="JOSE", state="CA"
  // The city's first word was left as a standalone preceding word because only the
  // second word+state was concatenated (e.g. "Ebay san Joseca" after ref stripping).
  if (!_cityWasStripped) {
    s = s.replace(/(\S+)\s+(\S+)$/, (match, prevWord, lastWord) => {
      const up = lastWord.toUpperCase();
      if (up.length < 3) return match;
      const state = up.slice(-2);
      if (!US_STATES.has(state)) return match;
      const cityPart = up.slice(0, -2);
      if (!cityPart) return match;
      // Combine the preceding word (letters only) with the city part and check KNOWN_CITIES
      const combined = prevWord.toUpperCase().replace(/[^A-Z]/g, '') + cityPart;
      for (const city of KNOWN_CITIES) {
        if (combined === city || (combined.length > city.length && combined.endsWith(city))) {
          _cityWasStripped = true;
          return '';
        }
      }
      return match;
    });
    s = s.trim();
  }
  if (_cityWasStripped) {
    // Strip any city-component word that was merged into the last merchant word
    // e.g. "CARNEFRESH" → "CARNE" when FRESH was the start of "FRESH MEADOWS"
    s = s.replace(/(\S+)$/, newLast => {
      const up = newLast.toUpperCase();
      for (const part of ['FRESHMEADOWS','FRESH','NORTH','SOUTH','EAST','WEST','NEW','OLD','MOUNT','FORT','PORT','LAKE','GREAT','UPPER','LOWER','LITTLE','CENTRAL','GARDENS','HEIGHTS','MEADOWS','HILLS','RIDGE','SHORES','SPRINGS','GROVE','DALE','WOOD','SIDE','VILLE']) {
        if (up !== part && up.endsWith(part) && up.length > part.length + 2) {
          return newLast.slice(0, up.length - part.length);
        }
      }
      return newLast;
    });
    s = s.trim();
  }
  // Only strip dangling 1–3 char uppercase tokens if city stripping already ran — prevents
  // false positives on legitimate short words like "ONE", "PRO", "MAX" in product names.
  if (_cityWasStripped) {
    s = s.replace(/\s+[A-Z]{1,3}\s*$/, '').trim() || s;
  }
  // Strip leftover city-only word at end (e.g. "QUEENS" after stripping "FLUSHING")
  s = s.replace(/\s+(\S+)\s*$/, (match, lastWord) =>
    KNOWN_CITIES.includes(lastWord.toUpperCase()) ? '' : match
  ).trim() || s;

  // --- Israeli bank statements ---
  // "Tel Aviv" with space OR hyphen ("Placetel-Aviv", "MEUHDETtel AVIV") — strip from where TEL begins
  s = s.replace(/TEL[-\s]+AVIV[-\w\s]*$/i, '').trim();

  // Israeli cities concatenated to last word (no trailing state code in Israeli bank data)
  // e.g. "LTDJERUSALEM" → "LTD", "TOREMJERUSALEM" → "TOREM", "PLACETEL-AVIV" → "PLACE"
  // Hyphens inside the last word are normalized away before matching (handles "tel-Aviv").
  let _israeliSecondPart = null;
  s = s.replace(/(\S+)$/, lastWord => {
    const upper = lastWord.toUpperCase();
    const norm = upper.replace(/-/g, ''); // "PLACETEL-AVIV" → "PLACETELAVIV"
    for (const city of ISRAELI_CITIES) {
      if (norm === city) {
        _israeliSecondPart = city;
        return '';
      }
      if (norm.endsWith(city) && norm.length > city.length + 1) {
        _israeliSecondPart = city;
        // Map the normalized cut-point back to the original string (hyphens skipped)
        const keep = norm.length - city.length;
        let n = 0, i = 0;
        while (i < upper.length && n < keep) { if (upper[i] !== '-') n++; i++; }
        return lastWord.slice(0, i);
      }
    }
    return lastWord;
  });
  s = s.trim();

  // If a two-word city's second part was stripped as the standalone last word, the
  // matching first part was merged into the preceding merchant word — strip it too.
  // e.g. "YESHRISHON" after stripping "LEZION" → strip "RISHON" → "YESH"
  //      "BAKERBET"   after stripping "SHEMESH" → strip "BET"   → "BAKER"
  if (_israeliSecondPart && ISRAELI_CITY_SECOND_PARTS.has(_israeliSecondPart)) {
    const firstParts = ISRAELI_CITY_SECOND_PARTS.get(_israeliSecondPart);
    s = s.replace(/(\S+)$/, newLast => {
      const up = newLast.toUpperCase();
      for (const fp of firstParts) {
        if (up === fp) return '';
        if (up.endsWith(fp) && up.length > fp.length) return newLast.slice(0, up.length - fp.length);
      }
      return newLast;
    });
    s = s.trim();
  }

  // Bnei Brak where the second word is "BREAK" (a bank transliteration of ברק).
  // "BREAK" is too common an English word to add to ISRAELI_CITIES, so we handle it
  // with a targeted regex that fires ONLY when the preceding word ends with a BN-prefix.
  // Pattern: any word ending in BNI/BNEI/BNEY/BNAI followed by any BRAK/BRAQ/BARAQ/BREAK variant.
  // "Coffee Break" is safe — "COFFEE" doesn't end with BN[AIEY]+.
  s = s.replace(/\s+\S*BN[AIEY]+\s+B[A]?R[AEOQ]*[KQ]?\s*$/i, '').trim();

  // Israeli cities as standalone spaced last word ("BRUKLYN BAKERY LTD HAIFA")
  // Also handles spaced two-word city names at end ("RISHON LE ZION", "BET SHEMESH", etc.)
  s = s.replace(/\s+(JERUSALEM|JUERUSALEM|YERUSHALAYIM|HAIFA|NETANYA|ASHDOD|ASHKELON|EILAT|HERZLIYA|KEISARYA|CAESAREA|TIBERIAS|NAZARETH|HOLON|BATYAM|REHOVOT|RAANANA|NAHARIYA|HADERA|AKKO|KARMIEL|GIVATAYIM|PETAH\s+TI[QK]VA|PETAH\s+TIQWA|BEER\s+SHEV[AH]|KFAR\s+SABA|RAMAT\s+GAN|RAMAT\s+HASHARON|BE[IT]+\s+SHEMESH|RISHON\s+LE[-\s]?ZIYYON|RISHON\s+LE[-\s]?ZION|TEL\s+AVIV|BN[AIEY]+\s+B[A]?R[AEOQ]*[KQ]?)\s*$/i, '').trim();

  // Trailing truncated phone numbers ("202-", "03-" etc. at end of string)
  s = s.replace(/\s*\d{2,}[-\s]+$/, '');

  // State code concatenated directly after a domain extension ("GETSAUCE.COMDE" → "GETSAUCE.COM")
  s = s.replace(/\.(com|net|org|app|co|io)([A-Z]{2})\s*$/gi, (match, tld, code) =>
    US_STATES.has(code.toUpperCase()) ? '.' + tld : match
  );

  // Strip embedded URLs / help domains
  s = s.replace(/\s+https?:\/\/\S*/gi, '');
  // Strip URL at end, including optional state code directly concatenated (e.g. "GETSAUCE.COMDE", "24SIX.APPNY")
  s = s.replace(/\s+\S*\.(com|net|org|app|co|io)(\/\S*)?([A-Z]{2})?\s*$/gi, (match, tld, path, stateCode) =>
    (!stateCode || US_STATES.has(stateCode.toUpperCase())) ? '' : match
  );

  // Re-run state strip after URL removal (catches "MERCHANT.COM NY" pattern)
  s = s.replace(/\s+(?:[A-Z][a-zA-Z'-]{3,14}\s+){0,2}([A-Z]{2})\s*$/, (match, state) =>
    US_STATES.has(state) ? '' : match
  );

  // URL-style names: www.merchant.com → merchant, 24six.app → 24six
  // Use \S* (not \b) so "24six.appwww.24six" → "24six" (consumes everything after the TLD)
  s = s.replace(/^www\./i, '').replace(/\.(com|net|org|co|app|io)\S*/gi, '');

  // Parenthetical suffixes: "Merchant (City, State)"
  s = s.replace(/\s*\([^)]{0,40}\)\s*$/, '');

  // Legal suffixes — spaced (word boundary) and concatenated (e.g. "YESHLTD" after city strip)
  s = s.replace(/\s*,?\s*\b(LLC|INC\.?|CORP\.?|LTD\.?|CO\.|PLC|PLLC|L\.L\.C\.?)\s*$/i, '');
  s = s.replace(/(.{2,}?)(LTD|LLC|INC|CORP|PLLC|PLC)\.?\s*$/i, '$1').trim();

  // Store / location numbers: #1234, St1234, or trailing standalone digits
  s = s.replace(/\s+#\d[\d\-]*(\s.*)?$/, '');
  s = s.replace(/\s+St\d{3,}\s*$/i, '');
  s = s.replace(/\s+\d{3,}\s*$/, '');

  // Transaction / reference codes: * CODE or *CODE at end (handles space after *)
  s = s.replace(/\s*\*\s*[A-Z0-9]{3,}\S*$/i, '');

  // eBay transaction IDs: "eBay C 18-13827-63987" / "eBay O*25-14041-09950"
  s = s.replace(/^(ebay)\s+[a-z]\s+[\d\-]+\s*$/i, '$1');
  s = s.replace(/^(ebay)\s+[a-z]\s*\*[\d\-]+\s*$/i, '$1');

  // Membership/subscriber IDs: "Walmart+ Member 04/28009..." → "Walmart+"
  s = s.replace(/\s+(member|subscr|account)\s+[\d\/\-]+.*$/i, '');

  // Repeated leading word: "Etsy Etsy ..." → "Etsy ..."
  s = s.replace(/^(\w+)\s+\1\b\s*/i, '$1 ').trim();

  // Trailing country names
  s = s.replace(/\s+(united states|united kingdom|israel)\s*$/i, '');

  s = s.replace(/\s{2,}/g, ' ').trim() || merchant.trim();

  // Abbreviation expansion (check before title-casing)
  const lower = s.toLowerCase();
  for (const [abbr, expanded] of MERCHANT_ABBR) {
    if (lower === abbr || lower.startsWith(abbr + ' ')) return expanded;
  }

  return toTitleCase(s);
}

module.exports = { toTitleCase, quickNormalizeName, MERCHANT_ABBR, US_STATES, KNOWN_CITIES, ISRAELI_CITIES };
