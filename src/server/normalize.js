'use strict';
// Merchant name normalization: turns raw bank descriptors like
// "SQ *BLUE BOTTLE COFFEE 0142 BROOKLYN NY" into "Blue Bottle Coffee".
// The rules were tuned against real US and Israeli statements; order matters.

// Known abbreviations that regex title-casing can't fix
const MERCHANT_ABBR = new Map([
  ['wsj', 'Wall Street Journal'],
  ['mayan 2000', 'Mayan 2000'],
  ['rav kav', 'Rav-Kav'],
  ['ravkav', 'Rav-Kav'],
  ['grab dom', 'Grab'],
  ['grabtaxi', 'Grab'],
  ['grab*', 'Grab'],
  ['kupat holim mecuhedet', 'Meuhedet'],
  ['kupat holim meuhedet', 'Meuhedet'],
  ['getyourguideoperations', 'GetYourGuide'],
  ['getyourguide', 'GetYourGuide'],
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

// Brands whose proper casing title-casing gets wrong. Matched on the whole
// cleaned name (case-insensitively).
const BRAND_CASING = new Map([
  ['mcdonalds', "McDonald's"], ["mcdonald's", "McDonald's"],
  ['trader joes', "Trader Joe's"], ["trader joe's", "Trader Joe's"],
  ['dunkin', "Dunkin'"], ['dunkin donuts', "Dunkin'"],
  ['wendys', "Wendy's"], ['arbys', "Arby's"], ['macys', "Macy's"], ['kohls', "Kohl's"],
  ['lowes', "Lowe's"], ['sams club', "Sam's Club"], ['bjs', "BJ's"], ['bjs wholesale', "BJ's Wholesale"],
  ['chick fil a', 'Chick-fil-A'], ['chick-fil-a', 'Chick-fil-A'], ['in-n-out burger', 'In-N-Out Burger'],
  ['ebay', 'eBay'], ['paypal', 'PayPal'], ['youtube', 'YouTube'], ['youtube premium', 'YouTube Premium'],
  ['itunes', 'iTunes'], ['icloud', 'iCloud'], ['doordash', 'DoorDash'], ['grubhub', 'Grubhub'],
  ['airbnb', 'Airbnb'], ['linkedin', 'LinkedIn'], ['github', 'GitHub'], ['openai', 'OpenAI'], ['chatgpt', 'ChatGPT'],
  ['whatsapp', 'WhatsApp'], ['tiktok', 'TikTok'], ['soulcycle', 'SoulCycle'], ['wework', 'WeWork'],
  ['jetblue', 'JetBlue'], ['fedex', 'FedEx'], ['petsmart', 'PetSmart'], ['gamestop', 'GameStop'],
  ['t-mobile', 'T-Mobile'], ['at&t', 'AT&T'], ['7-eleven', '7-Eleven'], ['7 eleven', '7-Eleven'],
  ['walmart', 'Walmart'], ['wal-mart', 'Walmart'], ['walgreens', 'Walgreens'], ['cvs', 'CVS'],
  ['ikea', 'IKEA'], ['kfc', 'KFC'], ['h&m', 'H&M'], ['usps', 'USPS'], ['ups', 'UPS'], ['ihop', 'IHOP'],
  ['amc', 'AMC'], ['bp', 'BP'], ['mta', 'MTA'], ['nyc', 'NYC'], ['dmv', 'DMV'], ['tj maxx', 'TJ Maxx'],
  ['gnc', 'GNC'], ['dsw', 'DSW'], ['rei', 'REI'], ['ulta', 'Ulta'], ['lululemon', 'Lululemon'],
  ['el al', 'El Al'], ['10bis', '10bis'], ['ten bis', '10bis'], ['wolt', 'Wolt'], ['gett', 'Gett'],
  ['getyourguide', 'GetYourGuide'], ['getyourguideoperations', 'GetYourGuide'], ['getyourguide operations', 'GetYourGuide'],
  ['rav kav online', 'Rav-Kav'], ['rav kav', 'Rav-Kav'], ['ravkav', 'Rav-Kav'], ['grab dom', 'Grab'], ['grabtaxi', 'Grab'],
  ['mayan 2000', 'Mayan 2000'], ['supersal', 'Supersal'], ['kupat holim mecuhedet', 'Meuhedet'], ['kupat holim meuhedet', 'Meuhedet'],
  ['ksp', 'KSP'], ['am pm', 'AM:PM'], ['am:pm', 'AM:PM'], ['ampm', 'AM:PM'], ['hot', 'HOT'], ['yes', 'yes'],
]);

// Words that stay uppercase inside a title-cased name
const ACRONYMS = new Set(['CVS', 'USPS', 'UPS', 'KFC', 'IKEA', 'BP', 'AMC', 'H&M', 'MTA', 'NYC', 'DMV', 'ATM',
  'IHOP', 'TJ', 'BBQ', 'DSW', 'REI', 'GNC', 'AT&T', 'TD', 'PNC', 'HSBC', 'BMW', 'NBA', 'NFL', 'MLB', 'NHL', 'NYU',
  'UCLA', 'MIT', 'LIRR', 'NJT', 'PATH', 'JFK', 'LGA', 'EWR', 'SFO', 'LAX', 'KSP', 'HOT', 'USA', 'UK', 'EU', 'IL',
  'LLC', 'DBA', 'PC', 'MD', 'DDS', 'CPA', 'HVAC', 'IT', 'AI', 'TV', 'DVD', 'CD', 'PS', 'XBOX', 'VIP', 'GPS', 'RV',
  'SUV', 'UPS', 'DHL', 'IRS', 'DOT', 'MTA', 'AAA', 'YMCA', 'YWCA', 'JCC', 'UJA', 'NPR', 'PBS']);

// Generic words that are part of a merchant name, never a city, so they are
// kept when a location is stripped from the end of a descriptor
const NOT_A_CITY = new Set(['PIZZA', 'PIZZERIA', 'CAFE', 'COFFEE', 'ESPRESSO', 'MARKET', 'MARKETS', 'STORE', 'STORES',
  'SHOP', 'SHOPS', 'GRILL', 'BAR', 'BAKERY', 'DELI', 'RESTAURANT', 'KITCHEN', 'INC', 'LLC', 'CO', 'GAS', 'FUEL',
  'PHARMACY', 'CLEANERS', 'LIQUOR', 'LIQUORS', 'WINE', 'WINES', 'DINER', 'BURGER', 'BURGERS', 'TACO', 'TACOS',
  'SUSHI', 'SALON', 'NAILS', 'SPA', 'HOTEL', 'PARKING', 'AUTO', 'TIRE', 'TIRES', 'DENTAL', 'MEDICAL', 'CLINIC',
  'CENTER', 'CENTRE', 'SUPPLY', 'HARDWARE', 'FARM', 'FARMS', 'FOODS', 'FOOD', 'FRESH', 'SUPERMARKET', 'GROCERY',
  'EXPRESS', 'MART', 'PLUS', 'ONE', 'MAX', 'PRO', 'USA', 'GROUP', 'SERVICES', 'SERVICE', 'SYSTEMS', 'STUDIO',
  'STUDIOS', 'FITNESS', 'GYM', 'YOGA', 'CLUB', 'LOUNGE', 'TAVERN', 'PUB', 'BREWING', 'BREWERY', 'DISTILLERY',
  'WINERY', 'BISTRO', 'EATERY', 'BAGELS', 'BAGEL', 'DONUTS', 'CREAMERY', 'CHOCOLATE', 'CANDY', 'TEA', 'JUICE',
  'SMOOTHIE', 'KOSHER', 'GLATT', 'BUTCHER', 'FISH', 'SEAFOOD', 'STEAKHOUSE', 'STEAK', 'CHICKEN', 'WINGS', 'RAMEN',
  'NOODLE', 'NOODLES', 'THAI', 'CHINESE', 'MEXICAN', 'ITALIAN', 'INDIAN', 'JAPANESE', 'KOREAN', 'FALAFEL',
  'SHAWARMA', 'HUMMUS', 'BOOKS', 'MUSIC', 'TOYS', 'GAMES', 'SPORTS', 'CYCLE', 'CYCLES', 'BIKES', 'BIKE', 'MOTORS',
  'GARAGE', 'BODY', 'WASH', 'LUBE', 'OIL', 'ENERGY', 'POWER', 'WATER', 'ELECTRIC', 'WIRELESS', 'MOBILE', 'ONLINE',
  'DIGITAL', 'MEDIA', 'NEWS', 'TIMES', 'POST', 'JOURNAL', 'PRESS', 'PRINT', 'PHOTO', 'VIDEO', 'FILM', 'THEATRE',
  'THEATER', 'CINEMA', 'MUSEUM', 'GALLERY', 'GARDEN', 'GARDENS', 'NURSERY', 'FLOWERS', 'FLORIST', 'GIFTS', 'GIFT',
  'CARDS', 'PARTY', 'EVENTS', 'TICKETS', 'TRAVEL', 'TOURS', 'AIRLINES', 'AIRWAYS', 'RENTAL', 'RENTALS', 'STORAGE',
  'MOVING', 'MOVERS', 'PLUMBING', 'HEATING', 'COOLING', 'ROOFING', 'PAINT', 'PAINTING', 'DESIGN', 'DESIGNS',
  'HOME', 'HOUSE', 'FURNITURE', 'MATTRESS', 'LIGHTING', 'KIDS', 'BABY', 'PETS', 'PET', 'VET', 'ANIMAL', 'HOSPITAL',
  'PHYSICAL', 'THERAPY', 'OPTICAL', 'VISION', 'EYE', 'EYES', 'HEALTH', 'CARE', 'LABS', 'LAB', 'IMAGING',
  'PEDIATRICS', 'FAMILY', 'URGENT', 'PRIMARY', 'WELLNESS', 'BEAUTY', 'BARBER', 'BARBERS', 'CUTS', 'HAIR', 'SKIN',
  'TAN', 'MASSAGE', 'WAX', 'LASH', 'BROW', 'SCHOOL', 'ACADEMY', 'UNIVERSITY', 'COLLEGE', 'INSTITUTE', 'LEARNING',
  'TUTORING', 'LESSONS', 'CAMP', 'DAYCARE', 'PRESCHOOL', 'YESHIVA', 'SHUL', 'SYNAGOGUE', 'CHURCH', 'TEMPLE',
  'MINISTRIES', 'CHARITY', 'FOUNDATION', 'FUND', 'INSURANCE', 'FINANCIAL', 'BANK', 'CREDIT', 'LOAN', 'LOANS',
  'MORTGAGE', 'REALTY', 'PROPERTIES', 'MANAGEMENT', 'ASSOCIATES', 'PARTNERS', 'CONSULTING', 'LAW', 'LEGAL',
  'ACCOUNTING', 'TAX', 'NOTARY', 'SECURITY', 'ALARM', 'LOCKSMITH', 'SHOE', 'SHOES', 'FOOTWEAR', 'APPAREL',
  'CLOTHING', 'FASHION', 'BOUTIQUE', 'OUTLET', 'OUTLETS', 'DEPOT', 'WAREHOUSE', 'WHOLESALE', 'DISCOUNT', 'DOLLAR',
  'GENERAL', 'VARIETY', 'THRIFT', 'VINTAGE', 'ANTIQUES', 'JEWELERS', 'JEWELRY', 'WATCH', 'WATCHES', 'EYEWEAR']);

// Two-word US cities, longest first, so "NEW YORK" is stripped as a unit
const TWO_WORD_CITIES = ['LONG ISLAND CITY', 'SALT LAKE CITY', 'OKLAHOMA CITY', 'KANSAS CITY', 'JERSEY CITY',
  'REDWOOD CITY', 'GARDEN CITY', 'FOSTER CITY', 'STUDIO CITY', 'CULVER CITY', 'DALY CITY', 'UNION CITY',
  'ROCKVILLE CENTRE', 'FOREST HILLS', 'FRESH MEADOWS', 'KEW GARDENS', 'REGO PARK', 'STATEN ISLAND', 'NEW ROCHELLE',
  'WHITE PLAINS', 'GREAT NECK', 'FAR ROCKAWAY', 'MOUNT VERNON', 'MOUNT KISCO', 'SILVER SPRING', 'SANTA MONICA',
  'SANTA CLARA', 'SANTA BARBARA', 'SANTA ROSA', 'SANTA CRUZ', 'SAN ANTONIO', 'SAN FRANCISCO', 'SAN DIEGO',
  'SAN JOSE', 'SAN MATEO', 'SAN RAFAEL', 'SAN BERNARDINO', 'FORT WORTH', 'FORT LAUDERDALE', 'FORT LEE',
  'FORT COLLINS', 'BOCA RATON', 'PALM BEACH', 'PALM SPRINGS', 'ST LOUIS', 'SAINT LOUIS', 'ST PAUL', 'SAINT PAUL',
  'ST PETERSBURG', 'EL PASO', 'COLORADO SPRINGS', 'VIRGINIA BEACH', 'MYRTLE BEACH', 'LONG BEACH', 'MIAMI BEACH',
  'ANN ARBOR', 'GRAND RAPIDS', 'BATON ROUGE', 'NEW ORLEANS', 'NEW HAVEN', 'NEW BRUNSWICK', 'NEW HYDE PARK',
  'PALO ALTO', 'MENLO PARK', 'MOUNTAIN VIEW', 'LAKE SUCCESS', 'VALLEY STREAM', 'LOS ANGELES', 'LOS GATOS',
  'LAS VEGAS', 'NEW YORK', 'LAKEWOOD', 'CEDARHURST', 'WEST HEMPSTEAD', 'EAST MEADOW', 'NORTH BERGEN',
  'WEST ORANGE', 'EAST BRUNSWICK', 'SOUTH ORANGE', 'HIGHLAND PARK', 'PARK SLOPE', 'CROWN HEIGHTS', 'BORO PARK',
  'BOROUGH PARK', 'SHEEPSHEAD BAY', 'BRIGHTON BEACH', 'HOWARD BEACH', 'OZONE PARK', 'JACKSON HEIGHTS',
  'SUNSET PARK', 'BAY RIDGE', 'CONEY ISLAND', 'BEVERLY HILLS', 'WEST HOLLYWOOD', 'SHERMAN OAKS', 'PARK CITY',
  'BOYNTON BEACH', 'DELRAY BEACH', 'HALLANDALE BEACH', 'SUNNY ISLES', 'NORTH MIAMI', 'CORAL GABLES',
  'CORAL SPRINGS', 'POMPANO BEACH', 'DEERFIELD BEACH', 'HOLLYWOOD FL', 'WEST PALM', 'LAKE WORTH', 'ROYAL PALM',
  'MONSEY', 'SPRING VALLEY', 'NEW CITY', 'NEW SQUARE', 'POMONA', 'AIRMONT', 'WESLEY HILLS', 'CHESTNUT RIDGE',
  'UPPER SADDLE', 'SADDLE RIVER', 'HO-HO-KUS', 'GLEN ROCK', 'FAIR LAWN', 'ELMWOOD PARK', 'CLIFFSIDE PARK']
  .sort((a, b) => b.length - a.length);

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

function toTitleCase(str) {
  return str
    .toLowerCase()
    .replace(/(?:^|[\s\-\/&\*])(\w)/g, m => m.toUpperCase());
}

// Title case with brand names and acronyms kept the way people write them
function properCase(str) {
  const key = str.toLowerCase().replace(/\s+/g, ' ').trim();
  if (BRAND_CASING.has(key)) return BRAND_CASING.get(key);
  return toTitleCase(str)
    .split(' ')
    .map(w => {
      const up = w.toUpperCase();
      if (ACRONYMS.has(up) || US_STATES.has(up)) return up;
      const brand = BRAND_CASING.get(w.toLowerCase());
      return brand && !brand.includes(' ') ? brand : w;
    })
    .join(' ');
}

const abbrKey = s => s.toLowerCase().replace(/[^a-z0-9*./&+ ]/g, '').replace(/\s+/g, ' ').trim();

// Expands known abbreviations, matched on the start of the name
function expandAbbreviation(s) {
  const key = abbrKey(s);
  for (const [abbr, expanded] of MERCHANT_ABBR) {
    if (key === abbr || key.startsWith(abbr + ' ')) return expanded;
  }
  return null;
}

// "JOES PIZZA NEW YORK NY" → "JOES PIZZA". Removes a trailing state code and
// the city before it: known one- or two-word cities are stripped outright; an
// unknown word is treated as a city unless it is a common merchant word.
function stripTrailingLocation(s) {
  const m = s.match(/^(.*?)[\s,\-]+([A-Z]{2})\s*$/);
  if (!m || !US_STATES.has(m[2])) return s;
  let rest = m[1].replace(/[\s,\-–—]+$/, '');
  const upper = rest.toUpperCase();
  for (const city of TWO_WORD_CITIES) {
    if (upper === city) return '';
    if (upper.endsWith(' ' + city)) return rest.slice(0, rest.length - city.length).replace(/[\s,\-–—]+$/, '');
  }
  const words = rest.split(/\s+/);
  const last = words[words.length - 1].toUpperCase();
  const alphabetic = /^[A-Z][A-Z'.-]{3,}$/.test(last);
  const knownCity = KNOWN_CITIES.includes(last.replace(/[^A-Z]/g, ''));
  if (words.length > 1 && (knownCity || (alphabetic && !NOT_A_CITY.has(last)))) {
    rest = words.slice(0, -1).join(' ');
  }
  return rest.replace(/[\s,\-–—]+$/, '');
}

function quickNormalizeName(merchant) {
  let s = merchant.trim();

  // Masked digits from the bank ("***.****.****** BOLT", "KGP ******") and
  // a parenthetical the bank cut off ("THE KOSHER PLACE (THAILAN")
  s = s.replace(/[*#]{2,}[*#.\-_/]*/g, ' ').replace(/(^|\s)[.\-_/]+(?=\s|$)/g, ' ').replace(/\s*\([^)]*$/, '').trim();
  // Leading store / reference numbers ("0491 STARBUCKS")
  s = s.replace(/^\d{3,}\s+(?=[A-Za-z])/, '');
  if (!s) return 'Unknown merchant';

  // Payment processor / wallet prefixes (order matters — longer first)
  s = s.replace(/^APLPAY\s+/i, '');
  const hadProcessorPrefix = /^(SQ|TST|GMF|MC|PY|PYD|WW|SP|APL|IN|DRI|WU|PP|NYX|OTTER|TOAST|CLOVER|D\s*J)\s*\*/i.test(s);
  s = s.replace(/^(SQ|TST|GMF|MC|PY|PYD|WW|SP|APL|IN|DRI|WU|PP|NYX|OTTER|TOAST|CLOVER|D\s*J)\s*\*\s*/i, '');
  s = s.replace(/^(PAYPAL|VENMO|ZELLE|STRIPE|SQUARE)\s*\*\s*/i, '');
  // Repeated-brand prefix: "Google *Google One" → "Google One"
  s = s.replace(/^(\w+)\s+\*\1\b\s*/i, '$1 ').trim();

  // Known abbreviations are checked on the raw form too ("ITUNES.COM/BILL", "D J*WSJ")
  const early = expandAbbreviation(merchant) || expandAbbreviation(s);
  if (early) return early;

  // Membership / subscriber ids: "Walmart+ Member 04/28009..." → "Walmart+"
  s = s.replace(/\s+(member|subscr|account)\s+[\d\/\-]+.*$/i, '');

  // Long embedded reference/phone numbers in last word (e.g. "KEVA1800800199HOL")
  s = s.replace(/\d{7,}\w{0,4}\s*$/, '');
  // US phone at end of string, with optional state code and trailing noise
  s = s.replace(/\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}[A-Za-z]{0,2}[\s\-.,*]*$/gi, '');
  // Phone directly concatenated to a word ("One855-836-3987ca -")
  s = s.replace(/([A-Za-z])\d{3}[-.\s]?\d{3}[-.\s]?\d{4}[A-Za-z]{0,2}[\s\-.,*]*$/, '$1');
  // US phone numbers mid-string
  s = s.replace(/\s*\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b\s*/g, ' ');
  // International / Israeli phone: "03 5202323" or "5202323tel"
  s = s.replace(/\s+\d{6,10}\s*(tel|fax|phone)?\s*$/gi, '');
  s = s.replace(/\s+\d{2,3}\s+\d{6,8}\s*(tel|fax|phone)?\s*$/gi, '');
  // Trailing 2-digit area code glued to a merchant word ("MECUHEDET03")
  s = s.replace(/[A-Za-z]\d{2}\s*$/, m => m[0]);
  // Multi-segment reference codes: "C 18-13827-63987" or "O*25-14041-09950"
  s = s.replace(/\s+[A-Z]\s*\*?\s*\d{2,}(?:-\d{3,}){2,}\b/gi, ' ');
  s = s.replace(/\s+\d{2,}(?:-\d{3,}){2,}\b/g, '');

  // Trailing city + state
  s = stripTrailingLocation(s);

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
  s = s.replace(/\s+\S*\.(com|net|org|app|co|io)(\/\S*)?([A-Z]{2})?\s*$/gi, (match, tld, path, stateCode) =>
    (!stateCode || US_STATES.has(stateCode.toUpperCase())) ? '' : match
  );
  // Location again, now that a URL can no longer hide it
  s = stripTrailingLocation(s);

  // URL-style names: www.merchant.com → merchant, 24six.app → 24six
  s = s.replace(/^www\./i, '').replace(/\.(com|net|org|co|app|io)\S*/gi, '');

  // Parenthetical suffixes: "Merchant (City, State)"
  s = s.replace(/\s*\([^)]{0,40}\)\s*$/, '');

  // Legal suffixes — spaced and concatenated ("YESHLTD")
  s = s.replace(/\s*,?\s*\b(LLC|INC\.?|CORP\.?|LTD\.?|CO\.|PLC|PLLC|L\.L\.C\.?)\s*$/i, '');
  s = s.replace(/(.{2,}?)(LTD|LLC|INC|CORP|PLLC|PLC)\.?\s*$/i, '$1').trim();

  // Store / location numbers: "STORE 08812", "#1234", "F1234", "ST1234", trailing digits
  s = s.replace(/\s+(STORE|STR|ST|LOC|LOCATION|UNIT|SHOP|BRANCH|NO)\.?\s*#?\s*\d{1,6}\s*$/i, '');
  s = s.replace(/\s+#\d[\d\-]*(\s.*)?$/, '');
  s = s.replace(/\s+[A-Z]\d{3,}\s*$/i, '');
  s = s.replace(/\s+\d{3,}\s*$/, '');
  // Short branch numbers: Square appends them ("SQ *BLUE DOOR 44") and Israeli
  // banks write them after the name ("PAZ YELLOW 12"). Bank descriptors are
  // all caps; a mixed-case "Studio 54" or "Route 66" is a real name.
  const allCaps = merchant === merchant.toUpperCase();
  if (hadProcessorPrefix || (allCaps && /\s\S+\s+\d{1,2}\s*$/.test(s))) s = s.replace(/\s+\d{1,2}\s*$/, '');

  // Transaction / reference codes: "*2K3" — codes carry digits; "*CHIPOTLE" is a sub-merchant
  s = s.replace(/\s*\*\s*(?=[A-Z0-9]*\d)[A-Z0-9]{3,}\S*$/i, '');
  s = s.replace(/\s*\*\s*/g, ' ');

  // eBay transaction ids
  s = s.replace(/^(ebay)\s+[a-z]\s+[\d\-]+\s*$/i, '$1');
  s = s.replace(/^(ebay)\s+[a-z]\s*\*[\d\-]+\s*$/i, '$1');

  // Repeated leading word: "Etsy Etsy ..." → "Etsy ..."
  s = s.replace(/^(\w+)\s+\1\b\s*/i, '$1 ').trim();

  // Trailing country names
  s = s.replace(/\s+(united states|united kingdom|israel)\s*$/i, '');

  s = s.replace(/[\s,\-–—:]+$/, '').replace(/^[\s,\-–—:]+/, '');
  s = s.replace(/\s{2,}/g, ' ').trim() || merchant.trim();

  return expandAbbreviation(s) || properCase(s);
}

module.exports = { toTitleCase, properCase, quickNormalizeName, stripTrailingLocation, MERCHANT_ABBR, US_STATES, KNOWN_CITIES, ISRAELI_CITIES, BRAND_CASING };
